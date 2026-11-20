import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type { RuntimeMetadata } from '../../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { acknowledgeBrowserScreencastFrame } from '../../../runtime/browser/screencast/browser-screencast-frame-credit'
import { browserScreencastSubscriptionPageId } from '../../../runtime/browser/screencast/browser-screencast-subscription-id'
import { ElectronSidecarTabRegistry } from './electron-sidecar-tab-registry'
import { electronServeBrowserScreencast } from './electron-serve-browser-screencast'
import type { BrowserScreencastStream } from '../../../runtime/browser/screencast/browser-screencast-contracts'
import { sendOrcadSidecarRequest } from '../orcad-sidecar-runtime-client'
import {
  openOrcadSidecarStream,
  type OrcadSidecarStream,
  type OrcadSidecarStreamHandlers
} from '../orcad-sidecar-stream-client'

vi.mock('../orcad-sidecar-runtime-client', () => ({
  sendOrcadSidecarRequest: vi.fn()
}))
vi.mock('../orcad-sidecar-stream-client', () => ({
  openOrcadSidecarStream: vi.fn()
}))

const openStreamMock = vi.mocked(openOrcadSidecarStream)
const sendRequestMock = vi.mocked(sendOrcadSidecarRequest)

const metadata: RuntimeMetadata = {
  runtimeId: 'sidecar-test',
  pid: 1,
  authToken: 'token',
  startedAt: 0,
  transports: [{ kind: 'unix', endpoint: '/tmp/sidecar.sock', streaming: true }]
}

const sidecarReady: BrowserScreencastResult = {
  type: 'ready',
  subscriptionId: 'browser-screencast:sidecar-page:nonce',
  browserPageId: 'sidecar-page',
  format: 'jpeg',
  tab: {
    browserPageId: 'sidecar-page',
    index: 0,
    url: 'https://example.test/',
    title: 'Example',
    active: true
  }
}

type ControlledStream = {
  handlers: OrcadSidecarStreamHandlers
  resolveDone: () => void
  rejectDone: (error: Error) => void
  close: Mock<() => void>
}

function controlledStream(): ControlledStream {
  let resolveDone!: () => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const controlled: ControlledStream = {
    handlers: {},
    resolveDone,
    rejectDone,
    close: vi.fn<() => void>()
  }
  openStreamMock.mockImplementation((_metadata, _method, _params, handlers) => {
    controlled.handlers = handlers ?? {}
    const stream: OrcadSidecarStream = { done, close: controlled.close }
    return stream
  })
  return controlled
}

afterEach(() => {
  openStreamMock.mockReset()
  sendRequestMock.mockReset()
})

describe('electronServeBrowserScreencast', () => {
  function registry(): ElectronSidecarTabRegistry {
    const tabs = new ElectronSidecarTabRegistry()
    tabs.register('sidecar-page', 'public-page', 'worktree-1')
    return tabs
  }

  it('rewrites sidecar page and subscription ids for the caller', async () => {
    const stream = controlledStream()
    const pending = electronServeBrowserScreencast(
      metadata,
      registry(),
      { format: 'jpeg' },
      {
        sendBinary: vi.fn()
      }
    )
    stream.handlers.onEvent?.(sidecarReady)
    const result = await pending

    expect(result.ready.browserPageId).toBe('public-page')
    expect(result.ready.tab.browserPageId).toBe('public-page')
    expect(result.ready.subscriptionId).toBe(result.subscriptionId)
    expect(result.ready.subscriptionId).not.toBe(sidecarReady.subscriptionId)
    expect(browserScreencastSubscriptionPageId(result.subscriptionId)).toBe('public-page')
    expect(result.ready.frameAck).toBeUndefined()
  })

  it('replays only the newest buffered frame on flushPendingFrame', async () => {
    const stream = controlledStream()
    const sent: string[] = []
    const pending = electronServeBrowserScreencast(
      metadata,
      registry(),
      { format: 'jpeg' },
      {
        sendBinary: (bytes) => {
          sent.push(Buffer.from(bytes).toString())
          return true
        }
      }
    )
    stream.handlers.onEvent?.(sidecarReady)
    stream.handlers.onBinary?.(new TextEncoder().encode('stale'))
    stream.handlers.onBinary?.(new TextEncoder().encode('fresh'))
    const result = await pending

    result.flushPendingFrame()
    expect(sent).toEqual(['fresh'])

    stream.handlers.onBinary?.(new TextEncoder().encode('live'))
    expect(sent).toEqual(['fresh', 'live'])
  })

  it('bridges viewer acks to the sidecar subscription when frameAck is requested', async () => {
    const stream = controlledStream()
    sendRequestMock.mockResolvedValue({ credited: true })
    const pending = electronServeBrowserScreencast(
      metadata,
      registry(),
      { format: 'jpeg', frameAck: 1 },
      { sendBinary: vi.fn(), pairedDeviceId: 'device-1' }
    )
    stream.handlers.onEvent?.(sidecarReady)
    const result = await pending

    expect(result.ready.frameAck).toBe(true)
    expect(acknowledgeBrowserScreencastFrame(result.subscriptionId, 'device-1', 7)).toBe(true)
    await vi.waitFor(() => {
      expect(sendRequestMock).toHaveBeenCalledWith(metadata, 'browser.screencast.ack', {
        subscriptionId: 'browser-screencast:sidecar-page:nonce',
        seq: 7
      })
    })
    // A foreign device id never reaches the sidecar.
    expect(acknowledgeBrowserScreencastFrame(result.subscriptionId, 'device-2', 8)).toBe(false)

    stream.resolveDone()
    await result.session.done
    expect(acknowledgeBrowserScreencastFrame(result.subscriptionId, 'device-1', 9)).toBe(false)
  })

  it('rejects when the sidecar errors before ready', async () => {
    const stream = controlledStream()
    const pending = electronServeBrowserScreencast(
      metadata,
      registry(),
      { format: 'jpeg' },
      {
        sendBinary: vi.fn()
      }
    )
    stream.rejectDone(Object.assign(new Error('no tab'), { code: 'browser_tab_not_found' }))
    await expect(pending).rejects.toMatchObject({ code: 'browser_tab_not_found' })
    expect(stream.close).toHaveBeenCalled()
  })

  it('forwards error events and ends the session when the stream resolves', async () => {
    const stream = controlledStream()
    const events: BrowserScreencastResult[] = []
    const pending = electronServeBrowserScreencast(
      metadata,
      registry(),
      { format: 'jpeg' },
      {
        sendBinary: vi.fn(),
        emit: (event) => events.push(event)
      }
    )
    stream.handlers.onEvent?.(sidecarReady)
    const result = await pending

    stream.handlers.onEvent?.({ type: 'error', message: 'renderer crashed' })
    expect(events).toEqual([{ type: 'error', message: 'renderer crashed' }])

    stream.resolveDone()
    await result.session.done
  })

  it('requires a binary sender', async () => {
    controlledStream()
    await expect(
      electronServeBrowserScreencast(
        metadata,
        registry(),
        { format: 'jpeg' },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercises the guard for transports that reach the command without sendBinary.
        {} as BrowserScreencastStream
      )
    ).rejects.toMatchObject({ code: 'browser_error' })
  })

  it('stop() closes the sidecar stream', async () => {
    const stream = controlledStream()
    const pending = electronServeBrowserScreencast(
      metadata,
      registry(),
      { format: 'jpeg' },
      {
        sendBinary: vi.fn()
      }
    )
    stream.handlers.onEvent?.(sidecarReady)
    const result = await pending

    result.session.stop()
    expect(stream.close).toHaveBeenCalled()
    stream.resolveDone()
    await result.session.done
  })
})

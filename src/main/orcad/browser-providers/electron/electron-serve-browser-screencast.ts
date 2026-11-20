import { randomUUID } from 'node:crypto'
import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type { RuntimeMetadata } from '../../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { errorMessage } from '../../../../shared/errors/error-message'
import { BrowserError } from '../../../browser/browser-error'
import { sendRemoteBrowserScreencastFrame } from '../../../runtime/browser/screencast/remote-browser-screencast-frame-admission'
import { mintBrowserScreencastSubscriptionId } from '../../../runtime/browser/screencast/browser-screencast-subscription-id'
import {
  registerBrowserScreencastFrameCredit,
  type BrowserScreencastFrameCredit
} from '../../../runtime/browser/screencast/browser-screencast-frame-credit'
import type {
  BrowserScreencastStartResult,
  BrowserScreencastStream
} from '../../../runtime/browser/screencast/browser-screencast-contracts'
import { sendOrcadSidecarRequest } from '../orcad-sidecar-runtime-client'
import { openOrcadSidecarStream } from '../orcad-sidecar-stream-client'
import type { ElectronSidecarTabRegistry } from './electron-sidecar-tab-registry'

// Held-frame retry matches the page stream's pacer interval.
const PROXY_PENDING_FRAME_RETRY_MS = 50

// The sidecar owns the CDP stream; this proxy mints the public subscription id,
// rewrites page ids, relays frames/events, and bridges viewer acks back.
export async function electronServeBrowserScreencast(
  metadata: RuntimeMetadata,
  tabs: ElectronSidecarTabRegistry,
  params: Record<string, unknown>,
  stream: BrowserScreencastStream
): Promise<BrowserScreencastStartResult> {
  const sendBinary = stream.sendBinary
  if (!sendBinary) {
    throw new BrowserError(
      'browser_error',
      'Browser screencast requires a binary streaming transport.'
    )
  }

  let flushed = false
  let emittedError = false
  let pendingFrame: Uint8Array<ArrayBufferLike> | null = null
  let pendingRetry: ReturnType<typeof setTimeout> | null = null
  let sidecarReady: Extract<BrowserScreencastResult, { type: 'ready' }> | null = null
  let resolveReady!: () => void
  const sawReady = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const deliver = (bytes: Uint8Array<ArrayBufferLike>): void => {
    const outcome = sendRemoteBrowserScreencastFrame(sendBinary, bytes)
    // Only the newest frame retries; an idle page may never produce a replacement.
    pendingFrame = outcome === 'backlogged' || outcome === 'refused' ? bytes : null
    if (pendingFrame && !pendingRetry) {
      pendingRetry = setTimeout(() => {
        pendingRetry = null
        const held = pendingFrame
        if (held) {
          deliver(held)
        }
      }, PROXY_PENDING_FRAME_RETRY_MS)
      pendingRetry.unref?.()
    }
  }

  const screencast = openOrcadSidecarStream(metadata, 'browser.screencast', params, {
    onBinary: (bytes) => {
      if (flushed) {
        deliver(bytes)
      } else {
        pendingFrame = bytes
      }
    },
    onEvent: (result) => {
      if (!isRecord(result) || typeof result.type !== 'string') {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sidecar serializes the BrowserScreencastResult contract on this stream; `type` is the wire discriminator.
      const event = result as BrowserScreencastResult
      if (event.type === 'ready') {
        sidecarReady = event
        resolveReady()
        return
      }
      // The caller's controller emits its own ready/end with the public subscription id.
      if (event.type === 'end') {
        return
      }
      if (event.type === 'error') {
        emittedError = true
      }
      stream.emit?.(event)
    }
  })

  // A rejection here means the sidecar refused or dropped before ready.
  let ready: Extract<BrowserScreencastResult, { type: 'ready' }> | null
  try {
    ready = await Promise.race([
      sawReady.then(() => sidecarReady),
      screencast.done.then(
        () => null,
        (error: unknown) => {
          throw error instanceof Error ? error : new BrowserError('browser_error', String(error))
        }
      )
    ])
  } catch (error) {
    screencast.close()
    throw error
  }
  if (!ready) {
    screencast.close()
    throw new BrowserError(
      'browser_screencast_unavailable',
      'Electron browser sidecar ended the screencast before it was ready.'
    )
  }

  const publicPageId = tabs.publicPageId(ready.browserPageId)
  const subscriptionId = mintBrowserScreencastSubscriptionId(publicPageId, randomUUID())

  // Viewer acks arrive here keyed by the public subscription id; forward them to the
  // sidecar's credit registry under the sidecar subscription. The sidecar registered
  // its credit without a paired device id, so forwarded acks omit it too.
  let releaseAckBridge: (() => void) | null = null
  if (params.frameAck === 1) {
    const bridgeCredit: BrowserScreencastFrameCredit = {
      canSend: () => true,
      recordSent: () => {},
      acknowledge: (seq) => {
        void sendOrcadSidecarRequest(metadata, 'browser.screencast.ack', {
          subscriptionId: ready.subscriptionId,
          seq
        }).catch(() => {})
      },
      dispose: () => {}
    }
    releaseAckBridge = registerBrowserScreencastFrameCredit(
      subscriptionId,
      stream.pairedDeviceId,
      bridgeCredit
    )
  }

  // Swallow transport errors after ready: the caller's controller ends the stream either
  // way, and an error event tells the viewer why when the sidecar did not report one.
  const sessionDone = screencast.done.then(
    () => {},
    (error: unknown) => {
      if (!emittedError) {
        stream.emit?.({ type: 'error', message: errorMessage(error) })
      }
    }
  )
  void sessionDone.finally(() => {
    if (pendingRetry) {
      clearTimeout(pendingRetry)
      pendingRetry = null
    }
    pendingFrame = null
    releaseAckBridge?.()
  })

  const rewritten = tabs.rewriteResult(ready)
  return {
    subscriptionId,
    ready: {
      type: 'ready',
      subscriptionId,
      browserPageId: publicPageId,
      format: ready.format,
      tab: rewritten.tab,
      // Echo the negotiated opt-in only when the ack bridge actually registered.
      ...(releaseAckBridge ? { frameAck: true as const } : {})
    },
    session: {
      done: sessionDone,
      stop: () => screencast.close(),
      // Connection-scoped remakes carry viewport changes; no remote viewport-update exists.
      updateViewport: async () => {}
    },
    flushPendingFrame: () => {
      flushed = true
      const bytes = pendingFrame
      pendingFrame = null
      if (bytes) {
        deliver(bytes)
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

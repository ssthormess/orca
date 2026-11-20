import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import {
  findTransport,
  type RuntimeMetadata
} from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { BrowserError } from '../../browser/browser-error'
import { daemonSocketDirIsTrusted } from '../../daemon/endpoint/publication/daemon-socket-endpoint-path'
import { RuntimeResponse } from './orcad-sidecar-runtime-client'

const SIDECAR_MAX_STREAM_LINE_BYTES = 32 * 1024 * 1024
// Server keepalives arrive every 10s once armed; silence past this means the peer died.
const SIDECAR_STREAM_IDLE_TIMEOUT_MS = 45_000

export type OrcadSidecarStreamHandlers = {
  /** Tagged streaming replies ({id, ok:true, streaming:true, result}). */
  onEvent?: (result: unknown) => void
  /** Base64 binary frames ({id, ok:true, streaming:true, binary}). */
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type OrcadSidecarStream = {
  /** Resolves on a terminal reply or socket close; rejects on transport/protocol failure. */
  done: Promise<void>
  /** Destroy the socket; the sidecar aborts the request on close. */
  close(): void
}

// Streaming requests keep the socket open: streaming-tagged replies and binary frames
// flow until a terminal response, an end event, or close.
export function openOrcadSidecarStream(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  handlers: OrcadSidecarStreamHandlers = {}
): OrcadSidecarStream {
  const transport = findTransport(metadata, 'unix', 'named-pipe')
  if (!transport || (transport.kind !== 'unix' && transport.kind !== 'named-pipe')) {
    throw new BrowserError(
      BROWSER_UNAVAILABLE_ERROR_CODE,
      'Electron browser sidecar has no local RPC transport.'
    )
  }
  if (transport.streaming !== true) {
    throw new BrowserError(
      'browser_screencast_unavailable',
      'Electron browser sidecar transport cannot stream. Update the installed Orca app.'
    )
  }
  if (transport.kind === 'unix' && !daemonSocketDirIsTrusted(transport.endpoint)) {
    throw new BrowserError(
      BROWSER_UNAVAILABLE_ERROR_CODE,
      'Electron browser sidecar socket directory is not private to this user.'
    )
  }

  const socket = createConnection(transport.endpoint)
  const requestId = randomUUID()
  let buffer = ''
  let settled = false
  let resolveDone!: () => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // done settles via close/error paths below; consumers may also just drop the handle.
  void done.catch(() => {})

  const finish = (error: Error | null): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    socket.destroy()
    if (error) {
      rejectDone(error)
    } else {
      resolveDone()
    }
  }
  const timer = setTimeout(() => {
    finish(new BrowserError('browser_timeout', 'Electron browser sidecar stream went idle.'))
  }, SIDECAR_STREAM_IDLE_TIMEOUT_MS)
  timer.unref?.()

  socket.setEncoding('utf8')
  socket.once('error', () => {
    finish(
      new BrowserError(BROWSER_UNAVAILABLE_ERROR_CODE, 'Electron browser sidecar stream failed.')
    )
  })
  socket.once('close', () => {
    finish(null)
  })
  socket.on('data', (chunk: string) => {
    timer.refresh()
    buffer += chunk
    if (Buffer.byteLength(buffer, 'utf8') > SIDECAR_MAX_STREAM_LINE_BYTES) {
      finish(new BrowserError('browser_error', 'Electron browser sidecar frame is too large.'))
      return
    }
    let newline = buffer.indexOf('\n')
    while (newline !== -1 && !settled) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.trim()) {
        continue
      }
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        finish(new BrowserError('browser_error', 'Electron browser sidecar returned invalid JSON.'))
        return
      }
      if (!isRecord(raw)) {
        finish(
          new BrowserError(
            'browser_error',
            'Electron browser sidecar returned an invalid response.'
          )
        )
        return
      }
      if ('_keepalive' in raw) {
        continue
      }
      if (raw.id !== requestId) {
        finish(
          new BrowserError(
            'browser_error',
            'Electron browser sidecar returned an invalid response.'
          )
        )
        return
      }
      // Binary frames ride tagged lines; events are ordinary streaming replies.
      if (typeof raw.binary === 'string') {
        handlers.onBinary?.(Buffer.from(raw.binary, 'base64'))
        continue
      }
      const parsed = RuntimeResponse.safeParse(raw)
      if (!parsed.success) {
        finish(
          new BrowserError(
            'browser_error',
            'Electron browser sidecar returned an invalid response.'
          )
        )
        return
      }
      if (!parsed.data.ok) {
        const { code, message, data } = parsed.data.error
        finish(new BrowserError(code, message, data))
        return
      }
      if (raw.streaming === true) {
        handlers.onEvent?.(parsed.data.result)
        continue
      }
      // Terminal success: a unary result or the end-of-stream sentinel.
      finish(null)
    }
  })
  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify({
        id: requestId,
        authToken: metadata.authToken,
        method,
        params
      })}\n`
    )
  })

  return {
    done,
    close: () => finish(null)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

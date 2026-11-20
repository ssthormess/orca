import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMetadata } from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { openOrcadSidecarStream } from './orcad-sidecar-stream-client'

describe.skipIf(process.platform === 'win32')('openOrcadSidecarStream', () => {
  const cleanups: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
  })

  async function serve(
    dir: string,
    onRequest: (write: (line: string) => void, request: Record<string, unknown>) => void
  ): Promise<RuntimeMetadata> {
    const endpoint = join(dir, 'sidecar.sock')
    const sockets = new Set<Socket>()
    const server: Server = createServer((socket) => {
      sockets.add(socket)
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) {
          return
        }
        const request: Record<string, unknown> = JSON.parse(buffer.slice(0, newline))
        onRequest((line) => socket.write(`${line}\n`), request)
      })
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    cleanups.push(async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
      runtimeId: 'sidecar-test',
      pid: process.pid,
      authToken: 'token',
      startedAt: 0,
      transports: [{ kind: 'unix', endpoint, streaming: true }]
    }
  }

  it('emits events and binary frames, then resolves on the terminal reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orcad-stream-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const events: unknown[] = []
    const frames: string[] = []
    const metadata = await serve(dir, (write, request) => {
      const id = request.id
      write(JSON.stringify({ id, ok: true, streaming: true, result: { type: 'ready' } }))
      write(
        JSON.stringify({
          id,
          ok: true,
          streaming: true,
          binary: Buffer.from('frame-1').toString('base64')
        })
      )
      write('{"_keepalive":true}')
      write(JSON.stringify({ id, ok: true, result: null }))
    })

    const stream = openOrcadSidecarStream(
      metadata,
      'browser.screencast',
      { format: 'jpeg' },
      {
        onEvent: (event) => events.push(event),
        onBinary: (bytes) => frames.push(Buffer.from(bytes).toString())
      }
    )
    await stream.done

    expect(events).toEqual([{ type: 'ready' }])
    expect(frames).toEqual(['frame-1'])
  })

  it('rejects done when the sidecar replies with an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orcad-stream-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const metadata = await serve(dir, (write, request) => {
      write(
        JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: 'browser_tab_not_found', message: 'no tab' }
        })
      )
    })

    const stream = openOrcadSidecarStream(metadata, 'browser.screencast', {})
    await expect(stream.done).rejects.toMatchObject({ code: 'browser_tab_not_found' })
  })

  it('refuses sidecars whose transport cannot stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orcad-stream-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const endpoint = join(dir, 'sidecar.sock')
    const metadata: RuntimeMetadata = {
      runtimeId: 'sidecar-test',
      pid: process.pid,
      authToken: 'token',
      startedAt: 0,
      transports: [{ kind: 'unix', endpoint }]
    }

    expect(() => openOrcadSidecarStream(metadata, 'browser.screencast', {})).toThrowError(
      expect.objectContaining({ code: 'browser_screencast_unavailable' })
    )
  })

  it('closes the stream without leaking pending state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orcad-stream-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const events: unknown[] = []
    const metadata = await serve(dir, (write, request) => {
      write(
        JSON.stringify({ id: request.id, ok: true, streaming: true, result: { type: 'ready' } })
      )
      // No terminal reply: the caller closes mid-stream.
    })

    const stream = openOrcadSidecarStream(
      metadata,
      'browser.screencast',
      {},
      {
        onEvent: (event) => {
          events.push(event)
          stream.close()
        }
      }
    )
    await stream.done

    expect(events).toEqual([{ type: 'ready' }])
  })
})

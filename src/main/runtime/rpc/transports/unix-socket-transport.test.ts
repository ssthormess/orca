import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { UnixSocketTransport } from './unix-socket-transport'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  writableLength = 0
  readonly writes: string[] = []
  private idleMs = 0
  private idleHandler: (() => void) | null = null
  private idleTimer: NodeJS.Timeout | null = null

  setEncoding(): void {}
  setNoDelay(): void {}
  end(): void {}

  // Match setTimeout: positive arms, zero suspends, and callback-free rearm preserves the handler.
  setTimeout(ms: number, handler?: () => void): this {
    if (handler) {
      this.idleHandler = handler
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.idleMs = ms
    if (ms > 0 && this.idleHandler) {
      this.idleTimer = setTimeout(() => this.idleHandler?.(), ms)
    }
    return this
  }

  write(data: string): boolean {
    this.writes.push(data)
    this.refreshIdleTimer()
    return true
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.writable = false
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
      this.emit('close')
    }
    return this
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'data') {
      this.refreshIdleTimer()
    }
    return super.emit(event, ...args)
  }

  // Traffic resets the idle window; net.Socket counts reads and writes alike.
  private refreshIdleTimer(): void {
    this.setTimeout(this.idleMs)
  }
}

type UnixSocketTransportInternals = {
  handleConnection(socket: Socket): void
}

function connectFakeSocket(transport: UnixSocketTransport, socket: FakeSocket): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches the private connection hook and a minimal socket stub.
  ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
    socket as unknown as Socket
  )
}

describe('UnixSocketTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createReceiver() {
    const transport = new UnixSocketTransport({ endpoint: 'test-pipe', kind: 'named-pipe' })
    const socket = new FakeSocket()
    const received: string[] = []
    transport.onMessage((message, reply) => {
      received.push(message)
      reply('ok')
    })
    connectFakeSocket(transport, socket)
    return { socket, received }
  }

  it.each([false, true])('preserves the UTF-8 byte boundary with oversized=%s', (oversized) => {
    const { socket, received } = createReceiver()
    const message = `${'é'.repeat(524287)}a${oversized ? 'x' : ''}`
    const wire = Buffer.from(`${message}\n`)
    const decoder = new StringDecoder('utf8')
    for (let offset = 0; offset < wire.length; offset += 4095) {
      socket.emit('data', decoder.write(wire.subarray(offset, offset + 4095)))
    }
    expect(received).toEqual([oversized ? '' : message])
  })

  it('clears request keepalive timers when the socket closes before a reply', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      keepaliveIntervalMs: 100
    })
    const socket = new FakeSocket()
    let aborted = false

    transport.onMessage((_msg, _reply, context) => {
      context?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
      context?.startKeepalive()
    })

    connectFakeSocket(transport, socket)
    socket.emit('data', '{"id":"pending","method":"wait"}\n')

    vi.advanceTimersByTime(100)
    expect(socket.writes).toHaveLength(1)

    socket.destroy()
    expect(aborted).toBe(true)

    vi.advanceTimersByTime(500)
    expect(socket.writes).toHaveLength(1)
  })

  it('writes streaming replies until a terminal reply, then drops the rest', () => {
    const transport = new UnixSocketTransport({ endpoint: 'test-pipe', kind: 'named-pipe' })
    const socket = new FakeSocket()
    transport.onMessage((_msg, reply) => {
      reply('{"id":"r1","ok":true,"streaming":true,"result":{"type":"ready"}}')
      reply('{"id":"r1","ok":true,"streaming":true,"binary":"aGk="}')
      reply('{"id":"r1","ok":true,"result":null}')
      reply('{"id":"r1","ok":true,"result":"late"}')
    })

    connectFakeSocket(transport, socket)
    socket.emit('data', '{"id":"r1","method":"browser.screencast"}\n')

    expect(socket.writes).toEqual([
      '{"id":"r1","ok":true,"streaming":true,"result":{"type":"ready"}}\n',
      '{"id":"r1","ok":true,"streaming":true,"binary":"aGk="}\n',
      '{"id":"r1","ok":true,"result":null}\n'
    ])
  })

  it('treats a nested streaming field in a unary result as terminal', () => {
    const transport = new UnixSocketTransport({ endpoint: 'test-pipe', kind: 'named-pipe' })
    const socket = new FakeSocket()
    transport.onMessage((_msg, reply) => {
      reply('{"id":"r1","ok":true,"result":{"streaming":true}}')
      reply('{"id":"r1","ok":true,"result":"late"}')
    })

    connectFakeSocket(transport, socket)
    socket.emit('data', '{"id":"r1","method":"status.get"}\n')

    expect(socket.writes).toEqual(['{"id":"r1","ok":true,"result":{"streaming":true}}\n'])
  })

  it('reports droppable replies as backlogged while earlier bytes still queue', () => {
    const transport = new UnixSocketTransport({ endpoint: 'test-pipe', kind: 'named-pipe' })
    const socket = new FakeSocket()
    const outcomes: unknown[] = []
    transport.onMessage((_msg, reply) => {
      socket.writableLength = 1
      outcomes.push(
        reply('{"id":"r1","ok":true,"streaming":true,"binary":"aGk="}', {
          dropWhenBacklogged: true
        })
      )
      socket.writableLength = 0
      outcomes.push(
        reply('{"id":"r1","ok":true,"streaming":true,"binary":"aGk="}', {
          dropWhenBacklogged: true
        })
      )
      reply('{"id":"r1","ok":true,"result":null}')
    })

    connectFakeSocket(transport, socket)
    socket.emit('data', '{"id":"r1","method":"browser.screencast"}\n')

    expect(outcomes).toEqual(['backlogged', true])
    expect(socket.writes).toEqual([
      '{"id":"r1","ok":true,"streaming":true,"binary":"aGk="}\n',
      '{"id":"r1","ok":true,"result":null}\n'
    ])
  })
})

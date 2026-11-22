import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-schemas'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { itemBlocks } from '../../../shared/agent-session/view/structured-agent-session-item-blocks'
import { nativeChatToolRunViewedImages } from '../../../shared/native-chat/tools/native-chat-tool-viewed-images'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { agentJournalItemForWire } from '../../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import { boundedFrameItem } from '../../native-chat/agent-session-wire/publication/history/agent-session-bounded-frame-item'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

// An ancillary text chunk before IDAT pushes the PNG past the wire page's per-item byte budget.
function annotatedPng(textBytes = 96 * 1024): string {
  const pixel = Buffer.from(PIXEL, 'base64')
  const text = Buffer.from(`Comment\0${'x'.repeat(textBytes)}`)
  const chunk = Buffer.alloc(text.length + 12)
  chunk.writeUInt32BE(text.length)
  chunk.write('tEXt', 4, 'ascii')
  text.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return Buffer.concat([pixel.subarray(0, 33), chunk, pixel.subarray(33)]).toString('base64')
}

/** Latest body each item reached; journal rows persist exactly what these events carry. */
function run(updates: SessionUpdate[]): Map<string, AgentJournalItemBody> {
  const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: OPENCODE_ACP_DIALECT })
  const bodies = new Map<string, AgentJournalItemBody>()
  const collect = (events: ProviderTimelineEvent[]) => {
    for (const event of events) {
      if (
        event.type === 'item.open' ||
        event.type === 'item.update' ||
        event.type === 'item.close'
      ) {
        bodies.set(event.item, event.body)
      }
    }
  }
  collect(lane.openPrompt('prompt-1', 1_000).events)
  updates.forEach((update, index) =>
    collect(lane.notification('session/update', { sessionId: 'session-1', update }, 1_100 + index))
  )
  collect(lane.promptResult('prompt-1', { stopReason: 'end_turn' }, 1_200))
  lane.dispose()
  return bodies
}

// A reopened journal hands back each body as JSON through the same read admission production uses.
function persisted(body: AgentJournalItemBody): AgentJournalItemBody {
  const revived = JSON.parse(JSON.stringify(body)) as unknown
  if (!isAdmissibleAgentJournalItemBody(revived)) {
    throw new Error('journal read admission rejected the row')
  }
  return revived
}

function previews(bodies: Iterable<AgentJournalItemBody>) {
  return nativeChatToolRunViewedImages(
    [...bodies].flatMap((body, index) => {
      const item: AgentJournalRenderItem = {
        itemId: `item-${index}`,
        revision: 1,
        body: persisted(body),
        sequence: index,
        observedAt: 1_100 + index
      }
      return itemBlocks(boundedFrameItem(agentJournalItemForWire(item)).item)?.blocks ?? []
    })
  )
}

const imageContent = (data: string) => ({
  type: 'content' as const,
  content: { type: 'image' as const, mimeType: 'image/png', data }
})

const screenshot = (callId: string, data: string): SessionUpdate => ({
  sessionUpdate: 'tool_call',
  toolCallId: callId,
  title: 'Capture screenshot',
  name: 'screenshot',
  status: 'completed',
  content: [imageContent(data)]
})

const readImage = (callId: string, path: string, data?: string): SessionUpdate => ({
  sessionUpdate: 'tool_call',
  toolCallId: callId,
  title: 'Read image',
  name: 'read',
  rawInput: { path },
  status: 'completed',
  content:
    data === undefined
      ? [{ type: 'content', content: { type: 'text', text: 'Image read successfully' } }]
      : [imageContent(data)]
})

describe('ACP tool images', () => {
  it('keeps a returned image with no file path through status-only completion', () => {
    const data = annotatedPng(32 * 1024)
    const bodies = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'capture',
        title: 'Capture screenshot',
        name: 'screenshot',
        status: 'in_progress',
        content: [imageContent(data)]
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'capture', status: 'completed' }
    ])

    expect(bodies.get('tool:capture')).toMatchObject({
      kind: 'tool-call',
      state: 'completed',
      outputImages: [{ type: 'image-ref', url: `data:image/png;base64,${data}` }]
    })
    expect(previews(bodies.values())).toEqual([
      { type: 'image-ref', url: `data:image/png;base64,${data}` }
    ])
  })

  it('replaces then clears captured output while a plain read keeps its path preview', () => {
    const bodies = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'capture',
        title: 'Read image',
        name: 'read',
        rawInput: { path: '/images/fallback.png' },
        status: 'in_progress',
        content: [imageContent(PIXEL)]
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'capture',
        status: 'in_progress',
        content: []
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'capture', status: 'completed' },
      readImage('plain-read', '/images/legacy.png')
    ])

    expect(bodies.get('tool:capture')).toMatchObject({ state: 'completed', outputImages: [] })
    expect(previews(bodies.values())).toEqual([
      { type: 'image-ref', path: '/images/fallback.png' },
      { type: 'image-ref', path: '/images/legacy.png' }
    ])
  })

  it('labels unrenderable output instead of previewing it', () => {
    const bodies = run([
      screenshot('capture', '!bad!'),
      readImage('empty-read', '/images/retained.png', ''),
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'failed-read',
        title: 'Read missing image',
        name: 'read',
        rawInput: { path: '/images/missing.png' },
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'File not found' } }]
      }
    ])

    expect(previews(bodies.values())).toEqual([
      { type: 'image-ref', alt: 'Image preview unavailable' },
      { type: 'image-ref', path: '/images/retained.png' }
    ])
  })

  it('falls back when wire clipping cuts a captured image', () => {
    const data = annotatedPng()
    const bodies = run([
      readImage('large-read', '/images/capture.png', data),
      screenshot('large-capture', data),
      screenshot('small-capture', PIXEL)
    ])

    expect(previews(bodies.values())).toEqual([
      { type: 'image-ref', path: '/images/capture.png' },
      { type: 'image-ref', alt: 'Image preview unavailable' },
      { type: 'image-ref', url: `data:image/png;base64,${PIXEL}` }
    ])
  })
})

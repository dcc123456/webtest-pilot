/**
 * Tests for persisting the open-ended conversation transcript.
 *
 * These verify that display entries are mirrored into `chrome.storage.session`
 * and restored intact, which is what keeps the conversation from disappearing
 * when the panel tab unmounts or the worker is evicted.
 *
 * @module tests/conversation.spec
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installChromeFake } from './fake-chrome'
import {
  applyConversationEvent,
  conversation,
  restoreConversation,
} from '../src/background/conversation'

describe('conversation transcript persistence', () => {
  beforeEach(() => {
    installChromeFake()
    conversation.reset()
  })

  afterEach(() => {
    conversation.reset()
  })

  it('accumulates user/assistant/tool entries', () => {
    applyConversationEvent({ type: 'convUser', text: '分析页面', at: 1 })
    applyConversationEvent({ type: 'convAssistant', text: '好的', at: 2 })
    applyConversationEvent({ type: 'convAssistant', text: '好的，我看看', at: 3 })
    applyConversationEvent({
      type: 'convTool',
      id: 't1',
      name: 'snapshot',
      args: '',
      result: 'ok',
      ok: true,
      durationMs: 5,
      at: 4,
    })

    expect(conversation.entries.map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'tool',
    ])
    // Repeated assistant deltas update the same streaming bubble rather than
    // appending a new line per token.
    const assistant = conversation.entries.find((e) => e.kind === 'assistant')
    expect(assistant && assistant.kind === 'assistant' && assistant.text).toBe('好的，我看看')
  })

  it('replaces a pending card with its resolved tool result', () => {
    applyConversationEvent({
      type: 'convPending',
      pendingId: 'p1',
      name: 'click',
      args: '提交',
      mutating: true,
      at: 1,
    })
    applyConversationEvent({
      type: 'convTool',
      id: 't1',
      name: 'click',
      args: '提交',
      result: 'clicked',
      ok: true,
      durationMs: 4,
      at: 2,
    })
    expect(conversation.entries.some((e) => e.kind === 'pending')).toBe(false)
    expect(conversation.entries.some((e) => e.kind === 'tool')).toBe(true)
  })

  it('restores the transcript and steps from session storage, dropping pending cards', async () => {
    applyConversationEvent({ type: 'convUser', text: '你好', at: 1 })
    applyConversationEvent({ type: 'convAssistant', text: '你好！', at: 2 })
    applyConversationEvent({
      type: 'convPending',
      pendingId: 'p9',
      name: 'fill',
      args: '邮箱',
      mutating: true,
      at: 3,
    })
    conversation.setLastSteps([{ action: 'click' }])
    applyConversationEvent({ type: 'convDone', steps: [{ action: 'click' }], at: 4 })

    // Let the debounced session-storage write settle before simulating eviction.
    await new Promise((resolve) => setTimeout(resolve, 160))

    // Simulate a fresh worker: clear in-memory state, then restore.
    conversation.entries = []
    conversation.lastSteps = []
    conversation.entryCounter = 0

    const restored = await restoreConversation()
    expect(restored.entries.some((e) => e.kind === 'pending')).toBe(false)
    expect(restored.entries.some((e) => e.kind === 'user')).toBe(true)
    const assistant = restored.entries.find((e) => e.kind === 'assistant')
    // Streaming is finalized on restore so the UI does not wait for more deltas.
    expect(assistant && assistant.kind === 'assistant' && assistant.streaming).toBe(false)
    expect(restored.lastSteps).toHaveLength(1)

    // New ids must not collide with restored ones.
    applyConversationEvent({ type: 'convUser', text: '再来一句', at: 5 })
    const ids = conversation.entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('clears the persisted transcript on convCleared', () => {
    applyConversationEvent({ type: 'convUser', text: '秘密', at: 1 })
    applyConversationEvent({ type: 'convCleared', at: 2 })
    expect(conversation.entries).toHaveLength(0)
  })
})

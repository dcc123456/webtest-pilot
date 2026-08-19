import { describe, expect, it } from 'vitest'

import { SseAccumulator } from '../src/lib/llm'

/** Wraps a payload object as one complete SSE frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** A content-delta chunk. */
function textChunk(content: string): string {
  return frame({ choices: [{ delta: { content }, finish_reason: null }] })
}

describe('SseAccumulator', () => {
  it('concatenates content deltas and reports them incrementally', () => {
    const seen: string[] = []
    const accumulator = new SseAccumulator({ onText: (delta) => seen.push(delta) })
    accumulator.push(textChunk('Hello'))
    accumulator.push(textChunk(' world'))
    accumulator.push('data: [DONE]\n\n')
    const result = accumulator.finish()
    expect(result.content).toBe('Hello world')
    expect(seen).toEqual(['Hello', ' world'])
    expect(accumulator.isDone).toBe(true)
  })

  it('handles a frame split across two network reads mid-JSON', () => {
    const whole = textChunk('split me')
    const cut = Math.floor(whole.length / 2)
    const accumulator = new SseAccumulator()
    accumulator.push(whole.slice(0, cut))
    // Nothing may be emitted before the frame is complete.
    expect(accumulator.result().content).toBe('')
    accumulator.push(whole.slice(cut))
    expect(accumulator.finish().content).toBe('split me')
  })

  it('handles several frames arriving in one read', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(`${textChunk('a')}${textChunk('b')}${textChunk('c')}`)
    expect(accumulator.finish().content).toBe('abc')
  })

  it('tolerates CRLF line endings from proxies', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(textChunk('crlf').replace(/\n/g, '\r\n'))
    expect(accumulator.finish().content).toBe('crlf')
  })

  it('flushes a trailing frame that never got its blank line', () => {
    const accumulator = new SseAccumulator()
    accumulator.push('data: {"choices":[{"delta":{"content":"tail"}}]}')
    expect(accumulator.finish().content).toBe('tail')
  })

  it('ignores comments, blank lines, and non-data fields', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(': keep-alive\n\n')
    accumulator.push('event: message\nid: 7\n\n')
    accumulator.push(textChunk('ok'))
    expect(accumulator.finish().content).toBe('ok')
  })

  it('survives a malformed frame without losing the stream', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(textChunk('before'))
    accumulator.push('data: {not json}\n\n')
    accumulator.push(textChunk('after'))
    expect(accumulator.finish().content).toBe('beforeafter')
  })

  it('ignores a usage-only trailing chunk but records the usage', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(textChunk('hi'))
    accumulator.push(frame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }))
    const result = accumulator.finish()
    expect(result.content).toBe('hi')
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 3 })
  })

  it('assembles a tool call from argument fragments and announces it once', () => {
    const started: string[] = []
    const accumulator = new SseAccumulator({ onToolCallStart: (name) => started.push(name) })
    accumulator.push(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'click', arguments: '{"r' } }],
            },
          },
        ],
      }),
    )
    accumulator.push(
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ef":"e' } }] } }] }),
    )
    accumulator.push(
      frame({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '5"}' } }] }, finish_reason: 'tool_calls' }],
      }),
    )
    const result = accumulator.finish()
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'click', arguments: '{"ref":"e5"}' },
    })
    expect(result.finishReason).toBe('tool_calls')
    expect(started).toEqual(['click'])
  })

  it('keeps parallel tool calls separate and ordered by index', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'b', function: { name: 'second', arguments: '{}' } },
                { index: 0, id: 'a', function: { name: 'first', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    )
    const names = accumulator.finish().toolCalls.map((call) => call.function.name)
    expect(names).toEqual(['first', 'second'])
  })

  it('defaults a missing tool-call index to zero rather than dropping the call', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(
      frame({ choices: [{ delta: { tool_calls: [{ id: 'x', function: { name: 'go', arguments: '{}' } }] } }] }),
    )
    expect(accumulator.finish().toolCalls).toHaveLength(1)
  })

  it('surfaces reasoning text separately and keeps it out of content', () => {
    const reasoning: string[] = []
    const accumulator = new SseAccumulator({ onReasoning: (delta) => reasoning.push(delta) })
    accumulator.push(frame({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }))
    accumulator.push(frame({ choices: [{ delta: { reasoning: ' more' } }] }))
    accumulator.push(textChunk('answer'))
    const result = accumulator.finish()
    expect(reasoning).toEqual(['thinking…', ' more'])
    expect(result.content).toBe('answer')
  })

  it('stops reporting done before [DONE] arrives', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(textChunk('x'))
    expect(accumulator.isDone).toBe(false)
  })

  it('omits usage entirely when the provider never reports it', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(textChunk('x'))
    expect(accumulator.finish()).not.toHaveProperty('usage')
  })
})

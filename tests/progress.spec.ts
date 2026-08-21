/**
 * Cancellation, the live transcript, and what the panel is told while a run works.
 *
 * These cover three defects that shared one root cause: the *live state of a run
 * lived in the panel*, which the side panel unmounts whenever the user switches
 * tabs. Concretely:
 *
 * 1. **Cancel did nothing for seconds.** The signal reached the model call but not
 *    the driver's polling loops, where a run actually spends its time.
 * 2. **The panel showed almost nothing.** A tool call was reported as a bare name.
 * 3. **Switching tabs erased the transcript.** It lived in `useState`, and events
 *    that arrived while unmounted were delivered to a dead listener.
 *
 * The guarantees asserted here, in the order they matter:
 *
 * - A cancelled run settles as `cancelled` — never `error` and never `failed`.
 *   Cancellation is a human choice; reporting it as a fault sends someone hunting a
 *   bug that does not exist.
 * - Cancelling during a long wait stops promptly rather than after the full step
 *   timeout, because "nothing happened when I clicked" is the actual complaint.
 * - The transcript survives an unmount, and replaying it does not duplicate what
 *   live events already delivered.
 * - A secret's *value* never reaches the transcript, in any tool, under any field.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { summarizeToolArgs } from '../src/background/agent'
import {
  CancelledError,
  sleepUnlessCancelled,
  throwIfCancelled,
  type RunContext,
} from '../src/background/driver'
import { installChromeFake } from './fake-chrome'

let transcript: typeof import('../src/background/transcript')
let store: typeof import('../src/panel/chatStore')

beforeEach(async () => {
  installChromeFake()
  vi.resetModules()
  transcript = await import('../src/background/transcript')
  store = await import('../src/panel/chatStore')
  store.clearChat()
})

describe('cancellation reaches the polling loops', () => {
  it('wakes a sleep early when the signal aborts', async () => {
    const controller = new AbortController()
    const started = Date.now()
    // A 5s nap that must end as soon as cancel is pressed. This is the mechanism
    // behind "I clicked cancel and nothing happened": the old code slept the full
    // interval before looking at the signal.
    setTimeout(() => controller.abort(), 20)
    await sleepUnlessCancelled(5_000, controller.signal)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    await sleepUnlessCancelled(5_000, controller.signal)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('still sleeps when there is no signal', async () => {
    const started = Date.now()
    await sleepUnlessCancelled(30)
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })

  it('throwIfCancelled distinguishes cancellation from every other fault', () => {
    const controller = new AbortController()
    expect(() => throwIfCancelled(controller.signal)).not.toThrow()
    controller.abort()
    // The dedicated type is what lets the orchestrator report `cancelled` instead of
    // `error`; a generic Error here would be misattributed as a harness failure.
    expect(() => throwIfCancelled(controller.signal)).toThrow(CancelledError)
  })

  it('carries the signal on the run context so every driver call sees it', () => {
    const controller = new AbortController()
    const context: RunContext = { tabId: 1, signal: controller.signal }
    expect(context.signal?.aborted).toBe(false)
    controller.abort()
    expect(context.signal?.aborted).toBe(true)
  })
})

describe('tool argument summaries never leak a secret', () => {
  it('names the secret but never its value', () => {
    const summary = summarizeToolArgs('fill', {
      ref: 'e4',
      secretRef: 'staging-password',
      value: 'hunter2-the-real-password',
    })
    expect(summary).toContain('staging-password')
    expect(summary).toContain('e4')
    // The load-bearing assertion of this file.
    expect(summary).not.toContain('hunter2-the-real-password')
  })

  it('shows a plain value when no secret is involved', () => {
    const summary = summarizeToolArgs('fill', { ref: 'e2', value: 'demo@example.com' })
    expect(summary).toContain('demo@example.com')
  })

  it('never renders the internal placeholder', () => {
    const summary = summarizeToolArgs('fill', {
      ref: 'e1',
      value: '\u0000WTP_SECRET\u0000',
      secretRef: 'token',
    })
    expect(summary).not.toContain('\u0000')
  })

  it('trims a long argument so one call cannot flood the panel', () => {
    const summary = summarizeToolArgs('fill', { value: 'x'.repeat(500) })
    expect(summary.length).toBeLessThan(200)
  })
})

describe('the worker owns the transcript', () => {
  it('records tool calls with the detail the panel needs', async () => {
    await transcript.beginTranscript('run-1', '登录流程')
    await transcript.appendEntry('run-1', {
      kind: 'tool',
      name: 'click',
      args: 'ref=e7',
      result: 'Clicked.',
      ok: true,
      durationMs: 42,
      round: 3,
    })

    const stored = await transcript.getTranscript('run-1')
    const entry = stored?.entries[0]
    expect(entry?.kind).toBe('tool')
    if (entry?.kind !== 'tool') throw new Error('expected a tool entry')
    // Each of these was invisible before: the panel showed only `name`.
    expect(entry.args).toBe('ref=e7')
    expect(entry.durationMs).toBe(42)
    expect(entry.round).toBe(3)
    expect(entry.ok).toBe(true)
  })

  it('assigns increasing sequence numbers', async () => {
    await transcript.beginTranscript('run-1', 'case')
    const first = await transcript.appendEntry('run-1', { kind: 'phase', text: 'a' })
    const second = await transcript.appendEntry('run-1', { kind: 'phase', text: 'b' })
    expect(first?.seq).toBe(1)
    expect(second?.seq).toBe(2)
  })

  it('merges streamed text into one bubble instead of one entry per token', async () => {
    await transcript.beginTranscript('run-1', 'case')
    await transcript.appendAssistantDelta('run-1', 'Open')
    await transcript.appendAssistantDelta('run-1', 'ing ')
    await transcript.appendAssistantDelta('run-1', 'the page')

    const stored = await transcript.getTranscript('run-1')
    expect(stored?.entries).toHaveLength(1)
    expect(stored?.entries[0]).toMatchObject({ kind: 'assistant', text: 'Opening the page' })
  })

  it('starts a new bubble after a tool call, keeping reasoning in order', async () => {
    await transcript.beginTranscript('run-1', 'case')
    await transcript.appendAssistantDelta('run-1', 'First I look.')
    await transcript.appendEntry('run-1', {
      kind: 'tool',
      name: 'snapshot',
      args: '',
      result: 'ok',
      ok: true,
      durationMs: 5,
      round: 1,
    })
    await transcript.appendAssistantDelta('run-1', 'Now I click.')

    const stored = await transcript.getTranscript('run-1')
    // Three entries, not two: merging across the tool call would claim the agent
    // said both sentences before acting.
    expect(stored?.entries.map((entry) => entry.kind)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('does not lose entries when appends overlap', async () => {
    await transcript.beginTranscript('run-1', 'case')
    // The observer fires these without awaiting. Unqueued, these read-modify-write
    // appends interleave and silently discard each other.
    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        transcript.appendEntry('run-1', { kind: 'phase', text: `step ${index}` }),
      ),
    )
    const stored = await transcript.getTranscript('run-1')
    expect(stored?.entries).toHaveLength(25)
  })

  it('caps a long run and keeps the most recent entries', async () => {
    await transcript.beginTranscript('run-1', 'case')
    for (let index = 0; index < transcript.MAX_ENTRIES + 20; index += 1) {
      await transcript.appendEntry('run-1', { kind: 'phase', text: `step ${index}` })
    }
    const stored = await transcript.getTranscript('run-1')
    expect(stored?.entries.length).toBe(transcript.MAX_ENTRIES)
    expect(stored?.truncated).toBe(true)
    // The tail is what matters when diagnosing a stuck run.
    const last = stored?.entries[stored.entries.length - 1]
    expect(last?.kind === 'phase' && last.text).toBe(`step ${transcript.MAX_ENTRIES + 19}`)
  })

  it('clips an enormous tool result rather than storing it whole', async () => {
    await transcript.beginTranscript('run-1', 'case')
    await transcript.appendEntry('run-1', {
      kind: 'tool',
      name: 'snapshot',
      args: '',
      result: 'y'.repeat(50_000),
      ok: true,
      durationMs: 1,
      round: 1,
    })
    const stored = await transcript.getTranscript('run-1')
    const entry = stored?.entries[0]
    if (entry?.kind !== 'tool') throw new Error('expected a tool entry')
    expect(entry.result.length).toBeLessThan(transcript.MAX_TEXT + 100)
  })

  it('lives in session storage, not permanent storage', async () => {
    const fake = installChromeFake()
    vi.resetModules()
    const fresh = await import('../src/background/transcript')
    await fresh.beginTranscript('run-1', 'case')
    await fresh.appendEntry('run-1', { kind: 'phase', text: 'hello' })

    // A transcript is scaffolding for a run in progress. Writing it to `local` would
    // accumulate permanently and compete with the run history for quota.
    const local = await fake.storage.get(null)
    expect(JSON.stringify(local)).not.toContain('hello')
    const session = await fake.session.get(null)
    expect(JSON.stringify(session)).toContain('hello')
  })

  it('marks a transcript finished so a reopened panel stops showing a spinner', async () => {
    await transcript.beginTranscript('run-1', 'case')
    expect((await transcript.getTranscript('run-1'))?.running).toBe(true)
    await transcript.endTranscript('run-1', 'passed')
    const stored = await transcript.getTranscript('run-1')
    expect(stored?.running).toBe(false)
    expect(stored?.status).toBe('passed')
  })

  it('closes transcripts orphaned by an evicted worker', async () => {
    await transcript.beginTranscript('run-live', 'a')
    await transcript.beginTranscript('run-dead', 'b')
    // After eviction the in-memory `active` map is empty, so every `running`
    // transcript is stale. Left alone they would spin for ever.
    await transcript.reconcileTranscripts(['run-live'])

    expect((await transcript.getTranscript('run-live'))?.running).toBe(true)
    const dead = await transcript.getTranscript('run-dead')
    expect(dead?.running).toBe(false)
    expect(dead?.status).toBe('interrupted')
  })

  it('drops a deleted run’s transcript', async () => {
    await transcript.beginTranscript('run-1', 'case')
    await transcript.deleteTranscript('run-1')
    expect(await transcript.getTranscript('run-1')).toBeUndefined()
  })

  it('ignores appends for a run that has no transcript', async () => {
    // The observer fires for scheduled and bridge runs too; a missing transcript
    // must never throw into a run.
    await expect(
      transcript.appendEntry('never-started', { kind: 'phase', text: 'x' }),
    ).resolves.toBeUndefined()
  })
})

describe('the panel transcript survives a tab switch', () => {
  it('keeps entries in a store that outlives the component', () => {
    store.addEntry({ kind: 'user', text: '打开登录页' })
    // Unmounting the Chat tab drops its subscription but must not drop the content;
    // this is the bug where switching tabs emptied the panel.
    expect(store.getChatEntries()).toHaveLength(1)
    expect(store.getChatEntries()[0]).toMatchObject({ kind: 'user', text: '打开登录页' })
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const seen: number[] = []
    const unsubscribe = store.subscribeChat((entries) => seen.push(entries.length))
    store.addEntry({ kind: 'user', text: 'a' })
    unsubscribe()
    store.addEntry({ kind: 'user', text: 'b' })
    expect(seen).toEqual([1])
  })

  it('refills what arrived while unmounted, without duplicating live entries', () => {
    // Live: one tool call seen while the tab was open.
    store.applyToolCall('run-1', 1, {
      name: 'click',
      args: 'ref=e1',
      result: 'ok',
      ok: true,
      durationMs: 10,
      round: 1,
    })
    expect(store.getChatEntries()).toHaveLength(1)

    // The worker's version holds that same call plus one the panel missed.
    store.mergeTranscript({
      runId: 'run-1',
      caseName: 'case',
      running: true,
      startedAt: 1,
      entries: [
        {
          kind: 'tool',
          seq: 1,
          at: 10,
          name: 'click',
          args: 'ref=e1',
          result: 'ok',
          ok: true,
          durationMs: 10,
          round: 1,
        },
        {
          kind: 'tool',
          seq: 2,
          at: 20,
          name: 'fill',
          args: 'ref=e2',
          result: 'ok',
          ok: true,
          durationMs: 12,
          round: 1,
        },
      ],
    })

    // Two, not three: identity is `runId` + `seq`, so the replayed call updates the
    // entry the panel already had instead of appending a duplicate.
    expect(store.getChatEntries()).toHaveLength(2)
  })

  it('is idempotent when the same transcript is merged twice', () => {
    const payload = {
      runId: 'run-1',
      caseName: 'case',
      running: false as const,
      startedAt: 1,
      entries: [{ kind: 'phase' as const, seq: 1, at: 5, text: '正在调用模型（第 1/24 轮）…' }],
    }
    store.mergeTranscript(payload)
    store.mergeTranscript(payload)
    // Remounting the tab repeatedly must not multiply history.
    expect(store.getChatEntries()).toHaveLength(1)
  })

  it('assigns streamed text rather than concatenating it', () => {
    // The event carries the accumulated text, so a duplicate delivery is harmless.
    store.applyAssistantText('run-1', 1, 'Opening')
    store.applyAssistantText('run-1', 1, 'Opening the page')
    store.applyAssistantText('run-1', 1, 'Opening the page')
    expect(store.getChatEntries()).toHaveLength(1)
    expect(store.getChatEntries()[0]).toMatchObject({ text: 'Opening the page' })
  })

  it('interleaves replayed entries with locally authored ones by time', () => {
    store.addEntry({ kind: 'user', text: 'first', at: 100 })
    store.mergeTranscript({
      runId: 'run-1',
      caseName: 'case',
      running: false,
      startedAt: 1,
      entries: [{ kind: 'phase', seq: 1, at: 50, text: 'earlier' }],
    })
    // The replayed line happened before the user's message and must read that way,
    // rather than all replayed content landing at the end.
    expect(store.getChatEntries().map((entry) => entry.at)).toEqual([50, 100])
  })

  it('treats a recovered run as a success in the transcript', () => {
    store.applyStatus('run-1', 1, 'recovered', '脚本已失效，智能体接管后通过')
    // `recovered` means the application behaved; it is the script that is stale.
    // Colouring it as an error would train people to ignore the tone.
    expect(store.getChatEntries()[0]).toMatchObject({ kind: 'system', tone: 'info' })
  })

  it('reports a cancelled run without dressing it up as a pass', () => {
    store.applyStatus('run-1', 1, 'cancelled')
    expect(store.getChatEntries()[0]).toMatchObject({ tone: 'error' })
  })

  it('records a terminal status even when no transcript existed', () => {
    // A run that fails before it starts has no transcript and therefore no `seq`;
    // the message still has to reach the user.
    store.applyStatus('run-1', undefined, 'error', '站点不在白名单里')
    expect(store.getChatEntries()).toHaveLength(1)
    expect(store.getChatEntries()[0]).toMatchObject({ kind: 'system', tone: 'error' })
  })
})

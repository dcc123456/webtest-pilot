/**
 * The live commentary of an agent run, owned by the worker.
 *
 * This module exists to fix a specific class of bug: the side panel unmounts a
 * tab's component when the user switches tabs, so anything kept in React state
 * disappears — and the events that arrive while it is unmounted are lost for good.
 * A user who started a run, glanced at the Cases tab and came back found an empty
 * transcript and no way to tell whether the agent was still working.
 *
 * The rule this establishes: **the worker owns the run, so the worker owns the
 * story of the run.** Live events are still pushed for immediacy, but they are a
 * fast path, not the source of truth. The panel can always redraw from
 * {@link getTranscript}.
 *
 * Two deliberate storage choices:
 *
 * - **`storage.session`, not `storage.local`.** A transcript is scaffolding for a
 *   run in progress, not user data. `session` is cleared when the browser closes,
 *   which is exactly the lifetime we want, and it survives the MV3 worker eviction
 *   that `local` would also survive — without leaving permanent debris behind. The
 *   durable record of a run is `TestRun` in `local`; this is the commentary.
 * - **Capped per run, oldest dropped.** A long agent run can emit thousands of
 *   deltas. An unbounded transcript would eventually blow the quota and take the
 *   write that mattered down with it.
 *
 * @module background/transcript
 */

import type { RunStatus, RunTranscript, TranscriptEntry } from '../lib/types'

/** One key per run, so writing one transcript never rewrites another. */
const KEY_PREFIX = 'transcript:'

/**
 * Entries kept per run.
 *
 * Chosen to cover a full `maxToolRounds` run with room for streamed text, while
 * staying far below the `session` quota. When it is exceeded the *oldest* entries
 * go: the interesting part of a stuck run is what it is doing now.
 */
export const MAX_ENTRIES = 400

/**
 * Longest text kept for one entry.
 *
 * A snapshot result can be tens of kilobytes; storing it whole would let a handful
 * of entries dominate the quota. The panel only renders a summary line plus an
 * expandable detail, so more than this is never seen.
 */
export const MAX_TEXT = 2_000

/** Serialized transcripts, keyed by run id, as held in `storage.session`. */
type Stored = Record<string, RunTranscript>

/**
 * Serializes every mutation, mirroring `lib/storage`.
 *
 * Not optional here. The observer calls these appenders fire-and-forget (`void
 * appendEntry(...)`) from a run that emits streamed text and tool results in bursts,
 * and each one is a read-modify-write against a single key. Unqueued, two appends
 * that overlap both read the same array and the second write silently discards the
 * first entry — losing exactly the commentary this module exists to preserve.
 */
let writeQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(body: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(body, body)
  // One failed write must not poison the chain; the caller still sees its own error.
  writeQueue = next.catch(() => undefined)
  return next
}

function keyFor(runId: string): string {
  return `${KEY_PREFIX}${runId}`
}

/**
 * The session area, or `undefined` where it does not exist.
 *
 * `storage.session` needs Chrome 102+, and the test fake historically provided only
 * `local`. Treating it as optional keeps the transcript a best-effort nicety: losing
 * it must never break a run, because the run's real result lives elsewhere.
 */
function sessionArea(): chrome.storage.StorageArea | undefined {
  const storage = (globalThis as { chrome?: { storage?: Record<string, unknown> } }).chrome?.storage
  return storage?.session as chrome.storage.StorageArea | undefined
}

function clip(text: string, limit = MAX_TEXT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…（已截断 / truncated）`
}

/** Reads one run's transcript, or `undefined` when there is none. */
export async function getTranscript(runId: string): Promise<RunTranscript | undefined> {
  const area = sessionArea()
  if (!area) return undefined
  try {
    const key = keyFor(runId)
    const data = (await area.get(key)) as Stored
    return data[key]
  } catch {
    // A read failure is not worth failing a run over; the panel simply shows less.
    return undefined
  }
}

/** Reads every transcript, newest run first. */
export async function listTranscripts(): Promise<RunTranscript[]> {
  const area = sessionArea()
  if (!area) return []
  try {
    const data = (await area.get(null)) as Stored
    return Object.entries(data)
      .filter(([key]) => key.startsWith(KEY_PREFIX))
      .map(([, value]) => value)
      .filter((value): value is RunTranscript => Boolean(value?.runId))
      .sort((a, b) => b.startedAt - a.startedAt)
  } catch {
    return []
  }
}

async function write(transcript: RunTranscript): Promise<void> {
  const area = sessionArea()
  if (!area) return
  try {
    await area.set({ [keyFor(transcript.runId)]: transcript })
  } catch {
    // Quota or a dead worker: the run continues regardless.
  }
}

/** Starts a transcript, replacing any earlier one for the same run id. */
export async function beginTranscript(runId: string, caseName: string): Promise<void> {
  await enqueue(() =>
    write({
      runId,
      caseName,
      entries: [],
      running: true,
      startedAt: Date.now(),
    }),
  )
}

/**
 * An entry as callers supply it: the store assigns `seq` and `at`.
 *
 * Distributed over the union rather than written as `Omit<TranscriptEntry, …>`,
 * because `Omit` on a union collapses it into one object type with the *shared*
 * keys only — which silently rejects `text` and `name` and would push callers
 * toward casts.
 */
export type NewEntry = TranscriptEntry extends infer T
  ? T extends { seq: number; at: number }
    ? Omit<T, 'seq' | 'at'> & { at?: number }
    : never
  : never

/**
 * Appends an entry and returns it with its assigned sequence number.
 *
 * Read-modify-write, like the rest of the extension's storage: `storage.session`
 * has no transactions either. Runs are serialized in practice, and a lost line of
 * commentary is not worth a lock.
 */
export async function appendEntry(
  runId: string,
  entry: NewEntry,
): Promise<TranscriptEntry | undefined> {
  const area = sessionArea()
  if (!area) return undefined
  return enqueue(async () => {
    const existing = await getTranscript(runId)
    if (!existing) return undefined

    const seq = (existing.entries[existing.entries.length - 1]?.seq ?? 0) + 1
    const full = { ...entry, seq, at: entry.at ?? Date.now() } as TranscriptEntry
    const next = clipEntry(full)

    const entries = [...existing.entries, next]
    const truncated = entries.length > MAX_ENTRIES
    await write({
      ...existing,
      entries: truncated ? entries.slice(entries.length - MAX_ENTRIES) : entries,
      ...(truncated ? { truncated: true } : {}),
    })
    return next
  })
}

/** Applies the per-entry text caps. */
function clipEntry(entry: TranscriptEntry): TranscriptEntry {
  switch (entry.kind) {
    case 'assistant':
      return { ...entry, text: clip(entry.text) }
    case 'tool':
      return { ...entry, args: clip(entry.args, 400), result: clip(entry.result) }
    case 'phase':
      return { ...entry, text: clip(entry.text, 200) }
    case 'status':
      return entry.message ? { ...entry, message: clip(entry.message, 400) } : entry
  }
}

/**
 * Merges streamed text into the trailing assistant entry.
 *
 * One entry per token would blow the cap within a single round and turn the
 * transcript into confetti. Appending to the tail — but only when the tail is
 * still assistant text — keeps the agent's reasoning in order relative to its
 * actions, which is the whole point of showing it.
 */
export async function appendAssistantDelta(
  runId: string,
  delta: string,
): Promise<TranscriptEntry | undefined> {
  const area = sessionArea()
  if (!area) return undefined
  const merged = await enqueue(async () => {
    const existing = await getTranscript(runId)
    if (!existing) return undefined
    const last = existing.entries[existing.entries.length - 1]
    if (last?.kind !== 'assistant') return undefined

    const next: TranscriptEntry = { ...last, text: clip(last.text + delta) }
    await write({
      ...existing,
      entries: existing.entries.with(existing.entries.length - 1, next),
    })
    return next
  })
  if (merged) return merged
  // The tail was not assistant text (or there is no transcript): start a new bubble.
  // Queued separately, which is safe because the queue preserves arrival order.
  return appendEntry(runId, { kind: 'assistant', text: delta })
}

/** Marks a transcript finished, so a reopened panel stops showing it as live. */
export async function endTranscript(runId: string, status: RunStatus): Promise<void> {
  await enqueue(async () => {
    const existing = await getTranscript(runId)
    if (!existing) return
    await write({ ...existing, running: false, status })
  })
}

/** Drops one run's transcript, e.g. when its run is deleted. */
export async function deleteTranscript(runId: string): Promise<void> {
  const area = sessionArea()
  if (!area) return
  try {
    await area.remove(keyFor(runId))
  } catch {
    /* nothing to do */
  }
}

/** Drops every transcript, e.g. when run history is cleared. */
export async function clearTranscripts(): Promise<void> {
  const area = sessionArea()
  if (!area) return
  try {
    const data = (await area.get(null)) as Stored
    const keys = Object.keys(data).filter((key) => key.startsWith(KEY_PREFIX))
    if (keys.length > 0) await area.remove(keys)
  } catch {
    /* nothing to do */
  }
}

/**
 * Marks stale `running` transcripts as interrupted.
 *
 * Called on worker startup for the same reason `reconcileRuns` exists: a transcript
 * left `running` by a crashed worker would show a spinner for ever, and a user
 * staring at a live-looking run that is actually dead is worse than no transcript.
 */
export async function reconcileTranscripts(liveRunIds: string[]): Promise<void> {
  const all = await listTranscripts()
  const live = new Set(liveRunIds)
  for (const transcript of all) {
    if (transcript.running && !live.has(transcript.runId)) {
      await write({ ...transcript, running: false, status: 'interrupted' })
    }
  }
}

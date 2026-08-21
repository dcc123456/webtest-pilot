/**
 * The Chat tab's transcript, held outside React.
 *
 * The bug this fixes: `App.tsx` renders the Chat tab as `{tab === 'chat' ? <ChatTab/>
 * : null}`, so switching to Cases or Scripts *unmounts* it. With the transcript in
 * `useState`, coming back showed an empty panel — and every event that arrived while
 * the tab was away had been delivered to a dead listener and lost.
 *
 * There are two kinds of content here, with different owners:
 *
 * - **Panel-authored** — what the user typed, the parse result, which runs were
 *   started from this tab. The worker knows nothing about these, so they live here.
 *   A module-level store outlives any component, which is exactly the lifetime we
 *   want: it survives a tab switch and dies when the panel closes.
 * - **Run commentary** — the agent's prose and tool calls. The *worker* owns these
 *   (see `background/transcript`), so they are merged in by `runId` + `seq`. That
 *   makes replaying a fetched transcript idempotent: re-entering the tab refills
 *   whatever was missed without duplicating what live events already delivered.
 *
 * @module panel/chatStore
 */

import type { RunStatus, RunTranscript } from '../lib/types'

/** One rendered line. A discriminated union so rendering cannot mix them up. */
export type Entry =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'assistant'; id: string; at: number; runId: string; text: string }
  | {
      kind: 'tool'
      id: string
      at: number
      runId: string
      name: string
      /** Redacted arguments — never a secret value. */
      args: string
      result: string
      ok: boolean
      durationMs: number
      round: number
    }
  | { kind: 'phase'; id: string; at: number; runId: string; text: string }
  | { kind: 'system'; id: string; at: number; text: string; tone: 'info' | 'error' }
  | { kind: 'cases'; id: string; at: number; caseIds: string[] }
  | { kind: 'run'; id: string; at: number; runId: string }

type Listener = (entries: Entry[]) => void

let entries: Entry[] = []
const listeners = new Set<Listener>()

/**
 * Counter for panel-authored ids.
 *
 * Worker-owned entries derive their id from `runId` + `seq` instead, which is what
 * makes a replay collision-free — a counter would mint a fresh id for an entry the
 * store already holds and render it twice.
 */
let seq = 0

function emit(): void {
  const snapshot = entries
  for (const listener of listeners) listener(snapshot)
}

/** Subscribes to the transcript. Returns an unsubscribe function. */
export function subscribeChat(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Current transcript, newest last. */
export function getChatEntries(): Entry[] {
  return entries
}

/**
 * A panel-authored entry before the store assigns its id and timestamp.
 *
 * Distributed over the union, because `Omit` applied to a union collapses it to the
 * shared keys only — which would reject `text`, `caseIds` and `runId` and push
 * callers toward casts.
 */
export type NewChatEntry = Entry extends infer T
  ? T extends { id: string; at: number }
    ? Omit<T, 'id' | 'at'> & { at?: number }
    : never
  : never

/** Appends a panel-authored entry. */
export function addEntry(entry: NewChatEntry): void {
  seq += 1
  entries = [...entries, { ...entry, id: `p${seq}`, at: entry.at ?? Date.now() } as Entry]
  emit()
}

/** Stable id for a worker-owned entry, so live events and replays coincide. */
export function workerId(runId: string, entrySeq: number): string {
  return `${runId}#${entrySeq}`
}

/**
 * Inserts or updates a worker-owned entry, keeping the transcript in time order.
 *
 * Upsert rather than append because streamed assistant text arrives as a growing
 * entry under one `seq`: the worker merges deltas into the same bubble, and the
 * panel has to follow suit rather than stack fragments.
 */
function upsert(entry: Entry): void {
  const index = entries.findIndex((existing) => existing.id === entry.id)
  if (index >= 0) {
    entries = entries.with(index, entry)
  } else {
    entries = [...entries, entry]
  }
  emit()
}

/**
 * Records streamed assistant text.
 *
 * Takes the accumulated `text` and the worker's `seq`, so this is an assignment
 * keyed by a stable id — not a concatenation. That makes a duplicate delivery
 * harmless, where `text += delta` would silently double a word.
 */
export function applyAssistantText(
  runId: string,
  entrySeq: number,
  text: string,
  at = Date.now(),
): void {
  upsert({ kind: 'assistant', id: workerId(runId, entrySeq), at, runId, text })
}

/** Records a completed tool call. */
export function applyToolCall(
  runId: string,
  entrySeq: number,
  report: Omit<Extract<Entry, { kind: 'tool' }>, 'id' | 'at' | 'kind' | 'runId'>,
  at = Date.now(),
): void {
  upsert({ ...report, kind: 'tool', id: workerId(runId, entrySeq), at, runId })
}

/** Records a coarse progress line. */
export function applyPhase(runId: string, entrySeq: number, text: string, at = Date.now()): void {
  upsert({ kind: 'phase', id: workerId(runId, entrySeq), at, runId, text })
}

/** Records a terminal run status. */
export function applyStatus(
  runId: string,
  entrySeq: number | undefined,
  status: RunStatus,
  message?: string,
): void {
  const text = message ? `运行结束：${status} — ${message}` : `运行结束：${status}`
  const entry = { kind: 'system', at: Date.now(), tone: terminalTone(status), text } as const
  if (entrySeq === undefined) {
    // No transcript existed (a run that failed before it started): keep it local.
    seq += 1
    entries = [...entries, { ...entry, id: `p${seq}` }]
    emit()
    return
  }
  upsert({ ...entry, id: workerId(runId, entrySeq) })
}

/**
 * Merges a worker transcript into the store.
 *
 * Called when the Chat tab mounts, which is how a tab switch stops losing history:
 * anything the worker recorded while no listener existed is filled in here. Entries
 * already present — by `runId` + `seq` — are updated in place rather than appended,
 * so calling this repeatedly is safe.
 */
export function mergeTranscript(transcript: RunTranscript): void {
  const next = [...entries]

  for (const item of transcript.entries) {
    const id = workerId(transcript.runId, item.seq)
    let entry: Entry
    switch (item.kind) {
      case 'assistant':
        entry = { kind: 'assistant', id, at: item.at, runId: transcript.runId, text: item.text }
        break
      case 'tool':
        entry = {
          kind: 'tool',
          id,
          at: item.at,
          runId: transcript.runId,
          name: item.name,
          args: item.args,
          result: item.result,
          ok: item.ok,
          durationMs: item.durationMs,
          round: item.round,
        }
        break
      case 'phase':
        entry = { kind: 'phase', id, at: item.at, runId: transcript.runId, text: item.text }
        break
      case 'status':
        entry = {
          kind: 'system',
          id,
          at: item.at,
          tone: terminalTone(item.status),
          text: item.message
            ? `运行结束：${item.status} — ${item.message}`
            : `运行结束：${item.status}`,
        }
        break
    }

    const index = next.findIndex((existing) => existing.id === id)
    if (index >= 0) next[index] = entry
    else next.push(entry)
  }

  // Sorted by timestamp so replayed entries interleave correctly with whatever the
  // panel authored locally, rather than all landing at the end.
  entries = next.sort((a, b) => a.at - b.at)
  emit()
}

function terminalTone(status: RunStatus): 'info' | 'error' {
  return status === 'passed' || status === 'recovered' ? 'info' : 'error'
}

/** Clears everything, for the panel's "clear transcript" affordance. */
export function clearChat(): void {
  entries = []
  emit()
}

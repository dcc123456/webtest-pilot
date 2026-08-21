/**
 * Worker-side state for the open-ended conversation.
 *
 * Held here rather than in a component because the panel unmounts on tab switch;
 * an in-flight turn must survive that, and the pending-approval promise needs a
 * stable resolver the UI can call into by id. Everything here lives only for the
 * service worker's lifetime — a worker eviction clears the conversation, which is
 * acceptable for an ad-hoc chat (unlike test runs, which are durably recorded).
 *
 * @module background/conversation
 */

import type { ConfirmMode, ScriptStep, Skill } from '../lib/types'
import type { WireMessage } from '../lib/llm'
import type { ConversationEntry, ConversationTranscript, WorkerEvent } from '../lib/messages'
import type { ToolEvent } from './converse'

/** Session storage key for the display transcript. */
const SESSION_KEY = 'wtp.conversation'

/** One pending tool call awaiting the user's decision. */
export interface PendingDecision {
  id: string
  name: string
  args: string
  mutating: boolean
  resolve: (approved: boolean) => void
}

class ConversationState {
  running = false
  /** Wire history for the model. Tool results and assistant turns accumulate. */
  history: WireMessage[] = []
  /** Pending approval currently awaiting a decision, if any. */
  pending: PendingDecision | null = null
  abort: AbortController | null = null
  /** Steps recorded during the most recent completed turn, for save-as-script. */
  lastSteps: ScriptStep[] = []
  confirmMode: ConfirmMode = 'write'
  activeSkill: Skill | null = null
  /**
   * Display transcript shown in the panel. Persisted to `chrome.storage.session`
   * so it survives the component unmounting on tab switch and the service worker
   * being evicted mid-conversation. A stable, monotonic id keeps entries
   * identifiable across restore and live updates.
   */
  entries: ConversationEntry[] = []
  entryCounter = 0

  reset(): void {
    this.history = []
    this.pending = null
    this.lastSteps = []
    this.entries = []
    this.running = false
    this.abort = null
    void persist({ entries: [], lastSteps: [] })
  }

  nextEntryId(): string {
    this.entryCounter += 1
    return `ce${this.entryCounter}`
  }

  /**
   * Applies a transcript update and schedules a debounced session write.
   *
   * The write is fire-and-forget: the in-memory copy is what the live turn
   * reads, and session storage is only the durable mirror for a later restore.
   */
  setEntries(updater: (current: ConversationEntry[]) => ConversationEntry[]): void {
    this.entries = updater(this.entries)
    void schedulePersist({ entries: this.entries, lastSteps: this.lastSteps })
  }

  setLastSteps(steps: ScriptStep[]): void {
    this.lastSteps = steps
    void schedulePersist({ entries: this.entries, lastSteps: this.lastSteps })
  }
}

export const conversation = new ConversationState()

let persistTimer: ReturnType<typeof setTimeout> | undefined

/** Coalesces rapid per-token writes so a streaming turn does not thrash storage. */
function schedulePersist(transcript: ConversationTranscript): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void persist(transcript)
  }, 120)
}

async function persist(transcript: ConversationTranscript): Promise<void> {
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: transcript })
  } catch {
    // Session storage can be unavailable (e.g. an unexpected worker state); the
    // in-memory transcript still works for the current session.
  }
}

/**
 * Loads the persisted transcript back into the state. Called once at worker
 * startup and on the panel's first request so a restored tab sees the history.
 */
export async function restoreConversation(): Promise<ConversationTranscript> {
  let stored: ConversationTranscript | undefined
  try {
    const bag = await chrome.storage.session.get(SESSION_KEY)
    stored = bag[SESSION_KEY] as ConversationTranscript | undefined
  } catch {
    stored = undefined
  }
  if (stored && Array.isArray(stored.entries)) {
    conversation.entries = stored.entries.map((entry) =>
      // A pending approval cannot survive a worker restart: its resolver is gone.
      // Drop it and mark no entry as streaming so the panel does not wait.
      entry.kind === 'pending'
        ? { id: entry.id, kind: 'status', text: `（操作已失效：${entry.name}）`, at: entry.at }
        : entry.kind === 'assistant'
          ? { ...entry, streaming: false }
          : entry,
    )
    conversation.lastSteps = Array.isArray(stored.lastSteps) ? stored.lastSteps : []
    // Re-seed the id counter past the largest numeric suffix so new entries do
    // not collide with restored ones.
    let maxId = 0
    for (const entry of conversation.entries) {
      const match = /^ce(\d+)$/.exec(entry.id)
      if (match) maxId = Math.max(maxId, Number(match[1]))
    }
    conversation.entryCounter = maxId
  }
  return { entries: conversation.entries, lastSteps: conversation.lastSteps }
}

/**
 * The subset of {@link WorkerEvent} this module emits. Reused as the parameter
 * type for {@link applyConversationEvent} so a caller can pass any conv* event
 * without the type narrowing collapsing to `never`.
 */
export type ConversationEvent = Extract<
  WorkerEvent,
  { type: `conv${string}` }
>

/** Broadcast helper type — the worker passes its own sender in. */
export type ConversationBroadcast = (event: ConversationEvent) => void

/** Maps a converse ToolEvent into the broadcast shape and stamps the time. */
export function toolEventToBroadcast(
  event: ToolEvent,
  at: number,
): Extract<Parameters<ConversationBroadcast>[0], { type: 'convTool' }> {
  return {
    type: 'convTool',
    id: event.id,
    name: event.name,
    args: event.argsSummary,
    result: event.resultPreview,
    ok: event.ok,
    durationMs: event.durationMs,
    ...(event.declined ? { declined: true } : {}),
    at,
  }
}

/**
 * Applies one conversation event to the persisted transcript and returns the
 * display entry to broadcast (if any).
 *
 * Centralising the mutation here is what makes the panel's view and the stored
 * mirror identical: callers only emit events, and every event funnels through
 * the same id assignment and entry replacement logic. `convAssistant` carries
 * the *full* accumulated text rather than a delta, so it can assign rather than
 * append.
 */
export function applyConversationEvent(
  event: Parameters<ConversationBroadcast>[0],
): ConversationEntry | null {
  switch (event.type) {
    case 'convUser': {
      const entry: ConversationEntry = {
        id: conversation.nextEntryId(),
        kind: 'user',
        text: event.text,
        at: event.at,
      }
      conversation.setEntries((current) => [...current, entry])
      return entry
    }
    case 'convAssistant': {
      const existing = [...conversation.entries].reverse().find((e) => e.kind === 'assistant' && e.streaming)
      if (existing && existing.kind === 'assistant') {
        const updated: ConversationEntry = { ...existing, text: event.text, at: event.at }
        conversation.setEntries((current) =>
          current.map((e) => (e.id === existing.id ? updated : e)),
        )
        return updated
      }
      const entry: ConversationEntry = {
        id: conversation.nextEntryId(),
        kind: 'assistant',
        text: event.text,
        streaming: true,
        at: event.at,
      }
      conversation.setEntries((current) => [...current, entry])
      return entry
    }
    case 'convStatus':
      if (!event.text) return null
      {
        const entry: ConversationEntry = {
          id: conversation.nextEntryId(),
          kind: 'status',
          text: event.text,
          at: event.at,
        }
        conversation.setEntries((current) => [...current, entry])
        return entry
      }
    case 'convTool': {
      // A resolved tool call supersedes its pending approval card (matched on
      // name+args), so only one ever shows for a given action.
      const pending = [...conversation.entries]
        .reverse()
        .find((e) => e.kind === 'pending' && e.name === event.name && e.args === event.args)
      const entry: ConversationEntry = {
        id: conversation.nextEntryId(),
        kind: 'tool',
        name: event.name,
        args: event.args,
        result: event.result,
        ok: event.ok,
        ...(event.declined ? { declined: true } : {}),
        durationMs: event.durationMs,
        at: event.at,
      }
      conversation.setEntries((current) => {
        const without = pending ? current.filter((e) => e.id !== pending.id) : current
        return [...without, entry]
      })
      return entry
    }
    case 'convPending': {
      const entry: ConversationEntry = {
        id: conversation.nextEntryId(),
        kind: 'pending',
        pendingId: event.pendingId,
        name: event.name,
        args: event.args,
        mutating: event.mutating,
        at: event.at,
      }
      conversation.setEntries((current) => [...current, entry])
      return entry
    }
    case 'convDone':
      conversation.setLastSteps(event.steps)
      conversation.setEntries((current) =>
        current.map((e) => (e.kind === 'assistant' && e.streaming ? { ...e, streaming: false } : e)),
      )
      return null
    case 'convCleared':
      conversation.reset()
      return null
    default:
      return null
  }
}

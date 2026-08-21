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
import type { ToolEvent } from './converse'

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

  reset(): void {
    this.history = []
    this.pending = null
    this.lastSteps = []
    this.running = false
    this.abort = null
  }
}

export const conversation = new ConversationState()

/** Broadcast helper type — the worker passes its own sender in. */
export type ConversationBroadcast = (
  event:
    | { type: 'convUser'; text: string; at: number }
    | { type: 'convAssistant'; text: string; at: number }
    | { type: 'convStatus'; text: string; at: number }
    | {
        type: 'convTool'
        id: string
        name: string
        args: string
        result: string
        ok: boolean
        durationMs: number
        declined?: boolean
        at: number
      }
    | {
        type: 'convPending'
        pendingId: string
        name: string
        args: string
        mutating: boolean
        at: number
      }
    | { type: 'convDone'; steps: ScriptStep[]; summary?: string; at: number }
    | { type: 'convCleared' },
) => void

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

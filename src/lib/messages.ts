/**
 * Messages between the side panel and the service worker.
 *
 * Typed as a discriminated union so a handler cannot silently ignore a new
 * message kind: adding one to the union makes the switch in the worker fail to
 * compile until it is handled.
 *
 * All panel state comes from the worker rather than being read from
 * `chrome.storage` directly, so there is one place that enforces invariants —
 * the panel cannot, for example, save a schedule without the worker recomputing
 * its next fire time.
 *
 * @module lib/messages
 */

import type { ArtifactMeta } from './artifacts'
import type { ProviderProfile } from './providers'
import type {
  CaseSource,
  ConfirmMode,
  LogEntry,
  RunStatus,
  RunTranscript,
  ScheduleEntry,
  SecretEntry,
  Settings,
  Skill,
  ScriptStep,
  StepRecord,
  TestCase,
  TestRun,
  TestScript,
} from './types'

/** Panel → worker. */
export type PanelRequest =
  | { type: 'getState' }
  | { type: 'runCase'; caseId: string; useAgent?: boolean }
  | { type: 'runScript'; scriptId: string }
  | { type: 'cancelRun'; runId: string }
  /**
   * Fetches one run's live commentary.
   *
   * The panel calls this on mount rather than relying only on live events, because
   * switching tabs unmounts the Chat tab and the events that arrived meanwhile are
   * gone. The worker keeps the transcript, so the panel can always redraw.
   */
  | { type: 'getTranscript'; runId: string }
  /** Fetches every transcript, so a reopened panel can restore its history. */
  | { type: 'getTranscripts' }
  | { type: 'importMarkdown'; markdown: string; source: CaseSource }
  | { type: 'saveCase'; testCase: TestCase }
  | { type: 'deleteCase'; caseId: string; withScripts?: boolean }
  | { type: 'saveScript'; script: TestScript }
  | { type: 'deleteScript'; scriptId: string }
  | { type: 'exportScript'; scriptId: string; format: 'json' | 'playwright' | 'markdown' }
  /** Builds a downloadable script file. Empty `scriptIds` means every script. */
  | { type: 'exportScriptBundle'; scriptIds: string[] }
  /** Reads a downloaded script file, always creating new scripts rather than overwriting. */
  | { type: 'importScriptBundle'; json: string }
  | { type: 'deleteRun'; runId: string }
  | { type: 'clearRuns' }
  | { type: 'getRunArtifacts'; runId: string }
  | { type: 'getArtifact'; artifactId: string }
  | { type: 'saveSchedule'; entry: ScheduleEntry }
  | { type: 'deleteSchedule'; scheduleId: string }
  | { type: 'toggleSchedule'; scheduleId: string; enabled: boolean }
  | { type: 'saveSettings'; patch: Partial<Settings> }
  | { type: 'testProvider'; profile: ProviderProfile }
  | { type: 'listModels'; profile: ProviderProfile }
  | { type: 'saveSecret'; entry: SecretEntry }
  | { type: 'deleteSecret'; name: string }
  | { type: 'testFeishu' }
  | { type: 'connectBridge' }
  | { type: 'disconnectBridge' }
  | { type: 'exportAll' }
  | { type: 'importAll'; json: string }
  | { type: 'clearLogs' }
  | { type: 'getStorageUsage' }
  // --- Open-ended conversation -------------------------------------------
  | { type: 'converse'; message: string; skillId?: string | null; confirmMode?: ConfirmMode }
  | { type: 'getConversation' }
  | { type: 'cancelConversation' }
  | { type: 'approveAction'; pendingId: string; approved: boolean }
  | { type: 'clearConversation' }
  | { type: 'listSkills' }
  | { type: 'saveSkill'; skill: Skill }
  | { type: 'deleteSkill'; skillId: string }
  /** Saves selected recorded steps from the last conversation turn as a script. */
  | {
      type: 'saveConversationScript'
      name: string
      startUrl: string
      /** Indices into the last turn's recorded steps; empty means all. */
      indices?: number[]
    }

/** Everything the panel renders, fetched in one round trip. */
export interface PanelState {
  cases: TestCase[]
  scripts: TestScript[]
  runs: TestRun[]
  schedules: ScheduleEntry[]
  settings: Settings
  /** Names only: values never leave the worker. */
  secretNames: string[]
  /** Skills available to the conversation, names and instructions only. */
  skills: Skill[]
  logs: LogEntry[]
  bridge: { connected: boolean; url: string; lastError?: string }
  /** Runs currently executing, so the panel can show a stop button. */
  activeRunIds: string[]
  /** True while the open-ended conversation agent is running. */
  conversationActive: boolean
}

/**
 * A persisted line in the open-ended conversation transcript.
 *
 * This is the *display* transcript (what the side panel renders), kept in
 * `chrome.storage.session` so it survives tab switches and worker eviction. It
 * is distinct from the model's wire history, which the worker also keeps but
 * never sends to the panel. Tool results are stored as a preview string, not the
 * full (possibly large) page text.
 */
export type ConversationEntry =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'assistant'; text: string; at: number; streaming?: boolean }
  | { id: string; kind: 'status'; text: string; at: number }
  | {
      id: string
      kind: 'tool'
      name: string
      args: string
      result: string
      ok: boolean
      declined?: boolean
      durationMs: number
      at: number
    }
  | {
      id: string
      kind: 'pending'
      pendingId: string
      name: string
      args: string
      mutating: boolean
      at: number
    }

export interface ConversationTranscript {
  entries: ConversationEntry[]
  /** Recorded steps from the most recent completed turn, for save-as-script. */
  lastSteps: ScriptStep[]
}

/** Worker → panel reply. Discriminated by the request that produced it. */
export type PanelResponse =
  | { ok: true; state: PanelState }
  | { ok: true; run: TestRun }
  | { ok: true; cases: TestCase[] }
  | { ok: true; script: TestScript }
  | { ok: true; artifacts: ArtifactMeta[] }
  | { ok: true; dataUrl: string }
  | { ok: true; text: string }
  | { ok: true; models: string[] }
  | { ok: true; usage: { storageBytes: number; artifactBytes: number; artifactCount: number } }
  | { ok: true; transcript: RunTranscript | null }
  | { ok: true; transcripts: RunTranscript[] }
  | { ok: true; conversation: ConversationTranscript }
  | { ok: true; message: string }
  | { ok: true }
  | { ok: false; error: string }

/**
 * Worker → panel, unsolicited. Sent while a run executes.
 *
 * The run events carry the transcript sequence number the worker assigned. That is
 * what lets the panel treat a live event and a later `getTranscript` replay as the
 * same entry: identity is `runId` + `seq`, so re-entering the Chat tab refills what
 * was missed without duplicating what already arrived.
 */
export type WorkerEvent =
  | { type: 'runUpdated'; run: TestRun }
  | { type: 'runStep'; runId: string; step: StepRecord }
  | { type: 'runStatus'; runId: string; status: RunStatus; message?: string; seq?: number }
  /**
   * Streamed assistant prose.
   *
   * Carries the bubble's full accumulated `text`, not just the new delta, so the
   * panel assigns rather than concatenates. Concatenating is fragile: one event
   * replayed or delivered twice silently doubles a word.
   */
  | { type: 'assistantText'; runId: string; delta: string; text: string; seq: number }
  | {
      type: 'toolCall'
      runId: string
      seq: number
      name: string
      /** Redacted arguments — never a secret value. */
      args: string
      result: string
      ok: boolean
      durationMs: number
      round: number
    }
  /**
   * Coarse progress for the long silent gaps.
   *
   * A model round or a page wait can run for tens of seconds emitting nothing else,
   * and a panel that shows nothing in that window looks hung.
   */
  | { type: 'runPhase'; runId: string; seq: number; text: string }
  | { type: 'stateChanged' }
  | { type: 'bridgeStatus'; connected: boolean; error?: string }
  | { type: 'log'; entry: LogEntry }
  // --- Open-ended conversation ------------------------------------------
  /** A user message was accepted and the turn started. */
  | { type: 'convUser'; text: string; at: number }
  /** Accumulated assistant text; `text` is the full bubble so far. */
  | { type: 'convAssistant'; text: string; at: number }
  /** A coarse status line ("正在思考…", "click …"). */
  | { type: 'convStatus'; text: string; at: number }
  /** A tool call happened (approved or auto-run). */
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
  /** A tool call is waiting for approve/decline. */
  | {
      type: 'convPending'
      pendingId: string
      name: string
      args: string
      mutating: boolean
      at: number
    }
  /** The turn finished. `steps` are recorded, for the save-as-script UI. */
  | { type: 'convDone'; steps: ScriptStep[]; summary?: string; at: number }
  | { type: 'convCleared'; at: number }

/**
 * Sends a request to the worker.
 *
 * Rejects with the worker's message rather than a generic failure, because the
 * panel shows these strings to the user directly — "no allow-listed sites" is
 * actionable, "message failed" is not.
 */
export async function sendToWorker(request: PanelRequest): Promise<PanelResponse> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as PanelResponse | undefined
    if (!response) {
      // An undefined reply means the worker threw before responding, or was
      // evicted mid-handler. Both look identical from here.
      return {
        ok: false,
        error: '后台没有响应。请关闭并重新打开侧边栏；如果仍然失败，请在 chrome://extensions 中重新加载插件。',
      }
    }
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

/** Narrows a response, throwing its error message for the caller to display. */
export function unwrap<T extends PanelResponse>(
  response: PanelResponse,
  predicate: (value: PanelResponse) => value is T,
): T {
  if (!response.ok) throw new Error(response.error)
  if (!predicate(response)) {
    throw new Error('后台返回了意料之外的响应类型。')
  }
  return response
}

/** Type guards for the response variants the panel consumes. */
export const is = {
  state: (value: PanelResponse): value is { ok: true; state: PanelState } =>
    value.ok && 'state' in value,
  run: (value: PanelResponse): value is { ok: true; run: TestRun } => value.ok && 'run' in value,
  cases: (value: PanelResponse): value is { ok: true; cases: TestCase[] } =>
    value.ok && 'cases' in value,
  script: (value: PanelResponse): value is { ok: true; script: TestScript } =>
    value.ok && 'script' in value,
  artifacts: (value: PanelResponse): value is { ok: true; artifacts: ArtifactMeta[] } =>
    value.ok && 'artifacts' in value,
  dataUrl: (value: PanelResponse): value is { ok: true; dataUrl: string } =>
    value.ok && 'dataUrl' in value,
  text: (value: PanelResponse): value is { ok: true; text: string } => value.ok && 'text' in value,
  models: (value: PanelResponse): value is { ok: true; models: string[] } =>
    value.ok && 'models' in value,
  usage: (
    value: PanelResponse,
  ): value is {
    ok: true
    usage: { storageBytes: number; artifactBytes: number; artifactCount: number }
  } => value.ok && 'usage' in value,
  transcript: (value: PanelResponse): value is { ok: true; transcript: RunTranscript | null } =>
    value.ok && 'transcript' in value,
  transcripts: (value: PanelResponse): value is { ok: true; transcripts: RunTranscript[] } =>
    value.ok && 'transcripts' in value,
  conversation: (
    value: PanelResponse,
  ): value is { ok: true; conversation: ConversationTranscript } =>
    value.ok && 'conversation' in value,
  message: (value: PanelResponse): value is { ok: true; message: string } =>
    value.ok && 'message' in value,
}

/** Broadcasts an event to any open panel, ignoring the case where none is open. */
export function broadcast(event: WorkerEvent): void {
  // `sendMessage` rejects when nothing is listening, which is the normal state
  // whenever the side panel is closed — a scheduled 3am run has no listener.
  // Swallowing it here keeps that from surfacing as an unhandled rejection.
  void chrome.runtime.sendMessage(event).catch(() => undefined)
}

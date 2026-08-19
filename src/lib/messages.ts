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
  LogEntry,
  RunStatus,
  ScheduleEntry,
  SecretEntry,
  Settings,
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
  | { type: 'importMarkdown'; markdown: string; source: CaseSource }
  | { type: 'saveCase'; testCase: TestCase }
  | { type: 'deleteCase'; caseId: string; withScripts?: boolean }
  | { type: 'saveScript'; script: TestScript }
  | { type: 'deleteScript'; scriptId: string }
  | { type: 'exportScript'; scriptId: string; format: 'json' | 'playwright' | 'markdown' }
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

/** Everything the panel renders, fetched in one round trip. */
export interface PanelState {
  cases: TestCase[]
  scripts: TestScript[]
  runs: TestRun[]
  schedules: ScheduleEntry[]
  settings: Settings
  /** Names only: values never leave the worker. */
  secretNames: string[]
  logs: LogEntry[]
  bridge: { connected: boolean; url: string; lastError?: string }
  /** Runs currently executing, so the panel can show a stop button. */
  activeRunIds: string[]
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
  | { ok: true; message: string }
  | { ok: true }
  | { ok: false; error: string }

/** Worker → panel, unsolicited. Sent while a run executes. */
export type WorkerEvent =
  | { type: 'runUpdated'; run: TestRun }
  | { type: 'runStep'; runId: string; step: StepRecord }
  | { type: 'runStatus'; runId: string; status: RunStatus; message?: string }
  | { type: 'assistantText'; runId: string; delta: string }
  | { type: 'toolCall'; runId: string; name: string; summary: string }
  | { type: 'stateChanged' }
  | { type: 'bridgeStatus'; connected: boolean; error?: string }
  | { type: 'log'; entry: LogEntry }

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

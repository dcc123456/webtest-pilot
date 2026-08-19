/**
 * Domain types.
 *
 * Four entities, deliberately separated:
 *
 * - {@link TestCase} — *intent*, in natural language. Authored by a human, in
 *   chat or Markdown. Cheap to write, needs a model to execute.
 * - {@link TestScript} — *mechanism*, a deterministic step list produced by
 *   recording a passing agent run. Replayable with no model and no token cost.
 * - {@link TestRun} — *evidence*, one execution with per-step records and
 *   screenshots.
 * - {@link ScheduleEntry} — *when*, a timer that starts a run unattended.
 *
 * A case and its script are kept separate rather than merged because they have
 * different lifetimes: the intent is edited by people, the script is regenerated
 * whenever the UI changes.
 *
 * @module lib/types
 */

import type { ActionName, AssertSpec, ExtractWhat, ExtractedValue, ScrollSpec } from './ops'
import type { ProviderProfile } from './providers'
import type { Target } from './selectors'

export type { ProviderProfile }

// --- Scripts -----------------------------------------------------------------

/** Current script format version, stamped on every saved script. */
export const SCRIPT_VERSION = 1

/**
 * One deterministic step.
 *
 * A step never stores a live element handle — only a {@link Target}, which is
 * re-resolved on every replay. That is the whole reason a recorded script keeps
 * working after the page is re-rendered.
 */
export interface ScriptStep {
  action: ActionName
  target?: Target
  /** Literal value to type, select, or press. Mutually exclusive with `secretRef`. */
  value?: string | string[] | boolean
  /**
   * Name of a secret in Settings, substituted for `value` at run time.
   *
   * Passwords must not be written into a script that gets committed to a repo or
   * shown to a model, so the recorder stores a reference and the worker resolves
   * it just before injection.
   */
  secretRef?: string
  assert?: AssertSpec
  scroll?: ScrollSpec
  extract?: ExtractWhat
  /** Where `extract` output is stored, so a later step can reference it. */
  saveAs?: string
  /** Per-step timeout override in ms. */
  timeoutMs?: number
  /**
   * When true, a failure is recorded but does not fail the run. For steps that
   * handle conditional UI — a cookie banner that may or may not appear.
   */
  optional?: boolean
  /** Author's note; exported as a comment. */
  note?: string
  /**
   * A better target proposed by self-healing after the recorded one failed.
   *
   * Kept as a proposal rather than applied silently: a script that rewrites
   * itself can drift into passing against the wrong element, so the user
   * confirms in the UI before it replaces `target`.
   */
  proposedFix?: Target
}

/** A saved, replayable script. */
export interface TestScript {
  id: string
  name: string
  /** The case this was recorded from, when it came from one. */
  caseId?: string
  /** URL the run opens first. */
  startUrl: string
  steps: ScriptStep[]
  version: typeof SCRIPT_VERSION
  createdAt: number
  updatedAt: number
  /** Run id this was recorded from, for traceability. */
  recordedFromRunId?: string
}

// --- Cases -------------------------------------------------------------------

/** Where a case came from; shown in the UI and used by the bridge. */
export type CaseSource = 'chat' | 'markdown' | 'manual' | 'bridge'

/**
 * A test case: what to do and what should be true afterwards, in prose.
 *
 * `steps` and `expectations` are separate lists because they are checked
 * differently: a step failing is an execution error, an expectation failing is a
 * test failure, and conflating them makes a report useless.
 */
export interface TestCase {
  id: string
  name: string
  description?: string
  tags: string[]
  /** URL the run should start at. Optional: a case may say so in prose instead. */
  startUrl?: string
  source: CaseSource
  /** Natural-language actions, in order. */
  steps: string[]
  /** Natural-language expectations. */
  expectations: string[]
  /** The recorded script, once a run has passed. */
  scriptId?: string
  createdAt: number
  updatedAt: number
}

// --- Runs --------------------------------------------------------------------

/** How a run was started. */
export type RunTrigger = 'manual' | 'chat' | 'schedule' | 'bridge' | 'replay'

/** Whether the run was driven by the model or by a saved script. */
export type RunMode = 'agent' | 'script'

/**
 * Terminal and non-terminal run states.
 *
 * `failed` and `error` are distinct on purpose: `failed` means the application
 * under test did not meet an expectation (a real test result), `error` means this
 * tool could not complete the attempt (no tab, model unreachable, bad selector
 * with no fallback). Reporting the second as the first would send teams hunting
 * for bugs that are not there.
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'error'
  | 'cancelled'
  | 'interrupted'

/** True for states that will never change again. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status !== 'queued' && status !== 'running'
}

/** One executed step. */
export interface StepRecord {
  index: number
  action: ActionName
  /** Human-readable line, e.g. `click "Sign in"`. */
  description: string
  ok: boolean
  startedAt: number
  durationMs: number
  error?: string
  /** How many attempts it took, when more than one was needed. */
  attempts?: number
  /** Set when a fallback selector was used, i.e. the primary one drifted. */
  usedFallback?: boolean
  /** Serialized spec that matched, for debugging a drifting selector. */
  usedSpec?: string
  /** Artifact id of a screenshot in IndexedDB. */
  screenshotId?: string
  /** Extraction output, when the step extracted something. */
  extracted?: ExtractedValue
  /** Assertion outcome, when the step asserted something. */
  assertion?: { passed: boolean; actual: string; expected: string }
}

/** One execution of a case or script. */
export interface TestRun {
  id: string
  caseId?: string
  /**
   * Denormalized case name.
   *
   * Copied rather than joined so run history stays readable after the case is
   * deleted — an audit trail that dangles is worse than a slightly stale name.
   */
  caseName: string
  scriptId?: string
  mode: RunMode
  trigger: RunTrigger
  status: RunStatus
  startedAt: number
  finishedAt?: number
  /**
   * Last progress timestamp.
   *
   * The watchdog marks a run `interrupted` when this goes stale, which is how a
   * run whose service worker was killed mid-flight stops looking active forever.
   */
  heartbeatAt: number
  steps: StepRecord[]
  /** Model's or runner's closing summary. */
  summary?: string
  /**
   * Screenshot ids captured during this run, in capture order.
   *
   * Ids only: the images live in IndexedDB, so a run list stays cheap to read
   * even when every run carries a dozen full-window PNGs. Optional because a run
   * stored before this field existed will not have it, and a migration that
   * rewrote history to add an empty array would risk the audit trail for nothing.
   */
  artifactIds?: string[]
  /** Values captured by `extract` steps that named a `saveAs`. */
  extracted?: Record<string, unknown>
  /** First hard failure, promoted out of `steps` so reports need not scan. */
  failure?: { stepIndex: number; message: string; screenshotId?: string }
  /** Window opened for this run, so cancellation can close it. */
  windowId?: number
  /** Bridge request id, when the run was started over the local API. */
  bridgeRequestId?: string
  /** Model tokens spent, when the provider reported them. */
  usage?: { promptTokens?: number; completionTokens?: number }
}

// --- Schedules ---------------------------------------------------------------

/** How often a schedule fires. */
export type Schedule =
  | {
      kind: 'interval'
      /** Minutes between runs. Chrome clamps alarm periods to >= 1 minute. */
      everyMinutes: number
    }
  | {
      kind: 'daily'
      /** Local wall-clock time, `"HH:mm"`. */
      time: string
      /** Weekdays (0 = Sunday). Empty means every day. */
      days: number[]
    }

/** When to send a Feishu notification for a scheduled run. */
export type NotifyPolicy = 'always' | 'failure' | 'never'

/** A timer that starts a run without a human present. */
export interface ScheduleEntry {
  id: string
  name: string
  /** Case to run. A schedule always targets a case, never a bare script. */
  caseId: string
  /**
   * Prefer replaying the recorded script when one exists.
   *
   * Default true: unattended runs should be deterministic and free, falling back
   * to the model only when there is no script yet.
   */
  preferScript: boolean
  schedule: Schedule
  enabled: boolean
  notify: NotifyPolicy
  createdAt: number
  lastRunAt?: number
  lastRunId?: string
  lastStatus?: RunStatus
  nextRunAt?: number
}

// --- Settings ----------------------------------------------------------------

/** A named secret; the value never leaves the worker. */
export interface SecretEntry {
  name: string
  value: string
}

/** Feishu custom-robot webhook configuration. */
export interface FeishuConfig {
  /** Full webhook URL from the custom robot. Empty disables notification. */
  webhookUrl: string
  /**
   * Signing secret, when the robot has signature verification enabled.
   *
   * Optional because the feature is opt-in on Feishu's side; when set, every
   * request carries `timestamp` and `sign`.
   */
  secret?: string
  /** Send a card (richer) or plain text (survives stricter tenants). */
  format: 'card' | 'text'
  notify: NotifyPolicy
  /** Extra @-mention text appended to a failure card. */
  mentionOnFailure?: string
}

/** Local bridge connection settings. */
export interface BridgeConfig {
  enabled: boolean
  /** WebSocket URL of the local bridge, e.g. `ws://127.0.0.1:8787/extension`. */
  url: string
  /** Shared token, matched against the bridge's generated token. */
  token: string
}

/** Everything that governs how runs execute. */
export interface RunPolicy {
  /**
   * URL globs the extension may automate.
   *
   * The central safety boundary. Per-action confirmation is unworkable for test
   * automation — a hundred steps would mean a hundred prompts — so consent is
   * granted once per site instead, and any step targeting a non-matching URL
   * fails hard. Unattended triggers (schedule, bridge) refuse to start when this
   * is empty.
   */
  allowedSites: string[]
  /**
   * Open a dedicated window for each run instead of using the current tab.
   *
   * Off by default: the common case is "test the page I am looking at". A run
   * that opened its own window would start on a blank page and lose the login
   * session, cookies and app state the user just set up by hand — so the
   * cheapest thing to test becomes the hardest. Unattended triggers still need
   * a window, and turn it on themselves.
   */
  useDedicatedWindow: boolean
  /** Total wall-clock budget for one run. */
  runTimeoutMs: number
  /** Default per-step timeout. */
  stepTimeoutMs: number
  /** Max LLM tool rounds in one agent run, so a confused model cannot burn cash. */
  maxToolRounds: number
  /** Capture a screenshot after every step, not just on failure. */
  screenshotEveryStep: boolean
  /** Allow the model to re-locate an element whose selectors all failed. */
  selfHeal: boolean
  /** Ask the model to record a script automatically when an agent run passes. */
  autoSaveScript: boolean
}

export interface Settings {
  providers: ProviderProfile[]
  /** Id of the profile the agent uses; empty when none is configured. */
  activeProviderId: string
  policy: RunPolicy
  feishu: FeishuConfig
  bridge: BridgeConfig
}

/**
 * Starting settings for a fresh install.
 *
 * `allowedSites` is deliberately empty: the extension can do nothing to any page
 * until the user names a site. An out-of-the-box wildcard would mean installing
 * this extension silently granted an LLM write access to every page the user has
 * open, including their bank.
 *
 * `selfHeal` is off for the same class of reason — a run that silently repairs
 * its own selectors can report a pass for a page that no longer matches the test.
 *
 * `useDedicatedWindow` is off so a manual run tests the tab the user is already
 * on, keeping their logged-in session. `screenshotEveryStep` is off because a
 * screenshot on failure is the evidence that matters; capturing every step costs
 * a `captureVisibleTab` round trip per step and fills the artifact budget with
 * frames nobody opens.
 */
export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  activeProviderId: '',
  policy: {
    allowedSites: [],
    useDedicatedWindow: false,
    runTimeoutMs: 300_000,
    stepTimeoutMs: 10_000,
    maxToolRounds: 24,
    screenshotEveryStep: false,
    selfHeal: false,
    autoSaveScript: true,
  },
  feishu: {
    webhookUrl: '',
    format: 'card',
    notify: 'failure',
  },
  bridge: {
    enabled: false,
    url: 'ws://127.0.0.1:8787/extension',
    token: '',
  },
}

/** One log line. Logs are a bounded ring buffer. */
export interface LogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  /** Free-form source tag: `scheduler`, `bridge`, `run:<id>`. */
  source: string
  message: string
}

/** A chat message as rendered in the side panel. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** Present on tool messages, for display. */
  toolName?: string
}

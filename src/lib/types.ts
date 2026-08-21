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
   * When true the step is kept in the script but skipped at replay time.
   *
   * Disabling rather than deleting lets a user temporarily turn off a step that
   * is flaky or not relevant to a particular environment without losing the
   * recorded selector/value; the run record marks it as skipped.
   */
  disabled?: boolean
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
  /**
   * A replay failed, the agent took over, and the case's expectations then held.
   *
   * Deliberately neither `passed` nor `failed`. Calling it `passed` would hide
   * that the saved script is now broken, and a script nobody notices is broken
   * stops being a test — it silently becomes an agent run, at agent cost and
   * agent speed. Calling it `failed` would throw away a real, verified result and
   * teach people to ignore red.
   *
   * So it is its own colour: the case works, the script does not. CI decides
   * whether that is acceptable via `treatRecoveredAsPass`.
   */
  | 'recovered'

/** True for states that will never change again. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status !== 'queued' && status !== 'running'
}

/**
 * True for a run whose expectations were met, however it got there.
 *
 * The one place `recovered` and `passed` are deliberately the same thing: the
 * application under test behaved correctly. Anything reporting on the *health of
 * the test suite* must keep them apart.
 */
export function isSuccessStatus(status: RunStatus): boolean {
  return status === 'passed' || status === 'recovered'
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
  /** True when the step was disabled in the script and therefore not executed. */
  skipped?: boolean
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
  /**
   * What the agent did after a replay failed.
   *
   * Present only when recovery was attempted, so an ordinary run carries no extra
   * weight. Kept on the run rather than only in the log because this is the
   * evidence a reviewer needs to answer "should I trust this green?" — and the
   * material for fixing the script for real.
   */
  recovery?: RecoveryAttempt
}

/**
 * One line of an agent run's live commentary.
 *
 * This exists because the panel is not a reliable place to keep it. The side panel
 * unmounts a tab's component the moment the user switches tabs, so a transcript
 * held in React state evaporates — and, worse, the events that arrived while it was
 * unmounted are gone for good. Since the worker owns the run, the worker owns the
 * story of the run, and the panel is only a view of it.
 *
 * Kept deliberately small and serializable: it crosses the `chrome.runtime`
 * boundary on every fetch and is persisted to `storage.session`, which MV3 caps.
 */
export type TranscriptEntry =
  | { kind: 'assistant'; seq: number; at: number; text: string }
  | {
      kind: 'tool'
      seq: number
      at: number
      /** Tool name, e.g. `click`. */
      name: string
      /** Redacted, human-readable arguments — never a secret value. */
      args: string
      /** The tool's own reply, trimmed for display. */
      result: string
      ok: boolean
      durationMs: number
      /** Which model round issued it, so a stuck loop is visible. */
      round: number
    }
  | {
      kind: 'phase'
      seq: number
      at: number
      /** Short status such as `正在调用模型（第 3/24 轮）`. */
      text: string
    }
  | { kind: 'status'; seq: number; at: number; status: RunStatus; message?: string }

/** Everything the panel needs to redraw an agent run's commentary from scratch. */
export interface RunTranscript {
  runId: string
  caseName: string
  /** Monotonic, so the panel can merge a fetch with live events without duplicates. */
  entries: TranscriptEntry[]
  /** True while the run is executing, so a reopened panel shows the right affordances. */
  running: boolean
  /** Set once the run reaches a terminal status. */
  status?: RunStatus
  startedAt: number
  /** True when older entries were dropped to respect the size cap. */
  truncated?: boolean
}

/**
 * The agent's attempt to diagnose and continue a failed replay.
 *
 * Recorded even when it fails. A recovery that did not work is exactly the
 * information a human needs — it says the failure is not a stale selector, so the
 * application probably really is broken.
 */
export interface RecoveryAttempt {
  /** Step index the replay died on, matching `StepRecord.index`. */
  failedAtStep: number
  /** The replay's own error, kept verbatim so diagnosis cannot launder it. */
  originalError: string
  /**
   * Which layer the runner blamed, and therefore why recovery was allowed.
   *
   * `selector` means the element was not found — very likely a stale script.
   * `application` means the page was found but behaved wrongly (a disabled
   * button, an assertion that did not hold). Both may be resumed, per the user's
   * decision, but they carry opposite priors and the report must not blur them.
   */
  cause: 'selector' | 'application'
  /** The model's plain-language reading of the failure, for a human to judge. */
  diagnosis?: string
  /** What the model proposed doing about it. */
  proposal?: string
  /** Whether the agent then drove the case's remaining steps to a verdict. */
  resumed: boolean
  /**
   * Steps the agent ran while recovering, numbered after the replay's.
   *
   * Separate from `TestRun.steps` so a reader can always tell which actions came
   * from the trusted script and which from the model.
   */
  steps?: StepRecord[]
  /** Why recovery stopped, when it did not reach a verdict. */
  gaveUpBecause?: string
  /**
   * A better target the agent found for the failed step.
   *
   * A proposal, never applied: a script that silently rewrites itself can drift
   * away from what the author meant while still reporting green.
   */
  suggestedFix?: { stepIndex: number; note: string }
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
  /**
   * Triggers for which the agent may diagnose a failed replay and continue it.
   *
   * Per-trigger rather than a single switch, because the value and the risk both
   * depend on who is watching. A human running by hand wants the diagnosis
   * immediately and can weigh it. A 3am schedule or a CI job produces a verdict
   * someone will act on without reading the transcript, so there the honest
   * default is to report the failure and let a person look.
   */
  resumeOnFailure: RunTrigger[]
  /**
   * Whether `recovered` counts as success for notifications and CI exit codes.
   *
   * Off by default: the point of `recovered` is that someone finds out the script
   * is broken. Teams that would rather keep the build green while they catch up on
   * script maintenance can turn it on, and still see the status in reports.
   */
  treatRecoveredAsPass: boolean
  /**
   * Default consent mode for the open-ended conversation tab.
   *
   * `write` is the default because a conversational agent acts on the user's real,
   * logged-in page — auto-running every click would let a confused model submit
   * forms unprompted, while confirming reads and scrolls adds friction without
   * protecting anything that leaves the machine.
   */
  confirmMode: ConfirmMode
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
 * `screenshotEveryStep` is off because a screenshot on failure is the evidence
 * that matters; capturing every step costs a `captureVisibleTab` round trip per
 * step and fills the artifact budget with frames nobody opens.
 *
 * `resumeOnFailure` is on for `manual` only. Recovery is most valuable with a
 * human watching, who can read the diagnosis and judge it; unattended it would
 * turn a red schedule into a green one that nobody looks at. `chat` is included
 * because it is the same person at the same keyboard.
 */
export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  activeProviderId: '',
  policy: {
    allowedSites: [],
    runTimeoutMs: 300_000,
    stepTimeoutMs: 10_000,
    maxToolRounds: 24,
    screenshotEveryStep: false,
    selfHeal: false,
    autoSaveScript: true,
    resumeOnFailure: ['manual'],
    treatRecoveredAsPass: false,
    confirmMode: 'write',
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

// --- Conversational agent (the "对话" tab) ----------------------------------

/**
 * A reusable instruction pack plus optional fillable data.
 *
 * Distinct from a {@link SecretEntry} (which holds a credential value the model
 * never sees) and from a {@link TestCase} (which is a verifiable expectation). A
 * skill is "when doing this kind of task, follow these instructions and use these
 * field values" — for example "fill the checkout form" with a mapping of field
 * labels to values. Values that are secrets are referenced by name via
 * {@link SkillField.secretRef}, so the file itself never stores the credential.
 *
 * The word is borrowed from browser-copilot, whose skills are pure instruction
 * packs. That model is extended here with field data because this extension can
 * actually operate the page, and "fill this form using my details" is the common
 * case an instruction alone cannot serve.
 */
export interface Skill {
  id: string
  /** Unique, human-chosen name; also how the agent refers to it. */
  name: string
  /** One line stating when the skill applies. Drives automatic matching. */
  description: string
  /** Instruction text appended to the system prompt while active. */
  instructions: string
  /** Whether the agent may select this skill on its own (via `use_skill`). */
  autoMatch: boolean
  /**
   * Field values the agent may fill. The agent matches each {@link SkillField}
   * to a form control by label/placeholder/name; credentials go through
   * `secretRef` rather than being stored here.
   */
  fields: SkillField[]
  createdAt: number
  updatedAt: number
}

/** One fillable field in a {@link Skill}. */
export interface SkillField {
  /**
   * What the agent should match the control against — a label, placeholder, or
   * input name. Free text because real forms are inconsistent; the model does
   * the matching, not an exact string compare.
   */
  label: string
  /** Literal value, or undefined when `secretRef` is set. */
  value?: string
  /** Name of a secret to use instead of a literal value. */
  secretRef?: string
}

/** How the agent asks for consent before touching the page. */
export type ConfirmMode =
  /** The agent acts without prompting; fastest, least safe. */
  | 'auto'
  /** Only page-mutating actions (click, fill, select, checkbox, press) prompt. */
  | 'write'
  /** Every tool call prompts, including reads and scrolls. Safest. */
  | 'always'

/** One message in an open-ended conversation. */
export interface ConversationTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** When the message was started. */
  at: number
}

/**
 * A page action the model proposed during a conversation, paused for approval.
 *
 * Unlike a {@link StepRecord} (which records something that already happened), a
 * pending action may be declined, so it carries the raw call and a resolvable
 * decision the loop waits on.
 */
export interface PendingAction {
  id: string
  /** Tool name, e.g. `click`, `fill`, `snapshot`. */
  name: string
  /** Human-readable summary of the arguments, never the post-substitution secret. */
  argsSummary: string
  /** Whether this action mutates the page, drives the confirm-mode decision. */
  mutating: boolean
  at: number
}

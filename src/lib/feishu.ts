/**
 * Feishu (Lark) custom-robot notifications for finished runs.
 *
 * Unattended runs — a schedule firing at 03:00, a bridge request from CI — have
 * nobody watching the side panel, so the result has to travel to where the team
 * already is. A custom robot webhook is the cheapest possible transport for that:
 * one URL, no OAuth, no app review, no tenant admin involved.
 *
 * Three facts about that API shape everything below.
 *
 * 1. Feishu answers HTTP 200 even when it rejected the message, and puts the real
 *    verdict in the body's `code`. A caller that checks `response.ok` alone
 *    reports every send as delivered, including the ones nobody received — so
 *    {@link sendFeishuNotification} always reads the body.
 * 2. Signature verification, when enabled on the robot, is not a header. The
 *    `timestamp` and `sign` fields sit at the top level of the JSON body, next to
 *    `msg_type`, and the HMAC uses the timestamp-and-secret string as its *key*
 *    over an *empty* message. Getting either detail wrong yields a 19021 that
 *    reads like a wrong secret.
 * 3. A custom robot cannot upload images: `image_key` requires an app token this
 *    integration deliberately does not have. Screenshots are therefore linked,
 *    never embedded — see {@link artifactUrl}.
 *
 * A notification is reporting, not testing. Nothing here may throw into a run:
 * a broken webhook must not turn a passing suite red, so every failure comes back
 * as data via {@link SendResult}.
 *
 * @module lib/feishu
 */

import { formatDuration, formatTime } from './time'
import type {
  FeishuConfig,
  NotifyPolicy,
  RunStatus,
  RunTrigger,
  StepRecord,
  TestRun,
} from './types'

/** Webhook prefixes the two Feishu deployments issue. Nothing else is accepted. */
export const FEISHU_HOOK_PREFIXES = [
  'https://open.feishu.cn/open-apis/bot/v2/hook/',
  'https://open.larksuite.com/open-apis/bot/v2/hook/',
] as const

/**
 * How long Feishu accepts a signed timestamp.
 *
 * Exported for retry queues: a notification that failed at 03:00 and is retried
 * at 05:00 must be re-signed, not replayed, or the retry fails with a signature
 * error that looks like a configuration problem.
 */
export const FEISHU_TIMESTAMP_MAX_AGE_SECONDS = 3600

// --- Wire shapes -------------------------------------------------------------

/** A text node inside a card. `lark_md` is the only place markdown is honoured. */
export interface FeishuCardText {
  tag: 'plain_text' | 'lark_md'
  content: string
}

export type FeishuCardElement =
  | { tag: 'div'; text: FeishuCardText }
  | { tag: 'hr' }
  | { tag: 'note'; elements: FeishuCardText[] }

/**
 * Header colours Feishu understands, narrowed to the ones this module uses.
 *
 * `blue` is not an outcome colour; it is reserved for the non-terminal states,
 * which are only ever notified by a caller reporting progress.
 */
export type FeishuCardTemplate = 'green' | 'red' | 'orange' | 'grey' | 'blue'

export interface FeishuCard {
  config: { wide_screen_mode: true }
  header: {
    template: FeishuCardTemplate
    /** Headers are plain text; markdown in a title renders literally. */
    title: { tag: 'plain_text'; content: string }
  }
  elements: FeishuCardElement[]
}

/** The two message kinds a custom robot supports without an app token. */
export type FeishuMessageBody =
  | { msg_type: 'text'; content: { text: string } }
  | { msg_type: 'interactive'; card: FeishuCard }

/**
 * Outcome of one send attempt.
 *
 * `retryable` exists so the caller can distinguish "try again later" from "stop
 * and tell the user to fix Settings"; retrying a rejected webhook forever only
 * fills the log.
 */
export type SendResult = { ok: true } | { ok: false; error: string; retryable: boolean }

/** Shared inputs for the two message builders. */
export interface MessageOptions {
  /**
   * Where the local bridge serves stored screenshots, e.g. `http://127.0.0.1:8787`.
   *
   * Absent for an extension-only install, which has no HTTP origin of its own —
   * the message then says where to find the screenshot instead of linking it.
   */
  artifactBaseUrl?: string
  /**
   * `all`, or an open ID, taken from {@link FeishuConfig.mentionOnFailure}.
   *
   * Applied only to failure-shaped outcomes: a robot that pings the group on
   * every green run gets muted, and a muted robot reports nothing.
   */
  mentionOnFailure?: string
  /** Clock injection, epoch ms. Used for a run that has not finished yet. */
  now?: number
}

export interface SendOptions extends MessageOptions {
  /** Lets a cancelled run abandon its own notification. */
  signal?: AbortSignal
}

// --- Labels ------------------------------------------------------------------

/**
 * Chinese-first labels with the English term kept alongside.
 *
 * The product UI is Chinese; the status words are also API values that people
 * grep for in logs and in the bridge's JSON, so both appear rather than forcing
 * a mental translation at 3am.
 *
 * Written as exhaustive records so adding a {@link RunStatus} is a compile error
 * here rather than a message reading `undefined` in a group chat.
 */
const STATUS_LABEL: Record<RunStatus, string> = {
  queued: '排队中',
  running: '执行中',
  passed: '通过',
  failed: '失败',
  error: '执行错误',
  cancelled: '已取消',
  interrupted: '已中断',
}

const TITLE_PREFIX: Record<RunStatus, string> = {
  queued: '测试排队中',
  running: '测试执行中',
  passed: '测试通过',
  failed: '测试失败',
  error: '测试执行错误',
  cancelled: '测试已取消',
  interrupted: '测试中断',
}

/**
 * Header colour per outcome.
 *
 * `error` and `interrupted` share orange with intent: neither is a verdict about
 * the application under test, so colouring them red would send people hunting
 * for a bug that the suite never actually looked for.
 */
const STATUS_TEMPLATE: Record<RunStatus, FeishuCardTemplate> = {
  queued: 'blue',
  running: 'blue',
  passed: 'green',
  failed: 'red',
  error: 'orange',
  interrupted: 'orange',
  cancelled: 'grey',
}

const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: '手动触发 manual',
  chat: '对话触发 chat',
  schedule: '定时任务 schedule',
  bridge: '本地 bridge',
  replay: '脚本回放 replay',
}

/**
 * Statuses that mean "the person on call needs to look at this".
 *
 * `error` and `interrupted` belong here even though they are not test failures:
 * a suite that could not run is strictly worse news than one that ran and failed,
 * because nothing was verified at all. `cancelled` is excluded — a human stopped
 * it on purpose and does not need to be told.
 */
const FAILURE_STATUSES: readonly RunStatus[] = ['failed', 'error', 'interrupted']

/** True when a status warrants a failure-shaped notification. */
export function isFailureStatus(status: RunStatus): boolean {
  return FAILURE_STATUSES.includes(status)
}

// --- Policy ------------------------------------------------------------------

/**
 * Whether a run in this state should be reported under this policy.
 *
 * The `failure` policy is the interesting one, and the reason it is a named
 * function rather than an inline `status !== 'passed'`: see
 * {@link FAILURE_STATUSES} for why `error` and `interrupted` notify while
 * `cancelled` does not. Non-terminal states never notify, because a run that is
 * still going has no result to report.
 */
export function shouldNotify(policy: NotifyPolicy, status: RunStatus): boolean {
  switch (policy) {
    case 'never':
      return false
    case 'always':
      return status !== 'queued' && status !== 'running'
    case 'failure':
      return isFailureStatus(status)
  }
}

// --- Configuration -----------------------------------------------------------

/** True when a webhook URL has been entered at all. Empty means "disabled". */
export function isFeishuConfigured(config: FeishuConfig): boolean {
  return config.webhookUrl.trim().length > 0
}

/**
 * Every problem with the Feishu settings, phrased for the Settings form.
 *
 * Returns a list rather than the first failure so the form can show everything at
 * once, matching `validateProfile` and `validatePattern`. Messages are English
 * like the rest of the validation layer; only the *notification* text is
 * Chinese-first, since that is what leaves the extension.
 *
 * `format` and `notify` are checked at runtime despite being typed, because
 * settings are merged from persisted JSON that an older build wrote — a stale key
 * would otherwise reach `fetch` as a body Feishu cannot parse.
 */
export function validateFeishuConfig(config: FeishuConfig): string[] {
  const problems: string[] = []
  const url = config.webhookUrl.trim()

  if (url.length === 0) {
    problems.push(
      'Webhook URL is required. In the Feishu group, open 设置 → 群机器人 → 添加机器人 → 自定义机器人 (Custom Bot) and copy the webhook URL it shows.',
    )
  } else {
    const prefix = FEISHU_HOOK_PREFIXES.find((candidate) => url.startsWith(candidate))
    if (!prefix) {
      problems.push(
        `Webhook URL must start with ${FEISHU_HOOK_PREFIXES[0]} (Feishu) or ${FEISHU_HOOK_PREFIXES[1]} (Lark). Copy it from the group's 自定义机器人 (Custom Bot) dialog — an open-platform app URL or a shortened link will not work.`,
      )
    } else if (url.slice(prefix.length).length === 0) {
      problems.push('Webhook URL is missing the hook token after /hook/. Copy the whole URL.')
    }
  }

  // Distinguish "no signing" from "signing misconfigured": an all-whitespace
  // secret is a paste accident, and signing every request with it fails 19021.
  if (config.secret !== undefined && config.secret.trim().length === 0 && config.secret.length > 0) {
    problems.push(
      'Signing secret is blank. Clear the field, or paste the 签名校验 (signature verification) secret from the robot dialog.',
    )
  }

  if (config.format !== 'card' && config.format !== 'text') {
    problems.push(`Unknown message format ${String(config.format)}; use card or text.`)
  }
  if (config.notify !== 'always' && config.notify !== 'failure' && config.notify !== 'never') {
    problems.push(`Unknown notify policy ${String(config.notify)}; use always, failure, or never.`)
  }
  return problems
}

// --- Signing -----------------------------------------------------------------

/**
 * Signs a request the way Feishu's custom robot expects.
 *
 * The algorithm is unusual and easy to get backwards: the string
 * `${timestamp}\n${secret}` is the HMAC-SHA256 **key**, and the signed **message
 * is empty**. The base64 of the raw digest is `sign`.
 *
 * Implemented with WebCrypto rather than Node's `crypto` because the only caller
 * is the extension's service worker, where no Node builtin exists. WebCrypto is
 * async all the way down, hence the promise.
 *
 * The timestamp is in *seconds*, and Feishu rejects one older than
 * {@link FEISHU_TIMESTAMP_MAX_AGE_SECONDS}, so it is derived at send time and
 * never cached alongside a prepared body.
 */
export async function signRequest(
  secret: string,
  timestampSeconds: number,
): Promise<{ timestamp: string; sign: string }> {
  // Seconds, integral: a fractional or millisecond value signs cleanly and is
  // then rejected as out of range, which is a miserable thing to debug.
  const timestamp = String(Math.floor(timestampSeconds))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new Uint8Array(0))
  return { timestamp, sign: base64FromBytes(new Uint8Array(digest)) }
}

/**
 * Base64 of raw bytes.
 *
 * A plain loop rather than `String.fromCharCode(...bytes)`: spreading bytes into
 * arguments blows the call stack on large inputs, and a helper that only happens
 * to work for 32-byte digests is a trap for the next caller.
 */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// --- Message building --------------------------------------------------------

/**
 * URL of a stored screenshot on the local bridge.
 *
 * The bridge is the only component with an HTTP origin, so it is the only one
 * that can serve an artifact to Feishu's renderer. The extension alone cannot:
 * a `chrome-extension://` URL is unreachable outside the browser profile, and a
 * base64 data URL in a card exceeds the message limit immediately.
 */
export function artifactUrl(baseUrl: string, artifactId: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.length === 0) return ''
  return `${base}/artifacts/${encodeURIComponent(artifactId)}`
}

/**
 * Renders an @-mention.
 *
 * `all` is special-cased because Feishu spells "everyone" as the literal user id
 * `all`; anything else is treated as an open ID (`ou_…`). The display text is
 * required for `all` and ignored for an individual, whose name the client
 * resolves itself.
 */
export function renderMention(mention: string): string {
  const target = mention.trim()
  if (target.length === 0) return ''
  if (target === 'all') return '<at user_id="all">所有人</at>'
  return `<at user_id="${target}"></at>`
}

/** Steps that succeeded, over steps attempted. */
function countSteps(run: TestRun): { passed: number; total: number } {
  return {
    passed: run.steps.filter((step) => step.ok).length,
    total: run.steps.length,
  }
}

/**
 * The step a report should point at.
 *
 * `run.failure.stepIndex` is matched against `StepRecord.index` rather than used
 * as an array position: the records array can be shorter than the step numbering
 * when a run was truncated, and an off-by-one here blames the wrong step.
 */
function findFailingStep(run: TestRun): StepRecord | undefined {
  const index = run.failure?.stepIndex
  if (index !== undefined) {
    const byIndex = run.steps.find((step) => step.index === index)
    if (byIndex) return byIndex
  }
  return run.steps.find((step) => !step.ok)
}

/**
 * The screenshot worth linking.
 *
 * Prefers the one promoted onto `failure`, then the failing step's, then the last
 * one captured — for a passing run that final frame is the evidence that the app
 * really was in the expected state. `artifactIds` is consulted last because a
 * step-level id says *which* step the image belongs to, which is what a reader
 * needs; the run-level list only says it exists.
 */
function pickScreenshotId(run: TestRun): string | undefined {
  const promoted = run.failure?.screenshotId
  if (promoted) return promoted
  const failing = findFailingStep(run)
  if (failing?.screenshotId) return failing.screenshotId
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const candidate = run.steps[index]?.screenshotId
    if (candidate) return candidate
  }
  return run.artifactIds?.at(-1)
}

/** Wall-clock length of the run; still-running runs are measured against now. */
function runDurationMs(run: TestRun, now: number): number {
  return (run.finishedAt ?? now) - run.startedAt
}

/** Title shared by the card header and the first line of the text message. */
function runTitle(run: TestRun): string {
  return `${TITLE_PREFIX[run.status]}：${run.caseName}`
}

/** The reason a run is being reported, or undefined when it simply passed. */
function failureReason(run: TestRun): string | undefined {
  const failing = findFailingStep(run)
  return run.failure?.message ?? failing?.error
}

/**
 * The screenshot line.
 *
 * Never an embedded image: a custom robot has no `image_key`, so without a bridge
 * origin the honest answer is to say where the picture lives rather than to drop
 * it silently.
 */
function screenshotLine(run: TestRun, options: MessageOptions): string | undefined {
  const screenshotId = pickScreenshotId(run)
  if (!screenshotId) return undefined
  const href = options.artifactBaseUrl ? artifactUrl(options.artifactBaseUrl, screenshotId) : ''
  if (href.length > 0) return `**截图**：[查看截图 screenshot](${href})`
  return '**截图**：已保存在扩展的运行历史 (Run history) 中；自定义机器人无法上传图片，配置本地 bridge 的 artifactBaseUrl 后此处会给出直接链接。'
}

/** The mention suffix, empty unless this outcome deserves a ping. */
function mentionSuffix(run: TestRun, options: MessageOptions): string {
  if (!options.mentionOnFailure || !isFailureStatus(run.status)) return ''
  return renderMention(options.mentionOnFailure)
}

/**
 * Plain-text summary.
 *
 * Kept as a first-class format, not a fallback: some tenants disable interactive
 * cards for custom robots, and a text message that always arrives beats a card
 * that renders as an empty bubble.
 */
export function buildTextMessage(run: TestRun, options: MessageOptions = {}): string {
  const now = options.now ?? Date.now()
  const counts = countSteps(run)
  const lines = [
    runTitle(run),
    `状态：${STATUS_LABEL[run.status]} (${run.status})`,
    `耗时：${formatDuration(runDurationMs(run, now))}`,
    `步骤：${counts.passed}/${counts.total} 通过`,
  ]

  const failing = findFailingStep(run)
  if (failing) lines.push(`失败步骤：#${failing.index} ${failing.description}`)
  const reason = failureReason(run)
  if (reason) lines.push(`失败原因：${reason}`)
  if (run.summary) lines.push(`结论：${run.summary}`)

  // The text variant strips the markdown link syntax the card uses; a bare URL
  // is clickable in Feishu and reads better than [text](url) in plain text.
  const screenshotId = pickScreenshotId(run)
  if (screenshotId) {
    const href = options.artifactBaseUrl ? artifactUrl(options.artifactBaseUrl, screenshotId) : ''
    lines.push(
      href.length > 0
        ? `截图：${href}`
        : '截图：已保存在扩展的运行历史 (Run history) 中；自定义机器人无法上传图片。',
    )
  }

  lines.push(`触发方式：${TRIGGER_LABEL[run.trigger]}`)
  lines.push(`开始时间：${formatTime(run.startedAt)}`)

  const mention = mentionSuffix(run, options)
  if (mention.length > 0) lines.push(mention)
  return lines.join('\n')
}

/**
 * Interactive card for one run.
 *
 * The header carries the verdict as colour so the outcome is legible from the
 * chat list without opening anything; the body carries only what a reader needs
 * before deciding to open the extension — what ran, how it ended, which step
 * broke, and how it was triggered.
 */
export function buildRunCard(run: TestRun, options: MessageOptions = {}): FeishuCard {
  const now = options.now ?? Date.now()
  const counts = countSteps(run)
  const elements: FeishuCardElement[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: [
          `**用例**：${run.caseName}`,
          `**状态**：${STATUS_LABEL[run.status]} (${run.status})`,
          `**耗时**：${formatDuration(runDurationMs(run, now))}`,
          `**步骤**：${counts.passed}/${counts.total} 通过`,
        ].join('\n'),
      },
    },
  ]

  const failing = findFailingStep(run)
  const reason = failureReason(run)
  if (failing || reason) {
    const detail: string[] = []
    if (failing) detail.push(`**失败步骤**：#${failing.index} ${failing.description}`)
    if (reason) detail.push(`**失败原因**：${reason}`)
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: detail.join('\n') } })
  }

  if (run.summary) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**结论**：${run.summary}` } })
  }

  const screenshot = screenshotLine(run, options)
  if (screenshot) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: screenshot } })
  }

  const mention = mentionSuffix(run, options)
  if (mention.length > 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: mention } })
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        // Run id included so a reader can find this exact run in the history,
        // which matters once the same case has failed several times.
        content: `${TRIGGER_LABEL[run.trigger]} · ${run.mode} · ${formatTime(run.startedAt)} · run ${run.id}`,
      },
    ],
  })

  return {
    config: { wide_screen_mode: true },
    header: {
      template: STATUS_TEMPLATE[run.status],
      title: { tag: 'plain_text', content: runTitle(run) },
    },
    elements,
  }
}

/** Picks the body shape the configuration asks for. */
export function buildMessageBody(
  config: FeishuConfig,
  run: TestRun,
  options: MessageOptions = {},
): FeishuMessageBody {
  const merged: MessageOptions = { ...options }
  // The mention lives in settings, but an explicit option wins so a caller can
  // suppress it for a re-send.
  if (merged.mentionOnFailure === undefined && config.mentionOnFailure !== undefined) {
    merged.mentionOnFailure = config.mentionOnFailure
  }
  if (config.format === 'text') {
    return { msg_type: 'text', content: { text: buildTextMessage(run, merged) } }
  }
  return { msg_type: 'interactive', card: buildRunCard(run, merged) }
}

// --- Sending -----------------------------------------------------------------

/** Feishu's envelope. Fields are read defensively; a gateway may return HTML. */
function readEnvelope(payload: unknown): { code?: number; msg?: string } {
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as Record<string, unknown>
  const envelope: { code?: number; msg?: string } = {}
  if (typeof record.code === 'number') envelope.code = record.code
  if (typeof record.msg === 'string') envelope.msg = record.msg
  return envelope
}

/**
 * Sends one notification. Never throws, never rejects.
 *
 * A notification is a side effect of reporting, so any failure here is returned
 * as {@link SendResult} rather than raised: a run that passed must not be
 * recorded as an error because a webhook was mistyped.
 *
 * The caller decides *whether* to send (see {@link shouldNotify}); this function
 * only decides *how*. That split exists because a {@link ScheduleEntry} carries
 * its own policy which overrides the global one, and baking the global policy in
 * here would silently ignore it.
 */
export async function sendFeishuNotification(
  config: FeishuConfig,
  run: TestRun,
  options: SendOptions = {},
): Promise<SendResult> {
  const problems = validateFeishuConfig(config)
  if (problems.length > 0) {
    // Configuration cannot fix itself; retrying would only repeat the rejection.
    return { ok: false, error: problems.join(' '), retryable: false }
  }

  let payload: Record<string, unknown>
  try {
    payload = { ...buildMessageBody(config, run, options) }
    const secret = config.secret?.trim()
    if (secret) {
      // Signed at send time, not at build time: a body queued for a later retry
      // would carry an expired timestamp (FEISHU_TIMESTAMP_MAX_AGE_SECONDS).
      const now = options.now ?? Date.now()
      const signature = await signRequest(secret, Math.floor(now / 1000))
      // Top level, siblings of msg_type — not headers, and not inside `content`.
      payload.timestamp = signature.timestamp
      payload.sign = signature.sign
    }
  } catch (error) {
    return {
      ok: false,
      error: `Could not build the Feishu request: ${describeError(error)}`,
      retryable: false,
    }
  }

  let response: Response
  try {
    response = await fetch(config.webhookUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    // A cancelled run abandoning its own notification is not a fault to retry.
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: 'Feishu notification was aborted.', retryable: false }
    }
    return {
      ok: false,
      error: `Cannot reach the Feishu webhook: ${describeError(error)}`,
      retryable: true,
    }
  }

  if (!response.ok) {
    // 5xx is Feishu having a bad minute; 429 is this robot being too chatty, and
    // both clear on their own. Every other 4xx is about the request itself.
    const retryable = response.status >= 500 || response.status === 429
    const detail = await readBodyText(response)
    return {
      ok: false,
      error: `Feishu webhook returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
      retryable,
    }
  }

  const text = await readBodyText(response)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A 200 whose body is unreadable — a proxy's HTML, say. The message was
    // accepted at the HTTP layer, and inventing a failure here would drive an
    // endless retry loop for something already delivered.
    return { ok: true }
  }

  const envelope = readEnvelope(parsed)
  // The whole point of this module: HTTP 200 with a non-zero code is a rejection.
  if (envelope.code !== undefined && envelope.code !== 0) {
    return {
      ok: false,
      error: `Feishu rejected the message (code ${envelope.code}): ${envelope.msg ?? 'no message'}`,
      retryable: false,
    }
  }
  return { ok: true }
}

/** Reads a body without ever letting a stream error escape. */
async function readBodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ''
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

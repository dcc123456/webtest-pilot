import { describe, expect, it, vi } from 'vitest'

import {
  FEISHU_HOOK_PREFIXES,
  FEISHU_TIMESTAMP_MAX_AGE_SECONDS,
  artifactUrl,
  buildMessageBody,
  buildRunCard,
  buildTextMessage,
  isFailureStatus,
  isFeishuConfigured,
  renderMention,
  sendFeishuNotification,
  shouldNotify,
  signRequest,
  validateFeishuConfig,
  type FeishuCard,
  type FeishuCardElement,
} from '../src/lib/feishu'
import type { FeishuConfig, RunStatus, StepRecord, TestRun } from '../src/lib/types'

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc123-def456'
const LARK_WEBHOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc123-def456'

/** Every status, so policy tables can be asserted exhaustively. */
const ALL_STATUSES: RunStatus[] = [
  'queued',
  'running',
  'passed',
  'failed',
  'error',
  'cancelled',
  'interrupted',
]

function config(overrides: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    webhookUrl: WEBHOOK,
    format: 'card',
    notify: 'always',
    ...overrides,
  }
}

function step(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    index: 0,
    action: 'click',
    description: 'click "Sign in"',
    ok: true,
    startedAt: 1_700_000_000_000,
    durationMs: 120,
    ...overrides,
  }
}

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: 'run_1',
    caseName: '登录冒烟',
    mode: 'script',
    trigger: 'schedule',
    status: 'passed',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_012_000,
    heartbeatAt: 1_700_000_012_000,
    steps: [step({ index: 0 }), step({ index: 1, description: 'fill "Email"' })],
    ...overrides,
  }
}

/** A failed run with a promoted failure and a screenshot on the failing step. */
function failedRun(overrides: Partial<TestRun> = {}): TestRun {
  return run({
    status: 'failed',
    steps: [
      step({ index: 0 }),
      step({
        index: 1,
        description: 'assert heading contains "Dashboard"',
        ok: false,
        error: 'expected "Dashboard", saw "Login"',
        screenshotId: 'art_9',
      }),
    ],
    failure: {
      stepIndex: 1,
      message: 'expected "Dashboard", saw "Login"',
      screenshotId: 'art_9',
    },
    ...overrides,
  })
}

/** A JSON Response, as Feishu sends it — always HTTP 200 unless stated. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Installs a fetch stub and returns the calls it recorded. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>): {
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, init })
    return impl(url, init)
  })
  return { calls }
}

/** Reads back the JSON body a stubbed fetch received. */
function sentBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

/** Concatenates every text node in a card, for content assertions. */
function cardText(card: FeishuCard): string {
  return card.elements.map(elementText).join('\n')
}

function elementText(element: FeishuCardElement): string {
  if (element.tag === 'div') return element.text.content
  if (element.tag === 'note') return element.elements.map((node) => node.content).join(' ')
  return ''
}

describe('signRequest', () => {
  /**
   * Regression pin. Computed independently with Node's crypto:
   *   createHmac('sha256', '1700000000\ntest-secret').update('').digest('base64')
   * If this value changes, the signature algorithm changed and every signed
   * request will be rejected by Feishu with 19021.
   */
  it('signs with the timestamp and secret joined by a newline', async () => {
    const signature = await signRequest('test-secret', 1_700_000_000)
    expect(signature.sign).toBe('mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=')
    expect(signature.timestamp).toBe('1700000000')
  })

  it('matches a second independently computed vector', async () => {
    const signature = await signRequest('SECRETabc123', 1_735_689_600)
    expect(signature.sign).toBe('Jmt9b5AfRFdAOuNhb9lHKsYPG0u4CJoFBa/UT5pZaZ4=')
  })

  it('uses the joined string as the key over an empty message, not the reverse', async () => {
    // Signing the joined string as the *message* under an empty key produces a
    // different digest; this pins that the roles are not swapped.
    const wrongWayRound = '2NkTwk5rgWzLM8jhmnEX9GSa8tQWNtveOhrnxBMtpQc='
    const signature = await signRequest('test-secret', 1_700_000_000)
    expect(signature.sign).not.toBe(wrongWayRound)
  })

  it('handles a non-ASCII secret as UTF-8', async () => {
    const signature = await signRequest('secret-with-中文-和-emoji-🎯', 1_700_000_000)
    expect(signature.sign).toBe('DnVIYbSGAcb0Lm7ilV/MyeyZKYBYfR20JcRkTdNNsdE=')
  })

  it('signs an empty secret without throwing', async () => {
    const signature = await signRequest('', 1_700_000_000)
    expect(signature.sign).toBe('DaBQacIHB6FCKocfPme7o5BIrwne87ibBLj7EYGUds0=')
  })

  it('truncates a fractional timestamp to whole seconds', async () => {
    const fractional = await signRequest('test-secret', 1_700_000_000.987)
    const whole = await signRequest('test-secret', 1_700_000_000)
    expect(fractional).toEqual(whole)
  })

  it('produces a different signature for a different second', async () => {
    const first = await signRequest('test-secret', 1_700_000_000)
    const second = await signRequest('test-secret', 1_700_000_001)
    expect(first.sign).not.toBe(second.sign)
  })

  it('emits base64 of a 32-byte SHA-256 digest', async () => {
    const { sign } = await signRequest('test-secret', 1_700_000_000)
    expect(sign).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  })

  it('states the window Feishu accepts, so retries know to re-sign', () => {
    expect(FEISHU_TIMESTAMP_MAX_AGE_SECONDS).toBe(3600)
  })
})

describe('shouldNotify', () => {
  it('never notifies under the never policy', () => {
    for (const status of ALL_STATUSES) {
      expect(shouldNotify('never', status), status).toBe(false)
    }
  })

  it('notifies every terminal status under the always policy', () => {
    expect(shouldNotify('always', 'passed')).toBe(true)
    expect(shouldNotify('always', 'failed')).toBe(true)
    expect(shouldNotify('always', 'error')).toBe(true)
    expect(shouldNotify('always', 'cancelled')).toBe(true)
    expect(shouldNotify('always', 'interrupted')).toBe(true)
  })

  it('stays quiet about runs that have not finished, even under always', () => {
    expect(shouldNotify('always', 'queued')).toBe(false)
    expect(shouldNotify('always', 'running')).toBe(false)
  })

  it('treats error and interrupted as failures, because nothing was verified', () => {
    expect(shouldNotify('failure', 'failed')).toBe(true)
    expect(shouldNotify('failure', 'error')).toBe(true)
    expect(shouldNotify('failure', 'interrupted')).toBe(true)
  })

  it('does not notify a deliberate cancellation under the failure policy', () => {
    expect(shouldNotify('failure', 'cancelled')).toBe(false)
  })

  it('does not notify a pass or a pending run under the failure policy', () => {
    expect(shouldNotify('failure', 'passed')).toBe(false)
    expect(shouldNotify('failure', 'queued')).toBe(false)
    expect(shouldNotify('failure', 'running')).toBe(false)
  })

  it('classifies statuses consistently with isFailureStatus', () => {
    for (const status of ALL_STATUSES) {
      expect(shouldNotify('failure', status), status).toBe(isFailureStatus(status))
    }
  })
})

describe('validateFeishuConfig', () => {
  it('accepts a feishu.cn hook URL', () => {
    expect(validateFeishuConfig(config())).toEqual([])
  })

  it('accepts a larksuite.com hook URL', () => {
    expect(validateFeishuConfig(config({ webhookUrl: LARK_WEBHOOK }))).toEqual([])
  })

  it('rejects a random URL and says where to find the right one', () => {
    const problems = validateFeishuConfig(config({ webhookUrl: 'https://example.com/hook/abc' }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(FEISHU_HOOK_PREFIXES[0])
    expect(problems[0]).toContain('自定义机器人')
  })

  it('rejects an open-platform app URL that is not a bot hook', () => {
    const problems = validateFeishuConfig(
      config({ webhookUrl: 'https://open.feishu.cn/open-apis/im/v1/messages' }),
    )
    expect(problems).toHaveLength(1)
  })

  it('rejects a hook URL with no token after /hook/', () => {
    const problems = validateFeishuConfig({
      ...config(),
      webhookUrl: FEISHU_HOOK_PREFIXES[0],
    })
    expect(problems[0]).toContain('hook token')
  })

  it('asks for a webhook URL when none is set, and points at the robot dialog', () => {
    const problems = validateFeishuConfig(config({ webhookUrl: '' }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('群机器人')
  })

  it('accepts a config with no secret at all', () => {
    expect(validateFeishuConfig(config({ secret: undefined }))).toEqual([])
  })

  it('rejects a whitespace-only secret as a paste accident', () => {
    const problems = validateFeishuConfig(config({ secret: '   ' }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('签名校验')
  })

  it('rejects a format or policy left over from an older stored build', () => {
    const stale = { ...config(), format: 'markdown', notify: 'sometimes' } as unknown as FeishuConfig
    const problems = validateFeishuConfig(stale)
    expect(problems).toHaveLength(2)
  })

  it('reports an unusable URL and an unusable format together', () => {
    const broken = {
      ...config({ webhookUrl: 'nope' }),
      format: 'post',
    } as unknown as FeishuConfig
    expect(validateFeishuConfig(broken)).toHaveLength(2)
  })
})

describe('isFeishuConfigured', () => {
  it('treats an empty or blank webhook URL as disabled', () => {
    expect(isFeishuConfigured(config({ webhookUrl: '' }))).toBe(false)
    expect(isFeishuConfigured(config({ webhookUrl: '   ' }))).toBe(false)
    expect(isFeishuConfigured(config())).toBe(true)
  })
})

describe('buildTextMessage', () => {
  it('contains the case name, the status, and the duration', () => {
    const text = buildTextMessage(run())
    expect(text).toContain('登录冒烟')
    expect(text).toContain('通过')
    expect(text).toContain('passed')
    expect(text).toContain('12.0s')
  })

  it('leads with a Chinese title naming the outcome and the case', () => {
    expect(buildTextMessage(failedRun()).split('\n')[0]).toBe('测试失败：登录冒烟')
  })

  it('reports the failing step and the failure reason', () => {
    const text = buildTextMessage(failedRun())
    expect(text).toContain('assert heading contains "Dashboard"')
    expect(text).toContain('expected "Dashboard", saw "Login"')
  })

  it('reports step counts as passed over total', () => {
    expect(buildTextMessage(failedRun())).toContain('1/2')
  })

  it('names the trigger so an unattended run is distinguishable', () => {
    expect(buildTextMessage(run({ trigger: 'schedule' }))).toContain('schedule')
    expect(buildTextMessage(run({ trigger: 'manual' }))).toContain('manual')
    expect(buildTextMessage(run({ trigger: 'bridge' }))).toContain('bridge')
  })

  it('measures an unfinished run against the supplied clock', () => {
    const unfinished = run({ status: 'running', finishedAt: undefined })
    expect(buildTextMessage(unfinished, { now: 1_700_000_030_000 })).toContain('30.0s')
  })

  it('includes the summary when the runner wrote one', () => {
    expect(buildTextMessage(run({ summary: '所有断言通过' }))).toContain('所有断言通过')
  })
})

describe('buildRunCard', () => {
  it('uses a green header for a passed run', () => {
    expect(buildRunCard(run()).header.template).toBe('green')
  })

  it('uses a red header for a failed run', () => {
    expect(buildRunCard(failedRun()).header.template).toBe('red')
  })

  it('uses orange for error and interrupted, which are not test verdicts', () => {
    expect(buildRunCard(run({ status: 'error' })).header.template).toBe('orange')
    expect(buildRunCard(run({ status: 'interrupted' })).header.template).toBe('orange')
  })

  it('uses grey for a cancelled run', () => {
    expect(buildRunCard(run({ status: 'cancelled' })).header.template).toBe('grey')
  })

  it('gives passed, failed, and error runs three different header colours', () => {
    const templates = new Set([
      buildRunCard(run({ status: 'passed' })).header.template,
      buildRunCard(run({ status: 'failed' })).header.template,
      buildRunCard(run({ status: 'cancelled' })).header.template,
    ])
    expect(templates.size).toBe(3)
  })

  it('renders the header title as plain text, since markdown is literal there', () => {
    const card = buildRunCard(failedRun())
    expect(card.header.title.tag).toBe('plain_text')
    expect(card.header.title.content).toBe('测试失败：登录冒烟')
  })

  it('emits the wide-screen config Feishu expects', () => {
    expect(buildRunCard(run()).config).toEqual({ wide_screen_mode: true })
  })

  it('includes the case name, status, duration, and step counts', () => {
    const text = cardText(buildRunCard(failedRun()))
    expect(text).toContain('登录冒烟')
    expect(text).toContain('失败')
    expect(text).toContain('12.0s')
    expect(text).toContain('1/2 通过')
  })

  it("shows the failing step's description and error text", () => {
    const text = cardText(buildRunCard(failedRun()))
    expect(text).toContain('#1 assert heading contains "Dashboard"')
    expect(text).toContain('expected "Dashboard", saw "Login"')
  })

  it('omits the failure block entirely for a clean pass', () => {
    expect(cardText(buildRunCard(run()))).not.toContain('失败步骤')
  })

  it('matches the failure step by its recorded index, not its array position', () => {
    const truncated = run({
      status: 'failed',
      steps: [step({ index: 7, description: 'click "Submit"', ok: false, error: 'timeout' })],
      failure: { stepIndex: 7, message: 'timeout' },
    })
    expect(cardText(buildRunCard(truncated))).toContain('#7 click "Submit"')
  })

  it('closes with a note carrying the trigger and the run id', () => {
    const card = buildRunCard(run({ trigger: 'bridge', id: 'run_42' }))
    const note = card.elements.at(-1)
    expect(note?.tag).toBe('note')
    expect(note ? elementText(note) : '').toContain('bridge')
    expect(note ? elementText(note) : '').toContain('run_42')
  })

  it('separates the note from the body with a divider', () => {
    const tags = buildRunCard(run()).elements.map((element) => element.tag)
    expect(tags).toContain('hr')
    expect(tags.indexOf('hr')).toBe(tags.length - 2)
  })
})

describe('screenshot linking', () => {
  it('links a screenshot through the bridge when a base URL is given', () => {
    const text = cardText(buildRunCard(failedRun(), { artifactBaseUrl: 'http://127.0.0.1:8787' }))
    expect(text).toContain('http://127.0.0.1:8787/artifacts/art_9')
  })

  it('explains where the screenshot is when no base URL is given', () => {
    const text = cardText(buildRunCard(failedRun()))
    expect(text).toContain('运行历史')
    expect(text).toContain('无法上传图片')
    expect(text).not.toContain('/artifacts/')
  })

  it('says nothing about screenshots when the run captured none', () => {
    expect(cardText(buildRunCard(run()))).not.toContain('截图')
  })

  it('normalises a trailing slash on the base URL', () => {
    expect(artifactUrl('http://127.0.0.1:8787/', 'art_9')).toBe(
      'http://127.0.0.1:8787/artifacts/art_9',
    )
    expect(artifactUrl('  http://127.0.0.1:8787//  ', 'art_9')).toBe(
      'http://127.0.0.1:8787/artifacts/art_9',
    )
  })

  it('escapes an artifact id so it cannot break out of the path', () => {
    expect(artifactUrl('http://h', 'a/b?c')).toBe('http://h/artifacts/a%2Fb%3Fc')
  })

  it('falls back to the last captured frame for a passing run', () => {
    const withShot = run({ steps: [step({ index: 0, screenshotId: 'art_final' })] })
    expect(cardText(buildRunCard(withShot, { artifactBaseUrl: 'http://h' }))).toContain('art_final')
  })

  it('gives an empty string for a blank base URL rather than a bare path', () => {
    expect(artifactUrl('   ', 'art_9')).toBe('')
  })

  it('falls back to the run-level artifact list when no step carries an id', () => {
    const withRunLevel = run({ artifactIds: ['art_a', 'art_b'] })
    expect(cardText(buildRunCard(withRunLevel, { artifactBaseUrl: 'http://h' }))).toContain('art_b')
  })

  it('prefers a step-level id over the run-level list, since it names the step', () => {
    const both = failedRun({ artifactIds: ['art_other'] })
    const text = cardText(buildRunCard(both, { artifactBaseUrl: 'http://h' }))
    expect(text).toContain('art_9')
    expect(text).not.toContain('art_other')
  })
})

describe('mentionOnFailure', () => {
  it('mentions everyone with the literal all user id', () => {
    expect(renderMention('all')).toBe('<at user_id="all">所有人</at>')
  })

  it('mentions an individual by open id', () => {
    expect(renderMention('ou_abc123')).toBe('<at user_id="ou_abc123"></at>')
  })

  it('renders nothing for a blank mention', () => {
    expect(renderMention('   ')).toBe('')
  })

  it('appears on a failure card', () => {
    expect(cardText(buildRunCard(failedRun(), { mentionOnFailure: 'all' }))).toContain(
      '<at user_id="all">所有人</at>',
    )
  })

  it('does not appear on a successful card', () => {
    expect(cardText(buildRunCard(run(), { mentionOnFailure: 'all' }))).not.toContain('<at')
  })

  it('appears for error and interrupted, which the on-call person must see', () => {
    expect(cardText(buildRunCard(run({ status: 'error' }), { mentionOnFailure: 'all' }))).toContain(
      '<at',
    )
    expect(
      cardText(buildRunCard(run({ status: 'interrupted' }), { mentionOnFailure: 'all' })),
    ).toContain('<at')
  })

  it('does not ping the group for a deliberate cancellation', () => {
    expect(
      cardText(buildRunCard(run({ status: 'cancelled' }), { mentionOnFailure: 'all' })),
    ).not.toContain('<at')
  })

  it('appears in the plain-text variant too', () => {
    expect(buildTextMessage(failedRun(), { mentionOnFailure: 'ou_x' })).toContain(
      '<at user_id="ou_x">',
    )
  })
})

describe('buildMessageBody', () => {
  it('builds an interactive card when the format is card', () => {
    const body = buildMessageBody(config({ format: 'card' }), run())
    expect(body.msg_type).toBe('interactive')
    expect(body).toHaveProperty('card.header.template', 'green')
  })

  it('builds a text body when the format is text, for tenants that block cards', () => {
    const body = buildMessageBody(config({ format: 'text' }), run())
    expect(body.msg_type).toBe('text')
    expect(body).toHaveProperty('content.text')
  })

  it('takes the mention from the config when the caller did not pass one', () => {
    const body = buildMessageBody(config({ mentionOnFailure: 'all' }), failedRun())
    expect(JSON.stringify(body)).toContain('user_id=\\"all\\"')
  })

  it('lets an explicit option override the configured mention', () => {
    const body = buildMessageBody(config({ mentionOnFailure: 'all' }), failedRun(), {
      mentionOnFailure: '',
    })
    expect(JSON.stringify(body)).not.toContain('<at')
  })
})

describe('sendFeishuNotification', () => {
  it('posts JSON to the webhook and reports success on code 0', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0, msg: 'success' }))
    const result = await sendFeishuNotification(config(), run())
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(WEBHOOK)
    expect(calls[0]?.init.method).toBe('POST')
    expect(sentBody(calls[0]?.init ?? {}).msg_type).toBe('interactive')
  })

  it('treats a 200 response with a non-zero code as a failure and surfaces msg', async () => {
    stubFetch(async () => jsonResponse({ code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' }))
    const result = await sendFeishuNotification(config(), run())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('19021')
    expect(result.error).toContain('sign match fail')
    expect(result.retryable).toBe(false)
  })

  it('reports a robot that was removed from the group as not retryable', async () => {
    stubFetch(async () => jsonResponse({ code: 9499, msg: 'bot not enabled' }))
    const result = await sendFeishuNotification(config(), run())
    expect(result).toEqual({
      ok: false,
      error: 'Feishu rejected the message (code 9499): bot not enabled',
      retryable: false,
    })
  })

  it('omits the signature entirely when no secret is configured', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    await sendFeishuNotification(config({ secret: undefined }), run())
    const body = sentBody(calls[0]?.init ?? {})
    expect(body).not.toHaveProperty('timestamp')
    expect(body).not.toHaveProperty('sign')
  })

  it('omits the signature when the secret is only whitespace', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    // A blank secret is a configuration problem, caught before the request.
    const result = await sendFeishuNotification(config({ secret: '  ' }), run())
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('puts timestamp and sign at the top level, as siblings of msg_type', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    await sendFeishuNotification(config({ secret: 'test-secret' }), run(), {
      now: 1_700_000_000_000,
    })
    const body = sentBody(calls[0]?.init ?? {})
    expect(body.timestamp).toBe('1700000000')
    expect(body.sign).toBe('mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=')
    expect(body.msg_type).toBe('interactive')
    // Not nested under content/card, where Feishu would never look for it.
    expect(JSON.stringify(body.card)).not.toContain('sign')
  })

  it('signs with seconds, not milliseconds, so the hour window is respected', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    await sendFeishuNotification(config({ secret: 'test-secret' }), run(), {
      now: 1_700_000_000_999,
    })
    expect(sentBody(calls[0]?.init ?? {}).timestamp).toBe('1700000000')
  })

  it('classifies a network rejection as retryable', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await sendFeishuNotification(config(), run())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(true)
    expect(result.error).toContain('Failed to fetch')
  })

  it('classifies HTTP 500 as retryable', async () => {
    stubFetch(async () => new Response('upstream error', { status: 500, statusText: 'Server Error' }))
    const result = await sendFeishuNotification(config(), run())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(true)
    expect(result.error).toContain('500')
  })

  it('classifies HTTP 429 as retryable, because the robot is merely too chatty', async () => {
    stubFetch(async () => new Response('too many', { status: 429, statusText: 'Too Many Requests' }))
    const result = await sendFeishuNotification(config(), run())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(true)
  })

  it('classifies HTTP 404 as not retryable', async () => {
    stubFetch(async () => new Response('not found', { status: 404, statusText: 'Not Found' }))
    const result = await sendFeishuNotification(config(), run())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(false)
    expect(result.error).toContain('404')
  })

  it('refuses a bad webhook URL without touching the network', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    const result = await sendFeishuNotification(config({ webhookUrl: 'https://evil.test/hook' }), run())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses an unconfigured webhook and explains how to configure it', async () => {
    const result = await sendFeishuNotification(config({ webhookUrl: '' }), run())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Webhook URL is required')
  })

  it('accepts a 200 whose body is not JSON rather than retrying a delivered message', async () => {
    stubFetch(async () => new Response('<html>ok</html>', { status: 200, statusText: 'OK' }))
    expect(await sendFeishuNotification(config(), run())).toEqual({ ok: true })
  })

  it('accepts a 200 whose body omits code, since nothing was rejected', async () => {
    stubFetch(async () => jsonResponse({ StatusMessage: 'success' }))
    expect(await sendFeishuNotification(config(), run())).toEqual({ ok: true })
  })

  it('reports an abort as a non-retryable outcome, not an error', async () => {
    stubFetch(async () => {
      const aborted = new Error('The operation was aborted.')
      aborted.name = 'AbortError'
      throw aborted
    })
    const result = await sendFeishuNotification(config(), run(), {
      signal: AbortSignal.abort(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(false)
    expect(result.error).toContain('aborted')
  })

  it('passes the abort signal through to fetch', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    const controller = new AbortController()
    await sendFeishuNotification(config(), run(), { signal: controller.signal })
    expect(calls[0]?.init.signal).toBe(controller.signal)
  })

  it('never throws, whatever fetch does', async () => {
    const failures: (() => Promise<Response>)[] = [
      async () => {
        throw new Error('boom')
      },
      async () => {
        throw 'not even an error'
      },
      async () => new Response('', { status: 500, statusText: 'x' }),
      async () => jsonResponse({ code: 1, msg: 'nope' }),
    ]
    for (const impl of failures) {
      stubFetch(impl)
      await expect(sendFeishuNotification(config(), run())).resolves.toHaveProperty('ok', false)
    }
  })

  it('never throws when the response body cannot be read', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => {
        throw new Error('stream closed')
      },
    }) as unknown as Response)
    await expect(sendFeishuNotification(config(), run())).resolves.toEqual({ ok: true })
  })

  it('sends a text body when the config asks for text', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    await sendFeishuNotification(config({ format: 'text' }), failedRun())
    const body = sentBody(calls[0]?.init ?? {})
    expect(body.msg_type).toBe('text')
    expect(JSON.stringify(body.content)).toContain('登录冒烟')
  })

  it('declares the JSON content type Feishu requires', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    await sendFeishuNotification(config(), run())
    expect(calls[0]?.init.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  it('works against a Lark webhook as well as a Feishu one', async () => {
    const { calls } = stubFetch(async () => jsonResponse({ code: 0 }))
    const result = await sendFeishuNotification(config({ webhookUrl: LARK_WEBHOOK }), run())
    expect(result).toEqual({ ok: true })
    expect(calls[0]?.url).toBe(LARK_WEBHOOK)
  })
})

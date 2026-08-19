#!/usr/bin/env -S npx tsx
/**
 * The `webtest-pilot` command line.
 *
 * Two audiences, one binary. A developer runs `serve` once and leaves it up; CI
 * runs `run --wait --junit` and cares about exactly one thing — the exit code.
 * Everything here is arranged around that: a non-zero exit whenever the tested
 * application did not pass, and human-readable Chinese-first output for the paths a
 * person actually reads.
 *
 * This is the only file that may call `process.exit`. The server is a library, so
 * exit codes are decided where the command's intent is known.
 *
 * @module bridge/main
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve as resolvePath } from 'node:path'

import type { BridgeError, CreateRunResponse, HealthResponse, RunDetail } from '../src/lib/protocol'
import { formatDuration, formatTime } from '../src/lib/time'
import { isTerminalStatus, type TestCase, type TestRun } from '../src/lib/types'

import { toJUnitXml } from './junit'
import { createBridgeServer } from './server'
import { configPath, loadConfig, resetToken } from './store'

/** Exit code for "the tool worked, the test did not pass" — what CI branches on. */
const EXIT_TEST_FAILED = 1
/** Exit code for "the tool could not do its job": no bridge, bad arguments. */
const EXIT_TOOL_ERROR = 2

const HELP = `webtest-pilot — WebTest Pilot 本地桥接 (local bridge)

用法 (usage):
  webtest-pilot serve [--port N]              启动桥接服务 / start the bridge server
  webtest-pilot run <caseId|file.md> [选项]    触发一次运行 / start a run
  webtest-pilot cases [--json]                列出用例 / list cases
  webtest-pilot runs [--json] [--limit N]     列出最近运行 / list recent runs
  webtest-pilot health                        检查桥接与扩展状态 / check bridge + extension
  webtest-pilot token [--reset]               查看或重置 token / show or rotate the token

run 选项 (options):
  --wait                 等待运行结束，未通过则退出码非零 / block until finished; non-zero exit unless passed
  --timeout N            等待上限，秒 / wait cap in seconds (default 300)
  --junit <out.xml>      写出 JUnit 报告 / write a JUnit XML report (implies --wait)
  --agent                强制使用 agent 而非回放脚本 / force the agent instead of replaying a script
  --save                 把 Markdown 用例保存到扩展 / persist a Markdown case in the extension

环境变量 (environment):
  WEBTEST_PILOT_URL      桥接地址 / bridge base URL (default http://127.0.0.1:<config port>)
  WEBTEST_PILOT_TOKEN    桥接 token / bridge token, overriding the config file
  WEBTEST_PILOT_HOME     配置目录 / config directory (default ~/.webtest-pilot)

CI 里通常只需要 (a CI job usually needs only):
  webtest-pilot run cases/login.md --wait --junit report.xml
`

/** Parsed argv: a command, its positional arguments, and its flags. */
interface ParsedArgs {
  command: string
  positional: string[]
  flags: Map<string, string | true>
}

/**
 * Minimal argv parser.
 *
 * Hand-rolled rather than a dependency: the grammar is `--flag`, `--flag value`,
 * and `--flag=value`, and a CLI that CI installs should not pull a parser in for
 * that. Unknown flags are kept rather than rejected so a future flag added to a
 * pipeline does not break against an older bridge with a confusing usage error.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  let command = ''

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const equals = body.indexOf('=')
      if (equals >= 0) {
        flags.set(body.slice(0, equals), body.slice(equals + 1))
        continue
      }
      const next = argv[index + 1]
      // A following token that looks like a flag is not this flag's value.
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next)
        index += 1
      } else {
        flags.set(body, true)
      }
      continue
    }
    if (command === '') command = token
    else positional.push(token)
  }
  return { command, positional, flags }
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function flagSet(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name)
}

// --- HTTP client -------------------------------------------------------------

/** Where and how to reach a running bridge. */
interface ClientContext {
  baseUrl: string
  token: string
}

/**
 * Resolves the bridge address and token.
 *
 * The env overrides come first because CI has no `~/.webtest-pilot`: the token
 * arrives as a masked pipeline variable, and the URL may point at a bridge on
 * another loopback port. Falling back to the config file is what makes the
 * interactive case need no arguments at all.
 */
async function clientContext(): Promise<ClientContext> {
  const envToken = process.env.WEBTEST_PILOT_TOKEN?.trim()
  const envUrl = process.env.WEBTEST_PILOT_URL?.trim()
  if (envToken && envUrl) return { baseUrl: stripSlash(envUrl), token: envToken }

  const config = await loadConfig()
  return {
    baseUrl: stripSlash(envUrl && envUrl.length > 0 ? envUrl : `http://127.0.0.1:${config.port}`),
    token: envToken && envToken.length > 0 ? envToken : config.token,
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** An HTTP error carrying the bridge's own `BridgeError`, when it sent one. */
class RequestFailed extends Error {
  constructor(
    readonly status: number,
    readonly code: BridgeError['code'] | 'network',
    message: string,
  ) {
    super(message)
    this.name = 'RequestFailed'
  }
}

/**
 * One authenticated call to the bridge.
 *
 * A connection refusal is translated on the spot, because "fetch failed" tells a
 * user nothing and the actual cause is almost always the same one: the bridge is
 * not running.
 */
async function request<T>(
  context: ClientContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${context.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${context.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new RequestFailed(
      0,
      'network',
      `无法连接桥接 ${context.baseUrl} / could not reach the bridge: ${
        error instanceof Error ? error.message : String(error)
      }. 先运行 \`webtest-pilot serve\`.`,
    )
  }

  const text = await response.text()
  if (!response.ok) {
    let code: BridgeError['code'] = 'internal'
    let message = text.slice(0, 500)
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        if (typeof record.error === 'string') message = record.error
        if (typeof record.code === 'string') code = record.code as BridgeError['code']
      }
    } catch {
      // Not JSON; the raw text is the best available message.
    }
    throw new RequestFailed(response.status, code, message)
  }
  if (text.length === 0) return undefined as T
  return JSON.parse(text) as T
}

// --- commands ----------------------------------------------------------------

/**
 * `serve` — run the bridge until interrupted.
 *
 * The token is printed in full. That looks alarming for a credential, but it is
 * the entire setup procedure: the user has to copy it into the extension's
 * settings, and hiding it would only send them hunting through a JSON file.
 */
async function commandServe(args: ParsedArgs): Promise<number> {
  const config = await loadConfig()
  const port = flagNumber(args, 'port') ?? (flagSet(args, 'port') ? 0 : config.port)

  const server = await createBridgeServer({
    token: config.token,
    port,
    maxConcurrent: config.maxConcurrent,
    onLog: (level, message) => {
      const stream = level === 'error' ? process.stderr : process.stdout
      stream.write(`[bridge:${level}] ${message}\n`)
    },
  })

  process.stdout.write(
    [
      'WebTest Pilot 桥接已启动 / bridge is listening',
      `  地址 (URL)          ${server.url}`,
      `  WebSocket           ${server.url.replace(/^http/, 'ws')}/extension`,
      `  配置 (config)       ${configPath()}`,
      `  并发上限            ${config.maxConcurrent} (maxConcurrent)`,
      `  token               ${config.token}`,
      '',
      '下一步：打开 Chrome → WebTest Pilot → Settings → Local bridge，勾选 Enabled，把上面的 token 粘贴进去。',
      '(Next: paste that token into the extension settings and enable the bridge.)',
      '按 Ctrl+C 退出 / Ctrl+C to stop.',
      '',
    ].join('\n'),
  )

  // Resolve only on a signal, so `serve` behaves like a daemon in the foreground.
  await new Promise<void>((resolve) => {
    let stopping = false
    const stop = (signal: string): void => {
      // A second Ctrl+C during shutdown must not start a second shutdown; the
      // first one is already ending sockets and streams.
      if (stopping) return
      stopping = true
      process.stdout.write(`\n收到 ${signal}，正在关闭桥接 / shutting down…\n`)
      server
        .close()
        .catch((error: unknown) => {
          process.stderr.write(`关闭时出错 / error while closing: ${describe(error)}\n`)
        })
        .finally(() => resolve())
    }
    process.once('SIGINT', () => stop('SIGINT'))
    process.once('SIGTERM', () => stop('SIGTERM'))
  })
  return 0
}

/**
 * `run` — start a run, optionally waiting for its verdict.
 *
 * A `.md` path is read and sent as `markdown` rather than uploaded by name,
 * because the case file lives in the repo being tested and the extension has no
 * access to the CI checkout.
 */
async function commandRun(args: ParsedArgs): Promise<number> {
  const target = args.positional[0]
  if (target === undefined || target.length === 0) {
    process.stderr.write('缺少参数：用例 id 或 .md 文件路径 / expected a case id or a path to a .md file.\n')
    return EXIT_TOOL_ERROR
  }

  const context = await clientContext()
  const body: Record<string, unknown> = {}

  if (/\.md$/i.test(target)) {
    const path = resolvePath(target)
    let markdown: string
    try {
      markdown = await readFile(path, 'utf8')
    } catch (error) {
      process.stderr.write(`读取用例文件失败 / could not read ${path}: ${describe(error)}\n`)
      return EXIT_TOOL_ERROR
    }
    body.markdown = markdown
    if (flagSet(args, 'save')) body.save = true
  } else {
    body.caseId = target
  }
  if (flagSet(args, 'agent')) body.useAgent = true

  const junitPath = flagString(args, 'junit')
  // A JUnit report needs a finished run, so asking for one implies waiting; the
  // alternative is silently writing a report of a run that had not started yet.
  const wait = flagSet(args, 'wait') || junitPath !== undefined
  const timeoutSeconds = flagNumber(args, 'timeout')
  if (wait) {
    body.wait = true
    if (timeoutSeconds !== undefined) body.timeoutSeconds = timeoutSeconds
  }

  if (!wait) {
    const created = await request<CreateRunResponse>(context, 'POST', '/api/runs', body)
    process.stdout.write(
      [
        `已开始运行 / run started: ${created.runId}`,
        `  模式 (mode)   ${created.mode}`,
        `  事件流        ${created.eventsUrl}`,
        '',
      ].join('\n'),
    )
    return 0
  }

  const detail = await request<RunDetail>(context, 'POST', '/api/runs', body)
  process.stdout.write(formatRunSummary(detail))

  if (junitPath !== undefined) {
    const xml = toJUnitXml([detail], { suiteName: basename(target) })
    await writeFile(resolvePath(junitPath), xml, 'utf8')
    process.stdout.write(`JUnit 报告已写入 / wrote ${resolvePath(junitPath)}\n`)
  }

  // The contract with CI: only `passed` is a green build. `cancelled` included —
  // a run someone stopped is not evidence that the application works.
  return detail.status === 'passed' ? 0 : EXIT_TEST_FAILED
}

/** Multi-line, human-first report of one finished run. */
function formatRunSummary(run: RunDetail): string {
  const lines: string[] = [
    '',
    `用例 (case)     ${run.caseName}`,
    `运行 (run)      ${run.id}`,
    `结果 (status)   ${statusLabel(run.status)}`,
    `模式 (mode)     ${run.mode}`,
    `开始 (started)  ${formatTime(run.startedAt)}`,
    `耗时 (duration) ${formatDuration(
      run.finishedAt === undefined ? undefined : run.finishedAt - run.startedAt,
    )}`,
    `步骤 (steps)    ${run.steps.filter((step) => step.ok).length}/${run.steps.length} ok`,
  ]
  if (run.summary) lines.push(`摘要 (summary)  ${run.summary}`)
  if (run.failure) {
    lines.push('', `失败步骤 #${run.failure.stepIndex}: ${run.failure.message}`)
  }
  // Only failing steps are listed: a passing 60-step run should not bury its own
  // verdict under 60 lines of noise in a CI log.
  const failed = run.steps.filter((step) => !step.ok)
  if (failed.length > 0) {
    lines.push('', '失败细节 (failed steps):')
    for (const step of failed) {
      lines.push(`  #${step.index} ${step.description} — ${step.error ?? 'failed'}`)
    }
  }
  if (run.artifacts.length > 0) {
    lines.push('', '截图 (screenshots):')
    for (const artifact of run.artifacts) lines.push(`  step #${artifact.stepIndex}: ${artifact.url}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Chinese label plus the raw status, so both a human and a grep can read it. */
function statusLabel(status: TestRun['status']): string {
  const labels: Record<TestRun['status'], string> = {
    queued: '排队中',
    running: '运行中',
    passed: '通过',
    failed: '未通过',
    error: '执行错误',
    cancelled: '已取消',
    interrupted: '被中断',
  }
  return `${labels[status]} (${status})`
}

async function commandCases(args: ParsedArgs): Promise<number> {
  const context = await clientContext()
  const response = await request<{ cases: TestCase[] }>(context, 'GET', '/api/cases')
  const cases = response.cases ?? []
  if (flagSet(args, 'json')) {
    process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`)
    return 0
  }
  if (cases.length === 0) {
    process.stdout.write('还没有用例 / no cases yet. 在扩展里新建，或 POST /api/cases 上传 Markdown。\n')
    return 0
  }
  process.stdout.write(`共 ${cases.length} 个用例 / ${cases.length} case(s)\n`)
  for (const item of cases) {
    const script = item.scriptId ? ' [已录制脚本 / has script]' : ''
    process.stdout.write(`  ${item.id}  ${item.name}${script}\n`)
    if (item.startUrl) process.stdout.write(`      ${item.startUrl}\n`)
  }
  return 0
}

async function commandRuns(args: ParsedArgs): Promise<number> {
  const context = await clientContext()
  const limit = flagNumber(args, 'limit')
  const query = limit === undefined ? '' : `?limit=${limit}`
  const response = await request<{ runs: TestRun[] }>(context, 'GET', `/api/runs${query}`)
  const runs = response.runs ?? []
  if (flagSet(args, 'json')) {
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`)
    return 0
  }
  if (runs.length === 0) {
    process.stdout.write('还没有运行记录 / no runs yet.\n')
    return 0
  }
  process.stdout.write(`最近 ${runs.length} 次运行 / ${runs.length} recent run(s)\n`)
  for (const run of runs) {
    const duration = run.finishedAt === undefined ? undefined : run.finishedAt - run.startedAt
    const pending = isTerminalStatus(run.status) ? '' : ' …'
    process.stdout.write(
      `  ${formatTime(run.startedAt)}  ${statusLabel(run.status).padEnd(20)} ${formatDuration(duration).padStart(
        8,
      )}  ${run.caseName}${pending}\n`,
    )
    process.stdout.write(`      ${run.id}\n`)
  }
  return 0
}

/**
 * `health` — is the whole chain up?
 *
 * Exits non-zero when the extension is absent, because that is what a pipeline's
 * pre-flight step needs: a bridge with no browser behind it cannot run anything,
 * and finding that out before the test stage saves a confusing failure later.
 */
async function commandHealth(): Promise<number> {
  const context = await clientContext()
  const health = await request<HealthResponse>(context, 'GET', '/health')
  process.stdout.write(
    [
      `桥接 (bridge)       ok, v${health.bridgeVersion}, protocol ${health.protocolVersion}`,
      `地址 (URL)          ${context.baseUrl}`,
      `运行时长 (uptime)   ${formatDuration(health.uptimeSeconds * 1000)}`,
      `扩展 (extension)    ${health.extensionConnected ? '已连接 / connected' : '未连接 / NOT connected'}`,
      `模型 (provider)     ${health.providerReady ? '已配置 / ready' : '未配置 / not configured'}`,
      `允许站点 (sites)    ${health.allowedSiteCount}`,
      `运行中 (running)    ${health.runningRuns}`,
      `排队中 (queued)     ${health.queuedRuns}`,
      '',
    ].join('\n'),
  )
  if (!health.extensionConnected) {
    process.stderr.write(
      '扩展未连接：打开 Chrome，在 WebTest Pilot → Settings → Local bridge 里启用桥接并粘贴 token。\n' +
        '(The extension is not connected; nothing can run until it is.)\n',
    )
    return EXIT_TOOL_ERROR
  }
  if (health.allowedSiteCount === 0) {
    // Not fatal: the chain is up. But an unattended run will refuse, so say so now.
    process.stderr.write(
      '提示：还没有允许的站点，无人值守的运行会被拒绝 / no allowed sites yet; unattended runs will refuse to start.\n',
    )
  }
  return 0
}

async function commandToken(args: ParsedArgs): Promise<number> {
  if (flagSet(args, 'reset')) {
    const rotated = await resetToken()
    process.stdout.write(
      [
        `新 token / new token: ${rotated.token}`,
        `配置 (config)        ${configPath()}`,
        '',
        '旧 token 立即失效：重启 `webtest-pilot serve`，并把新 token 粘贴到扩展设置里。',
        '(The old token is dead. Restart the bridge and update the extension.)',
        '',
      ].join('\n'),
    )
    return 0
  }
  const config = await loadConfig()
  process.stdout.write(`${config.token}\n`)
  return 0
}

// --- entry -------------------------------------------------------------------

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Dispatches one command and returns its exit code. Never exits itself. */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === '' || args.command === 'help' || flagSet(args, 'help') || flagSet(args, 'h')) {
    process.stdout.write(HELP)
    // Zero: `--help` was answered correctly. A bare invocation also prints help
    // and exits zero, because a human exploring the tool has not made an error.
    return 0
  }

  try {
    switch (args.command) {
      case 'serve':
        return await commandServe(args)
      case 'run':
        return await commandRun(args)
      case 'cases':
        return await commandCases(args)
      case 'runs':
        return await commandRuns(args)
      case 'health':
        return await commandHealth()
      case 'token':
        return await commandToken(args)
      default:
        process.stderr.write(`未知命令 ${args.command} / unknown command.\n\n${HELP}`)
        return EXIT_TOOL_ERROR
    }
  } catch (error) {
    if (error instanceof RequestFailed) {
      process.stderr.write(`${error.message}\n`)
      // A 4xx/5xx from a reachable bridge is still a tool problem, not a test
      // verdict: only `run --wait` decides a test verdict, and it returns instead
      // of throwing when it gets one.
      return EXIT_TOOL_ERROR
    }
    process.stderr.write(`出错 / error: ${describe(error)}\n`)
    return EXIT_TOOL_ERROR
  }
}

/**
 * Run only when invoked as a program.
 *
 * The guard lets the test suite import {@link parseArgs} without the CLI trying to
 * dispatch vitest's own argv.
 */
const invokedDirectly = process.argv[1] !== undefined && /main\.ts$|webtest-pilot$/.test(process.argv[1])
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`致命错误 / fatal: ${describe(error)}\n`)
      process.exitCode = EXIT_TOOL_ERROR
    })
}

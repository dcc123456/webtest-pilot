/**
 * The local bridge: HTTP for tooling, WebSocket for the extension.
 *
 * The direction of the socket is forced by the platform. A Chrome extension
 * cannot listen on a port, and nothing outside the browser can call into a
 * service worker, so the extension dials *out* to this process and this process
 * is the server. Every REST call therefore becomes a relayed request over an
 * already-open socket, and every failure mode of that arrangement — no browser
 * running, a socket that died without saying so, an extension that never answers
 * — has to be an explicit, actionable HTTP response rather than a hang.
 *
 * This module never calls `process.exit`: it is a library the CLI and the test
 * suite both drive, and a library that kills the process cannot be tested.
 *
 * @module bridge/server
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer, type WebSocket } from 'ws'

import {
  PROTOCOL_VERSION,
  parseFrame,
  serializeFrame,
  type BridgeError,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeRequest,
  type CasesResponse,
  type CreateRunBody,
  type CreateRunResponse,
  type HealthResponse,
  type HelloPayload,
  type RunDetail,
  type ScriptsResponse,
  type StartRunResult,
} from '../src/lib/protocol'
import { isTerminalStatus, type RunStatus, type TestRun } from '../src/lib/types'

/** Version reported by `/health` when the caller does not supply one. */
const DEFAULT_BRIDGE_VERSION = '0.1.0'

/** How long a relayed request may stay unanswered before it is failed. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Ping period. Also the worst-case delay in noticing a dead socket. */
const DEFAULT_HEARTBEAT_MS = 30_000

/** SSE comment period, well under the 60s idle timeout of common proxies. */
const DEFAULT_SSE_HEARTBEAT_MS = 15_000

/** Default cap on `wait=true`, matching the extension's own run budget plus slack. */
const DEFAULT_WAIT_SECONDS = 330

/**
 * Backstop on an active-run slot.
 *
 * The queue slot is normally freed by a terminal run event. If the extension is
 * killed mid-run — the browser quits, the service worker is evicted — that event
 * never arrives, and without a lease the bridge would report `busy` forever and
 * need a restart.
 */
const DEFAULT_RUN_LEASE_MS = 900_000

/** Largest request body accepted, so a stray upload cannot exhaust memory. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Per-run event history kept for a late SSE subscriber. */
const MAX_EVENTS_PER_RUN = 500

/** How many runs keep an event history at all, evicted oldest-first. */
const MAX_TRACKED_RUNS = 64

/** Options for {@link createBridgeServer}. */
export interface BridgeServerOptions {
  /** Shared secret required on every `/api/*` call and on the WS upgrade. */
  token: string
  /** TCP port. 0 means "any free port", which is what the tests use. */
  port?: number
  /** Parallel runs allowed. See the note on {@link BridgeServerHandle} for the policy. */
  maxConcurrent?: number
  /** Relay timeout in ms. Tests shorten it so a hang is observable in a second. */
  requestTimeoutMs?: number
  /** WebSocket ping period in ms. */
  heartbeatMs?: number
  /** SSE keep-alive comment period in ms. */
  sseHeartbeatMs?: number
  /** Reported by `/health`. */
  bridgeVersion?: string
  /** Active-run lease in ms; see {@link DEFAULT_RUN_LEASE_MS}. */
  runLeaseMs?: number
  /** Optional sink for diagnostics. Silent by default so tests stay readable. */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** What a caller — the CLI or a test — can do with a running bridge. */
export interface BridgeServerHandle {
  /** `http://127.0.0.1:<port>`, resolved after listen so port 0 is usable. */
  url: string
  port: number
  /** Connected, handshaken extensions. An array so tests can read `.length`. */
  readonly connectedExtensions: HelloPayload[]
  /** Resolves true once an extension has completed `hello`, false on timeout. */
  waitForExtension(timeoutMs: number): Promise<boolean>
  /** Shuts everything down: sockets, streams, timers, listener. */
  close(): Promise<void>
}

/** One live extension socket and the requests outstanding on it. */
interface ExtensionLink {
  socket: WebSocket
  pending: Map<string, PendingCall>
  hello: HelloPayload | null
  /** Set by the pong handler; cleared before each ping. */
  alive: boolean
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** A live SSE subscriber. */
interface EventSubscriber {
  runId: string
  send: (event: BridgeEvent) => void
  end: () => void
}

/** An error carrying the HTTP status and machine code to report. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: BridgeError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Actionable text for the most common failure by far: the browser is not open. */
const NOT_CONNECTED_MESSAGE =
  'No extension is connected. Open Chrome, then enable the bridge in WebTest Pilot → Settings → Local bridge and paste the bridge token there.'

/**
 * Starts the bridge.
 *
 * Binding is unconditionally to `127.0.0.1`: this server can start browser
 * automation against whatever the user is logged into, so it must not be
 * reachable from the office LAN, a container's host network, or a coffee-shop
 * Wi-Fi. There is no option to widen it, because "just for a minute" is how such
 * an option always gets used.
 */
export async function createBridgeServer(options: BridgeServerOptions): Promise<BridgeServerHandle> {
  const token = options.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('A bridge token is required; the bridge refuses to run without authentication.')
  }

  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 1))
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const sseHeartbeatMs = options.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS
  const bridgeVersion = options.bridgeVersion ?? DEFAULT_BRIDGE_VERSION
  const runLeaseMs = options.runLeaseMs ?? DEFAULT_RUN_LEASE_MS
  const log = options.onLog ?? (() => {})

  const startedAt = Date.now()
  const links = new Set<ExtensionLink>()
  const subscribers = new Set<EventSubscriber>()
  /** Last status seen per run, so `wait` and SSE need not re-query the extension. */
  const runStatuses = new Map<string, RunStatus>()
  /** Replay buffer per run; see {@link MAX_EVENTS_PER_RUN}. */
  const runEvents = new Map<string, BridgeEvent[]>()
  /** Runs occupying a concurrency slot, with their lease timers. */
  const activeRuns = new Map<string, NodeJS.Timeout>()
  /**
   * Slots taken by a `startRun` that has been sent but not yet answered.
   *
   * Counted separately from {@link activeRuns} because the run id does not exist
   * yet. Without it, two `POST /api/runs` arriving in the same tick would both pass
   * the concurrency check — `await` hands control back to the event loop — and two
   * runs would fight over the one browser, which is precisely what the limit exists
   * to prevent.
   */
  let reservedSlots = 0
  const extensionWaiters = new Set<() => void>()
  /** Live SSE responses, so `close()` can end them instead of hanging on them. */
  const openStreams = new Set<ServerResponse>()
  let closing = false

  // --- token comparison ------------------------------------------------------

  /**
   * Constant-time token comparison.
   *
   * `timingSafeEqual` throws on a length mismatch, so length is checked first;
   * that leaks only the length, which is a fixed 64 hex characters and therefore
   * not a secret. Comparing with `===` would leak a per-character timing signal
   * that is genuinely exploitable against a local server an attacker can hammer.
   */
  function tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(token, 'utf8')
    const given = Buffer.from(candidate, 'utf8')
    if (expected.length !== given.length) return false
    return timingSafeEqual(expected, given)
  }

  // --- extension plumbing ----------------------------------------------------

  /** The link a relay should use: the first one that finished its handshake. */
  function readyLink(): ExtensionLink | undefined {
    for (const link of links) {
      if (link.hello) return link
    }
    return undefined
  }

  function send(link: ExtensionLink, frame: BridgeRequest): void {
    link.socket.send(serializeFrame(frame))
  }

  /**
   * Sends one request and resolves with the extension's result.
   *
   * The timeout is not optional politeness: without it, an extension that dropped
   * the frame — a service worker evicted between receive and reply — would leave
   * this HTTP request open until the client gave up, and the client is usually a
   * CI job whose own timeout is measured in minutes.
   */
  function callOn(
    link: ExtensionLink,
    method: BridgeMethod,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the entry first: a late reply must not resolve a settled promise.
        link.pending.delete(id)
        reject(
          new HttpError(
            504,
            'internal',
            `扩展未在 ${Math.round(timeoutMs / 1000)}s 内响应 ${method}。The extension did not answer; check that Chrome is awake and the extension's bridge is enabled.`,
          ),
        )
      }, timeoutMs)
      // The bridge should not hold the event loop open on a pending relay.
      timer.unref()
      link.pending.set(id, { resolve, reject, timer })
      try {
        send(link, { kind: 'request', id, method, ...(params ? { params } : {}) })
      } catch (error) {
        clearTimeout(timer)
        link.pending.delete(id)
        reject(new HttpError(503, 'not_connected', `无法发送到扩展 / could not write to the extension socket: ${describe(error)}`))
      }
    })
  }

  /** Relays to whichever extension is connected, or fails with `not_connected`. */
  function call(
    method: BridgeMethod,
    params?: Record<string, unknown>,
    timeoutMs = requestTimeoutMs,
  ): Promise<unknown> {
    const link = readyLink()
    if (!link) throw new HttpError(503, 'not_connected', NOT_CONNECTED_MESSAGE)
    return callOn(link, method, params, timeoutMs)
  }

  /** Rejects every outstanding call on a link. Called when its socket dies. */
  function failPending(link: ExtensionLink, reason: string): void {
    for (const [id, entry] of link.pending) {
      clearTimeout(entry.timer)
      link.pending.delete(id)
      // A pending request whose transport vanished can never be answered; letting
      // it sit until its own timeout would waste a CI minute for no information.
      entry.reject(new HttpError(503, 'not_connected', reason))
    }
  }

  function notifyExtensionWaiters(): void {
    for (const waiter of [...extensionWaiters]) waiter()
  }

  // --- run bookkeeping -------------------------------------------------------

  function statusOf(event: BridgeEvent): RunStatus | undefined {
    if (event.event === 'runStarted' || event.event === 'runFinished') return event.run?.status
    if (event.event === 'runStatus') return event.status
    return undefined
  }

  function runIdOf(event: BridgeEvent): string | undefined {
    if (event.event === 'runStarted' || event.event === 'runFinished') return event.run?.id
    if (event.event === 'runStep' || event.event === 'runStatus') return event.runId
    return undefined
  }

  /** Frees a concurrency slot and cancels its lease. */
  function releaseRun(runId: string): void {
    const lease = activeRuns.get(runId)
    if (lease) clearTimeout(lease)
    activeRuns.delete(runId)
  }

  /**
   * Claims a concurrency slot, or refuses.
   *
   * **Policy: fail fast with `busy`, never queue.** Both options were viable; this
   * one was chosen because the caller is a CI job. A queued request would hold an
   * HTTP connection open for an unbounded time and then usually die to the
   * pipeline's own timeout, producing a red build with no explanation. `429 busy`
   * is a fact the pipeline can act on — retry, or fail with "another test job is
   * using the browser". It also keeps `/health` honest: `queuedRuns` is always 0,
   * because nothing is ever queued.
   */
  function claimRunSlot(): void {
    const taken = activeRuns.size + reservedSlots
    if (taken >= maxConcurrent) {
      throw new HttpError(
        429,
        'busy',
        `浏览器正忙：已有 ${taken} 个运行在执行（maxConcurrent=${maxConcurrent}）。One browser cannot run two tests at once; retry when the current run finishes.`,
      )
    }
    reservedSlots += 1
  }

  /** Turns a reservation into a real slot once the extension has named the run. */
  function beginRun(runId: string): void {
    const lease = setTimeout(() => {
      log('warn', `run ${runId} lease expired; releasing its slot`)
      releaseRun(runId)
    }, runLeaseMs)
    lease.unref()
    activeRuns.set(runId, lease)
  }

  /** Gives a reservation back when `startRun` never produced a run. */
  function releaseReservation(): void {
    if (reservedSlots > 0) reservedSlots -= 1
  }

  /** Keeps the replay buffers bounded; a long-lived bridge must not grow forever. */
  function recordEvent(runId: string, event: BridgeEvent): void {
    const existing = runEvents.get(runId)
    const list = existing ?? []
    if (!existing) {
      runEvents.set(runId, list)
      if (runEvents.size > MAX_TRACKED_RUNS) {
        // Map iteration is insertion-ordered, so the first key is the oldest run.
        const oldest = runEvents.keys().next()
        if (!oldest.done) {
          runEvents.delete(oldest.value)
          runStatuses.delete(oldest.value)
        }
      }
    }
    list.push(event)
    if (list.length > MAX_EVENTS_PER_RUN) list.splice(0, list.length - MAX_EVENTS_PER_RUN)
  }

  /**
   * Handles one unsolicited event frame.
   *
   * State is updated *before* fan-out so a subscriber that reacts synchronously —
   * ending its stream on a terminal status — sees a consistent view.
   */
  function onEvent(event: BridgeEvent): void {
    const runId = runIdOf(event)
    const status = statusOf(event)
    if (runId) {
      if (status) runStatuses.set(runId, status)
      recordEvent(runId, event)
      if (status && isTerminalStatus(status)) releaseRun(runId)
    }
    for (const subscriber of [...subscribers]) {
      // A `log` event has no run id; it is broadcast, because a CI log tailing one
      // run still wants to see "provider unreachable".
      if (runId && subscriber.runId !== runId) continue
      subscriber.send(event)
      if (runId && status && isTerminalStatus(status)) subscriber.end()
    }
  }

  /**
   * Resolves when the run reaches a terminal status, or null on timeout.
   *
   * The already-known status is checked first to close a real race: the extension
   * may have finished a fast run and pushed `runFinished` before this HTTP handler
   * got around to subscribing.
   */
  function waitForTerminal(runId: string, timeoutMs: number): Promise<RunStatus | null> {
    const known = runStatuses.get(runId)
    if (known && isTerminalStatus(known)) return Promise.resolve(known)
    return new Promise<RunStatus | null>((resolve) => {
      const subscriber: EventSubscriber = {
        runId,
        send: (event) => {
          const status = statusOf(event)
          if (status && isTerminalStatus(status)) {
            cleanup()
            resolve(status)
          }
        },
        end: () => {},
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(null)
      }, timeoutMs)
      timer.unref()
      function cleanup(): void {
        clearTimeout(timer)
        subscribers.delete(subscriber)
      }
      subscribers.add(subscriber)
    })
  }

  // --- HTTP ------------------------------------------------------------------

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // Last resort: a handler that threw after headers went out can only be cut
      // off, but one that threw before must still produce a BridgeError.
      if (res.headersSent) {
        res.end()
        return
      }
      sendHttpError(res, error)
    })
  })

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.byteLength),
      // The bridge serves JSON and PNGs to tools, never HTML to a browser; nosniff
      // removes any chance of content being reinterpreted.
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(body)
  }

  function sendError(res: ServerResponse, status: number, code: BridgeError['code'], message: string): void {
    const payload: BridgeError = { error: message, code }
    sendJson(res, status, payload)
  }

  function sendHttpError(res: ServerResponse, error: unknown): void {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.code, error.message)
      return
    }
    sendError(res, 500, 'internal', `桥接内部错误 / bridge internal error: ${describe(error)}`)
  }

  /**
   * Origin policy.
   *
   * A page in the user's browser can send a "CORS-simple" request to
   * `http://127.0.0.1:8787` without any preflight; the browser will refuse to show
   * that page the *response*, but the request still executes. If such a page ever
   * learned the token — from a screenshot, a pasted log, a leaked CI variable — a
   * write-only request would be enough to start browser automation. Rejecting any
   * `Origin` that is not localhost blocks that: a real CLI or CI client sends no
   * `Origin` at all, so nothing legitimate is lost.
   *
   * For the same reason no `Access-Control-Allow-*` header is ever sent. Permissive
   * CORS would be the browser handing arbitrary pages a working client for this
   * API, and there is no web UI that needs it — the extension uses the WebSocket.
   */
  function isAllowedHttpOrigin(origin: string): boolean {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isLoopbackHost(parsed.hostname)
  }

  function requireOrigin(req: IncomingMessage): void {
    const origin = header(req, 'origin')
    // No Origin means a non-browser client, which is the normal case.
    if (!origin || origin === 'null') return
    if (!isAllowedHttpOrigin(origin)) {
      throw new HttpError(
        403,
        'unauthorized',
        `拒绝来自 ${origin} 的请求 / refused: this bridge only accepts requests from localhost origins.`,
      )
    }
  }

  function requireAuth(req: IncomingMessage): void {
    const authorization = header(req, 'authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (!match || !match[1] || !tokenMatches(match[1].trim())) {
      throw new HttpError(
        401,
        'unauthorized',
        '缺少或错误的 bridge token / missing or invalid bearer token. Run `webtest-pilot token` to print it, then send it as `Authorization: Bearer <token>`.',
      )
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${header(req, 'host') ?? '127.0.0.1'}`)
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
    const method = req.method ?? 'GET'

    // Origin is checked before auth so a hostile page gets 403 rather than a hint
    // about whether its token guess was right.
    requireOrigin(req)

    // `/health` is deliberately unauthenticated: its whole purpose is letting a
    // human or a container probe answer "is the bridge up?" before they have a
    // token, and it discloses nothing an attacker could use.
    if (segments.length === 0 || (segments.length === 1 && segments[0] === 'health')) {
      requireMethod(method, ['GET'])
      sendJson(res, 200, health())
      return
    }

    if (segments[0] !== 'api') throw notFound(url.pathname)
    requireAuth(req)

    const rest = segments.slice(1)
    const [head, id, sub, subId] = rest

    if (head === 'cases' && rest.length === 1) {
      requireMethod(method, ['GET', 'POST'])
      if (method === 'GET') {
        sendJson(res, 200, await listCases())
        return
      }
      sendJson(res, 201, await saveCase(req))
      return
    }

    if (head === 'cases' && rest.length === 2 && id) {
      requireMethod(method, ['DELETE'])
      const withScripts = url.searchParams.get('withScripts') === 'true'
      sendJson(res, 200, await call('deleteCase', { id, withScripts }))
      return
    }

    if (head === 'scripts' && rest.length === 1) {
      requireMethod(method, ['GET'])
      const result = await call('listScripts')
      const scripts: ScriptsResponse = { scripts: asArray(result, 'scripts') }
      sendJson(res, 200, scripts)
      return
    }

    if (head === 'scripts' && rest.length === 2 && id) {
      requireMethod(method, ['GET', 'DELETE'])
      if (method === 'DELETE') {
        sendJson(res, 200, await call('deleteScript', { id }))
        return
      }
      const script = await call('getScript', { id })
      if (script === null || script === undefined) {
        throw new HttpError(404, 'not_found', `未找到 script ${id} / no such script on this extension.`)
      }
      sendJson(res, 200, script)
      return
    }

    if (head === 'runs' && rest.length === 1) {
      requireMethod(method, ['GET', 'POST'])
      if (method === 'GET') {
        const limit = parsePositiveInt(url.searchParams.get('limit'))
        const result = await call('listRuns', limit === undefined ? undefined : { limit })
        sendJson(res, 200, { runs: asArray(result, 'runs') })
        return
      }
      await createRun(req, res)
      return
    }

    if (head === 'runs' && rest.length === 2 && id) {
      requireMethod(method, ['GET'])
      sendJson(res, 200, await runDetail(id))
      return
    }

    if (head === 'runs' && rest.length === 3 && id && sub === 'events') {
      requireMethod(method, ['GET'])
      streamEvents(req, res, id)
      return
    }

    if (head === 'runs' && rest.length === 3 && id && sub === 'cancel') {
      requireMethod(method, ['POST'])
      const result = await call('cancelRun', { runId: id })
      // Cancelling is the one operation whose slot must be freed eagerly: the
      // extension may go straight to `cancelled` without another event.
      releaseRun(id)
      sendJson(res, 200, result ?? { ok: true })
      return
    }

    if (head === 'runs' && rest.length === 4 && id && sub === 'artifacts' && subId) {
      requireMethod(method, ['GET'])
      await serveArtifact(res, id, subId)
      return
    }

    throw notFound(url.pathname)
  }

  function notFound(pathname: string): HttpError {
    return new HttpError(404, 'not_found', `未知路径 ${pathname} / no such endpoint on this bridge.`)
  }

  /** 405 rather than 404 for a known path, so a client can see it used the wrong verb. */
  function requireMethod(method: string, allowed: string[]): void {
    if (allowed.includes(method)) return
    throw new HttpError(
      405,
      'bad_request',
      `${method} 不适用于该端点 / method not allowed here; use ${allowed.join(', ')}.`,
    )
  }

  function health(): HealthResponse {
    const hello = readyLink()?.hello ?? null
    return {
      ok: true,
      bridgeVersion,
      protocolVersion: PROTOCOL_VERSION,
      extensionConnected: hello !== null,
      providerReady: hello?.providerReady ?? false,
      allowedSiteCount: hello?.allowedSiteCount ?? 0,
      runningRuns: activeRuns.size,
      // Always 0: the bridge refuses rather than queues. See claimRunSlot.
      queuedRuns: 0,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }
  }

  async function listCases(): Promise<CasesResponse> {
    const result = await call('listCases')
    return { cases: asArray(result, 'cases') }
  }

  /**
   * `POST /api/cases`.
   *
   * Two body shapes are accepted because two kinds of caller exist: a script doing
   * `-d @case.md -H 'Content-Type: text/markdown'`, and anything with a JSON
   * client. Refusing the raw form would push every shell user into escaping their
   * Markdown into a JSON string, which is exactly where newlines get mangled.
   */
  async function saveCase(req: IncomingMessage): Promise<unknown> {
    const raw = await readBody(req)
    const contentType = (header(req, 'content-type') ?? '').toLowerCase()
    let markdown: string | undefined
    if (contentType.includes('application/json')) {
      const body = parseJsonBody(raw)
      const value = body.markdown
      if (typeof value === 'string') markdown = value
    } else {
      markdown = raw
    }
    if (!markdown || markdown.trim().length === 0) {
      throw new HttpError(
        400,
        'bad_request',
        '需要用例 Markdown / expected a case body: send JSON {"markdown": "..."} or the Markdown itself as text/markdown.',
      )
    }
    return call('saveCase', { markdown })
  }

  /**
   * Normalizes the extension's `getRun` reply into a {@link RunDetail}.
   *
   * The reply is tolerated in two shapes — a bare `TestRun`, or `{ run, artifacts }`
   * — because artifact metadata lives in IndexedDB on the extension side and may
   * or may not be joined in before it answers. When it is absent, the artifact
   * list is reconstructed from the steps' `screenshotId`s, which is the same
   * information. URLs are absolute: a Feishu card links to them from a phone.
   */
  function toRunDetail(result: unknown, runId: string, baseUrl: string): RunDetail {
    const record = isRecord(result) ? result : {}
    const runValue = isRecord(record.run) ? record.run : record
    const run = runValue as unknown as TestRun
    if (typeof run.id !== 'string') {
      throw new HttpError(404, 'not_found', `未找到 run ${runId} / no such run on this extension.`)
    }
    const declared = Array.isArray(record.artifacts) ? record.artifacts : null
    const artifacts: RunDetail['artifacts'] = declared
      ? declared.filter(isRecord).map((meta) => ({
          id: String(meta.id ?? ''),
          stepIndex: typeof meta.stepIndex === 'number' ? meta.stepIndex : -1,
          url: artifactUrl(baseUrl, run.id, String(meta.id ?? '')),
        }))
      : (run.steps ?? [])
          .filter((step) => typeof step.screenshotId === 'string' && step.screenshotId.length > 0)
          .map((step) => ({
            id: String(step.screenshotId),
            stepIndex: step.index,
            url: artifactUrl(baseUrl, run.id, String(step.screenshotId)),
          }))
    return { ...run, artifacts }
  }

  function artifactUrl(baseUrl: string, runId: string, artifactId: string): string {
    return `${baseUrl}/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`
  }

  async function runDetail(runId: string): Promise<RunDetail> {
    const result = await call('getRun', { runId, id: runId })
    if (result === null || result === undefined) {
      throw new HttpError(404, 'not_found', `未找到 run ${runId} / no such run on this extension.`)
    }
    return toRunDetail(result, runId, handleUrl())
  }

  /**
   * `POST /api/runs`.
   *
   * With `wait`, the response is held until the run is terminal: one request, one
   * exit code, no polling loop for a pipeline author to get subtly wrong. Without
   * it, the caller gets the run id and an `eventsUrl` immediately.
   */
  async function createRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req)
    const body: CreateRunBody = raw.trim().length === 0 ? {} : (parseJsonBody(raw) as CreateRunBody)
    if (!body.caseId && !body.scriptId && !body.markdown) {
      throw new HttpError(
        400,
        'bad_request',
        '需要 caseId、scriptId 或 markdown 之一 / provide one of caseId, scriptId, or markdown.',
      )
    }

    // Checked before relaying, so a refusal costs nothing. Note that the slot is
    // only *taken* once the extension confirms a run id: claiming it up front would
    // mean a failed or timed-out `startRun` leaked a slot, and after
    // `maxConcurrent` such failures the bridge would answer `busy` for ever.
    claimRunSlot()
    const params: Record<string, unknown> = {}
    if (body.caseId) params.caseId = body.caseId
    if (body.scriptId) params.scriptId = body.scriptId
    if (body.markdown) params.markdown = body.markdown
    if (body.useAgent !== undefined) params.useAgent = body.useAgent
    if (body.save !== undefined) params.save = body.save

    const started = normalizeStartResult(await call('startRun', params).finally(releaseReservation))
    beginRun(started.runId)

    const eventsUrl = `${handleUrl()}/api/runs/${encodeURIComponent(started.runId)}/events`
    if (!body.wait) {
      const payload: CreateRunResponse = { ...started, eventsUrl }
      sendJson(res, 202, payload)
      return
    }

    const seconds = body.timeoutSeconds && body.timeoutSeconds > 0 ? body.timeoutSeconds : DEFAULT_WAIT_SECONDS
    const status = await waitForTerminal(started.runId, seconds * 1000)
    if (status === null) {
      // `BridgeError.code` has no timeout member, so `internal` carries it and the
      // status line does the discriminating: 504 means "still running", and the
      // run id in the message lets the caller follow up instead of starting over.
      throw new HttpError(
        504,
        'internal',
        `运行 ${started.runId} 在 ${seconds}s 内未结束 / the run is still going after ${seconds}s. Poll GET /api/runs/${started.runId} or raise timeoutSeconds.`,
      )
    }
    sendJson(res, 200, await runDetail(started.runId))
  }

  function normalizeStartResult(result: unknown): StartRunResult {
    const record = isRecord(result) ? result : {}
    const runId = typeof record.runId === 'string' ? record.runId : ''
    if (runId.length === 0) {
      throw new HttpError(500, 'internal', '扩展未返回 runId / the extension did not return a runId for startRun.')
    }
    const mode = record.mode === 'agent' ? 'agent' : 'script'
    return { runId, mode }
  }

  /**
   * `GET /api/runs/:id/events` as Server-Sent Events.
   *
   * SSE rather than a WebSocket because the consumer is `curl` in a pipeline or a
   * dashboard's `EventSource`; both get this for free, and the stream is one-way
   * anyway. Buffered events are replayed first so a client that connects just
   * after `POST /api/runs` does not miss the beginning of its own run.
   */
  function streamEvents(req: IncomingMessage, res: ServerResponse, runId: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Without an explicit flush the first event can sit in Node's buffer until
    // something else is written, and a client waiting on headers looks hung.
    res.flushHeaders()
    openStreams.add(res)

    let ended = false
    const subscriber: EventSubscriber = {
      runId,
      send: (event) => {
        if (ended) return
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`)
      },
      end: () => finish(),
    }

    const heartbeat = setInterval(() => {
      if (ended) return
      // A comment line is a no-op for every SSE parser but keeps the TCP
      // connection and any intermediary proxy from timing the stream out.
      res.write(': ping\n\n')
    }, sseHeartbeatMs)
    heartbeat.unref()

    function finish(): void {
      if (ended) return
      ended = true
      clearInterval(heartbeat)
      subscribers.delete(subscriber)
      openStreams.delete(res)
      res.end()
    }

    // A CI job that aborts leaves this handler as the only owner of the listener;
    // one leaked subscriber per run is a slow, real memory leak in a bridge that
    // stays up for weeks.
    req.on('close', () => {
      ended = true
      clearInterval(heartbeat)
      subscribers.delete(subscriber)
      openStreams.delete(res)
    })

    subscribers.add(subscriber)

    for (const event of runEvents.get(runId) ?? []) subscriber.send(event)
    const known = runStatuses.get(runId)
    if (known && isTerminalStatus(known)) finish()
  }

  /**
   * `GET /api/runs/:id/artifacts/:artifactId`.
   *
   * The extension holds screenshots as base64 data URLs in IndexedDB, but this
   * endpoint must serve real bytes: it is the `img src` of a Feishu card, and a
   * card renderer will not decode a data URL fetched over HTTP.
   */
  async function serveArtifact(res: ServerResponse, runId: string, artifactId: string): Promise<void> {
    const result = await call('getArtifact', { runId, id: artifactId })
    const record = isRecord(result) ? result : {}
    const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : ''
    if (dataUrl.length === 0) {
      throw new HttpError(404, 'not_found', `未找到截图 ${artifactId} / no such artifact; it may have been pruned.`)
    }
    const decoded = decodeDataUrl(dataUrl)
    if (!decoded) {
      throw new HttpError(500, 'internal', '截图数据无法解码 / the artifact was not a decodable data URL.')
    }
    res.writeHead(200, {
      'Content-Type': decoded.mime,
      'Content-Length': String(decoded.bytes.byteLength),
      // Artifacts are immutable once written, so a card or browser may cache them.
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(decoded.bytes)
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.byteLength
      if (size > MAX_BODY_BYTES) {
        // Fail before buffering more: a case is Markdown, so anything this large is
        // a mistake or an attack, and either way must not be held in memory.
        throw new HttpError(413, 'bad_request', '请求体过大 / request body exceeds the 8 MB limit.')
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  function parseJsonBody(raw: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) throw new Error('not an object')
      return parsed
    } catch {
      throw new HttpError(400, 'bad_request', 'JSON 解析失败 / the request body was not a JSON object.')
    }
  }

  // --- WebSocket -------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, clientTracking: false })

  /**
   * Upgrade handling for `/extension`.
   *
   * The token arrives as a query parameter rather than a header because
   * `chrome.runtime`'s service worker builds the socket with the DOM `WebSocket`
   * constructor, which has no way to set request headers at all. That is a
   * platform constraint, not a shortcut: the alternative would be an
   * unauthenticated socket. The parameter is acceptable here because the request
   * never leaves the loopback interface, so there is no proxy log to leak it into.
   */
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/extension') {
      rejectUpgrade(socket, 404, 'not_found', 'WebSocket 端点是 /extension / the WebSocket endpoint is /extension.')
      return
    }

    const origin = header(req, 'origin')
    // A chrome-extension origin is exactly who should be here; a page origin is
    // not, and would mean a website is trying to impersonate the extension.
    if (origin && !origin.startsWith('chrome-extension://') && !isAllowedHttpOrigin(origin)) {
      rejectUpgrade(socket, 403, 'unauthorized', `拒绝来自 ${origin} 的 WebSocket / refused this origin.`)
      return
    }

    const supplied = url.searchParams.get('token') ?? bearerFrom(header(req, 'authorization'))
    if (!supplied || !tokenMatches(supplied)) {
      rejectUpgrade(
        socket,
        401,
        'unauthorized',
        'WebSocket token 无效 / invalid bridge token. Copy it from `webtest-pilot token` into the extension settings.',
      )
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => acceptExtension(ws))
  })

  /** Writes a minimal HTTP error and closes; the socket is not yet a WebSocket. */
  function rejectUpgrade(socket: Duplex, status: number, code: BridgeError['code'], message: string): void {
    const payload: BridgeError = { error: message, code }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`,
    )
    socket.end(body)
    socket.destroy()
  }

  function acceptExtension(socket: WebSocket): void {
    const link: ExtensionLink = { socket, pending: new Map(), hello: null, alive: true }
    links.add(link)

    socket.on('pong', () => {
      link.alive = true
    })

    socket.on('message', (data) => {
      const frame = parseFrame(typeof data === 'string' ? data : data.toString())
      // A malformed frame is ignored rather than fatal: one bad message must not
      // take down a socket that is mid-run.
      if (!frame) {
        log('warn', 'ignored a malformed frame from the extension')
        return
      }
      if (frame.kind === 'response') {
        const entry = link.pending.get(frame.id)
        if (!entry) return // late reply to something already timed out
        clearTimeout(entry.timer)
        link.pending.delete(frame.id)
        if (frame.ok) entry.resolve(frame.result)
        else entry.reject(new HttpError(502, 'internal', frame.error ?? '扩展返回了错误 / the extension reported an error.'))
        return
      }
      if (frame.kind === 'event') {
        onEvent(frame)
        return
      }
      // The extension is never the requester in this protocol; ignore politely.
      log('warn', `ignored an unexpected request frame for ${frame.method}`)
    })

    const drop = (reason: string): void => {
      links.delete(link)
      failPending(link, reason)
    }
    socket.on('close', () => drop(`扩展连接已断开 / the extension disconnected before answering. ${NOT_CONNECTED_MESSAGE}`))
    socket.on('error', (error) => {
      log('warn', `extension socket error: ${describe(error)}`)
      drop(`扩展连接出错 / the extension socket failed: ${describe(error)}`)
    })

    // Handshake first, then the link becomes eligible for relays.
    callOn(link, 'hello', { protocolVersion: PROTOCOL_VERSION }, requestTimeoutMs)
      .then((result) => {
        const hello = normalizeHello(result)
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          // Not negotiated on purpose: both halves ship together, so a mismatch
          // means one of them is stale and silently continuing would produce
          // baffling failures deep inside a run.
          const reason = `protocol mismatch: bridge ${PROTOCOL_VERSION}, extension ${hello.protocolVersion}. Update both halves of WebTest Pilot.`
          log('error', reason)
          links.delete(link)
          // 1002 is the WebSocket "protocol error" code; the reason is capped at
          // 123 bytes by the spec, which this stays under.
          socket.close(1002, reason.slice(0, 120))
          return
        }
        link.hello = hello
        log('info', `extension connected: v${hello.extensionVersion}, ${hello.allowedSiteCount} allowed site(s)`)
        notifyExtensionWaiters()
      })
      .catch((error: unknown) => {
        log('warn', `handshake failed: ${describe(error)}`)
        links.delete(link)
        socket.close(1002, 'hello handshake failed')
      })
  }

  function normalizeHello(result: unknown): HelloPayload {
    const record = isRecord(result) ? result : {}
    return {
      protocolVersion: typeof record.protocolVersion === 'number' ? record.protocolVersion : -1,
      extensionVersion: typeof record.extensionVersion === 'string' ? record.extensionVersion : 'unknown',
      providerReady: record.providerReady === true,
      allowedSiteCount: typeof record.allowedSiteCount === 'number' ? record.allowedSiteCount : 0,
    }
  }

  /**
   * Heartbeat.
   *
   * A TCP connection can die without either side being told — a laptop suspends, a
   * VPN drops, Chrome is force-quit. The socket then looks perfectly healthy while
   * every relayed request silently waits for its timeout, so a `GET /api/cases`
   * would take 30s to fail instead of 0ms. Pinging turns that into a disconnect
   * the bridge can report accurately.
   */
  const heartbeat = setInterval(() => {
    for (const link of [...links]) {
      if (!link.alive) {
        log('warn', 'dropping an extension socket that missed its pong')
        links.delete(link)
        failPending(link, `扩展心跳超时 / the extension stopped responding. ${NOT_CONNECTED_MESSAGE}`)
        link.socket.terminate()
        continue
      }
      link.alive = false
      link.socket.ping()
    }
  }, heartbeatMs)
  // Unref'd so a bridge embedded in a test run cannot hold the process open.
  heartbeat.unref()

  // --- listen ----------------------------------------------------------------

  const boundPort = await listen(httpServer, options.port ?? 0)
  // Read after listen so port 0 resolves to the port the OS actually chose; the
  // absolute base is needed for `eventsUrl` and artifact URLs, which travel to
  // clients (a Feishu card) that have no idea what port this is on.
  const baseUrl = `http://127.0.0.1:${boundPort}`
  function handleUrl(): string {
    return baseUrl
  }

  const handleObject: BridgeServerHandle = {
    url: baseUrl,
    port: boundPort,
    get connectedExtensions(): HelloPayload[] {
      const found: HelloPayload[] = []
      for (const link of links) {
        if (link.hello) found.push(link.hello)
      }
      return found
    },
    waitForExtension(timeoutMs: number): Promise<boolean> {
      if (readyLink()) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        const waiter = (): void => {
          if (!readyLink()) return
          cleanup()
          resolve(true)
        }
        const timer = setTimeout(() => {
          cleanup()
          resolve(false)
        }, timeoutMs)
        timer.unref()
        function cleanup(): void {
          clearTimeout(timer)
          extensionWaiters.delete(waiter)
        }
        extensionWaiters.add(waiter)
      })
    },
    async close(): Promise<void> {
      if (closing) return
      closing = true
      clearInterval(heartbeat)
      for (const lease of activeRuns.values()) clearTimeout(lease)
      activeRuns.clear()
      // End streams before closing the listener: an open SSE response would
      // otherwise keep `server.close()` waiting for ever.
      for (const stream of [...openStreams]) {
        openStreams.delete(stream)
        stream.end()
      }
      for (const subscriber of [...subscribers]) subscribers.delete(subscriber)
      for (const link of [...links]) {
        links.delete(link)
        failPending(link, '桥接正在关闭 / the bridge is shutting down.')
        link.socket.terminate()
      }
      wss.close()
      // Keep-alive connections from a `fetch` client are idle but open; without
      // this the listener never actually closes and vitest hangs.
      httpServer.closeIdleConnections()
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
    },
  }

  return handleObject
}

// --- small helpers -----------------------------------------------------------

/** Binds the listener to loopback and resolves the actual port (for port 0). */
function listen(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError)
      reject(
        new Error(
          `无法监听端口 ${port} / could not listen on 127.0.0.1:${port}: ${error.message}. Another bridge may already be running.`,
        ),
      )
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('监听地址异常 / the server reported no numeric address.'))
        return
      }
      resolve(address.port)
    })
  })
}

/** Case-insensitive single header read; Node lowercases keys but arrays happen. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function bearerFrom(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim()
}

/** True for the loopback names a local client may legitimately use. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a list from either a bare array or `{ <key>: [...] }`.
 *
 * The extension's storage helpers return bare arrays, while the REST shapes wrap
 * them; accepting both keeps one harmless inconsistency from becoming a 500.
 */
function asArray<T>(result: unknown, key: string): T[] {
  if (Array.isArray(result)) return result as T[]
  if (isRecord(result) && Array.isArray(result[key])) return result[key] as T[]
  return []
}

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

/** Splits a base64 data URL into its media type and bytes. */
export function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const mime = match[1] && match[1].length > 0 ? match[1] : 'image/png'
  const payload = match[3] ?? ''
  const bytes = match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  if (bytes.byteLength === 0) return null
  return { mime, bytes }
}

/** Message text from an unknown throwable, for a log line or an error body. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

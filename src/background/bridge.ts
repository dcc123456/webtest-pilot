/**
 * The extension's client for the local bridge.
 *
 * The extension is the WebSocket **client**, always. An extension cannot listen
 * on a port and a local server cannot reach into the browser, so this direction
 * is the only one that works — and it has a useful consequence: the bridge needs
 * no knowledge of Chrome, and the extension needs no open port.
 *
 * The awkward part is MV3 worker eviction. A WebSocket does not keep the worker
 * alive indefinitely on its own, but *activity on it does* reset the idle timer,
 * so the heartbeat below is load-bearing rather than merely hygienic: without it
 * the socket dies with the worker after ~30s of quiet, and CI would see a bridge
 * that works only while someone is clicking.
 *
 * @module background/bridge
 */

import {
  PROTOCOL_VERSION,
  parseFrame,
  respond,
  respondError,
  serializeFrame,
  type BridgeEvent,
  type BridgeRequest,
  type HelloPayload,
  type StartRunParams,
} from '../lib/protocol'
import { parseCasesMarkdown, toTestCase } from '../lib/markdown'
import { getArtifact } from '../lib/artifacts'
import {
  appendLog,
  deleteCase,
  deleteScript,
  getCase,
  getCases,
  getRun,
  getRuns,
  getScript,
  getScripts,
  getSettings,
  newId,
  saveCase,
} from '../lib/storage'
import type { TestRun } from '../lib/types'
import { broadcast } from '../lib/messages'

/** What the bridge client needs from the worker to actually run anything. */
export interface BridgeHandlers {
  startRun: (params: StartRunParams) => Promise<TestRun>
  cancelRun: (runId: string) => boolean
}

/**
 * Heartbeat interval.
 *
 * Twenty seconds, comfortably inside Chrome's ~30s idle window: each frame is
 * activity, which is what keeps the worker — and therefore the socket — alive.
 */
const HEARTBEAT_MS = 20_000

/** Reconnect backoff bounds. */
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

let socket: WebSocket | null = null
let handlers: BridgeHandlers | null = null
let heartbeat: ReturnType<typeof setInterval> | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectDelay = RECONNECT_MIN_MS
let lastError: string | undefined
/** Set when the user disabled the bridge, so we stop trying to reconnect. */
let stopped = false

/** Current connection state, for the Settings panel. */
export function status(): { connected: boolean; url: string; lastError?: string } {
  const settings = { url: socket?.url ?? '' }
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    url: settings.url,
    ...(lastError ? { lastError } : {}),
  }
}

/** Opens the connection, reconnecting until told to stop. */
export async function connect(next: BridgeHandlers): Promise<void> {
  handlers = next
  stopped = false
  await open()
}

/** Closes the connection and cancels any pending reconnect. */
export function disconnect(): void {
  stopped = true
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  stopHeartbeat()
  const current = socket
  socket = null
  // Code 1000 is a normal closure, which tells the bridge this was deliberate
  // rather than a crash it should log as a problem.
  current?.close(1000, 'disabled by user')
}

function stopHeartbeat(): void {
  if (heartbeat !== undefined) {
    clearInterval(heartbeat)
    heartbeat = undefined
  }
}

async function open(): Promise<void> {
  const settings = await getSettings()
  const { bridge } = settings
  if (!bridge.enabled || stopped) return

  if (!bridge.token.trim()) {
    lastError =
      '缺少访问令牌（token）。请运行 `npx webtest-pilot serve`，把它打印出来的 token 粘贴到设置中。'
    broadcast({ type: 'bridgeStatus', connected: false, error: lastError })
    return
  }

  // The token goes in the query string because a WebSocket handshake from a
  // service worker cannot carry custom headers — the browser owns that request.
  // The bridge binds to 127.0.0.1 only, so the token never crosses a network.
  const url = `${bridge.url}?token=${encodeURIComponent(bridge.token)}`

  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch (error) {
    lastError = `无法连接本地服务：${error instanceof Error ? error.message : String(error)}`
    broadcast({ type: 'bridgeStatus', connected: false, error: lastError })
    scheduleReconnect()
    return
  }
  socket = ws

  ws.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN_MS
    lastError = undefined
    void sendHello()
    stopHeartbeat()
    heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      // An application-level ping rather than a protocol ping frame: the
      // WebSocket API in a page context cannot send protocol pings, and this
      // doubles as the worker keep-alive.
      ws.send(serializeFrame({ kind: 'event', event: 'log', level: 'info', message: 'ping' }))
    }, HEARTBEAT_MS)
    broadcast({ type: 'bridgeStatus', connected: true })
    void appendLog({ level: 'info', source: 'bridge', message: '已连接本地服务。' })
  })

  ws.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : ''
    const frame = parseFrame(data)
    // A malformed frame is ignored rather than fatal: one bad message must not
    // take down a connection CI depends on.
    if (!frame || frame.kind !== 'request') return
    void handleRequest(frame, ws)
  })

  ws.addEventListener('close', (event) => {
    stopHeartbeat()
    if (socket === ws) socket = null
    broadcast({ type: 'bridgeStatus', connected: false })
    if (stopped) return
    // 1008 is the bridge rejecting us — a bad token or a protocol mismatch.
    // Retrying that in a loop would just spam; surface it and wait for the user.
    if (event.code === 1008) {
      lastError = event.reason || '本地服务拒绝了连接，请检查 token 是否正确。'
      void appendLog({ level: 'error', source: 'bridge', message: lastError })
      broadcast({ type: 'bridgeStatus', connected: false, error: lastError })
      return
    }
    scheduleReconnect()
  })

  ws.addEventListener('error', () => {
    // The error event carries no detail by design (to avoid leaking network
    // information to pages); `close` follows and handles reconnection.
    lastError = '与本地服务的连接出错。请确认 `npx webtest-pilot serve` 正在运行。'
  })
}

/** Reconnects with exponential backoff, so a stopped bridge is not hammered. */
function scheduleReconnect(): void {
  if (stopped || reconnectTimer !== undefined) return
  const delay = reconnectDelay
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    void open()
  }, delay)
}

/** Announces protocol version and readiness, so `/health` can report it. */
async function sendHello(): Promise<void> {
  const settings = await getSettings()
  const provider = settings.providers.find(
    (profile) => profile.id === settings.activeProviderId,
  ) ?? settings.providers[0]
  const payload: HelloPayload = {
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    providerReady: Boolean(provider?.apiKey.trim()),
    allowedSiteCount: settings.policy.allowedSites.length,
  }
  send({ kind: 'request', id: newId('hello'), method: 'hello', params: { ...payload } })
}

function send(frame: Parameters<typeof serializeFrame>[0]): void {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(serializeFrame(frame))
}

/** Pushes run progress to the bridge, which fans it out over SSE. */
export function publish(event: BridgeEvent): void {
  send(event)
}

/**
 * Answers one relayed request.
 *
 * Every branch replies exactly once, including on error: the bridge holds an
 * HTTP client open waiting for this, and a missing reply becomes a timeout that
 * looks like a hung test rather than a bad request.
 */
async function handleRequest(request: BridgeRequest, ws: WebSocket): Promise<void> {
  const reply = (frame: ReturnType<typeof respond>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(serializeFrame(frame))
  }

  try {
    switch (request.method) {
      case 'ping':
        return reply(respond(request.id, { pong: true }))

      case 'listCases':
        return reply(respond(request.id, { cases: await getCases() }))

      case 'getCase': {
        const id = String(request.params?.id ?? '')
        const testCase = await getCase(id)
        return testCase
          ? reply(respond(request.id, testCase))
          : reply(respondError(request.id, `找不到用例 ${id}。`))
      }

      case 'saveCase': {
        const markdown = String(request.params?.markdown ?? '')
        const parsed = parseCasesMarkdown(markdown)
        if (parsed.cases.length === 0) {
          return reply(
            respondError(
              request.id,
              parsed.problems[0]?.message ?? '无法从 Markdown 中解析出测试用例。',
            ),
          )
        }
        const saved = []
        for (const entry of parsed.cases) {
          saved.push(await saveCase(toTestCase(entry, { id: newId('case'), source: 'bridge' })))
        }
        broadcast({ type: 'stateChanged' })
        return reply(respond(request.id, { cases: saved }))
      }

      case 'deleteCase': {
        const id = String(request.params?.id ?? '')
        await deleteCase(id, { withScripts: request.params?.withScripts === true })
        broadcast({ type: 'stateChanged' })
        return reply(respond(request.id, { deleted: true }))
      }

      case 'listScripts':
        return reply(respond(request.id, { scripts: await getScripts() }))

      case 'getScript': {
        const id = String(request.params?.id ?? '')
        const script = await getScript(id)
        return script
          ? reply(respond(request.id, script))
          : reply(respondError(request.id, `找不到脚本 ${id}。`))
      }

      case 'deleteScript': {
        await deleteScript(String(request.params?.id ?? ''))
        broadcast({ type: 'stateChanged' })
        return reply(respond(request.id, { deleted: true }))
      }

      case 'listRuns': {
        const limit = Number(request.params?.limit ?? 50)
        const runs = await getRuns()
        return reply(
          respond(request.id, { runs: runs.slice(0, Number.isFinite(limit) ? limit : 50) }),
        )
      }

      case 'getRun': {
        const id = String(request.params?.id ?? '')
        const run = await getRun(id)
        return run
          ? reply(respond(request.id, run))
          : reply(respondError(request.id, `找不到运行记录 ${id}。`))
      }

      case 'getArtifact': {
        const id = String(request.params?.id ?? '')
        const artifact = await getArtifact(id)
        return artifact
          ? reply(respond(request.id, { dataUrl: artifact.dataUrl }))
          : reply(respondError(request.id, `找不到截图 ${id}，它可能已被清理。`))
      }

      case 'startRun': {
        if (!handlers) {
          return reply(respondError(request.id, '插件尚未就绪，请稍后重试。'))
        }
        const params = (request.params ?? {}) as StartRunParams
        // Markdown arriving from CI is turned into a case first, so the run has
        // something with a name and expectations to report against.
        if (params.markdown && !params.caseId && !params.scriptId) {
          const parsed = parseCasesMarkdown(params.markdown)
          const first = parsed.cases[0]
          if (!first) {
            return reply(
              respondError(
                request.id,
                parsed.problems[0]?.message ?? '无法从 Markdown 中解析出测试用例。',
              ),
            )
          }
          const testCase = toTestCase(first, { id: newId('case'), source: 'bridge' })
          // Saved only when asked: CI usually wants to stay stateless and not
          // accumulate a case per pipeline run.
          if (params.save) await saveCase(testCase)
          const run = await handlers.startRun({ ...params, caseId: testCase.id })
          return reply(respond(request.id, { runId: run.id, mode: run.mode }))
        }

        const run = await handlers.startRun(params)
        return reply(respond(request.id, { runId: run.id, mode: run.mode }))
      }

      case 'cancelRun': {
        if (!handlers) return reply(respondError(request.id, '插件尚未就绪。'))
        const cancelled = handlers.cancelRun(String(request.params?.id ?? ''))
        return cancelled
          ? reply(respond(request.id, { cancelled: true }))
          : reply(respondError(request.id, '该运行已经结束，无法取消。'))
      }

      case 'hello':
        // The bridge acknowledging our hello; nothing to do.
        return

      default:
        return reply(respondError(request.id, `不支持的方法：${String(request.method)}`))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendLog({ level: 'error', source: 'bridge', message })
    reply(respondError(request.id, message))
  }
}

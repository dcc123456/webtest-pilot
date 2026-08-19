/**
 * Integration tests for the bridge.
 *
 * These start a real HTTP+WebSocket server on an ephemeral port, connect a real
 * `ws` client that impersonates the extension, and drive it with real `fetch`.
 * Nothing is mocked, because every bug this module can have lives in the seams:
 * the auth check, the relay correlation, the timeout, the SSE framing, the socket
 * dying mid-request. A test with a stubbed transport would pass through all of it.
 *
 * Port 0 everywhere, so the whole file can run in parallel with anything else.
 *
 * @module tests/bridge.spec
 */

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { createBridgeServer, decodeDataUrl, type BridgeServerHandle } from '../bridge/server'
import {
  PROTOCOL_VERSION,
  parseFrame,
  respond,
  respondError,
  serializeFrame,
  type BridgeError,
  type BridgeEvent,
  type BridgeMethod,
  type CasesResponse,
  type CreateRunResponse,
  type HealthResponse,
  type RunDetail,
} from '../src/lib/protocol'
import type { RunStatus, StepRecord, TestCase, TestRun } from '../src/lib/types'

const TOKEN = 'a'.repeat(64)
const WRONG_TOKEN = 'b'.repeat(64)

/** A 1x1 transparent PNG, so the artifact test asserts on real image bytes. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

// --- teardown registry -------------------------------------------------------

/**
 * Everything opened during a test, closed afterwards no matter how it ended.
 *
 * A leaked server or socket does not fail a test; it hangs the whole vitest
 * process after the last assertion passes, which is a miserable thing to debug in
 * CI. Registering on creation makes that impossible to forget.
 */
const openServers: BridgeServerHandle[] = []
const openSockets: WebSocket[] = []
const openReaders: ReadableStreamDefaultReader<Uint8Array>[] = []

afterEach(async () => {
  for (const reader of openReaders.splice(0)) {
    await reader.cancel().catch(() => {})
  }
  for (const socket of openSockets.splice(0)) {
    socket.removeAllListeners()
    socket.terminate()
  }
  for (const server of openServers.splice(0)) {
    await server.close()
  }
})

// --- helpers -----------------------------------------------------------------

interface StartOptions {
  maxConcurrent?: number
  requestTimeoutMs?: number
  heartbeatMs?: number
  sseHeartbeatMs?: number
}

async function startBridge(options: StartOptions = {}): Promise<BridgeServerHandle> {
  const server = await createBridgeServer({
    token: TOKEN,
    port: 0,
    // Explicit values everywhere so no test accidentally depends on a production
    // default measured in tens of seconds.
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    heartbeatMs: options.heartbeatMs ?? 60_000,
    sseHeartbeatMs: options.sseHeartbeatMs ?? 60_000,
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  })
  openServers.push(server)
  return server
}

/** A canned answer per method. */
type Handlers = Partial<Record<BridgeMethod, (params: Record<string, unknown>) => unknown>>

interface FakeExtensionOptions {
  handlers?: Handlers
  /** Methods to receive and deliberately ignore, to exercise the relay timeout. */
  silent?: BridgeMethod[]
  /** Methods to answer with `ok: false`. */
  failing?: Partial<Record<BridgeMethod, string>>
  protocolVersion?: number
  extensionVersion?: string
  providerReady?: boolean
  allowedSiteCount?: number
}

interface FakeExtension {
  socket: WebSocket
  /** Every request the bridge relayed, in order. */
  calls: { method: BridgeMethod; params: Record<string, unknown> }[]
  /** Pushes an unsolicited event frame, as a real run would. */
  emit(event: BridgeEvent): void
  /** Resolves with the close code and reason, for the handshake-rejection test. */
  closed: Promise<{ code: number; reason: string }>
}

function makeRun(overrides: Partial<TestRun> = {}): TestRun {
  const startedAt = 1_700_000_000_000
  return {
    id: 'run-1',
    caseName: 'Login works',
    mode: 'script',
    trigger: 'bridge',
    status: 'passed',
    startedAt,
    finishedAt: startedAt + 4_200,
    heartbeatAt: startedAt + 4_200,
    steps: [],
    ...overrides,
  }
}

function makeStep(overrides: Partial<StepRecord> = {}): StepRecord {
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

/**
 * Connects a WebSocket that behaves like the extension.
 *
 * Resolves as soon as the socket is *open*, not once the handshake finished: the
 * protocol-mismatch test needs to observe the bridge rejecting it, so waiting for
 * a successful handshake here would make that case untestable.
 */
async function connectExtension(
  server: BridgeServerHandle,
  options: FakeExtensionOptions = {},
  token = TOKEN,
): Promise<FakeExtension> {
  const wsUrl = `${server.url.replace(/^http/, 'ws')}/extension?token=${encodeURIComponent(token)}`
  const socket = new WebSocket(wsUrl)
  openSockets.push(socket)

  const calls: FakeExtension['calls'] = []
  const silent = new Set<BridgeMethod>(options.silent ?? [])
  const failing = options.failing ?? {}

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })

  socket.on('message', (data) => {
    const frame = parseFrame(data.toString())
    if (!frame || frame.kind !== 'request') return
    calls.push({ method: frame.method, params: frame.params ?? {} })

    if (silent.has(frame.method)) return

    const failure = failing[frame.method]
    if (failure !== undefined) {
      socket.send(serializeFrame(respondError(frame.id, failure)))
      return
    }

    if (frame.method === 'hello') {
      socket.send(
        serializeFrame(
          respond(frame.id, {
            protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
            extensionVersion: options.extensionVersion ?? '0.1.0',
            providerReady: options.providerReady ?? true,
            allowedSiteCount: options.allowedSiteCount ?? 2,
          }),
        ),
      )
      return
    }

    const handler = options.handlers?.[frame.method]
    if (!handler) {
      socket.send(serializeFrame(respondError(frame.id, `fake extension has no handler for ${frame.method}`)))
      return
    }
    let result: unknown
    try {
      result = handler(frame.params ?? {})
    } catch (error) {
      socket.send(serializeFrame(respondError(frame.id, error instanceof Error ? error.message : String(error))))
      return
    }
    socket.send(serializeFrame(respond(frame.id, result)))
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', (error) => reject(error))
  })

  return {
    socket,
    calls,
    emit: (event) => socket.send(serializeFrame(event)),
    closed,
  }
}

/** A connected, handshaken extension: the state most tests start from. */
async function connectReady(server: BridgeServerHandle, options: FakeExtensionOptions = {}): Promise<FakeExtension> {
  const extension = await connectExtension(server, options)
  const ready = await server.waitForExtension(2_000)
  expect(ready).toBe(true)
  return extension
}

interface Fetched<T> {
  status: number
  headers: Headers
  body: T
}

/** Authenticated JSON call; returns the parsed body whatever the status was. */
async function api<T>(
  server: BridgeServerHandle,
  method: string,
  path: string,
  init: { body?: string; contentType?: string; token?: string | null; origin?: string } = {},
): Promise<Fetched<T>> {
  const headers: Record<string, string> = {}
  const token = init.token === undefined ? TOKEN : init.token
  if (token !== null) headers.Authorization = `Bearer ${token}`
  if (init.contentType) headers['Content-Type'] = init.contentType
  if (init.origin) headers.Origin = init.origin

  const response = await fetch(`${server.url}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: (text.length > 0 ? JSON.parse(text) : undefined) as T,
  }
}

/** Shorthand for a JSON request body. */
function jsonBody(payload: unknown): { body: string; contentType: string } {
  return { body: JSON.stringify(payload), contentType: 'application/json' }
}

/**
 * Reads an SSE stream frame by frame off the raw body.
 *
 * Deliberately not `EventSource`: the point is to assert on the exact bytes the
 * bridge writes, including the `event:` line, the `data:` line, the blank-line
 * terminator, and the `: ping` comment, all of which a parser would hide.
 */
class RawSse {
  private buffer = ''
  private readonly chunks: string[] = []
  private readonly decoder = new TextDecoder()
  private done = false

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Consumes one read and splits out whatever complete frames it produced. */
  private async pump(): Promise<void> {
    const { value, done } = await this.reader.read()
    if (done) {
      this.done = true
      return
    }
    this.buffer += this.decoder.decode(value, { stream: true })
    let index = this.buffer.indexOf('\n\n')
    while (index >= 0) {
      this.chunks.push(this.buffer.slice(0, index))
      this.buffer = this.buffer.slice(index + 2)
      index = this.buffer.indexOf('\n\n')
    }
  }

  /** Pumps until `count` complete frames have arrived, or the deadline passes. */
  async take(count: number, timeoutMs = 3_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    while (this.chunks.length < count && !this.done && Date.now() < deadline) {
      await this.pump()
    }
    return this.chunks.slice(0, count)
  }

  /** True once the server ended the response. */
  async waitForEnd(timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!this.done && Date.now() < deadline) {
      await this.pump()
    }
    return this.done
  }

  get frames(): string[] {
    return [...this.chunks]
  }
}

async function openSse(server: BridgeServerHandle, runId: string): Promise<{ response: Response; sse: RawSse }> {
  const response = await fetch(`${server.url}/api/runs/${runId}/events`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const body = response.body
  if (!body) throw new Error('the SSE response had no body stream')
  const reader = body.getReader()
  openReaders.push(reader)
  return { response, sse: new RawSse(reader) }
}

/** Waits for an observable condition, polling; used instead of a bare sleep. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/**
 * Lets the bridge process frames already in flight.
 *
 * Used only where there is nothing observable to poll for, such as a buffered
 * event or a freed concurrency slot, because both sides are real sockets and the
 * effect lands a tick or two after `emit` returns.
 */
function settle(ms = 80): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** A `startRun` handler that hands out sequential ids. */
function sequentialStartRun(): (params: Record<string, unknown>) => unknown {
  let counter = 0
  return () => {
    counter += 1
    return { runId: `run-${counter}`, mode: 'script' }
  }
}

// --- auth --------------------------------------------------------------------

describe('bridge authentication', () => {
  it('serves /health without any token, so a human can check the bridge is alive', async () => {
    const server = await startBridge()
    const response = await fetch(`${server.url}/health`)
    expect(response.status).toBe(200)
    const health = (await response.json()) as HealthResponse
    expect(health.ok).toBe(true)
    expect(health.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(health.extensionConnected).toBe(false)
  })

  it('treats the root path as /health', async () => {
    const server = await startBridge()
    const response = await fetch(`${server.url}/`)
    expect(response.status).toBe(200)
    expect(((await response.json()) as HealthResponse).ok).toBe(true)
  })

  it('rejects an /api call with no Authorization header', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'GET', '/api/cases', { token: null })
    expect(result.status).toBe(401)
    expect(result.body.code).toBe('unauthorized')
  })

  it('rejects an /api call with the wrong token', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'GET', '/api/cases', { token: WRONG_TOKEN })
    expect(result.status).toBe(401)
    expect(result.body.code).toBe('unauthorized')
  })

  it('rejects a token sent without the Bearer scheme', async () => {
    const server = await startBridge()
    const response = await fetch(`${server.url}/api/cases`, { headers: { Authorization: TOKEN } })
    expect(response.status).toBe(401)
    await response.text()
  })

  it('rejects a token of the right length but the wrong value', async () => {
    const server = await startBridge()
    const nearMiss = `${TOKEN.slice(0, 63)}c`
    const result = await api<BridgeError>(server, 'GET', '/api/cases', { token: nearMiss })
    expect(result.status).toBe(401)
  })

  it('tells the user how to find the token in the 401 body', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'GET', '/api/cases', { token: null })
    expect(result.body.error).toMatch(/webtest-pilot token/)
  })

  it('accepts the right token and relays the call', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { listCases: () => ({ cases: [] }) } })
    const result = await api<CasesResponse>(server, 'GET', '/api/cases')
    expect(result.status).toBe(200)
    expect(result.body.cases).toEqual([])
  })

  it('never sends a permissive CORS header', async () => {
    const server = await startBridge()
    const response = await fetch(`${server.url}/health`)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    await response.text()
  })
})

// --- origin ------------------------------------------------------------------

describe('bridge Origin policy', () => {
  it('allows a request with no Origin, which is what every CLI client sends', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { listCases: () => ({ cases: [] }) } })
    const result = await api<CasesResponse>(server, 'GET', '/api/cases')
    expect(result.status).toBe(200)
  })

  it('allows a localhost Origin', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { listCases: () => ({ cases: [] }) } })
    const result = await api<CasesResponse>(server, 'GET', '/api/cases', { origin: 'http://localhost:5173' })
    expect(result.status).toBe(200)
  })

  it('allows a 127.0.0.1 Origin', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { listCases: () => ({ cases: [] }) } })
    const result = await api<CasesResponse>(server, 'GET', '/api/cases', { origin: 'http://127.0.0.1:3000' })
    expect(result.status).toBe(200)
  })

  it('rejects a non-localhost Origin with 403', async () => {
    const server = await startBridge()
    await connectReady(server)
    const result = await api<BridgeError>(server, 'GET', '/api/cases', { origin: 'https://evil.example.com' })
    expect(result.status).toBe(403)
    expect(result.body.code).toBe('unauthorized')
    expect(result.body.error).toMatch(/localhost/)
  })

  it('rejects a host that merely ends in localhost', async () => {
    const server = await startBridge()
    await connectReady(server)
    const result = await api<BridgeError>(server, 'GET', '/api/cases', { origin: 'http://notlocalhost.example.com' })
    expect(result.status).toBe(403)
  })

  it('checks Origin before the token, so a hostile page learns nothing from a guess', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'GET', '/api/cases', {
      origin: 'https://evil.example.com',
      token: WRONG_TOKEN,
    })
    expect(result.status).toBe(403)
  })

  it('rejects a bad Origin even on the unauthenticated /health', async () => {
    const server = await startBridge()
    const response = await fetch(`${server.url}/health`, { headers: { Origin: 'https://evil.example.com' } })
    expect(response.status).toBe(403)
    await response.text()
  })
})

// --- no extension ------------------------------------------------------------

describe('bridge with no extension connected', () => {
  it('answers 503 not_connected with an actionable message', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'GET', '/api/cases')
    expect(result.status).toBe(503)
    expect(result.body.code).toBe('not_connected')
    expect(result.body.error).toMatch(/Chrome/)
    expect(result.body.error).toMatch(/Settings/)
  })

  it('answers 503 when asked to start a run', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' }))
    expect(result.status).toBe(503)
    expect(result.body.code).toBe('not_connected')
  })

  it('reports extensionConnected false in /health', async () => {
    const server = await startBridge()
    const result = await api<HealthResponse>(server, 'GET', '/health', { token: null })
    expect(result.body.extensionConnected).toBe(false)
    expect(result.body.providerReady).toBe(false)
    expect(result.body.runningRuns).toBe(0)
  })

  it('reports the extension once it connects', async () => {
    const server = await startBridge()
    await connectReady(server, { allowedSiteCount: 3, extensionVersion: '9.9.9' })
    const result = await api<HealthResponse>(server, 'GET', '/health', { token: null })
    expect(result.body.extensionConnected).toBe(true)
    expect(result.body.allowedSiteCount).toBe(3)
    expect(result.body.providerReady).toBe(true)
  })
})

// --- handshake ---------------------------------------------------------------

describe('bridge handshake', () => {
  it('stores the HelloPayload and exposes it via connectedExtensions', async () => {
    const server = await startBridge()
    await connectReady(server, { extensionVersion: '1.2.3', providerReady: true, allowedSiteCount: 7 })
    expect(server.connectedExtensions).toHaveLength(1)
    expect(server.connectedExtensions[0]?.extensionVersion).toBe('1.2.3')
    expect(server.connectedExtensions[0]?.allowedSiteCount).toBe(7)
  })

  it('rejects a protocolVersion mismatch and closes the socket with a clear reason', async () => {
    const server = await startBridge()
    const extension = await connectExtension(server, { protocolVersion: PROTOCOL_VERSION + 99 })
    const close = await extension.closed
    expect(close.code).toBe(1002)
    expect(close.reason).toMatch(/protocol mismatch/)
    expect(server.connectedExtensions).toHaveLength(0)
  })

  it('does not treat a mismatched extension as connected', async () => {
    const server = await startBridge()
    const extension = await connectExtension(server, { protocolVersion: 0 })
    await extension.closed
    const result = await api<HealthResponse>(server, 'GET', '/health', { token: null })
    expect(result.body.extensionConnected).toBe(false)
  })

  it('closes a socket whose hello never arrives', async () => {
    const server = await startBridge({ requestTimeoutMs: 200 })
    const extension = await connectExtension(server, { silent: ['hello'] })
    const close = await extension.closed
    expect(close.reason).toMatch(/hello/)
  })

  it('refuses a WebSocket upgrade carrying the wrong token', async () => {
    const server = await startBridge()
    const socket = new WebSocket(`${server.url.replace(/^http/, 'ws')}/extension?token=${WRONG_TOKEN}`)
    openSockets.push(socket)
    const error = await new Promise<Error>((resolve) => {
      socket.once('error', (err) => resolve(err))
    })
    expect(error.message).toMatch(/401/)
  })

  it('refuses a WebSocket upgrade with no token at all', async () => {
    const server = await startBridge()
    const socket = new WebSocket(`${server.url.replace(/^http/, 'ws')}/extension`)
    openSockets.push(socket)
    const error = await new Promise<Error>((resolve) => {
      socket.once('error', (err) => resolve(err))
    })
    expect(error.message).toMatch(/401/)
  })

  it('refuses a WebSocket upgrade on the wrong path', async () => {
    const server = await startBridge()
    const socket = new WebSocket(`${server.url.replace(/^http/, 'ws')}/nope?token=${TOKEN}`)
    openSockets.push(socket)
    const error = await new Promise<Error>((resolve) => {
      socket.once('error', (err) => resolve(err))
    })
    expect(error.message).toMatch(/404/)
  })

  it('waitForExtension resolves false when nothing connects in time', async () => {
    const server = await startBridge()
    expect(await server.waitForExtension(100)).toBe(false)
  })
})

// --- relay -------------------------------------------------------------------

describe('bridge relay of cases and scripts', () => {
  const sampleCase: TestCase = {
    id: 'case-1',
    name: 'Login works',
    tags: ['smoke'],
    source: 'bridge',
    steps: ['open the app'],
    expectations: ['the dashboard is shown'],
    createdAt: 1,
    updatedAt: 2,
  }

  it('relays GET /api/cases and returns a CasesResponse', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { listCases: () => ({ cases: [sampleCase] }) } })
    const result = await api<CasesResponse>(server, 'GET', '/api/cases')
    expect(result.status).toBe(200)
    expect(result.body.cases[0]?.id).toBe('case-1')
    expect(extension.calls.map((call) => call.method)).toContain('listCases')
  })

  it('accepts a bare array from the extension as well as the wrapped shape', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { listCases: () => [sampleCase] } })
    const result = await api<CasesResponse>(server, 'GET', '/api/cases')
    expect(result.body.cases).toHaveLength(1)
  })

  it('relays POST /api/cases from a JSON body', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { saveCase: () => sampleCase } })
    const result = await api<TestCase>(
      server,
      'POST',
      '/api/cases',
      jsonBody({ markdown: '# Login works\n\n- open the app\n' }),
    )
    expect(result.status).toBe(201)
    expect(result.body.id).toBe('case-1')
    expect(extension.calls.find((entry) => entry.method === 'saveCase')?.params.markdown).toMatch(/# Login works/)
  })

  it('relays POST /api/cases from a raw text/markdown body', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { saveCase: () => sampleCase } })
    const result = await api<TestCase>(server, 'POST', '/api/cases', {
      body: '# Raw markdown\n\n- click Sign in\n',
      contentType: 'text/markdown',
    })
    expect(result.status).toBe(201)
    expect(extension.calls.find((entry) => entry.method === 'saveCase')?.params.markdown).toMatch(/# Raw markdown/)
  })

  it('rejects an empty case body with 400 bad_request', async () => {
    const server = await startBridge()
    await connectReady(server)
    const result = await api<BridgeError>(server, 'POST', '/api/cases', { body: '   ', contentType: 'text/markdown' })
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('bad_request')
  })

  it('passes withScripts=true through on DELETE /api/cases/:id', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { deleteCase: () => ({ ok: true }) } })
    const result = await api<{ ok: boolean }>(server, 'DELETE', '/api/cases/case-1?withScripts=true')
    expect(result.status).toBe(200)
    expect(extension.calls.find((entry) => entry.method === 'deleteCase')?.params).toEqual({
      id: 'case-1',
      withScripts: true,
    })
  })

  it('defaults withScripts to false when the query parameter is absent', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { deleteCase: () => ({ ok: true }) } })
    await api(server, 'DELETE', '/api/cases/case-1')
    expect(extension.calls.find((entry) => entry.method === 'deleteCase')?.params.withScripts).toBe(false)
  })

  it('relays GET /api/scripts and GET /api/scripts/:id', async () => {
    const server = await startBridge()
    await connectReady(server, {
      handlers: {
        listScripts: () => ({ scripts: [{ id: 'script-1', name: 'Login' }] }),
        getScript: (params) => ({ id: params.id, name: 'Login' }),
      },
    })
    const list = await api<{ scripts: { id: string }[] }>(server, 'GET', '/api/scripts')
    expect(list.body.scripts[0]?.id).toBe('script-1')
    const one = await api<{ id: string }>(server, 'GET', '/api/scripts/script-1')
    expect(one.body.id).toBe('script-1')
  })

  it('returns 404 when the extension has no such script', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { getScript: () => null } })
    const result = await api<BridgeError>(server, 'GET', '/api/scripts/missing')
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('not_found')
  })

  it('relays DELETE /api/scripts/:id', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { deleteScript: () => ({ ok: true }) } })
    const result = await api<{ ok: boolean }>(server, 'DELETE', '/api/scripts/script-1')
    expect(result.status).toBe(200)
    expect(extension.calls.find((entry) => entry.method === 'deleteScript')?.params).toEqual({ id: 'script-1' })
  })

  it('relays GET /api/runs and forwards the limit', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { listRuns: () => ({ runs: [makeRun()] }) } })
    const result = await api<{ runs: TestRun[] }>(server, 'GET', '/api/runs?limit=5')
    expect(result.status).toBe(200)
    expect(result.body.runs).toHaveLength(1)
    expect(extension.calls.find((entry) => entry.method === 'listRuns')?.params).toEqual({ limit: 5 })
  })

  it('ignores a nonsense limit rather than passing it on', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { listRuns: () => ({ runs: [] }) } })
    await api(server, 'GET', '/api/runs?limit=abc')
    expect(extension.calls.find((entry) => entry.method === 'listRuns')?.params).toEqual({})
  })

  it('surfaces an extension-side error as 502 with the extension text', async () => {
    const server = await startBridge()
    await connectReady(server, { failing: { listCases: 'storage is corrupt' } })
    const result = await api<BridgeError>(server, 'GET', '/api/cases')
    expect(result.status).toBe(502)
    expect(result.body.error).toBe('storage is corrupt')
  })

  it('correlates concurrent relays to the right responses', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { getScript: (params) => ({ id: params.id }) } })
    const [a, b, c] = await Promise.all([
      api<{ id: string }>(server, 'GET', '/api/scripts/one'),
      api<{ id: string }>(server, 'GET', '/api/scripts/two'),
      api<{ id: string }>(server, 'GET', '/api/scripts/three'),
    ])
    // A correlation bug would cross these over; each id must match its own request.
    expect(a?.body.id).toBe('one')
    expect(b?.body.id).toBe('two')
    expect(c?.body.id).toBe('three')
  })
})

// --- relay failure modes -----------------------------------------------------

describe('bridge relay failure modes', () => {
  it('times out with a clear error instead of hanging when the extension never answers', async () => {
    const server = await startBridge({ requestTimeoutMs: 300 })
    await connectReady(server, { silent: ['listCases'] })
    const started = Date.now()
    const result = await api<BridgeError>(server, 'GET', '/api/cases')
    expect(result.status).toBe(504)
    expect(result.body.error).toMatch(/listCases/)
    // The point of the test: it returned, and quickly.
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('rejects a pending request when the extension socket closes mid-flight', async () => {
    const server = await startBridge({ requestTimeoutMs: 10_000 })
    const extension = await connectReady(server, { silent: ['listCases'] })
    const pending = api<BridgeError>(server, 'GET', '/api/cases')
    // Wait until the bridge actually relayed it, so the close is genuinely mid-flight.
    await until(() => extension.calls.some((call) => call.method === 'listCases'))
    extension.socket.terminate()
    const result = await pending
    expect(result.status).toBe(503)
    expect(result.body.code).toBe('not_connected')
  })

  it('goes back to not_connected after the extension disconnects', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { listCases: () => ({ cases: [] }) } })
    expect((await api<CasesResponse>(server, 'GET', '/api/cases')).status).toBe(200)
    extension.socket.close()
    expect(await until(() => server.connectedExtensions.length === 0)).toBe(true)
    const result = await api<BridgeError>(server, 'GET', '/api/cases')
    expect(result.status).toBe(503)
  })

  it('ignores a malformed frame rather than dropping the connection', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { listCases: () => ({ cases: [] }) } })
    extension.socket.send('this is not JSON at all')
    // The socket must still be usable for a real call afterwards.
    const result = await api<CasesResponse>(server, 'GET', '/api/cases')
    expect(result.status).toBe(200)
  })

  it('ignores a response carrying an unknown id', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { listCases: () => ({ cases: [] }) } })
    extension.socket.send(serializeFrame(respond('no-such-id', { cases: [] })))
    expect((await api<CasesResponse>(server, 'GET', '/api/cases')).status).toBe(200)
  })

  it('drops a socket that fails to answer the heartbeat ping', async () => {
    const server = await startBridge({ heartbeatMs: 60 })
    const extension = await connectReady(server)
    // Pausing the socket stops `ws` auto-replying to the ping frame, so the bridge
    // must notice and stop claiming an extension is available.
    extension.socket.pause()
    expect(await until(() => server.connectedExtensions.length === 0, 3_000)).toBe(true)
  })
})

// --- runs --------------------------------------------------------------------

describe('bridge run creation', () => {
  it('returns 202 with a CreateRunResponse and an absolute eventsUrl when not waiting', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { startRun: () => ({ runId: 'run-7', mode: 'agent' }) } })
    const result = await api<CreateRunResponse>(server, 'POST', '/api/runs', jsonBody({ caseId: 'case-1' }))
    expect(result.status).toBe(202)
    expect(result.body.runId).toBe('run-7')
    expect(result.body.mode).toBe('agent')
    expect(result.body.eventsUrl).toBe(`${server.url}/api/runs/run-7/events`)
  })

  it('rejects a body naming neither a case, a script, nor markdown', async () => {
    const server = await startBridge()
    await connectReady(server)
    const result = await api<BridgeError>(server, 'POST', '/api/runs', jsonBody({ wait: true }))
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('bad_request')
  })

  it('rejects a body that is not JSON', async () => {
    const server = await startBridge()
    await connectReady(server)
    const result = await api<BridgeError>(server, 'POST', '/api/runs', {
      body: '{oops',
      contentType: 'application/json',
    })
    expect(result.status).toBe(400)
  })

  it('forwards useAgent and save through to startRun', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, { handlers: { startRun: sequentialStartRun() } })
    await api(server, 'POST', '/api/runs', jsonBody({ markdown: '# case', useAgent: true, save: true }))
    expect(extension.calls.find((entry) => entry.method === 'startRun')?.params).toEqual({
      markdown: '# case',
      useAgent: true,
      save: true,
    })
  })

  it('fails with 500 when the extension answers startRun without a runId', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { startRun: () => ({ mode: 'script' }) } })
    const result = await api<BridgeError>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' }))
    expect(result.status).toBe(500)
    expect(result.body.code).toBe('internal')
  })

  it('holds the response until the run is terminal when wait is true', async () => {
    const server = await startBridge()
    const finished = makeRun({ id: 'run-1', status: 'passed', steps: [makeStep()] })
    const extension: FakeExtension = await connectReady(server, {
      handlers: {
        startRun: () => {
          // Emitted after the reply, exactly as a real run would.
          setTimeout(() => {
            extension.emit({ kind: 'event', event: 'runStatus', runId: 'run-1', status: 'running' })
            extension.emit({ kind: 'event', event: 'runFinished', run: finished })
          }, 30)
          return { runId: 'run-1', mode: 'script' }
        },
        getRun: () => finished,
      },
    })
    const result = await api<RunDetail>(
      server,
      'POST',
      '/api/runs',
      jsonBody({ caseId: 'case-1', wait: true, timeoutSeconds: 5 }),
    )
    expect(result.status).toBe(200)
    expect(result.body.status).toBe('passed')
    expect(result.body.steps).toHaveLength(1)
  })

  it('returns the failed run rather than an error when the application under test fails', async () => {
    const server = await startBridge()
    const failed = makeRun({ id: 'run-1', status: 'failed', failure: { stepIndex: 2, message: 'no dashboard' } })
    const extension: FakeExtension = await connectReady(server, {
      handlers: {
        startRun: () => {
          setTimeout(() => extension.emit({ kind: 'event', event: 'runFinished', run: failed }), 20)
          return { runId: 'run-1', mode: 'script' }
        },
        getRun: () => failed,
      },
    })
    const result = await api<RunDetail>(
      server,
      'POST',
      '/api/runs',
      jsonBody({ caseId: 'case-1', wait: true, timeoutSeconds: 5 }),
    )
    expect(result.status).toBe(200)
    expect(result.body.status).toBe('failed')
    expect(result.body.failure?.message).toBe('no dashboard')
  })

  it('returns a timeout error rather than hanging when wait exceeds timeoutSeconds', async () => {
    const server = await startBridge()
    // startRun answers, but no terminal event ever arrives.
    await connectReady(server, { handlers: { startRun: () => ({ runId: 'run-slow', mode: 'script' }) } })
    const started = Date.now()
    const result = await api<BridgeError>(
      server,
      'POST',
      '/api/runs',
      jsonBody({ caseId: 'case-1', wait: true, timeoutSeconds: 1 }),
    )
    expect(result.status).toBe(504)
    expect(result.body.error).toMatch(/run-slow/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('resolves a wait that lost the race, because the run finished before it subscribed', async () => {
    const server = await startBridge()
    const finished = makeRun({ id: 'run-fast', status: 'passed' })
    const extension: FakeExtension = await connectReady(server, {
      handlers: {
        startRun: () => {
          // Emitted synchronously with the reply: the HTTP handler cannot possibly
          // have subscribed yet, so this only passes because the bridge remembers
          // the last known status.
          extension.emit({ kind: 'event', event: 'runFinished', run: finished })
          return { runId: 'run-fast', mode: 'script' }
        },
        getRun: () => finished,
      },
    })
    const result = await api<RunDetail>(
      server,
      'POST',
      '/api/runs',
      jsonBody({ caseId: 'case-1', wait: true, timeoutSeconds: 5 }),
    )
    expect(result.status).toBe(200)
    expect(result.body.status).toBe('passed')
  })

  it('returns a RunDetail with absolute artifact URLs derived from the steps', async () => {
    const server = await startBridge()
    const run = makeRun({
      id: 'run-9',
      steps: [makeStep({ index: 0 }), makeStep({ index: 1, screenshotId: 'shot-a', ok: false, error: 'boom' })],
    })
    await connectReady(server, { handlers: { getRun: () => run } })
    const result = await api<RunDetail>(server, 'GET', '/api/runs/run-9')
    expect(result.status).toBe(200)
    expect(result.body.artifacts).toEqual([
      { id: 'shot-a', stepIndex: 1, url: `${server.url}/api/runs/run-9/artifacts/shot-a` },
    ])
  })

  it('uses the artifact list when the extension supplies one', async () => {
    const server = await startBridge()
    const run = makeRun({ id: 'run-10' })
    await connectReady(server, {
      handlers: { getRun: () => ({ run, artifacts: [{ id: 'shot-z', stepIndex: 4 }] }) },
    })
    const result = await api<RunDetail>(server, 'GET', '/api/runs/run-10')
    expect(result.body.artifacts[0]?.id).toBe('shot-z')
    expect(result.body.artifacts[0]?.url).toContain('/api/runs/run-10/artifacts/shot-z')
  })

  it('returns 404 for an unknown run', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { getRun: () => null } })
    const result = await api<BridgeError>(server, 'GET', '/api/runs/nope')
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('not_found')
  })

  it('relays a cancel request', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, {
      handlers: { startRun: sequentialStartRun(), cancelRun: () => ({ ok: true }) },
    })
    const result = await api<{ ok: boolean }>(server, 'POST', '/api/runs/run-1/cancel')
    expect(result.status).toBe(200)
    expect(extension.calls.find((entry) => entry.method === 'cancelRun')?.params).toEqual({ runId: 'run-1' })
  })
})

// --- SSE ---------------------------------------------------------------------

describe('bridge Server-Sent Events', () => {
  it('sets the SSE headers and flushes them before any event arrives', async () => {
    const server = await startBridge()
    await connectReady(server)
    const { response } = await openSse(server, 'run-1')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    // `fetch` resolving at all proves the headers were flushed before any body byte.
    expect(response.body).not.toBeNull()
  })

  it('delivers events in order, framed as event/data pairs', async () => {
    const server = await startBridge()
    const extension = await connectReady(server)
    const { sse } = await openSse(server, 'run-1')

    extension.emit({ kind: 'event', event: 'runStarted', run: makeRun({ id: 'run-1', status: 'running' }) })
    extension.emit({
      kind: 'event',
      event: 'runStep',
      runId: 'run-1',
      step: makeStep({ index: 0, description: 'click "Sign in"' }),
    })
    extension.emit({ kind: 'event', event: 'runStatus', runId: 'run-1', status: 'running', message: 'step 2' })

    const frames = await sse.take(3)
    expect(frames).toHaveLength(3)
    expect(frames[0]?.startsWith('event: runStarted\ndata: ')).toBe(true)
    expect(frames[1]?.startsWith('event: runStep\ndata: ')).toBe(true)
    expect(frames[2]?.startsWith('event: runStatus\ndata: ')).toBe(true)

    const second = JSON.parse(frames[1]?.split('data: ')[1] ?? '{}') as { step: StepRecord }
    expect(second.step.description).toBe('click "Sign in"')
  })

  it('ends the stream once the run reaches a terminal status', async () => {
    const server = await startBridge()
    const extension = await connectReady(server)
    const { sse } = await openSse(server, 'run-1')
    extension.emit({ kind: 'event', event: 'runStarted', run: makeRun({ id: 'run-1', status: 'running' }) })
    extension.emit({ kind: 'event', event: 'runFinished', run: makeRun({ id: 'run-1', status: 'passed' }) })
    expect(await sse.waitForEnd()).toBe(true)
    expect(sse.frames.some((frame) => frame.startsWith('event: runFinished'))).toBe(true)
  })

  it('replays buffered events to a subscriber that connects late', async () => {
    const server = await startBridge()
    const extension = await connectReady(server)
    extension.emit({ kind: 'event', event: 'runStarted', run: makeRun({ id: 'run-late', status: 'running' }) })
    await settle()
    const { sse } = await openSse(server, 'run-late')
    const frames = await sse.take(1)
    expect(frames[0]?.startsWith('event: runStarted')).toBe(true)
  })

  it('closes immediately for a run that is already terminal', async () => {
    const server = await startBridge()
    const extension = await connectReady(server)
    extension.emit({ kind: 'event', event: 'runFinished', run: makeRun({ id: 'run-done', status: 'passed' }) })
    await settle()
    const { sse } = await openSse(server, 'run-done')
    expect(await sse.waitForEnd()).toBe(true)
  })

  it('only delivers the requested run, not another run in flight', async () => {
    const server = await startBridge()
    const extension = await connectReady(server)
    const { sse } = await openSse(server, 'run-mine')
    extension.emit({ kind: 'event', event: 'runStatus', runId: 'run-theirs', status: 'running' })
    extension.emit({ kind: 'event', event: 'runStatus', runId: 'run-mine', status: 'running' })
    const frames = await sse.take(1)
    expect(frames).toHaveLength(1)
    const payload = JSON.parse(frames[0]?.split('data: ')[1] ?? '{}') as { runId: string }
    expect(payload.runId).toBe('run-mine')
  })

  it('sends a comment heartbeat so an idle stream is not closed by a proxy', async () => {
    const server = await startBridge({ sseHeartbeatMs: 40 })
    await connectReady(server)
    const { sse } = await openSse(server, 'run-idle')
    const frames = await sse.take(2, 2_000)
    expect(frames).toHaveLength(2)
    expect(frames.every((frame) => frame === ': ping')).toBe(true)
  })

  it('requires the token like every other /api route', async () => {
    const server = await startBridge()
    await connectReady(server)
    const response = await fetch(`${server.url}/api/runs/run-1/events`)
    expect(response.status).toBe(401)
    await response.text()
  })

  it('drops its listener when the client disconnects, so a CI run leaks nothing', async () => {
    const server = await startBridge()
    const extension = await connectReady(server)
    await openSse(server, 'run-abort')
    // Cancelling the reader aborts the request; the server must survive a write to a
    // closed socket and must not accumulate the listener.
    const reader = openReaders.pop()
    await reader?.cancel()
    await settle()
    extension.emit({ kind: 'event', event: 'runStatus', runId: 'run-abort', status: 'running' })
    await settle()
    // Proof that nothing broke: the bridge still answers normally afterwards.
    const health = await api<HealthResponse>(server, 'GET', '/health', { token: null })
    expect(health.body.ok).toBe(true)
  })
})

// --- artifacts ---------------------------------------------------------------

describe('bridge artifact serving', () => {
  it('serves a screenshot as real PNG bytes with a correct Content-Length', async () => {
    const server = await startBridge()
    await connectReady(server, {
      handlers: { getArtifact: () => ({ id: 'shot-a', dataUrl: `data:image/png;base64,${PNG_BASE64}` }) },
    })
    const response = await fetch(`${server.url}/api/runs/run-1/artifacts/shot-a`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')

    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
    // The PNG magic number: proof it is decoded binary, not a base64 string.
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('returns 404 when the artifact has been pruned', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { getArtifact: () => null } })
    const result = await api<BridgeError>(server, 'GET', '/api/runs/run-1/artifacts/gone')
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('not_found')
  })

  it('passes the run and artifact ids through to the extension', async () => {
    const server = await startBridge()
    const extension = await connectReady(server, {
      handlers: { getArtifact: () => ({ dataUrl: `data:image/png;base64,${PNG_BASE64}` }) },
    })
    const response = await fetch(`${server.url}/api/runs/run-5/artifacts/shot-b`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    await response.arrayBuffer()
    expect(extension.calls.find((entry) => entry.method === 'getArtifact')?.params).toEqual({
      runId: 'run-5',
      id: 'shot-b',
    })
  })

  it('decodes a base64 data URL to the same bytes Buffer.from would', () => {
    const decoded = decodeDataUrl(`data:image/png;base64,${PNG_BASE64}`)
    expect(decoded?.mime).toBe('image/png')
    expect(decoded?.bytes.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true)
  })

  it('refuses a data URL it cannot decode', async () => {
    const server = await startBridge()
    await connectReady(server, { handlers: { getArtifact: () => ({ dataUrl: 'not-a-data-url' }) } })
    const result = await api<BridgeError>(server, 'GET', '/api/runs/run-1/artifacts/bad')
    expect(result.status).toBe(500)
    expect(result.body.code).toBe('internal')
  })
})

// --- routing -----------------------------------------------------------------

describe('bridge routing', () => {
  it('answers 404 with the not_found code for an unknown /api path', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'GET', '/api/nonsense')
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('not_found')
  })

  it('answers 404 for an unknown top-level path', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'GET', '/wat', { token: null })
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('not_found')
  })

  it('answers 404 for an over-long run sub-path', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'GET', '/api/runs/run-1/events/extra')
    expect(result.status).toBe(404)
  })

  it('answers 405 for a wrong method on /health', async () => {
    const server = await startBridge()
    const result = await api<BridgeError>(server, 'POST', '/health', { token: null })
    expect(result.status).toBe(405)
    expect(result.body.error).toMatch(/GET/)
  })

  it('answers 405 for a wrong method on /api/cases', async () => {
    const server = await startBridge()
    await connectReady(server)
    const result = await api<BridgeError>(server, 'PUT', '/api/cases')
    expect(result.status).toBe(405)
  })

  it('answers 405 for a GET on the cancel endpoint', async () => {
    const server = await startBridge()
    await connectReady(server)
    const result = await api<BridgeError>(server, 'GET', '/api/runs/run-1/cancel')
    expect(result.status).toBe(405)
  })

  it('binds to loopback only', async () => {
    const server = await startBridge()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(server.port).toBeGreaterThan(0)
  })
})

// --- concurrency -------------------------------------------------------------

describe('bridge maxConcurrent', () => {
  it('refuses a second run with the busy code rather than queueing it', async () => {
    const server = await startBridge({ maxConcurrent: 1 })
    await connectReady(server, { handlers: { startRun: sequentialStartRun() } })
    const first = await api<CreateRunResponse>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' }))
    expect(first.status).toBe(202)
    const second = await api<BridgeError>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c2' }))
    expect(second.status).toBe(429)
    expect(second.body.code).toBe('busy')
    expect(second.body.error).toMatch(/maxConcurrent=1/)
  })

  it('frees the slot when the run reaches a terminal status', async () => {
    const server = await startBridge({ maxConcurrent: 1 })
    const extension = await connectReady(server, { handlers: { startRun: sequentialStartRun() } })
    await api(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' }))
    extension.emit({ kind: 'event', event: 'runFinished', run: makeRun({ id: 'run-1', status: 'passed' }) })
    await settle()
    const next = await api<CreateRunResponse>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c2' }))
    expect(next.status).toBe(202)
    expect(next.body.runId).toBe('run-2')
  })

  it('frees the slot when a run is cancelled', async () => {
    const server = await startBridge({ maxConcurrent: 1 })
    await connectReady(server, { handlers: { startRun: sequentialStartRun(), cancelRun: () => ({ ok: true }) } })
    await api(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' }))
    await api(server, 'POST', '/api/runs/run-1/cancel')
    const next = await api<CreateRunResponse>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c2' }))
    expect(next.status).toBe(202)
  })

  it('allows two runs when maxConcurrent is 2 and refuses the third', async () => {
    const server = await startBridge({ maxConcurrent: 2 })
    await connectReady(server, { handlers: { startRun: sequentialStartRun() } })
    const first = await api<CreateRunResponse>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' }))
    const second = await api<CreateRunResponse>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c2' }))
    const third = await api<BridgeError>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c3' }))
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(third.status).toBe(429)
  })

  it('does not leak a slot when startRun itself fails', async () => {
    const server = await startBridge({ maxConcurrent: 1 })
    await connectReady(server, { failing: { startRun: 'no allowed sites' } })
    const failed = await api<BridgeError>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' }))
    expect(failed.status).toBe(502)
    // A leaked reservation would make this 429 instead of another 502.
    const again = await api<BridgeError>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c2' }))
    expect(again.status).toBe(502)
  })

  it('does not double-claim when two run requests arrive together', async () => {
    const server = await startBridge({ maxConcurrent: 1 })
    await connectReady(server, { handlers: { startRun: sequentialStartRun() } })
    const [a, b] = await Promise.all([
      api<CreateRunResponse | BridgeError>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' })),
      api<CreateRunResponse | BridgeError>(server, 'POST', '/api/runs', jsonBody({ caseId: 'c2' })),
    ])
    const statuses = [a?.status ?? 0, b?.status ?? 0].sort((x, y) => x - y)
    expect(statuses).toEqual([202, 429])
  })

  it('counts a running run in /health and never reports a queue', async () => {
    const server = await startBridge({ maxConcurrent: 2 })
    await connectReady(server, { handlers: { startRun: sequentialStartRun() } })
    await api(server, 'POST', '/api/runs', jsonBody({ caseId: 'c1' }))
    const health = await api<HealthResponse>(server, 'GET', '/health', { token: null })
    expect(health.body.runningRuns).toBe(1)
    // Always zero: this bridge refuses rather than queues.
    expect(health.body.queuedRuns).toBe(0)
  })
})

// --- lifecycle ---------------------------------------------------------------

describe('bridge lifecycle', () => {
  it('refuses to start without a token', async () => {
    await expect(createBridgeServer({ token: '', port: 0 })).rejects.toThrow(/token/)
  })

  it('is idempotent on close', async () => {
    const server = await startBridge()
    await server.close()
    await expect(server.close()).resolves.toBeUndefined()
  })

  it('rejects pending requests when the bridge shuts down', async () => {
    const server = await startBridge({ requestTimeoutMs: 10_000 })
    const extension = await connectReady(server, { silent: ['listCases'] })
    const pending = api<BridgeError>(server, 'GET', '/api/cases').catch(() => null)
    await until(() => extension.calls.some((call) => call.method === 'listCases'))
    await server.close()
    const result = await pending
    // Either a 503 body or a dropped connection is acceptable; a hang is not.
    if (result) expect(result.status).toBe(503)
  })

  it('gives each server its own ephemeral port so suites can run in parallel', async () => {
    const first = await startBridge()
    const second = await startBridge()
    expect(first.port).not.toBe(second.port)
  })

  it('ends the stream for every terminal status kind', async () => {
    const server = await startBridge()
    const extension = await connectReady(server)
    const terminals: RunStatus[] = ['passed', 'failed', 'error', 'cancelled', 'interrupted']
    for (const status of terminals) {
      const runId = `run-${status}`
      const { sse } = await openSse(server, runId)
      extension.emit({ kind: 'event', event: 'runStatus', runId, status })
      expect(await sse.waitForEnd()).toBe(true)
    }
  })
})

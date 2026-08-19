/**
 * The wire contract between the extension and the local bridge.
 *
 * Shared by both sides so the Node process and the service worker cannot drift.
 * The extension is always the WebSocket *client*: a local server cannot reach
 * into a browser extension, and an extension cannot listen on a port. That
 * asymmetry is what makes the whole design work — and it means the bridge must
 * tolerate the extension being absent, since the browser may simply be closed.
 *
 * Envelopes are request/response with an `id` for correlation, plus unsolicited
 * `event` frames for run progress. There is no versioned handshake beyond
 * `protocolVersion`: a mismatch is reported and the connection closed, rather
 * than being negotiated, because both halves ship together.
 *
 * @module lib/protocol
 */

import type { RunStatus, StepRecord, TestCase, TestRun, TestScript } from './types'

/** Bumped on any breaking change to the frames below. */
export const PROTOCOL_VERSION = 1

/** What the extension can be asked to do. */
export type BridgeMethod =
  | 'hello'
  | 'listCases'
  | 'getCase'
  | 'saveCase'
  | 'deleteCase'
  | 'listScripts'
  | 'getScript'
  | 'deleteScript'
  | 'startRun'
  | 'cancelRun'
  | 'listRuns'
  | 'getRun'
  | 'getArtifact'
  | 'ping'

/** A request from the bridge to the extension. */
export interface BridgeRequest {
  kind: 'request'
  id: string
  method: BridgeMethod
  params?: Record<string, unknown>
}

/** The extension's reply. Exactly one per request. */
export interface BridgeResponse {
  kind: 'response'
  id: string
  ok: boolean
  result?: unknown
  /** Present when `ok` is false. Phrased for a CI log, not a developer console. */
  error?: string
}

/** Unsolicited progress, pushed while a run executes. */
export type BridgeEvent =
  | { kind: 'event'; event: 'runStarted'; run: TestRun }
  | { kind: 'event'; event: 'runStep'; runId: string; step: StepRecord }
  | { kind: 'event'; event: 'runStatus'; runId: string; status: RunStatus; message?: string }
  | { kind: 'event'; event: 'runFinished'; run: TestRun }
  | { kind: 'event'; event: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type BridgeFrame = BridgeRequest | BridgeResponse | BridgeEvent

/** The extension's opening frame, so the bridge knows what it is talking to. */
export interface HelloPayload {
  protocolVersion: number
  extensionVersion: string
  /** Whether a provider is configured; the bridge reports this in /health. */
  providerReady: boolean
  /** Whether any site is allow-listed; without one, unattended runs refuse. */
  allowedSiteCount: number
}

/** Parameters for `startRun`. */
export interface StartRunParams {
  /** Run a stored case. */
  caseId?: string
  /** Or run a stored script directly. */
  scriptId?: string
  /** Or supply a case as Markdown, which is how CI usually drives it. */
  markdown?: string
  /**
   * Force the agent even when a recorded script exists.
   *
   * Default is to replay the script: deterministic, free, and fast. CI wants
   * that; a developer re-recording after a UI change wants this flag.
   */
  useAgent?: boolean
  /** Save the case when it arrived as Markdown. Default false, so CI stays stateless. */
  save?: boolean
}

export interface StartRunResult {
  runId: string
  /** How the run will execute, so the caller can set expectations. */
  mode: 'script' | 'agent'
}

/** A JSON-safe error the bridge can return verbatim to an HTTP client. */
export interface BridgeError {
  error: string
  /** Machine-readable, for a CI script that branches on the cause. */
  code:
    | 'not_connected'
    | 'not_found'
    | 'bad_request'
    | 'unauthorized'
    | 'no_allowed_sites'
    | 'no_provider'
    | 'busy'
    | 'internal'
}

/** Builds a response frame. */
export function respond(id: string, result: unknown): BridgeResponse {
  return { kind: 'response', id, ok: true, result }
}

/** Builds an error response frame. */
export function respondError(id: string, error: string): BridgeResponse {
  return { kind: 'response', id, ok: false, error }
}

/**
 * Parses an incoming frame.
 *
 * Returns null instead of throwing: a malformed frame on a socket is not an
 * exception, it is a peer to ignore or disconnect. Throwing here would take down
 * the whole connection for one bad message.
 */
export function parseFrame(data: string): BridgeFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const frame = parsed as Partial<BridgeFrame> & { kind?: string }
  if (frame.kind === 'request') {
    const request = frame as Partial<BridgeRequest>
    if (typeof request.id !== 'string' || typeof request.method !== 'string') return null
    return {
      kind: 'request',
      id: request.id,
      method: request.method as BridgeMethod,
      ...(request.params && typeof request.params === 'object' ? { params: request.params } : {}),
    }
  }
  if (frame.kind === 'response') {
    const response = frame as Partial<BridgeResponse>
    if (typeof response.id !== 'string' || typeof response.ok !== 'boolean') return null
    return {
      kind: 'response',
      id: response.id,
      ok: response.ok,
      ...(response.result !== undefined ? { result: response.result } : {}),
      ...(typeof response.error === 'string' ? { error: response.error } : {}),
    }
  }
  if (frame.kind === 'event') {
    const event = frame as Partial<BridgeEvent> & { event?: string }
    if (typeof event.event !== 'string') return null
    return frame as BridgeEvent
  }
  return null
}

/** Serializes a frame for the socket. */
export function serializeFrame(frame: BridgeFrame): string {
  return JSON.stringify(frame)
}

// --- REST shapes -------------------------------------------------------------

/** `GET /health`. */
export interface HealthResponse {
  ok: true
  bridgeVersion: string
  protocolVersion: number
  /** False when the browser is closed or the extension is not connected. */
  extensionConnected: boolean
  providerReady: boolean
  allowedSiteCount: number
  runningRuns: number
  queuedRuns: number
  uptimeSeconds: number
}

/** `POST /api/runs` body. */
export interface CreateRunBody extends StartRunParams {
  /**
   * Block until the run finishes and return the whole result.
   *
   * The mode CI actually needs: one request, one exit code. Without it, a
   * pipeline has to poll, and every pipeline author writes that loop slightly
   * wrong.
   */
  wait?: boolean
  /** Cap on the wait, in seconds. Defaults to the run timeout plus a margin. */
  timeoutSeconds?: number
}

/** `POST /api/runs` response when not waiting. */
export interface CreateRunResponse extends StartRunResult {
  /** Where to watch progress. */
  eventsUrl: string
}

/** A run with everything a report needs, returned by `GET /api/runs/:id`. */
export interface RunDetail extends TestRun {
  artifacts: { id: string; stepIndex: number; url: string }[]
}

/** `GET /api/cases` response. */
export interface CasesResponse {
  cases: TestCase[]
}

/** `GET /api/scripts` response. */
export interface ScriptsResponse {
  scripts: TestScript[]
}

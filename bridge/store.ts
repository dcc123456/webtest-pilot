/**
 * Bridge configuration and the shared token, persisted under the user's home.
 *
 * The bridge is a local HTTP server, and "local" is not a security boundary on a
 * developer machine: every process the user runs — including the JavaScript of
 * any page open in their browser, via one stray `fetch('http://127.0.0.1:8787')`
 * — can reach it. A bridge without a secret would therefore let a random web page
 * start browser automation against the user's logged-in sessions. So the bridge
 * generates a high-entropy token on first run, keeps it 0600, and requires it on
 * every `/api/*` call; the Origin check in the server closes the remaining hole,
 * where a page that somehow learned the token drives the bridge from the browser.
 *
 * The file is JSON rather than a keychain entry on purpose: the user has to be
 * able to read the token to paste it into the extension's settings.
 *
 * @module bridge/store
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default port. Chosen to be memorable and outside the usual dev-server range. */
export const DEFAULT_PORT = 8787

/**
 * Default parallelism.
 *
 * One, because every run drives the *same* browser: two runs at once would fight
 * over windows, focus, and cookies, and the failures would look like flaky tests
 * rather than a configuration mistake.
 */
export const DEFAULT_MAX_CONCURRENT = 1

/** Everything the bridge needs to start. */
export interface BridgeStoredConfig {
  port: number
  token: string
  maxConcurrent: number
}

/**
 * Directory holding the config.
 *
 * `WEBTEST_PILOT_HOME` exists so a CI sandbox — and this project's own tests —
 * can keep their config out of a real user's home directory. Without it, running
 * the test suite would rewrite the developer's token.
 */
export function configDir(): string {
  const override = process.env.WEBTEST_PILOT_HOME
  if (override && override.trim().length > 0) return override
  return join(homedir(), '.webtest-pilot')
}

/** Absolute path of `config.json`; printed by the CLI so the user can find it. */
export function configPath(): string {
  return join(configDir(), 'config.json')
}

/** A fresh 256-bit token, hex-encoded so it survives copy-paste into a form. */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Reads the config, creating it (with a new token) when it does not exist yet.
 *
 * Missing or malformed individual fields are repaired rather than rejected: a
 * hand-edited config with a typo should not stop the user's test run, and every
 * field has a safe default. A missing *token*, though, is regenerated and
 * persisted, because a bridge with an empty token would accept `Bearer ` from
 * anyone.
 */
export async function loadConfig(): Promise<BridgeStoredConfig> {
  let raw: string
  try {
    raw = await readFile(configPath(), 'utf8')
  } catch {
    // First run (or an unreadable file): write a complete config so the token is
    // stable across restarts — the user pastes it into the extension once.
    const created: BridgeStoredConfig = {
      port: DEFAULT_PORT,
      token: generateToken(),
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
    }
    await saveConfig(created)
    return created
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}

  const port = normalizePort(record.port)
  const maxConcurrent = normalizeConcurrency(record.maxConcurrent)
  const storedToken = typeof record.token === 'string' ? record.token.trim() : ''
  const config: BridgeStoredConfig = {
    port,
    maxConcurrent,
    token: storedToken.length > 0 ? storedToken : generateToken(),
  }
  // Persist only when something actually changed, so a normal start does not
  // rewrite the file (and its mtime) on every invocation.
  if (
    storedToken !== config.token ||
    record.port !== config.port ||
    record.maxConcurrent !== config.maxConcurrent
  ) {
    await saveConfig(config)
  }
  return config
}

/**
 * Writes the config with owner-only permissions.
 *
 * `writeFile`'s `mode` applies only when the file is created, so an explicit
 * `chmod` follows: a config written before this rule existed — or copied in by
 * hand — must not stay world-readable, since it holds a live credential. The
 * chmod failure is swallowed because Windows has no POSIX mode bits and throwing
 * there would make the bridge unusable on the platform most of its users are on.
 */
export async function saveConfig(config: BridgeStoredConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  const path = configPath()
  const body = `${JSON.stringify(
    {
      port: normalizePort(config.port),
      token: config.token,
      maxConcurrent: normalizeConcurrency(config.maxConcurrent),
    },
    null,
    2,
  )}\n`
  await writeFile(path, body, { encoding: 'utf8', mode: 0o600 })
  try {
    await chmod(path, 0o600)
  } catch {
    // Best effort; see the note above.
  }
}

/**
 * Replaces the token and returns the updated config.
 *
 * Used when a token may have leaked — into a shell history, a CI log, a shared
 * screenshot. Rotating it invalidates the extension's copy too, which is why the
 * CLI reminds the user to paste the new one.
 */
export async function resetToken(): Promise<BridgeStoredConfig> {
  const current = await loadConfig()
  const rotated: BridgeStoredConfig = { ...current, token: generateToken() }
  await saveConfig(rotated)
  return rotated
}

/** Keeps a port usable: 0 is allowed, since it means "pick an ephemeral one". */
function normalizePort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65_535) {
    return DEFAULT_PORT
  }
  return value
}

/** At least one, so a nonsense value cannot deadlock every run. */
function normalizeConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return DEFAULT_MAX_CONCURRENT
  }
  return value
}

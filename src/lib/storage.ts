/**
 * Persistent state, in `chrome.storage.local`.
 *
 * MV3 evicts the service worker after roughly thirty seconds of inactivity and
 * gives no reliable shutdown hook, so **storage is the single source of truth**
 * for everything that must outlive a turn: cases, scripts, run history,
 * schedules, settings. Nothing important lives only in a worker variable.
 *
 * Two consequences shape this module:
 *
 * - **Writes are read-modify-write under a queue.** Two concurrent handlers —
 *   an alarm firing while the panel saves — would otherwise clobber each other,
 *   since `storage.local` has no transactions.
 * - **Lists are capped on write.** Unbounded run history eventually exceeds the
 *   quota, and a failing write at that point would lose the run that was just
 *   completed.
 *
 * @module lib/storage
 */

import { DEFAULT_SETTINGS } from './types'
import type { ProviderProfile } from './providers'
import type {
  LogEntry,
  RunStatus,
  Schedule,
  ScheduleEntry,
  SecretEntry,
  Settings,
  Skill,
  TestCase,
  TestRun,
  TestScript,
} from './types'

/** Storage keys, namespaced so an unrelated key cannot collide. */
const KEYS = {
  cases: 'wtp.cases',
  scripts: 'wtp.scripts',
  runs: 'wtp.runs',
  schedules: 'wtp.schedules',
  settings: 'wtp.settings',
  logs: 'wtp.logs',
  secrets: 'wtp.secrets',
  skills: 'wtp.skills',
} as const

/** Retention caps. Chosen so a busy month of nightly runs still fits the quota. */
export const LIMITS = {
  runs: 200,
  logs: 500,
  /** Total screenshot bytes kept in IndexedDB. */
  artifactBytes: 200 * 1024 * 1024,
} as const

/**
 * Serializes read-modify-write sequences.
 *
 * One queue for all keys rather than one per key: the sequences are short, and a
 * single queue removes any chance of a deadlock between two updates that touch
 * overlapping keys.
 */
let writeQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(body: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(body, body)
  // Swallow rejections in the chain itself so one failed write does not poison
  // every subsequent one; the caller still sees its own rejection.
  writeQueue = next.catch(() => undefined)
  return next
}

async function readKey<T>(key: string, fallback: T): Promise<T> {
  const bag = await chrome.storage.local.get(key)
  const value = bag[key]
  return (value as T | undefined) ?? fallback
}

async function writeKey(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

/** Creates an id that sorts by creation time, which makes run lists stable. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${time}${random}`
}

// --- Settings ---------------------------------------------------------------

/**
 * Reads settings, merged over defaults.
 *
 * Merged per section rather than shallowly: adding a field to `RunPolicy` in a
 * later version must not leave existing installs with that field undefined,
 * which would read as "off" for a safety option.
 */
export async function getSettings(): Promise<Settings> {
  const stored = await readKey<Partial<Settings>>(KEYS.settings, {})
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    providers: stored.providers ?? DEFAULT_SETTINGS.providers,
    policy: { ...DEFAULT_SETTINGS.policy, ...(stored.policy ?? {}) },
    feishu: { ...DEFAULT_SETTINGS.feishu, ...(stored.feishu ?? {}) },
    bridge: { ...DEFAULT_SETTINGS.bridge, ...(stored.bridge ?? {}) },
  }
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return enqueue(async () => {
    const current = await getSettings()
    const merged: Settings = {
      ...current,
      ...patch,
      policy: { ...current.policy, ...(patch.policy ?? {}) },
      feishu: { ...current.feishu, ...(patch.feishu ?? {}) },
      bridge: { ...current.bridge, ...(patch.bridge ?? {}) },
    }
    await writeKey(KEYS.settings, merged)
    return merged
  })
}

/** The provider profile the agent should use, or undefined when none is set. */
export async function activeProvider(): Promise<ProviderProfile | undefined> {
  const settings = await getSettings()
  return (
    settings.providers.find((profile) => profile.id === settings.activeProviderId) ??
    settings.providers[0]
  )
}

// --- Secrets ----------------------------------------------------------------

/**
 * Secrets live under their own key.
 *
 * Separate from settings so a settings export — which a user might paste into a
 * bug report — cannot carry passwords with it. `storage.local` is not encrypted;
 * this is a blast-radius measure, not a vault, and the README says so.
 */
export function getSecrets(): Promise<SecretEntry[]> {
  return readKey<SecretEntry[]>(KEYS.secrets, [])
}

export function saveSecret(entry: SecretEntry): Promise<SecretEntry[]> {
  return enqueue(async () => {
    const all = await getSecrets()
    const index = all.findIndex((secret) => secret.name === entry.name)
    const next = index >= 0 ? all.with(index, entry) : [...all, entry]
    await writeKey(KEYS.secrets, next)
    return next
  })
}

export function deleteSecret(name: string): Promise<SecretEntry[]> {
  return enqueue(async () => {
    const next = (await getSecrets()).filter((secret) => secret.name !== name)
    await writeKey(KEYS.secrets, next)
    return next
  })
}

// --- Skills -----------------------------------------------------------------

/**
 * Reusable instruction packs with optional fillable field data.
 *
 * Like secrets, skills are user-authored and small; unlike them they are not
 * credentials, so the full record is safe to keep in a normal list key.
 */
export function getSkills(): Promise<Skill[]> {
  return readKey<Skill[]>(KEYS.skills, [])
}

export async function getSkill(id: string): Promise<Skill | undefined> {
  return (await getSkills()).find((skill) => skill.id === id)
}

export function saveSkill(skill: Skill): Promise<Skill[]> {
  return enqueue(async () => {
    const all = await getSkills()
    const index = all.findIndex((existing) => existing.id === skill.id)
    const stamped: Skill = { ...skill, updatedAt: Date.now() }
    const next = index >= 0 ? all.with(index, stamped) : [stamped, ...all]
    await writeKey(KEYS.skills, next)
    return next
  })
}

export function deleteSkill(id: string): Promise<Skill[]> {
  return enqueue(async () => {
    const next = (await getSkills()).filter((skill) => skill.id !== id)
    await writeKey(KEYS.skills, next)
    return next
  })
}

/** Finds a skill by its unique name, used when the model calls `use_skill`. */
export async function findSkillByName(name: string): Promise<Skill | undefined> {
  const needle = name.trim().toLowerCase()
  return (await getSkills()).find((skill) => skill.name.toLowerCase() === needle)
}

/** Builds the resolver the runner uses, so secrets never cross a message port. */
export async function secretResolver(): Promise<(name: string) => string> {
  const secrets = await getSecrets()
  const table = new Map(secrets.map((secret) => [secret.name, secret.value]))
  return (name: string) => table.get(name) ?? ''
}

// --- Cases ------------------------------------------------------------------

export function getCases(): Promise<TestCase[]> {
  return readKey<TestCase[]>(KEYS.cases, [])
}

export async function getCase(id: string): Promise<TestCase | undefined> {
  return (await getCases()).find((testCase) => testCase.id === id)
}

export function saveCase(testCase: TestCase): Promise<TestCase> {
  return enqueue(async () => {
    const all = await getCases()
    const index = all.findIndex((existing) => existing.id === testCase.id)
    const stamped = { ...testCase, updatedAt: Date.now() }
    const next = index >= 0 ? all.with(index, stamped) : [stamped, ...all]
    await writeKey(KEYS.cases, next)
    return stamped
  })
}

export function saveCases(cases: TestCase[]): Promise<TestCase[]> {
  return enqueue(async () => {
    const all = await getCases()
    const byId = new Map(all.map((testCase) => [testCase.id, testCase]))
    for (const testCase of cases) byId.set(testCase.id, { ...testCase, updatedAt: Date.now() })
    const next = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    await writeKey(KEYS.cases, next)
    return cases
  })
}

/**
 * Deletes a case.
 *
 * Scripts are kept by default. A recorded script is the expensive artefact — it
 * cost a model run to produce — and deleting a case is often just tidying the
 * inbox, so throwing the script away silently would be the wrong default.
 */
export function deleteCase(id: string, options: { withScripts?: boolean } = {}): Promise<void> {
  return enqueue(async () => {
    const cases = (await getCases()).filter((testCase) => testCase.id !== id)
    await writeKey(KEYS.cases, cases)
    if (options.withScripts) {
      const scripts = (await getScripts()).filter((script) => script.caseId !== id)
      await writeKey(KEYS.scripts, scripts)
    }
  })
}

// --- Scripts ----------------------------------------------------------------

export function getScripts(): Promise<TestScript[]> {
  return readKey<TestScript[]>(KEYS.scripts, [])
}

export async function getScript(id: string): Promise<TestScript | undefined> {
  return (await getScripts()).find((script) => script.id === id)
}

/** The most recently updated script recorded for a case. */
export async function getScriptForCase(caseId: string): Promise<TestScript | undefined> {
  const scripts = (await getScripts()).filter((script) => script.caseId === caseId)
  return scripts.sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export function saveScript(script: TestScript): Promise<TestScript> {
  return enqueue(async () => {
    const all = await getScripts()
    const index = all.findIndex((existing) => existing.id === script.id)
    const stamped = { ...script, updatedAt: Date.now() }
    const next = index >= 0 ? all.with(index, stamped) : [stamped, ...all]
    await writeKey(KEYS.scripts, next)
    return stamped
  })
}

export function deleteScript(id: string): Promise<void> {
  return enqueue(async () => {
    const next = (await getScripts()).filter((script) => script.id !== id)
    await writeKey(KEYS.scripts, next)
  })
}

/**
 * Saves several scripts in one write.
 *
 * Used by bundle import. Calling `saveScript` per script would serialize a
 * read-modify-write for each one through the queue, so importing twenty scripts
 * would mean twenty full rewrites of the list.
 */
export function saveScripts(scripts: TestScript[]): Promise<TestScript[]> {
  return enqueue(async () => {
    const all = await getScripts()
    const byId = new Map(all.map((script) => [script.id, script]))
    const stamped = scripts.map((script) => ({ ...script, updatedAt: Date.now() }))
    for (const script of stamped) byId.set(script.id, script)
    await writeKey(KEYS.scripts, [...byId.values()])
    return stamped
  })
}

// --- Runs -------------------------------------------------------------------

export function getRuns(): Promise<TestRun[]> {
  return readKey<TestRun[]>(KEYS.runs, [])
}

export async function getRun(id: string): Promise<TestRun | undefined> {
  return (await getRuns()).find((run) => run.id === id)
}

/**
 * Inserts or replaces a run, newest first, capped at {@link LIMITS.runs}.
 *
 * Called on every step boundary during a run, which is exactly what makes the
 * progress visible after a worker restart — and why the write is queued.
 */
export function saveRun(run: TestRun): Promise<TestRun> {
  return enqueue(async () => {
    const all = await getRuns()
    const index = all.findIndex((existing) => existing.id === run.id)
    const next = index >= 0 ? all.with(index, run) : [run, ...all]
    next.sort((a, b) => b.startedAt - a.startedAt)
    await writeKey(KEYS.runs, next.slice(0, LIMITS.runs))
    return run
  })
}

/** Applies a partial update to a run, if it still exists. */
export function patchRun(id: string, patch: Partial<TestRun>): Promise<TestRun | undefined> {
  return enqueue(async () => {
    const all = await getRuns()
    const index = all.findIndex((run) => run.id === id)
    if (index < 0) return undefined
    const merged = { ...(all[index] as TestRun), ...patch }
    await writeKey(KEYS.runs, all.with(index, merged))
    return merged
  })
}

export function deleteRun(id: string): Promise<void> {
  return enqueue(async () => {
    const next = (await getRuns()).filter((run) => run.id !== id)
    await writeKey(KEYS.runs, next)
  })
}

export function clearRuns(): Promise<void> {
  return enqueue(async () => {
    await writeKey(KEYS.runs, [])
  })
}

/**
 * Marks runs left `running` by a crash as interrupted.
 *
 * Called on every worker startup. Without this, a browser restart mid-run leaves
 * a row that says "running" for ever, and a CI client waiting on it would hang
 * rather than fail — the worst possible outcome for an automated suite.
 */
export function reconcileRuns(now = Date.now(), staleMs = 120_000): Promise<TestRun[]> {
  return enqueue(async () => {
    const all = await getRuns()
    const repaired: TestRun[] = []
    const next = all.map((run) => {
      const active: RunStatus[] = ['running', 'queued']
      if (!active.includes(run.status)) return run
      const lastSeen = run.heartbeatAt ?? run.startedAt
      if (now - lastSeen < staleMs) return run
      const fixed: TestRun = {
        ...run,
        status: 'interrupted',
        finishedAt: now,
        summary:
          'The run was interrupted — the browser or the extension stopped before it finished. Start it again.',
      }
      repaired.push(fixed)
      return fixed
    })
    if (repaired.length > 0) await writeKey(KEYS.runs, next)
    return repaired
  })
}

// --- Schedules --------------------------------------------------------------

export function getSchedules(): Promise<ScheduleEntry[]> {
  return readKey<ScheduleEntry[]>(KEYS.schedules, [])
}

export async function getSchedule(id: string): Promise<ScheduleEntry | undefined> {
  return (await getSchedules()).find((entry) => entry.id === id)
}

export function saveSchedule(entry: ScheduleEntry): Promise<ScheduleEntry> {
  return enqueue(async () => {
    const all = await getSchedules()
    const index = all.findIndex((existing) => existing.id === entry.id)
    const next = index >= 0 ? all.with(index, entry) : [...all, entry]
    await writeKey(KEYS.schedules, next)
    return entry
  })
}

export function patchSchedule(
  id: string,
  patch: Partial<ScheduleEntry>,
): Promise<ScheduleEntry | undefined> {
  return enqueue(async () => {
    const all = await getSchedules()
    const index = all.findIndex((entry) => entry.id === id)
    if (index < 0) return undefined
    const merged = { ...(all[index] as ScheduleEntry), ...patch }
    await writeKey(KEYS.schedules, all.with(index, merged))
    return merged
  })
}

export function deleteSchedule(id: string): Promise<void> {
  return enqueue(async () => {
    const next = (await getSchedules()).filter((entry) => entry.id !== id)
    await writeKey(KEYS.schedules, next)
  })
}

/** Builds a schedule entry with its derived fields normalized. */
export function scheduleEntry(input: {
  name: string
  caseId: string
  schedule: Schedule
  preferScript?: boolean
  enabled?: boolean
  notify?: ScheduleEntry['notify']
  id?: string
  nextRunAt?: number
  createdAt?: number
}): ScheduleEntry {
  const entry: ScheduleEntry = {
    id: input.id ?? newId('sch'),
    name: input.name,
    caseId: input.caseId,
    // Unattended runs should be deterministic and free where possible, so
    // replaying a recorded script is the default.
    preferScript: input.preferScript ?? true,
    schedule: input.schedule,
    enabled: input.enabled ?? false,
    notify: input.notify ?? 'failure',
    createdAt: input.createdAt ?? Date.now(),
  }
  if (input.nextRunAt !== undefined) entry.nextRunAt = input.nextRunAt
  return entry
}

// --- Logs -------------------------------------------------------------------

export function getLogs(): Promise<LogEntry[]> {
  return readKey<LogEntry[]>(KEYS.logs, [])
}

/**
 * Appends a log line, capped at {@link LIMITS.logs}.
 *
 * The log is a diagnostic aid for the unattended paths — scheduled runs, bridge
 * requests — where nobody is watching the panel when something goes wrong.
 */
export function appendLog(entry: Omit<LogEntry, 'at'> & { at?: number }): Promise<void> {
  return enqueue(async () => {
    const all = await getLogs()
    const line: LogEntry = { ...entry, at: entry.at ?? Date.now() }
    const next = [line, ...all].slice(0, LIMITS.logs)
    await writeKey(KEYS.logs, next)
  })
}

export function clearLogs(): Promise<void> {
  return enqueue(async () => {
    await writeKey(KEYS.logs, [])
  })
}

// --- Bulk -------------------------------------------------------------------

/** Everything a user might want to back up, without secrets. */
export async function exportAll(): Promise<string> {
  const [cases, scripts, schedules, settings] = await Promise.all([
    getCases(),
    getScripts(),
    getSchedules(),
    getSettings(),
  ])
  // API keys and the bridge token are credentials: excluded from an export that
  // is likely to be shared in a bug report or committed to a repository.
  const safeProviders = settings.providers.map(({ apiKey: _apiKey, ...rest }) => ({
    ...rest,
    apiKey: '',
  }))
  return `${JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      cases,
      scripts,
      schedules,
      settings: {
        ...settings,
        providers: safeProviders,
        bridge: { ...settings.bridge, token: '' },
      },
    },
    null,
    2,
  )}\n`
}

/** Restores an export, merging by id. */
export function importAll(text: string): Promise<{ cases: number; scripts: number; schedules: number }> {
  return enqueue(async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('An export must be a JSON object.')
    const bag = parsed as {
      cases?: TestCase[]
      scripts?: TestScript[]
      schedules?: ScheduleEntry[]
    }

    let cases = 0
    let scripts = 0
    let schedules = 0

    if (Array.isArray(bag.cases)) {
      const existing = await readKey<TestCase[]>(KEYS.cases, [])
      const byId = new Map(existing.map((testCase) => [testCase.id, testCase]))
      for (const testCase of bag.cases) {
        if (typeof testCase?.id !== 'string') continue
        byId.set(testCase.id, testCase)
        cases += 1
      }
      await writeKey(KEYS.cases, [...byId.values()])
    }
    if (Array.isArray(bag.scripts)) {
      const existing = await readKey<TestScript[]>(KEYS.scripts, [])
      const byId = new Map(existing.map((script) => [script.id, script]))
      for (const script of bag.scripts) {
        if (typeof script?.id !== 'string') continue
        byId.set(script.id, script)
        scripts += 1
      }
      await writeKey(KEYS.scripts, [...byId.values()])
    }
    if (Array.isArray(bag.schedules)) {
      const existing = await readKey<ScheduleEntry[]>(KEYS.schedules, [])
      const byId = new Map(existing.map((entry) => [entry.id, entry]))
      for (const entry of bag.schedules) {
        if (typeof entry?.id !== 'string') continue
        // An imported schedule starts disabled: enabling it silently would make
        // an import trigger runs against whatever site it names.
        byId.set(entry.id, { ...entry, enabled: false })
        schedules += 1
      }
      await writeKey(KEYS.schedules, [...byId.values()])
    }
    return { cases, scripts, schedules }
  })
}

/** Bytes used in `chrome.storage.local`, for the Settings readout. */
export async function storageUsage(): Promise<number> {
  try {
    return await chrome.storage.local.getBytesInUse(null)
  } catch {
    return 0
  }
}

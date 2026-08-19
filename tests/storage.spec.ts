/**
 * Storage tests.
 *
 * The invariants here are the ones that only break under concurrency or at a
 * limit â€?a lost write when an alarm fires mid-save, run history growing past the
 * quota, a secret leaking into an export. Those are cheap to test now and very
 * expensive to diagnose in the field.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { installChromeFake, type FakeStorage } from './fake-chrome'

let storage: FakeStorage
/** Re-imported per test so the module's write queue starts empty. */
let mod: typeof import('../src/lib/storage')

beforeEach(async () => {
  ;({ storage } = installChromeFake())
  // A fresh module registry gives each test its own queue and caches.
  await import('vitest').then(({ vi }) => vi.resetModules())
  mod = await import('../src/lib/storage')
})

function run(overrides: Partial<import('../src/lib/types').TestRun> = {}) {
  const base = {
    id: 'run-1',
    caseName: 'Login smoke',
    mode: 'agent' as const,
    trigger: 'manual' as const,
    status: 'passed' as const,
    startedAt: 1000,
    heartbeatAt: 1000,
    steps: [],
  }
  return { ...base, ...overrides }
}

function testCase(overrides: Partial<import('../src/lib/types').TestCase> = {}) {
  return {
    id: 'case-1',
    name: 'Login smoke',
    steps: ['Open the login page'],
    expectations: ['The dashboard appears'],
    tags: [],
    source: 'manual' as const,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function script(overrides: Partial<import('../src/lib/types').TestScript> = {}) {
  return {
    id: 'scr-1',
    version: 1 as const,
    name: 'Login smoke',
    startUrl: 'https://app.test/login',
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    const settings = await mod.getSettings()
    expect(settings.policy.allowedSites).toEqual([])
    // The allow-list defaulting to empty is the safety property: an unconfigured
    // install can drive nothing.
    expect(settings.policy.useDedicatedWindow).toBe(true)
    expect(settings.policy.selfHeal).toBe(false)
  })

  it('merges a nested policy patch instead of replacing the whole object', async () => {
    await mod.saveSettings({ policy: { ...(await mod.getSettings()).policy, stepTimeoutMs: 999 } })
    const settings = await mod.getSettings()
    expect(settings.policy.stepTimeoutMs).toBe(999)
    // Everything else in `policy` must survive, or a single UI toggle would reset
    // the user's timeouts.
    expect(settings.policy.maxToolRounds).toBe(24)
  })

  it('keeps unrelated top-level sections when patching one', async () => {
    await mod.saveSettings({ feishu: { ...(await mod.getSettings()).feishu, webhookUrl: 'https://x' } })
    const settings = await mod.getSettings()
    expect(settings.feishu.webhookUrl).toBe('https://x')
    expect(settings.bridge.url).toContain('127.0.0.1')
  })

  it('reads back a stored provider as the active one', async () => {
    await mod.saveSettings({
      providers: [
        {
          id: 'p1',
          label: 'Ark',
          presetId: 'ark',
          baseUrl: 'https://ark.test/api/v3',
          apiKey: 'k',
          model: 'ep-1',
        },
      ],
      activeProviderId: 'p1',
    })
    expect((await mod.activeProvider())?.model).toBe('ep-1')
  })

  it('falls back to the first provider when the active id is stale', async () => {
    await mod.saveSettings({
      providers: [
        { id: 'p1', label: 'A', presetId: 'openai', baseUrl: 'https://a', apiKey: 'k', model: 'm' },
      ],
      activeProviderId: 'gone',
    })
    // Otherwise deleting the active profile would silently disable the tool.
    expect((await mod.activeProvider())?.id).toBe('p1')
  })

  it('returns undefined when no provider is configured', async () => {
    expect(await mod.activeProvider()).toBeUndefined()
  })
})

describe('secrets', () => {
  it('stores and resolves a secret by name', async () => {
    await mod.saveSecret({ name: 'PW', value: 'hunter2' })
    const resolve = await mod.secretResolver()
    expect(resolve('PW')).toBe('hunter2')
  })

  it('resolves an unknown name to an empty string rather than throwing', async () => {
    const resolve = await mod.secretResolver()
    // A missing secret must fail the step with an empty value, not crash the run.
    expect(resolve('NOPE')).toBe('')
  })

  it('replaces a secret with the same name instead of duplicating it', async () => {
    await mod.saveSecret({ name: 'PW', value: 'one' })
    await mod.saveSecret({ name: 'PW', value: 'two' })
    const secrets = await mod.getSecrets()
    expect(secrets).toHaveLength(1)
    expect(secrets[0]?.value).toBe('two')
  })

  it('deletes a secret', async () => {
    await mod.saveSecret({ name: 'PW', value: 'x' })
    await mod.deleteSecret('PW')
    expect(await mod.getSecrets()).toEqual([])
  })
})

describe('cases and scripts', () => {
  it('saves and reads a case', async () => {
    await mod.saveCase(testCase())
    expect((await mod.getCase('case-1'))?.name).toBe('Login smoke')
  })

  it('replaces a case on re-save rather than appending', async () => {
    await mod.saveCase(testCase())
    await mod.saveCase(testCase({ name: 'Renamed' }))
    const cases = await mod.getCases()
    expect(cases).toHaveLength(1)
    expect(cases[0]?.name).toBe('Renamed')
  })

  it('saves many cases at once, which is how a Markdown import arrives', async () => {
    await mod.saveCases([testCase({ id: 'a' }), testCase({ id: 'b' })])
    expect(await mod.getCases()).toHaveLength(2)
  })

  it('keeps a script when its case is deleted, by default', async () => {
    await mod.saveCase(testCase())
    await mod.saveScript(script({ caseId: 'case-1' }))
    await mod.deleteCase('case-1')
    // The recorded script is the expensive artefact; deleting a case must not
    // throw away a working automation by surprise.
    expect(await mod.getScripts()).toHaveLength(1)
  })

  it('deletes the script too when asked explicitly', async () => {
    await mod.saveCase(testCase())
    await mod.saveScript(script({ caseId: 'case-1' }))
    await mod.deleteCase('case-1', { withScripts: true })
    expect(await mod.getScripts()).toEqual([])
  })

  it('finds the script belonging to a case', async () => {
    await mod.saveScript(script({ id: 's1', caseId: 'case-1' }))
    expect((await mod.getScriptForCase('case-1'))?.id).toBe('s1')
  })

  it('returns undefined when a case has no script', async () => {
    expect(await mod.getScriptForCase('case-1')).toBeUndefined()
  })

  it('bumps updatedAt on save so the UI can sort by recency', async () => {
    const saved = await mod.saveScript(script({ updatedAt: 0 }))
    expect(saved.updatedAt).toBeGreaterThan(0)
  })
})

describe('runs', () => {
  it('stores a run and reads it back', async () => {
    await mod.saveRun(run())
    expect((await mod.getRun('run-1'))?.caseName).toBe('Login smoke')
  })

  it('keeps runs newest first', async () => {
    await mod.saveRun(run({ id: 'old', startedAt: 100 }))
    await mod.saveRun(run({ id: 'new', startedAt: 900 }))
    expect((await mod.getRuns()).map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  it('replaces a run in place as it progresses', async () => {
    await mod.saveRun(run({ status: 'running' }))
    await mod.saveRun(run({ status: 'passed' }))
    const runs = await mod.getRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('passed')
  })

  it('caps history so storage cannot grow without bound', async () => {
    for (let index = 0; index < mod.LIMITS.runs + 20; index += 1) {
      await mod.saveRun(run({ id: `run-${index}`, startedAt: index }))
    }
    const runs = await mod.getRuns()
    expect(runs).toHaveLength(mod.LIMITS.runs)
    // The newest must be the ones kept: old history is the expendable part.
    expect(runs[0]?.id).toBe(`run-${mod.LIMITS.runs + 19}`)
  })

  it('patches a run without rewriting the rest', async () => {
    await mod.saveRun(run())
    const patched = await mod.patchRun('run-1', { heartbeatAt: 5000 })
    expect(patched?.heartbeatAt).toBe(5000)
    expect(patched?.caseName).toBe('Login smoke')
  })

  it('patching a deleted run resolves undefined instead of recreating it', async () => {
    // A late step callback from a run the user just deleted must not resurrect it.
    expect(await mod.patchRun('gone', { heartbeatAt: 1 })).toBeUndefined()
    expect(await mod.getRuns()).toEqual([])
  })

  it('deletes one run and clears all runs', async () => {
    await mod.saveRun(run({ id: 'a' }))
    await mod.saveRun(run({ id: 'b' }))
    await mod.deleteRun('a')
    expect(await mod.getRuns()).toHaveLength(1)
    await mod.clearRuns()
    expect(await mod.getRuns()).toEqual([])
  })
})

describe('reconcileRuns', () => {
  it('marks a stale running run as interrupted', async () => {
    await mod.saveRun(run({ status: 'running', heartbeatAt: 0 }))
    const repaired = await mod.reconcileRuns(500_000)
    expect(repaired).toHaveLength(1)
    // Without this, a crashed run looks active for ever and a waiting CI client
    // never gets an answer.
    expect((await mod.getRun('run-1'))?.status).toBe('interrupted')
  })

  it('leaves a run whose heartbeat is recent', async () => {
    await mod.saveRun(run({ status: 'running', heartbeatAt: 499_000 }))
    expect(await mod.reconcileRuns(500_000)).toEqual([])
    expect((await mod.getRun('run-1'))?.status).toBe('running')
  })

  it('never touches an already finished run', async () => {
    await mod.saveRun(run({ status: 'passed', heartbeatAt: 0 }))
    expect(await mod.reconcileRuns(500_000)).toEqual([])
    expect((await mod.getRun('run-1'))?.status).toBe('passed')
  })

  it('records a finishedAt so the duration is not open-ended', async () => {
    await mod.saveRun(run({ status: 'running', heartbeatAt: 0 }))
    await mod.reconcileRuns(500_000)
    expect((await mod.getRun('run-1'))?.finishedAt).toBe(500_000)
  })
})

describe('the write queue', () => {
  it('does not lose a write when two writers overlap', async () => {
    // The bug this prevents: an alarm firing while the panel saves. Both read the
    // same array, both write, and one case silently vanishes.
    ;({ storage } = installChromeFake({ writeDelayMs: 5 }))
    const { vi } = await import('vitest')
    vi.resetModules()
    const fresh = await import('../src/lib/storage')

    await Promise.all([
      fresh.saveCase(testCase({ id: 'a' })),
      fresh.saveCase(testCase({ id: 'b' })),
      fresh.saveCase(testCase({ id: 'c' })),
    ])

    expect((await fresh.getCases()).map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('serializes concurrent run patches so no step record is lost', async () => {
    ;({ storage } = installChromeFake({ writeDelayMs: 3 }))
    const { vi } = await import('vitest')
    vi.resetModules()
    const fresh = await import('../src/lib/storage')

    await fresh.saveRun(run({ status: 'running' }))
    await Promise.all([
      fresh.patchRun('run-1', { summary: 'one' }),
      fresh.patchRun('run-1', { heartbeatAt: 2 }),
      fresh.patchRun('run-1', { windowId: 7 }),
    ])

    const stored = await fresh.getRun('run-1')
    // Every patch must be present: they touch different fields, and a lost
    // update here means a step disappears from the report.
    expect(stored?.summary).toBe('one')
    expect(stored?.heartbeatAt).toBe(2)
    expect(stored?.windowId).toBe(7)
  })
})

describe('logs', () => {
  it('appends with a timestamp', async () => {
    await mod.appendLog({ level: 'info', source: 'test', message: 'hello' })
    const logs = await mod.getLogs()
    expect(logs[0]?.message).toBe('hello')
    expect(typeof logs[0]?.at).toBe('number')
  })

  it('caps the log so it cannot fill the quota', async () => {
    for (let index = 0; index < mod.LIMITS.logs + 25; index += 1) {
      await mod.appendLog({ level: 'info', source: 'test', message: `m${index}` })
    }
    expect(await mod.getLogs()).toHaveLength(mod.LIMITS.logs)
  })

  it('clears the log', async () => {
    await mod.appendLog({ level: 'info', source: 'test', message: 'x' })
    await mod.clearLogs()
    expect(await mod.getLogs()).toEqual([])
  })
})

describe('export and import', () => {
  it('never exports an API key', async () => {
    await mod.saveSettings({
      providers: [
        {
          id: 'p1',
          label: 'A',
          presetId: 'openai',
          baseUrl: 'https://a',
          apiKey: 'sk-super-secret',
          model: 'm',
        },
      ],
      activeProviderId: 'p1',
    })
    const json = await mod.exportAll()
    // The export is meant to be shared with a teammate or committed; a key in it
    // would be a credential leak with no warning.
    expect(json).not.toContain('sk-super-secret')
  })

  it('never exports a secret value or a bridge token', async () => {
    await mod.saveSecret({ name: 'PW', value: 'hunter2' })
    await mod.saveSettings({
      bridge: { ...(await mod.getSettings()).bridge, token: 'tok-abc' },
    })
    const json = await mod.exportAll()
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('tok-abc')
  })

  it('round-trips cases and scripts', async () => {
    await mod.saveCase(testCase())
    await mod.saveScript(script())
    const json = await mod.exportAll()

    await storage.clear()
    const counts = await mod.importAll(json)
    expect(counts.cases).toBe(1)
    expect(counts.scripts).toBe(1)
    expect(await mod.getCases()).toHaveLength(1)
  })

  it('forces imported schedules to arrive disabled', async () => {
    const json = JSON.stringify({
      version: 1,
      schedules: [
        {
          id: 'sch-1',
          name: 'Nightly',
          caseId: 'case-1',
          schedule: { kind: 'daily', time: '03:00', weekdays: [] },
          enabled: true,
          notify: 'failure',
          createdAt: 1,
        },
      ],
    })
    await mod.importAll(json)
    // Importing someone else's file must never start driving a browser on a
    // timer the user has not seen yet.
    expect((await mod.getSchedules())[0]?.enabled).toBe(false)
  })

  it('rejects malformed JSON with a readable message', async () => {
    await expect(mod.importAll('{not json')).rejects.toThrow()
  })

  it('imports an empty payload without failing', async () => {
    const counts = await mod.importAll(JSON.stringify({ version: 1 }))
    expect(counts).toEqual({ cases: 0, scripts: 0, schedules: 0 })
  })
})

describe('newId', () => {
  it('prefixes and does not repeat', async () => {
    const ids = new Set(Array.from({ length: 200 }, () => mod.newId('run')))
    expect(ids.size).toBe(200)
    expect([...ids].every((id) => id.startsWith('run'))).toBe(true)
  })
})

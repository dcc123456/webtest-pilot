/**
 * Share bundle tests.
 *
 * Two properties matter more than the rest and are pinned hardest:
 *
 * 1. A bundle leaks nothing. Shared files land in chat messages and git repos, so
 *    a secret value in one is effectively published.
 * 2. An import never overwrites the recipient's own work. Ids from another machine
 *    are unrelated to local ones, so merging by id would silently replace a
 *    stranger's script over yours.
 */

import { describe, expect, it } from 'vitest'

import {
  BUNDLE_KIND,
  BUNDLE_VERSION,
  buildBundle,
  collectSecretRefs,
  parseBundle,
  toBundleJson,
} from '../src/lib/share'
import type { ScriptStep, TestCase, TestScript } from '../src/lib/types'

/** A counter-based id factory, so assertions can name exact ids. */
function ids(): (prefix: 'script' | 'case') => string {
  const counts = { script: 0, case: 0 }
  return (prefix) => {
    counts[prefix] += 1
    return `new-${prefix}-${counts[prefix]}`
  }
}

const target = { primary: { how: 'testid' as const, value: 'go' }, fallbacks: [] }

function script(overrides: Partial<TestScript> = {}): TestScript {
  return {
    id: 'their-script-1',
    version: 1,
    name: 'Checkout smoke',
    startUrl: 'https://shop.test/cart',
    steps: [{ action: 'click', target }],
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  }
}

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'their-case-1',
    name: 'Checkout',
    tags: ['smoke'],
    source: 'chat',
    steps: ['click checkout'],
    expectations: ['order appears'],
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  }
}

describe('what a bundle carries', () => {
  it('includes only the cases the exported scripts reference', () => {
    const bundle = buildBundle(
      [script({ caseId: 'their-case-1' })],
      [testCase(), testCase({ id: 'their-case-2', name: 'Unrelated private test' })],
    )
    // Exporting one script must not disclose every other test in the profile.
    expect(bundle.cases.map((entry) => entry.name)).toEqual(['Checkout'])
  })

  it('carries no cases when the script has none, rather than guessing', () => {
    const bundle = buildBundle([script()], [testCase()])
    expect(bundle.cases).toEqual([])
  })

  it('lists the secret names a script needs, so the recipient can create them', () => {
    const steps: ScriptStep[] = [
      { action: 'fill', target, secretRef: 'LOGIN_PW' },
      { action: 'fill', target, secretRef: 'API_TOKEN' },
      { action: 'fill', target, secretRef: 'LOGIN_PW' },
    ]
    const bundle = buildBundle([script({ steps })], [])
    expect(bundle.requiredSecrets).toEqual(['API_TOKEN', 'LOGIN_PW'])
  })

  it('never contains a secret value, only the reference name', () => {
    const steps: ScriptStep[] = [{ action: 'fill', target, secretRef: 'LOGIN_PW' }]
    const json = toBundleJson(buildBundle([script({ steps })], []))
    expect(json).toContain('LOGIN_PW')
    // The whole point: names travel, values never do. The runner substitutes the
    // value in the worker at the last moment, so it is not in the script either.
    expect(json).not.toMatch(/hunter2|password|apiKey|"value"\s*:\s*"[^"]*secret/i)
  })

  it('drops scriptId, which means nothing on another machine', () => {
    const bundle = buildBundle(
      [script({ caseId: 'their-case-1' })],
      [testCase({ scriptId: 'their-script-1' })],
    )
    expect(bundle.cases[0]).not.toHaveProperty('scriptId')
  })

  it('is identifiable as a share bundle', () => {
    const bundle = buildBundle([script()], [])
    expect(bundle.kind).toBe(BUNDLE_KIND)
    expect(bundle.bundleVersion).toBe(BUNDLE_VERSION)
  })
})

describe('importing never overwrites local work', () => {
  it('assigns a fresh id even when the file carries one', () => {
    const json = toBundleJson(buildBundle([script({ id: 'their-script-1' })], []))
    const result = parseBundle(json, ids())
    // The failure this prevents: a colleague's bundle replacing your own script
    // because both machines happened to mint the same id.
    expect(result.scripts[0]?.id).toBe('new-script-1')
    expect(result.scripts[0]?.id).not.toBe('their-script-1')
  })

  it('assigns fresh ids to cases too', () => {
    const json = toBundleJson(buildBundle([script({ caseId: 'their-case-1' })], [testCase()]))
    const result = parseBundle(json, ids())
    expect(result.cases[0]?.id).toBe('new-case-1')
  })

  it('rewrites caseId to the imported case, keeping the pairing intact', () => {
    const json = toBundleJson(buildBundle([script({ caseId: 'their-case-1' })], [testCase()]))
    const result = parseBundle(json, ids())
    expect(result.scripts[0]?.caseId).toBe(result.cases[0]?.id)
  })

  it('re-links the case back to its imported script', () => {
    const json = toBundleJson(buildBundle([script({ caseId: 'their-case-1' })], [testCase()]))
    const result = parseBundle(json, ids())
    expect(result.cases[0]?.scriptId).toBe(result.scripts[0]?.id)
  })

  it('drops a caseId whose case is not in the bundle, rather than dangling', () => {
    // Hand-built: a bundle claiming a case it does not include.
    const json = JSON.stringify({
      kind: BUNDLE_KIND,
      bundleVersion: 1,
      exportedAt: '2024-01-01T00:00:00.000Z',
      scripts: [script({ caseId: 'missing-case' })],
      cases: [],
      requiredSecrets: [],
    })
    const result = parseBundle(json, ids())
    expect(result.scripts[0]?.caseId).toBeUndefined()
  })

  it('gives two distinct scripts when the same file is imported twice', () => {
    const json = toBundleJson(buildBundle([script()], []))
    // One shared factory, mimicking two imports into the same profile.
    const factory = ids()
    const first = parseBundle(json, factory)
    const second = parseBundle(json, factory)
    // Accepted cost of never overwriting: visible duplicates the user can delete,
    // instead of silent data loss they cannot recover.
    expect(first.scripts[0]?.id).not.toBe(second.scripts[0]?.id)
    expect([first.scripts[0]?.id, second.scripts[0]?.id]).toEqual(['new-script-1', 'new-script-2'])
  })

  it('preserves the steps verbatim through a round trip', () => {
    const steps: ScriptStep[] = [
      { action: 'click', target },
      { action: 'fill', target, value: 'hello', note: '搜索框' },
      { action: 'assert', target, assert: { kind: 'text', expected: 'Done' } },
    ]
    const json = toBundleJson(buildBundle([script({ steps })], []))
    const result = parseBundle(json, ids())
    expect(result.scripts[0]?.steps).toEqual(steps)
  })

  it('round-trips a multi-script bundle in order', () => {
    const json = toBundleJson(
      buildBundle([script({ name: 'First' }), script({ id: 'b', name: 'Second' })], []),
    )
    const result = parseBundle(json, ids())
    expect(result.scripts.map((entry) => entry.name)).toEqual(['First', 'Second'])
  })
})

describe('accepting a plain single-script file', () => {
  it('reads the format the existing "导出 JSON" button produces', () => {
    // Refusing the shape this tool already emits would be a gratuitous trap.
    const json = JSON.stringify({
      version: 1,
      name: 'Solo',
      startUrl: 'https://shop.test/',
      steps: [{ action: 'click', target }],
    })
    const result = parseBundle(json, ids())
    expect(result.scripts).toHaveLength(1)
    expect(result.scripts[0]?.name).toBe('Solo')
    expect(result.cases).toEqual([])
  })

  it('drops a lone script\'s caseId, which points at a case not in the file', () => {
    const json = JSON.stringify({
      version: 1,
      name: 'Solo',
      caseId: 'their-case-1',
      steps: [{ action: 'click', target }],
    })
    expect(parseBundle(json, ids()).scripts[0]?.caseId).toBeUndefined()
  })

  it('still reports the secrets a lone script needs', () => {
    const json = JSON.stringify({
      version: 1,
      name: 'Solo',
      steps: [{ action: 'fill', target, secretRef: 'LOGIN_PW' }],
    })
    expect(parseBundle(json, ids()).requiredSecrets).toEqual(['LOGIN_PW'])
  })
})

describe('rejecting a file with a reason the user can act on', () => {
  it('names JSON syntax trouble', () => {
    expect(() => parseBundle('{ not json', ids())).toThrow(/不是合法的 JSON/)
  })

  it('rejects a non-object', () => {
    expect(() => parseBundle('[1,2,3]', ids())).toThrow(/必须是一个 JSON 对象/)
  })

  it('points a full backup at the right importer instead of failing vaguely', () => {
    // The realistic mistake: feeding a whole-profile export to the script importer.
    const backup = JSON.stringify({ exportedAt: 'x', cases: [], scripts: [], settings: {} })
    expect(() => parseBundle(backup, ids())).toThrow(/设置 → 数据导入/)
  })

  it('refuses a bundle from a newer version rather than misreading it', () => {
    const json = JSON.stringify({
      kind: BUNDLE_KIND,
      bundleVersion: BUNDLE_VERSION + 1,
      scripts: [script()],
      cases: [],
    })
    expect(() => parseBundle(json, ids())).toThrow(/升级插件/)
  })

  it('reports a missing bundleVersion', () => {
    const json = JSON.stringify({ kind: BUNDLE_KIND, scripts: [script()] })
    expect(() => parseBundle(json, ids())).toThrow(/bundleVersion/)
  })

  it('rejects an empty bundle', () => {
    const json = JSON.stringify({ kind: BUNDLE_KIND, bundleVersion: 1, scripts: [], cases: [] })
    expect(() => parseBundle(json, ids())).toThrow(/没有任何脚本/)
  })

  it('names the offending script when one has a bad step', () => {
    const json = JSON.stringify({
      kind: BUNDLE_KIND,
      bundleVersion: 1,
      scripts: [script({ name: 'Broken', steps: [{ action: 'click' } as ScriptStep] })],
      cases: [],
    })
    // A whole bundle rejected with "invalid" would leave the user guessing which
    // of twenty scripts is at fault.
    expect(() => parseBundle(json, ids())).toThrow(/Broken/)
  })

  it('skips a case entry with no id instead of throwing away the bundle', () => {
    const json = JSON.stringify({
      kind: BUNDLE_KIND,
      bundleVersion: 1,
      scripts: [script()],
      cases: [{ name: 'no id here' }],
    })
    expect(parseBundle(json, ids()).cases).toEqual([])
  })
})

describe('collectSecretRefs', () => {
  it('ignores blank and whitespace-only refs', () => {
    const steps: ScriptStep[] = [
      { action: 'fill', target, secretRef: '' },
      { action: 'fill', target, secretRef: '   ' },
      { action: 'fill', target, secretRef: ' PW ' },
    ]
    expect(collectSecretRefs([script({ steps })])).toEqual(['PW'])
  })

  it('collects across several scripts', () => {
    const a = script({ steps: [{ action: 'fill', target, secretRef: 'A' }] })
    const b = script({ steps: [{ action: 'fill', target, secretRef: 'B' }] })
    expect(collectSecretRefs([a, b])).toEqual(['A', 'B'])
  })

  it('returns an empty list for scripts with no secrets', () => {
    expect(collectSecretRefs([script()])).toEqual([])
  })
})

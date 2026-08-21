/**
 * Script files: download a script, import one back.
 *
 * Distinct from `exportAll` in `lib/storage`, which is a whole-profile backup for
 * one user restoring their own data. This is the narrower errand: a few scripts
 * written to a file the user can do whatever they like with — send it, commit it,
 * archive it. Passing it on is deliberately not this tool's job.
 *
 * The file carries the cases the scripts were recorded from, because steps alone
 * do not say what they are supposed to prove.
 *
 * What it must never contain is the point of the format: no secret values, no API
 * keys, no bridge token, no run history, no schedules. A downloaded file tends to
 * end up in a chat message or a git repository, so anything sensitive in it is
 * effectively published. Secrets survive as `secretRef` *names*, which tell the
 * reader which credentials to create locally without revealing any.
 *
 * @module lib/share
 */

import { parseScriptJson } from './script'
import type { TestCase, TestScript } from './types'

/**
 * Bundle format version.
 *
 * Separate from `SCRIPT_VERSION`: the envelope and the script model can change
 * independently, and a reader needs to tell "I cannot read this file at all" from
 * "I can read the file but not these steps".
 */
export const BUNDLE_VERSION = 1

/** Identifies a file as a script file from this extension rather than some other JSON. */
export const BUNDLE_KIND = 'webtest-pilot/scripts'

/** A set of scripts with the cases they came from. */
export interface ShareBundle {
  kind: typeof BUNDLE_KIND
  bundleVersion: number
  exportedAt: string
  scripts: TestScript[]
  /** Cases referenced by the scripts, so the intent travels with the steps. */
  cases: TestCase[]
  /**
   * Secret names the scripts reference, collected for whoever imports the file.
   *
   * Names only — never values. Present so an importer can say "this needs a
   * secret called LOGIN_PW" up front, instead of that being discovered when a run
   * fails midway.
   */
  requiredSecrets: string[]
}

/** What an import produced, for a message the user can act on. */
export interface ImportSummary {
  scripts: TestScript[]
  cases: TestCase[]
  /** Secret names the imported scripts need but this profile does not have. */
  missingSecrets: string[]
}

/** Collects the secret names a set of scripts references, sorted and deduped. */
export function collectSecretRefs(scripts: TestScript[]): string[] {
  const names = new Set<string>()
  for (const script of scripts) {
    for (const step of script.steps) {
      if (typeof step.secretRef === 'string' && step.secretRef.trim()) {
        names.add(step.secretRef.trim())
      }
    }
  }
  return [...names].sort()
}

/**
 * Builds a bundle from scripts and the cases they reference.
 *
 * Cases are filtered to those actually referenced rather than passed through:
 * exporting one script must not leak the names and expectations of every other
 * test in the profile.
 */
export function buildBundle(scripts: TestScript[], allCases: TestCase[]): ShareBundle {
  const wantedCaseIds = new Set(
    scripts.map((script) => script.caseId).filter((id): id is string => typeof id === 'string' && id !== ''),
  )
  const cases = allCases
    .filter((testCase) => wantedCaseIds.has(testCase.id))
    // `scriptId` is meaningless off this machine, and an importer rebuilds the
    // link from the scripts it actually received.
    .map(({ scriptId: _scriptId, ...rest }) => rest)
  return {
    kind: BUNDLE_KIND,
    bundleVersion: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    scripts,
    cases,
    requiredSecrets: collectSecretRefs(scripts),
  }
}

/** Serializes a bundle for download. */
export function toBundleJson(bundle: ShareBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

/**
 * Reads a script file, assigning fresh ids to everything it contains.
 *
 * Fresh ids unconditionally, never merge-by-id. The file may come from another
 * machine, where ids were minted independently, so a collision means two
 * unrelated scripts — and silently replacing the user's own work with an imported
 * one would be the worst possible reading of "import". The cost is that importing
 * the same file twice gives two copies, which is visible and correctable; the
 * alternative destroys data.
 *
 * `caseId` links are rewritten to the new case ids, so an imported script still
 * knows which imported case it belongs to.
 *
 * @throws {Error} with a specific reason when the text is not a usable bundle.
 */
export function parseBundle(
  text: string,
  idFactory: (prefix: 'script' | 'case') => string,
): { scripts: TestScript[]; cases: TestCase[]; requiredSecrets: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('脚本文件必须是一个 JSON 对象。')
  }
  const bag = raw as Partial<ShareBundle> & { steps?: unknown }

  // A bare single-script file is accepted too: older versions of this extension
  // emitted that shape, and refusing a format this tool once produced would be a
  // gratuitous trap.
  if (bag.kind === undefined && Array.isArray(bag.steps)) {
    const script = parseScriptJson(text, () => idFactory('script'))
    // A lone script's caseId points at a case that is not in this file, so drop
    // it rather than leave a dangling reference.
    delete script.caseId
    return { scripts: [script], cases: [], requiredSecrets: collectSecretRefs([script]) }
  }

  if (bag.kind !== BUNDLE_KIND) {
    throw new Error(
      `这个文件不是 WebTest Pilot 的脚本文件（缺少 kind: "${BUNDLE_KIND}"）。` +
        '如果你要恢复自己的完整备份，请用「设置 → 数据导入」。',
    )
  }
  if (typeof bag.bundleVersion !== 'number') {
    throw new Error('这个脚本文件缺少 bundleVersion 字段。')
  }
  if (bag.bundleVersion > BUNDLE_VERSION) {
    throw new Error(
      `这个脚本文件的格式版本是 ${bag.bundleVersion}，当前插件只支持到 ${BUNDLE_VERSION}。请升级插件后再导入。`,
    )
  }
  if (!Array.isArray(bag.scripts) || bag.scripts.length === 0) {
    throw new Error('这个文件里没有任何脚本。')
  }

  // Old case id -> new case id, so script.caseId can be rewritten.
  const caseIdMap = new Map<string, string>()
  const cases: TestCase[] = []
  if (Array.isArray(bag.cases)) {
    for (const entry of bag.cases) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue
      const fresh = idFactory('case')
      caseIdMap.set(entry.id, fresh)
      const now = Date.now()
      const imported: TestCase = {
        ...entry,
        id: fresh,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : now,
        updatedAt: now,
      }
      // `scriptId` points into the *sender's* profile. It is repaired below once
      // the scripts have their new ids; leaving the stale value would make the
      // case claim a recording that either does not exist here or, worse, belongs
      // to an unrelated local script that happens to share the id.
      delete imported.scriptId
      cases.push(imported)
    }
  }

  const scripts: TestScript[] = bag.scripts.map((entry, index) => {
    let script: TestScript
    try {
      // Reuse the single-script parser: it is the one place that validates steps,
      // and a second implementation would drift from it.
      script = parseScriptJson(JSON.stringify(entry), () => idFactory('script'))
    } catch (error) {
      const name =
        entry && typeof entry === 'object' && typeof (entry as TestScript).name === 'string'
          ? `「${(entry as TestScript).name}」`
          : `第 ${index + 1} 个`
      throw new Error(`脚本${name}无法读取：${error instanceof Error ? error.message : String(error)}`)
    }
    // Always a fresh id, even when the file carried one.
    script.id = idFactory('script')
    const mapped = script.caseId ? caseIdMap.get(script.caseId) : undefined
    if (mapped) script.caseId = mapped
    else delete script.caseId
    return script
  })

  // Re-link each case to its imported script, restoring the pairing the sender
  // had. Done after both sides have final ids so the link is never dangling.
  for (const script of scripts) {
    if (!script.caseId) continue
    const owner = cases.find((testCase) => testCase.id === script.caseId)
    if (owner && !owner.scriptId) owner.scriptId = script.id
  }

  return { scripts, cases, requiredSecrets: collectSecretRefs(scripts) }
}

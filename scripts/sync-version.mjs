/**
 * Bumps the extension version in `manifest.config.ts` to match a release tag.
 *
 * Run by the release workflow before `vite build`: the tag (e.g. `v0.2.0` or
 * `v0.2.0-rc1`) is the source of truth for the published version. Chrome
 * manifests only accept `x.y.z.w` with non-negative integers and no prerelease
 * suffix, so a leading `v` and any `-suffix` are stripped and the result is
 * validated. The script rewrites the single literal `version: '...'` line; it
 * intentionally does not touch package.json, which stays at a development
 * version.
 *
 * Usage: RELEASE_TAG=v0.2.0 node scripts/sync-version.mjs
 *
 * @module scripts/sync-version
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(root, 'manifest.config.ts')

const raw = (process.env.RELEASE_TAG ?? '').trim()
if (!raw) {
  throw new Error('RELEASE_TAG is not set; expected a tag like v0.2.0.')
}

// Strip a leading v and any prerelease/build suffix (-rc1, +meta, etc.). Chrome
// versions are strictly dot-separated integers with at most four parts.
const numeric = raw.replace(/^[vV]/, '').split(/[-+]/, 1)[0] ?? ''
const parts = numeric.split('.')
if (parts.length < 1 || parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) {
  throw new Error(
    `Tag "${raw}" is not a valid Chrome extension version (expected v0.2.0 or v0.2.0.1).`,
  )
}
// Reject leading zeros and over-large components defensively; Chrome caps each
// component at 65535 for packed extensions in some channels.
for (const part of parts) {
  const value = Number(part)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Version component "${part}" out of range 0–65535.`)
  }
}
const version = parts.join('.')

const source = await readFile(manifestPath, 'utf8')
const pattern = /(version:\s*)['"][^'"]+['"]/
if (!pattern.test(source)) {
  throw new Error(`Could not find a version literal in ${manifestPath}.`)
}
const next = source.replace(pattern, `$1'${version}'`)
if (next !== source) {
  await writeFile(manifestPath, next, 'utf8')
}
// A no-op is fine (e.g. v0.2.0-rc1 maps to the same 0.2.0 already on disk);
// only a failed match is an error.
console.log(`manifest version -> ${version} (from tag ${raw})`)

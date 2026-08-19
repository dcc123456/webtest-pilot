/**
 * URL allow-listing.
 *
 * This is the extension's security boundary. Test automation cannot ask for
 * per-action approval — a hundred-step run would mean a hundred prompts, and
 * approval fatigue means people click through everything — so consent is granted
 * once per site and enforced on every single operation instead.
 *
 * The matcher is therefore written to fail closed. Where a rule is ambiguous, it
 * refuses. A false negative costs the user one edit in Settings; a false positive
 * lets a model drive a page it was never authorised to touch.
 *
 * @module lib/urlmatch
 */

/** Only these schemes can ever be automated, regardless of the pattern. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/**
 * Hosts and schemes where no extension may inject, so no pattern can allow them.
 *
 * Chrome enforces most of this itself; listing it here turns a confusing
 * injection failure deep in a run into a clear message before the run starts.
 */
const BLOCKED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-search://',
  'chrome-untrusted://',
  'edge://',
  'extension://',
  'moz-extension://',
  'about:',
  'devtools://',
  'view-source:',
  'file://',
  'data:',
  'javascript:',
  'blob:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
  'https://microsoftedge.microsoft.com/addons',
]

/**
 * True when Chrome forbids scripting this URL outright.
 *
 * Checked before the allow-list, so a user cannot accidentally add a pattern
 * that appears to permit a restricted page.
 */
export function isRestrictedUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  if (lower.length === 0) return true
  return BLOCKED_URL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** True when this URL is an ordinary page an extension may script. */
export function isAutomatableUrl(url: string | undefined): boolean {
  if (!url) return false
  if (isRestrictedUrl(url)) return false
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/** Why a pattern was rejected, phrased for the Settings form. */
export interface PatternProblem {
  pattern: string
  message: string
}

/**
 * Validates one allow-list pattern.
 *
 * Two rules do real work:
 *
 * - A bare `*` or a host of `*` is rejected. "Automate every site on the
 *   internet" is never a considered choice, and accepting it would quietly
 *   nullify the whole boundary.
 * - A leading `*.` must match at least one label, so `*.example.com` does not
 *   also match `example.com.evil.test` (see {@link matchesHost}).
 */
export function validatePattern(pattern: string): PatternProblem | null {
  const trimmed = pattern.trim()
  if (trimmed.length === 0) {
    return { pattern, message: 'Pattern is empty.' }
  }
  if (trimmed === '*' || trimmed === '*://*/*' || trimmed === '<all_urls>') {
    return {
      pattern,
      message:
        'Refusing a pattern that matches every site. List the hosts under test, e.g. https://staging.example.com/*',
    }
  }

  const parsed = parsePattern(trimmed)
  if (!parsed) {
    return {
      pattern,
      message: 'Use the form scheme://host/path, e.g. https://staging.example.com/*',
    }
  }
  if (parsed.host === '*' || parsed.host.length === 0) {
    return {
      pattern,
      message: 'A wildcard host would allow every site. Name the host explicitly.',
    }
  }
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https' && parsed.scheme !== '*') {
    return { pattern, message: `Only http and https can be automated, not ${parsed.scheme}.` }
  }
  return null
}

interface ParsedPattern {
  /** `http`, `https`, or `*`. */
  scheme: string
  /** Host, possibly `*.example.com`. Lowercased. Includes a port when given. */
  host: string
  /** Path glob, always starting with `/`. */
  path: string
}

/**
 * Splits a pattern into scheme, host, and path.
 *
 * A pattern with no scheme is read as "either http scheme", because
 * `staging.example.com/*` is what people type and rejecting it would be pedantic
 * without being safer — the scheme is constrained to http(s) regardless.
 */
export function parsePattern(pattern: string): ParsedPattern | null {
  const trimmed = pattern.trim().toLowerCase()
  if (trimmed.length === 0) return null

  const schemeMatch = /^([a-z*][a-z0-9+.*-]*):\/\/(.*)$/.exec(trimmed)
  const scheme = schemeMatch?.[1] ?? '*'
  const rest = schemeMatch?.[2] ?? trimmed
  if (rest.length === 0) return null

  const slash = rest.indexOf('/')
  const host = slash === -1 ? rest : rest.slice(0, slash)
  const path = slash === -1 ? '/*' : rest.slice(slash)
  if (host.length === 0) return null
  return { scheme, host, path: path.length === 0 ? '/*' : path }
}

/**
 * Host matching, with one deliberate asymmetry.
 *
 * `*.example.com` matches `app.example.com` but **not** `example.com`: the
 * pattern says "a subdomain of", and silently including the apex would grant
 * more than was written. `example.com` (no wildcard) matches only itself.
 *
 * Suffix matching is anchored on a dot boundary, so `*.example.com` cannot be
 * satisfied by `notexample.com` or by `example.com.attacker.test`.
 */
export function matchesHost(patternHost: string, host: string): boolean {
  const pattern = patternHost.toLowerCase()
  const candidate = host.toLowerCase()
  if (pattern === candidate) return true
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // keeps the leading dot
    return candidate.endsWith(suffix) && candidate.length > suffix.length
  }
  return false
}

/**
 * Glob matching for the path segment: `*` matches any run of characters.
 *
 * The pattern is anchored at both ends, so `/app` does not match `/application`.
 * A pattern of exactly `/*` matches every path, including the empty one.
 */
export function matchesPath(patternPath: string, path: string): boolean {
  if (patternPath === '/*' || patternPath === '*') return true
  const escaped = patternPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(path)
}

/**
 * True when `url` is permitted by `pattern`.
 *
 * Restricted URLs are rejected first: no pattern can grant access to a page
 * Chrome will not let an extension script anyway.
 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  if (!isAutomatableUrl(url)) return false
  const parsed = parsePattern(pattern)
  if (!parsed) return false
  if (parsed.host === '*') return false // never granted; see validatePattern

  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }

  const scheme = target.protocol.replace(':', '')
  if (parsed.scheme !== '*' && parsed.scheme !== scheme) return false

  // Compare host with the port when the pattern names one, so
  // `http://localhost:3000/*` does not also allow port 8080.
  const patternHasPort = /:\d+$/.test(parsed.host)
  const candidateHost = patternHasPort ? `${target.hostname}:${target.port}` : target.hostname
  if (!matchesHost(parsed.host, candidateHost)) return false

  return matchesPath(parsed.path, `${target.pathname}${target.search}`)
}

/** Verdict for a URL against the whole allow-list. */
export interface AllowVerdict {
  allowed: boolean
  /** The pattern that permitted it, for the run log. */
  matchedPattern?: string
  /** Why it was refused, phrased for the user. */
  reason?: string
}

/**
 * Checks a URL against the configured allow-list.
 *
 * An empty list denies everything and says so: defaulting to "allow all" when
 * unconfigured is exactly the failure mode this boundary exists to prevent.
 */
export function checkUrlAllowed(url: string | undefined, patterns: string[]): AllowVerdict {
  if (!url) {
    return { allowed: false, reason: 'No URL to check.' }
  }
  if (isRestrictedUrl(url)) {
    return {
      allowed: false,
      reason: `${url} is a browser-internal or Web Store page; no extension can automate it.`,
    }
  }
  if (!isAutomatableUrl(url)) {
    return { allowed: false, reason: `${url} is not an http(s) page.` }
  }
  const usable = patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
  if (usable.length === 0) {
    return {
      allowed: false,
      reason:
        'No sites are allowed yet. Add the site under test in Settings → Allowed sites, e.g. https://staging.example.com/*',
    }
  }
  for (const pattern of usable) {
    if (validatePattern(pattern)) continue // skip patterns that are not usable
    if (urlMatchesPattern(url, pattern)) return { allowed: true, matchedPattern: pattern }
  }
  return {
    allowed: false,
    reason: `${url} is not in the allowed sites list. Add it in Settings if this is a site you want to test.`,
  }
}

/**
 * Suggests a pattern covering a URL's whole origin.
 *
 * Used by the "allow this site" button, so the common case needs no typing. The
 * port is preserved because a local dev server on another port is a different
 * application.
 */
export function suggestPatternForUrl(url: string): string | null {
  if (!isAutomatableUrl(url)) return null
  try {
    const parsed = new URL(url)
    const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
    return `${parsed.protocol}//${host}/*`
  } catch {
    return null
  }
}

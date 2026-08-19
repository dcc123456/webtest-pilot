import { describe, expect, it } from 'vitest'

import {
  checkUrlAllowed,
  isAutomatableUrl,
  isRestrictedUrl,
  matchesHost,
  matchesPath,
  parsePattern,
  suggestPatternForUrl,
  urlMatchesPattern,
  validatePattern,
} from '../src/lib/urlmatch'

describe('isRestrictedUrl', () => {
  it('rejects browser-internal, store, and non-web schemes', () => {
    const restricted = [
      'chrome://settings',
      'chrome-extension://abc/page.html',
      'edge://flags',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'file:///C:/tmp/a.html',
      'data:text/html,<h1>hi</h1>',
      'javascript:alert(1)',
      'blob:https://example.com/uuid',
      'https://chromewebstore.google.com/detail/x',
      'https://chrome.google.com/webstore/detail/x',
      '',
    ]
    for (const url of restricted) {
      expect(isRestrictedUrl(url), url).toBe(true)
    }
  })

  it('is case-insensitive about the scheme', () => {
    expect(isRestrictedUrl('CHROME://settings')).toBe(true)
  })

  it('allows ordinary pages', () => {
    expect(isRestrictedUrl('https://staging.example.com/login')).toBe(false)
  })
})

describe('isAutomatableUrl', () => {
  it('accepts only http and https', () => {
    expect(isAutomatableUrl('http://localhost:3000/')).toBe(true)
    expect(isAutomatableUrl('https://example.com/')).toBe(true)
    expect(isAutomatableUrl('ws://example.com/')).toBe(false)
    expect(isAutomatableUrl('ftp://example.com/')).toBe(false)
    expect(isAutomatableUrl(undefined)).toBe(false)
    expect(isAutomatableUrl('not a url')).toBe(false)
  })
})

describe('validatePattern', () => {
  it('accepts ordinary host patterns', () => {
    for (const pattern of [
      'https://staging.example.com/*',
      'http://localhost:3000/*',
      'https://*.example.com/app/*',
      'staging.example.com/*',
      'https://example.com/exact/path',
    ]) {
      expect(validatePattern(pattern), pattern).toBeNull()
    }
  })

  it('refuses patterns that would allow the whole internet', () => {
    for (const pattern of ['*', '*://*/*', '<all_urls>', 'https://*/*', '*/*']) {
      expect(validatePattern(pattern), pattern).not.toBeNull()
    }
  })

  it('refuses empty and malformed patterns', () => {
    expect(validatePattern('')).not.toBeNull()
    expect(validatePattern('   ')).not.toBeNull()
    expect(validatePattern('https://')).not.toBeNull()
  })

  it('refuses schemes that cannot be automated', () => {
    expect(validatePattern('ftp://example.com/*')?.message).toContain('http')
    expect(validatePattern('file://tmp/*')).not.toBeNull()
  })
})

describe('parsePattern', () => {
  it('defaults a missing scheme and a missing path', () => {
    expect(parsePattern('example.com')).toEqual({
      scheme: '*',
      host: 'example.com',
      path: '/*',
    })
  })

  it('keeps the path exactly as written', () => {
    expect(parsePattern('https://example.com/app')).toEqual({
      scheme: 'https',
      host: 'example.com',
      path: '/app',
    })
  })

  it('lowercases the pattern', () => {
    expect(parsePattern('HTTPS://Example.COM/App')?.host).toBe('example.com')
  })
})

describe('matchesHost', () => {
  it('matches an exact host only', () => {
    expect(matchesHost('example.com', 'example.com')).toBe(true)
    expect(matchesHost('example.com', 'app.example.com')).toBe(false)
  })

  it('matches subdomains but deliberately not the apex', () => {
    expect(matchesHost('*.example.com', 'app.example.com')).toBe(true)
    expect(matchesHost('*.example.com', 'a.b.example.com')).toBe(true)
    expect(matchesHost('*.example.com', 'example.com')).toBe(false)
  })

  it('cannot be fooled by a lookalike host', () => {
    expect(matchesHost('*.example.com', 'notexample.com')).toBe(false)
    expect(matchesHost('*.example.com', 'example.com.attacker.test')).toBe(false)
    expect(matchesHost('example.com', 'example.com.attacker.test')).toBe(false)
  })

  it('ignores case', () => {
    expect(matchesHost('*.Example.com', 'APP.example.COM')).toBe(true)
  })
})

describe('matchesPath', () => {
  it('anchors both ends so a prefix is not a match', () => {
    expect(matchesPath('/app', '/app')).toBe(true)
    expect(matchesPath('/app', '/application')).toBe(false)
  })

  it('treats /* as every path', () => {
    expect(matchesPath('/*', '/')).toBe(true)
    expect(matchesPath('/*', '/deep/nested/page?x=1')).toBe(true)
  })

  it('expands interior wildcards', () => {
    expect(matchesPath('/app/*/edit', '/app/42/edit')).toBe(true)
    expect(matchesPath('/app/*/edit', '/app/42/view')).toBe(false)
  })

  it('does not let regex metacharacters in the pattern change the meaning', () => {
    expect(matchesPath('/a.b', '/axb')).toBe(false)
    expect(matchesPath('/a.b', '/a.b')).toBe(true)
    expect(matchesPath('/a+b', '/a+b')).toBe(true)
    expect(matchesPath('/list(1)', '/list(1)')).toBe(true)
  })
})

describe('urlMatchesPattern', () => {
  it('matches on scheme, host, and path together', () => {
    expect(urlMatchesPattern('https://staging.example.com/login', 'https://staging.example.com/*'))
      .toBe(true)
    expect(urlMatchesPattern('http://staging.example.com/login', 'https://staging.example.com/*'))
      .toBe(false)
    expect(urlMatchesPattern('https://prod.example.com/login', 'https://staging.example.com/*'))
      .toBe(false)
  })

  it('lets a scheme-less pattern match either http scheme', () => {
    expect(urlMatchesPattern('http://example.com/a', 'example.com/*')).toBe(true)
    expect(urlMatchesPattern('https://example.com/a', 'example.com/*')).toBe(true)
  })

  it('distinguishes ports when the pattern names one', () => {
    expect(urlMatchesPattern('http://localhost:3000/a', 'http://localhost:3000/*')).toBe(true)
    expect(urlMatchesPattern('http://localhost:8080/a', 'http://localhost:3000/*')).toBe(false)
  })

  it('ignores the port when the pattern does not name one', () => {
    expect(urlMatchesPattern('http://localhost:3000/a', 'http://localhost/*')).toBe(true)
  })

  it('includes the query string in path matching', () => {
    expect(urlMatchesPattern('https://example.com/s?q=1', 'https://example.com/s?q=1')).toBe(true)
    expect(urlMatchesPattern('https://example.com/s?q=2', 'https://example.com/s?q=1')).toBe(false)
  })

  it('never matches a restricted url, whatever the pattern says', () => {
    expect(urlMatchesPattern('chrome://settings', 'chrome://settings')).toBe(false)
    expect(urlMatchesPattern('file:///c:/x.html', 'file://*/*')).toBe(false)
  })
})

describe('checkUrlAllowed', () => {
  it('denies everything when nothing is configured, and explains how to fix it', () => {
    const verdict = checkUrlAllowed('https://example.com/', [])
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('Allowed sites')
  })

  it('reports which pattern granted access', () => {
    const verdict = checkUrlAllowed('https://staging.example.com/login', [
      'https://other.example.com/*',
      'https://staging.example.com/*',
    ])
    expect(verdict.allowed).toBe(true)
    expect(verdict.matchedPattern).toBe('https://staging.example.com/*')
  })

  it('ignores blank entries and skips unusable patterns instead of throwing', () => {
    const verdict = checkUrlAllowed('https://staging.example.com/login', [
      '   ',
      '*',
      'https://staging.example.com/*',
    ])
    expect(verdict.allowed).toBe(true)
  })

  it('is not rescued by an all-sites pattern', () => {
    expect(checkUrlAllowed('https://evil.test/', ['*']).allowed).toBe(false)
    expect(checkUrlAllowed('https://evil.test/', ['https://*/*']).allowed).toBe(false)
  })

  it('explains a restricted page differently from an unlisted one', () => {
    expect(checkUrlAllowed('chrome://settings', ['https://a.test/*']).reason).toContain(
      'browser-internal',
    )
    expect(checkUrlAllowed('https://b.test/', ['https://a.test/*']).reason).toContain(
      'not in the allowed sites',
    )
  })

  it('denies a missing url', () => {
    expect(checkUrlAllowed(undefined, ['https://a.test/*']).allowed).toBe(false)
  })
})

describe('suggestPatternForUrl', () => {
  it('covers the whole origin, keeping a non-default port', () => {
    expect(suggestPatternForUrl('https://staging.example.com/login?next=/x')).toBe(
      'https://staging.example.com/*',
    )
    expect(suggestPatternForUrl('http://localhost:5173/app')).toBe('http://localhost:5173/*')
  })

  it('returns null for a page that can never be automated', () => {
    expect(suggestPatternForUrl('chrome://settings')).toBeNull()
    expect(suggestPatternForUrl('nonsense')).toBeNull()
  })
})

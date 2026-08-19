import { describe, expect, it } from 'vitest'

import {
  PROVIDER_PRESETS,
  findPreset,
  isLocalEndpoint,
  normalizeBaseUrl,
  profileFromPreset,
  validateProfile,
  type ProviderProfile,
} from '../src/lib/providers'

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    label: 'Test',
    presetId: 'custom',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'model-x',
    ...overrides,
  }
}

describe('normalizeBaseUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl('  https://api.deepseek.com/v1/  ')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://api.deepseek.com/v1///')).toBe('https://api.deepseek.com/v1')
  })

  it('strips a pasted /chat/completions suffix', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions')).toBe(
      'https://api.deepseek.com/v1',
    )
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions/')).toBe(
      'https://api.deepseek.com/v1',
    )
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/CHAT/Completions')).toBe(
      'https://api.deepseek.com/v1',
    )
  })

  it('preserves the version segment vendors disagree about', () => {
    expect(normalizeBaseUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3',
    )
  })

  it('returns an empty string for blank input', () => {
    expect(normalizeBaseUrl('   ')).toBe('')
  })
})

describe('validateProfile', () => {
  it('accepts a complete profile', () => {
    expect(validateProfile(profile())).toEqual([])
  })

  it('reports every problem at once so a form can show them together', () => {
    const problems = validateProfile(
      profile({ label: '  ', baseUrl: '', apiKey: '', model: '' }),
    )
    expect(problems.map((problem) => problem.field).sort()).toEqual([
      'apiKey',
      'baseUrl',
      'label',
      'model',
    ])
  })

  it('rejects a base URL with the wrong scheme', () => {
    const problems = validateProfile(profile({ baseUrl: 'ftp://api.example.com' }))
    expect(problems).toHaveLength(1)
    expect(problems[0]?.field).toBe('baseUrl')
  })

  it('accepts a base URL that only needs normalizing', () => {
    expect(validateProfile(profile({ baseUrl: ' https://api.example.com/v1/ ' }))).toEqual([])
  })

  it('rejects a syntactically invalid URL', () => {
    expect(validateProfile(profile({ baseUrl: 'https://' }))).not.toEqual([])
  })
})

describe('PROVIDER_PRESETS', () => {
  it('has unique ids', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every preset except custom a usable https base URL', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === 'custom') {
        expect(preset.baseUrl).toBe('')
        continue
      }
      expect(preset.baseUrl, preset.id).toMatch(/^https?:\/\//)
      expect(preset.defaultModel.length, preset.id).toBeGreaterThan(0)
      expect(preset.hint.length, preset.id).toBeGreaterThan(0)
    }
  })

  it('has a base URL that survives normalization unchanged', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(normalizeBaseUrl(preset.baseUrl), preset.id).toBe(preset.baseUrl)
    }
  })

  it('is discoverable by id', () => {
    expect(findPreset('deepseek')?.label).toBe('DeepSeek')
    expect(findPreset('nope')).toBeUndefined()
  })
})

describe('profileFromPreset', () => {
  it('prefills everything but the key', () => {
    const preset = findPreset('ark')!
    const created = profileFromPreset(preset, 'id-1')
    expect(created).toMatchObject({
      id: 'id-1',
      presetId: 'ark',
      baseUrl: preset.baseUrl,
      model: preset.defaultModel,
      apiKey: '',
    })
  })

  it('marks vision support only for presets that have it', () => {
    expect(profileFromPreset(findPreset('openai')!, 'a').supportsVision).toBe(true)
    expect(profileFromPreset(findPreset('deepseek')!, 'b')).not.toHaveProperty('supportsVision')
  })

  it('produces a profile that only lacks an API key', () => {
    const created = profileFromPreset(findPreset('deepseek')!, 'id-2')
    expect(validateProfile(created).map((problem) => problem.field)).toEqual(['apiKey'])
  })
})

describe('isLocalEndpoint', () => {
  it('recognises loopback hosts, so a placeholder key is enough', () => {
    expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true)
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://[::1]:1234/v1')).toBe(true)
  })

  it('does not treat a remote host as local', () => {
    expect(isLocalEndpoint('https://api.deepseek.com/v1')).toBe(false)
    // A lookalike hostname must not pass.
    expect(isLocalEndpoint('https://localhost.evil.test/v1')).toBe(false)
  })

  it('returns false for unparseable input', () => {
    expect(isLocalEndpoint('not a url')).toBe(false)
    expect(isLocalEndpoint('')).toBe(false)
  })
})

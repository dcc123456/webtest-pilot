/**
 * findUsableTab tests.
 *
 * This function decides which page a run drives, and this is a browser extension:
 * with no start URL the answer must be the tab the user is looking at. A wrong
 * answer here is destructive — it types into a page the user never pointed at,
 * possibly in a window they cannot see — so the "no guessing" rule is pinned
 * rather than left to the implementation's discretion.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeRunTab, findUsableTab, openRunTab } from '../src/background/driver.chrome'

interface FakeTab {
  id?: number
  url?: string
  title?: string
  active?: boolean
  windowId?: number
}

/**
 * Installs a tabs fake.
 *
 * `focused` is what `{ active: true, lastFocusedWindow: true }` returns; `all` is
 * every tab across every window. Keeping them separate is the point: the two
 * queries must not be conflated, or "the current tab" silently becomes "some tab".
 */
function installTabs(focused: FakeTab | undefined, all: FakeTab[] = []): { queries: unknown[] } {
  const queries: unknown[] = []
  vi.stubGlobal('chrome', {
    tabs: {
      query: async (info: Record<string, unknown>) => {
        queries.push(info)
        if (info.lastFocusedWindow) return focused ? [focused] : []
        return all
      },
    },
  })
  return { queries }
}

const page = (url: string, id = 1, windowId = 1): FakeTab => ({
  id,
  url,
  title: 'Page',
  active: true,
  windowId,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('with no start URL', () => {
  it('returns the active tab, because that is what "this page" means', async () => {
    installTabs(page('https://app.test/cart', 7, 3))
    const tab = await findUsableTab()
    expect(tab?.id).toBe(7)
    expect(tab?.url).toBe('https://app.test/cart')
    expect(tab?.windowId).toBe(3)
  })

  it('treats an empty string the same as no URL at all', async () => {
    installTabs(page('https://app.test/cart', 7))
    expect((await findUsableTab(''))?.id).toBe(7)
    expect((await findUsableTab('   '))?.id).toBe(7)
  })

  it('refuses a new-tab page instead of hunting for another tab', async () => {
    // The failure this prevents: the run silently drives an unrelated page in
    // another window while the user watches the tab they actually meant.
    const { queries } = installTabs(page('chrome://newtab/', 1), [
      page('https://elsewhere.test/admin', 2, 9),
    ])
    expect(await findUsableTab()).toBeUndefined()
    // It must not even look at the other tabs: no all-tabs query.
    expect(queries.every((q) => (q as Record<string, unknown>).lastFocusedWindow)).toBe(true)
  })

  it.each([
    'chrome://settings/',
    'chrome-extension://abcdef/panel.html',
    'https://chrome.google.com/webstore',
    'https://chromewebstore.google.com/detail/x',
    'about:blank',
    'file:///C:/tmp/page.html',
    'view-source:https://app.test/',
    'devtools://devtools/bundled/inspector.html',
  ])('refuses %s', async (url) => {
    installTabs(page(url))
    expect(await findUsableTab()).toBeUndefined()
  })

  it('refuses when there is no focused tab at all', async () => {
    installTabs(undefined, [page('https://app.test/', 2)])
    expect(await findUsableTab()).toBeUndefined()
  })

  it('refuses a tab with no id, which cannot be scripted', async () => {
    installTabs({ url: 'https://app.test/', active: true, windowId: 1 })
    expect(await findUsableTab()).toBeUndefined()
  })

  it('refuses a tab whose URL Chrome withheld', async () => {
    // chrome.tabs reports no url without the right permission; acting blind on it
    // would bypass the allow-list entirely.
    installTabs({ id: 5, active: true, windowId: 1 })
    expect(await findUsableTab()).toBeUndefined()
  })
})

describe('with a start URL', () => {
  it('still prefers the active tab, since the run will navigate it anyway', async () => {
    installTabs(page('https://app.test/home', 7), [page('https://app.test/login', 8, 2)])
    const tab = await findUsableTab('https://app.test/login')
    // Reusing the tab the user is on keeps the run visible to them.
    expect(tab?.id).toBe(7)
  })

  it('falls back to a tab already on the target origin when the active one is unusable', async () => {
    installTabs(page('chrome://newtab/', 1), [
      page('https://other.test/', 2, 5),
      page('https://app.test/login', 3, 6),
    ])
    const tab = await findUsableTab('https://app.test/checkout')
    expect(tab?.id).toBe(3)
    expect(tab?.windowId).toBe(6)
  })

  it('matches on origin, not on substring', async () => {
    // 'https://app.test' is a substring of this hostile hostname, which a naive
    // includes() check would have accepted.
    installTabs(page('chrome://newtab/', 1), [page('https://app.test.evil.com/', 2)])
    expect(await findUsableTab('https://app.test/login')).toBeUndefined()
  })

  it('does not match a different port', async () => {
    installTabs(page('chrome://newtab/', 1), [page('http://localhost:4000/', 2)])
    expect(await findUsableTab('http://localhost:3000/')).toBeUndefined()
  })

  it('does not match a different scheme', async () => {
    installTabs(page('chrome://newtab/', 1), [page('http://app.test/login', 2)])
    expect(await findUsableTab('https://app.test/login')).toBeUndefined()
  })

  it('ignores a restricted tab even when it is on the target origin', async () => {
    installTabs(page('chrome://newtab/', 1), [page('view-source:https://app.test/', 2)])
    expect(await findUsableTab('https://app.test/')).toBeUndefined()
  })

  it('refuses rather than throwing when the start URL is unparseable', async () => {
    installTabs(page('chrome://newtab/', 1), [page('https://app.test/', 2)])
    expect(await findUsableTab('not a url')).toBeUndefined()
  })
})

describe('the fallback stays inside the user\'s browser', () => {
  /** Installs a tabs fake that records create/remove calls. */
  function installCreatable(): { created: Record<string, unknown>[]; removed: number[] } {
    const created: Record<string, unknown>[] = []
    const removed: number[] = []
    vi.stubGlobal('chrome', {
      tabs: {
        query: async () => [],
        create: async (info: Record<string, unknown>) => {
          created.push(info)
          return { id: 77, windowId: 3 }
        },
        remove: async (id: number) => {
          removed.push(id)
        },
      },
      // Present but must never be called: a run has no business opening a window.
      windows: {
        create: async () => {
          throw new Error('a run must never open a window')
        },
        remove: async () => {
          throw new Error('a run must never close a window')
        },
      },
    })
    return { created, removed }
  }

  it('opens a tab, never a window, so the profile session is inherited', async () => {
    const { created } = installCreatable()
    const opened = await openRunTab('https://app.test/login')
    expect(opened).toEqual({ tabId: 77, windowId: 3 })
    expect(created).toEqual([{ url: 'https://app.test/login', active: false }])
  })

  it('opens the tab in the background, so an unattended run does not steal focus', async () => {
    const { created } = installCreatable()
    await openRunTab('https://app.test/')
    expect(created[0]?.active).toBe(false)
  })

  it('closes a tab it opened', async () => {
    const { removed } = installCreatable()
    await closeRunTab(77)
    expect(removed).toEqual([77])
  })

  it('ignores a tab the user already closed', async () => {
    vi.stubGlobal('chrome', {
      tabs: {
        remove: async () => {
          throw new Error('No tab with id 77')
        },
      },
    })
    // Must not turn a already-closed tab into a run failure.
    await expect(closeRunTab(77)).resolves.toBeUndefined()
  })

  it('does nothing when there is no tab to close', async () => {
    const { removed } = installCreatable()
    await closeRunTab(undefined)
    expect(removed).toEqual([])
  })
})

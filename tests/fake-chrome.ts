/**
 * A minimal in-memory `chrome.storage.local` and `chrome.alarms`.
 *
 * Real Chrome APIs are unavailable under vitest, and mocking them per test would
 * hide the behaviour that actually matters here: `storage.local` has no
 * transactions, so a read-modify-write race is a real bug class. This fake adds
 * an optional delay to `set` precisely so that race can be provoked on purpose.
 */

export interface FakeStorageOptions {
  /** Artificial delay on `set`, used to interleave concurrent writers. */
  writeDelayMs?: number
  /** Byte budget; a `set` beyond it rejects the way Chrome's quota does. */
  quotaBytes?: number
}

export class FakeStorage {
  private data = new Map<string, unknown>()
  /** Counts of each operation, so a test can assert a single serialized write. */
  readonly writes: string[][] = []
  readonly reads: string[][] = []
  private options: FakeStorageOptions

  constructor(options: FakeStorageOptions = {}) {
    this.options = options
  }

  get = async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
    const list =
      keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys]
    this.reads.push(list)
    const out: Record<string, unknown> = {}
    for (const key of list) {
      const value = this.data.get(key)
      // Chrome omits absent keys rather than returning undefined values.
      if (value !== undefined) out[key] = structuredClone(value)
    }
    return out
  }

  set = async (items: Record<string, unknown>): Promise<void> => {
    if (this.options.writeDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.writeDelayMs))
    }
    const next = new Map(this.data)
    for (const [key, value] of Object.entries(items)) next.set(key, structuredClone(value))
    if (this.options.quotaBytes !== undefined) {
      const size = JSON.stringify([...next.entries()]).length
      if (size > this.options.quotaBytes) {
        throw new Error('QUOTA_BYTES quota exceeded')
      }
    }
    this.data = next
    this.writes.push(Object.keys(items))
  }

  remove = async (keys: string | string[]): Promise<void> => {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key)
  }

  clear = async (): Promise<void> => {
    this.data.clear()
  }

  getBytesInUse = async (): Promise<number> => JSON.stringify([...this.data.entries()]).length

  /** Direct access for arranging state without going through the module. */
  seed(key: string, value: unknown): void {
    this.data.set(key, structuredClone(value))
  }

  peek<T>(key: string): T | undefined {
    const value = this.data.get(key)
    return value === undefined ? undefined : (structuredClone(value) as T)
  }
}

export interface FakeAlarm {
  name: string
  periodInMinutes?: number
  delayInMinutes?: number
  when?: number
}

export class FakeAlarms {
  private alarms = new Map<string, FakeAlarm>()

  create = async (name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void> => {
    this.alarms.set(name, { name, ...info })
  }

  get = async (name: string): Promise<FakeAlarm | undefined> => this.alarms.get(name)

  getAll = async (): Promise<FakeAlarm[]> => [...this.alarms.values()]

  clear = async (name: string): Promise<boolean> => this.alarms.delete(name)

  clearAll = async (): Promise<boolean> => {
    this.alarms.clear()
    return true
  }

  readonly onAlarm = { addListener: () => undefined }

  has(name: string): boolean {
    return this.alarms.has(name)
  }
}

/** Installs the fakes on `globalThis.chrome` and returns them. */
export function installChromeFake(options: FakeStorageOptions = {}): {
  storage: FakeStorage
  session: FakeStorage
  alarms: FakeAlarms
} {
  const storage = new FakeStorage(options)
  // A separate instance, mirroring Chrome: `session` is cleared when the browser
  // closes and shares no keys with `local`. One shared object would let a test pass
  // while the real extension wrote a transcript into permanent storage.
  const session = new FakeStorage()
  const alarms = new FakeAlarms()
  const chromeLike = {
    storage: { local: storage, session },
    alarms,
    runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async () => undefined,
      lastError: undefined,
    },
  }
  ;(globalThis as { chrome?: unknown }).chrome = chromeLike
  return { storage, session, alarms }
}

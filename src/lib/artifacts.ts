/**
 * Screenshot storage, in IndexedDB.
 *
 * Screenshots are the evidence behind a failure report, so they must survive a
 * service-worker restart — but `chrome.storage.local` is the wrong home for them:
 * it is read and written whole for many keys, and a handful of full-window PNGs
 * would slow every settings read in the extension. IndexedDB keeps large blobs
 * out of that path, and `storage.local` holds only the metadata needed to list
 * them.
 *
 * @module lib/artifacts
 */

const DB_NAME = 'webtest-pilot'
const DB_VERSION = 1
const STORE = 'artifacts'

/** A stored screenshot with its provenance. */
export interface Artifact {
  id: string
  runId: string
  stepIndex: number
  dataUrl: string
  width: number
  height: number
  createdAt: number
  /** Approximate byte size, used to enforce the retention budget. */
  bytes: number
}

/** Metadata only — safe to keep in `storage.local` and to send to the panel. */
export type ArtifactMeta = Omit<Artifact, 'dataUrl'>

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        // Indexed by run so deleting a run's artifacts is one cursor walk rather
        // than a full-store scan.
        store.createIndex('runId', 'runId', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // A version change from another context would leave this handle stale.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () =>
      reject(new Error(`Could not open the artifact database: ${request.error?.message ?? 'unknown'}`))
  })
  return dbPromise
}

function transact<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T> | { done: true },
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const store = transaction.objectStore(STORE)
        let result: T | undefined
        const outcome = body(store)
        if ('onsuccess' in outcome) {
          outcome.onsuccess = () => {
            result = outcome.result
          }
        }
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () =>
          reject(new Error(`Artifact store failed: ${transaction.error?.message ?? 'unknown'}`))
        transaction.onabort = () =>
          reject(new Error(`Artifact store aborted: ${transaction.error?.message ?? 'unknown'}`))
      }),
  )
}

/** Rough byte size of a data URL's payload. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  // 4 base64 characters carry 3 bytes.
  return Math.round((base64.length * 3) / 4)
}

/** Stores a screenshot and returns its id. */
export async function putArtifact(artifact: Omit<Artifact, 'bytes'>): Promise<string> {
  const record: Artifact = { ...artifact, bytes: dataUrlBytes(artifact.dataUrl) }
  await transact('readwrite', (store) => store.put(record))
  return record.id
}

/** Reads one screenshot, or undefined when it has been pruned. */
export async function getArtifact(id: string): Promise<Artifact | undefined> {
  return (await transact<Artifact>('readonly', (store) => store.get(id))) ?? undefined
}

/** Lists a run's artifact metadata, oldest first. */
export async function listRunArtifacts(runId: string): Promise<ArtifactMeta[]> {
  const db = await openDb()
  return new Promise<ArtifactMeta[]>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly')
    const index = transaction.objectStore(STORE).index('runId')
    const request = index.openCursor(IDBKeyRange.only(runId))
    const found: ArtifactMeta[] = []
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const { dataUrl: _dataUrl, ...meta } = cursor.value as Artifact
      found.push(meta)
      cursor.continue()
    }
    transaction.oncomplete = () => resolve(found.sort((a, b) => a.createdAt - b.createdAt))
    transaction.onerror = () =>
      reject(new Error(`Could not list artifacts: ${transaction.error?.message ?? 'unknown'}`))
  })
}

/** Deletes every artifact belonging to a run. */
export async function deleteRunArtifacts(runId: string): Promise<number> {
  const db = await openDb()
  return new Promise<number>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    const index = transaction.objectStore(STORE).index('runId')
    const request = index.openCursor(IDBKeyRange.only(runId))
    let deleted = 0
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      cursor.delete()
      deleted += 1
      cursor.continue()
    }
    transaction.oncomplete = () => resolve(deleted)
    transaction.onerror = () =>
      reject(new Error(`Could not delete artifacts: ${transaction.error?.message ?? 'unknown'}`))
  })
}

/**
 * Prunes oldest-first until the store fits the budget.
 *
 * A budget rather than a per-run cap: what matters is total disk use, and a
 * single long run should not be truncated while ten short ones are kept. Runs
 * that no longer exist are pruned first by the caller passing `keepRunIds`.
 */
export async function pruneArtifacts(options: {
  maxBytes: number
  keepRunIds?: Set<string>
}): Promise<{ deleted: number; freedBytes: number }> {
  const db = await openDb()
  const all = await new Promise<Artifact[]>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).index('createdAt').openCursor()
    const found: Artifact[] = []
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      found.push(cursor.value as Artifact)
      cursor.continue()
    }
    transaction.oncomplete = () => resolve(found)
    transaction.onerror = () =>
      reject(new Error(`Could not scan artifacts: ${transaction.error?.message ?? 'unknown'}`))
  })

  const doomed: Artifact[] = []
  let total = 0
  // Newest first, so the budget is spent on the most recent evidence.
  for (const artifact of [...all].sort((a, b) => b.createdAt - a.createdAt)) {
    const orphaned = options.keepRunIds ? !options.keepRunIds.has(artifact.runId) : false
    if (orphaned) {
      doomed.push(artifact)
      continue
    }
    total += artifact.bytes
    if (total > options.maxBytes) doomed.push(artifact)
  }
  if (doomed.length === 0) return { deleted: 0, freedBytes: 0 }

  await transact('readwrite', (store) => {
    for (const artifact of doomed) store.delete(artifact.id)
    return { done: true as const }
  })
  return {
    deleted: doomed.length,
    freedBytes: doomed.reduce((sum, artifact) => sum + artifact.bytes, 0),
  }
}

/** Total bytes held, for the Settings storage readout. */
export async function artifactUsage(): Promise<{ count: number; bytes: number }> {
  const db = await openDb()
  return new Promise<{ count: number; bytes: number }>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).openCursor()
    let count = 0
    let bytes = 0
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      count += 1
      bytes += (cursor.value as Artifact).bytes
      cursor.continue()
    }
    transaction.oncomplete = () => resolve({ count, bytes })
    transaction.onerror = () =>
      reject(new Error(`Could not measure artifacts: ${transaction.error?.message ?? 'unknown'}`))
  })
}

/** Deletes everything. Used by Settings → Clear data. */
export async function clearArtifacts(): Promise<void> {
  await transact('readwrite', (store) => store.clear())
}

/** Human-readable byte size for the UI. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

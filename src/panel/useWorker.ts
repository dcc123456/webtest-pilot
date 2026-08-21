/**
 * The panel's single connection to the service worker.
 *
 * Everything the panel knows comes from here, for one reason: the worker owns the
 * invariants. It recomputes a schedule's `nextRunAt`, it caps run history, and it
 * keeps secret *values* out of the renderer entirely. A panel that read
 * `chrome.storage` directly could produce state the worker would never have
 * allowed — a schedule with a stale fire time, a secret sitting in React
 * DevTools — so the panel deliberately has no other door.
 *
 * Two shapes of traffic, handled differently:
 *
 * - **Requests** are `call()`: one round trip, one `PanelResponse`. Failures are
 *   thrown as `Error(response.error)` so a component's `try/catch` handles a
 *   protocol failure and a network failure identically.
 * - **Events** are unsolicited `WorkerEvent`s over `chrome.runtime.onMessage`.
 *   `stateChanged` and the run events refresh state; `assistantText` and
 *   `toolCall` are streams the Chat tab consumes directly, so they are exposed as
 *   a subscription rather than folded into state — buffering deltas here would
 *   re-render every tab on every token.
 *
 * @module panel/useWorker
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  sendToWorker,
  type PanelRequest,
  type PanelResponse,
  type PanelState,
  type WorkerEvent,
} from '../lib/messages'
import { DEFAULT_SETTINGS } from '../lib/types'

/** State shown before the first `getState` reply lands. */
const EMPTY_STATE: PanelState = {
  cases: [],
  scripts: [],
  runs: [],
  schedules: [],
  settings: DEFAULT_SETTINGS,
  secretNames: [],
  skills: [],
  logs: [],
  bridge: { connected: false, url: DEFAULT_SETTINGS.bridge.url },
  activeRunIds: [],
  conversationActive: false,
}

/** A `WorkerEvent` handler, registered by a component that wants the stream. */
export type EventListener = (event: WorkerEvent) => void

export interface WorkerApi {
  state: PanelState
  /** True until the first state load resolves, so tabs can avoid a false "empty". */
  loading: boolean
  /**
   * Last state-load failure.
   *
   * Kept in state rather than thrown: the usual cause is an evicted worker, and
   * the panel should show a retry affordance rather than an error boundary.
   */
  error: string | null
  refresh: () => Promise<void>
  /** Sends a request; throws `Error(error)` when the worker replies `ok:false`. */
  call: (request: PanelRequest) => Promise<PanelResponse>
  /** Subscribes to raw worker events. Returns an unsubscribe function. */
  subscribe: (listener: EventListener) => () => void
}

/**
 * Debounce for state refreshes triggered by events.
 *
 * A run emits `runStep` and `runUpdated` on every step boundary; refetching the
 * whole `PanelState` for each would mean dozens of full reads during one run. A
 * short coalescing window keeps the lists live without that churn.
 */
const REFRESH_DEBOUNCE_MS = 180

export function useWorker(): WorkerApi {
  const [state, setState] = useState<PanelState>(EMPTY_STATE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const listeners = useRef(new Set<EventListener>())
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Guards against a state write after unmount, which React 19 still warns about. */
  const mounted = useRef(true)

  const call = useCallback(async (request: PanelRequest): Promise<PanelResponse> => {
    const response = await sendToWorker(request)
    // Thrown rather than returned so every caller either handles the message or
    // lets it reach the toast; a returned union invites `if (!ok) {}`.
    if (!response.ok) throw new Error(response.error)
    return response
  }, [])

  const refresh = useCallback(async () => {
    const response = await sendToWorker({ type: 'getState' })
    if (!mounted.current) return
    if (!response.ok) {
      setError(response.error)
      setLoading(false)
      return
    }
    if (!('state' in response)) {
      setError('后台返回的状态格式无法识别，请在 chrome://extensions 中重新加载插件。')
      setLoading(false)
      return
    }
    setState(response.state)
    setError(null)
    setLoading(false)
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      void refresh()
    }, REFRESH_DEBOUNCE_MS)
  }, [refresh])

  useEffect(() => {
    mounted.current = true
    void refresh()

    const onMessage = (message: unknown): void => {
      // The worker's own `PanelRequest`s never come this way, but a reply to some
      // other listener might, so the shape is checked before it is trusted.
      if (!isWorkerEvent(message)) return

      for (const listener of listeners.current) listener(message)

      switch (message.type) {
        case 'stateChanged':
        case 'runUpdated':
        case 'runStatus':
        case 'bridgeStatus':
        case 'log':
        case 'convDone':
        case 'convCleared':
          scheduleRefresh()
          break
        case 'runStep':
        case 'assistantText':
        case 'toolCall':
        case 'convUser':
        case 'convAssistant':
        case 'convStatus':
        case 'convTool':
        case 'convPending':
          // Pure progress: whoever is showing the turn already got it above.
          break
      }
    }

    chrome.runtime.onMessage.addListener(onMessage)
    return () => {
      mounted.current = false
      chrome.runtime.onMessage.removeListener(onMessage)
      if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
    }
  }, [refresh, scheduleRefresh])

  const subscribe = useCallback((listener: EventListener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  return useMemo(
    () => ({ state, loading, error, refresh, call, subscribe }),
    [state, loading, error, refresh, call, subscribe],
  )
}

/**
 * Structural check for a worker event.
 *
 * `messages.ts` exports guards for `PanelResponse` but not for `WorkerEvent`,
 * because the worker is the only sender and never needed to narrow one. The panel
 * does: `chrome.runtime.onMessage` is a shared channel, so an unrecognised
 * message must be ignored rather than pushed at listeners as a malformed event.
 */
function isWorkerEvent(message: unknown): message is WorkerEvent {
  if (!message || typeof message !== 'object') return false
  const type = (message as { type?: unknown }).type
  return (
    type === 'runUpdated' ||
    type === 'runStep' ||
    type === 'runStatus' ||
    type === 'assistantText' ||
    type === 'toolCall' ||
    type === 'stateChanged' ||
    type === 'bridgeStatus' ||
    type === 'log' ||
    type === 'convUser' ||
    type === 'convAssistant' ||
    type === 'convStatus' ||
    type === 'convTool' ||
    type === 'convPending' ||
    type === 'convDone' ||
    type === 'convCleared'
  )
}

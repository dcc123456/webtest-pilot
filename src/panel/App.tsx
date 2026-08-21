/**
 * The panel shell: tab bar, shared worker connection, cross-tab navigation.
 *
 * All six tabs read one `PanelState` from one {@link useWorker} instance, rather
 * than each fetching its own. That is not just deduplication: run events arrive
 * for whichever tab happens to be mounted, and two independent subscriptions
 * would give the Runs tab and the Chat tab different ideas about which runs are
 * still active.
 *
 * Tabs are mounted one at a time. Keeping all six alive would mean the Runs tab
 * holding decoded screenshots and the Chat tab holding a transcript while neither
 * is visible — and in a side panel that shares the browser's memory budget, the
 * unmount is the cheap fix. The cost is that Chat's transcript resets when the
 * user leaves it, which is acceptable because the durable record is the run
 * itself, in the Runs tab.
 *
 * Navigation between tabs is a *request*, not a route: `focusCaseId` and
 * `focusRunId` are handed to the target tab, which clears them once honoured. A
 * click on "查看详情" in Chat should land on the Runs tab with that run already
 * expanded, not merely on the Runs tab.
 *
 * @module panel/App
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CancelButton } from './CancelButton'
import { CasesTab } from './CasesTab'
import { ChatTab } from './ChatTab'
import { CopilotTab } from './CopilotTab'
import { RunsTab } from './RunsTab'
import { ScriptsTab } from './ScriptsTab'
import { SchedulesTab } from './SchedulesTab'
import { SettingsTab } from './SettingsTab'
import { Badge, Button, Notice, ToastProvider } from './components'
import { useWorker } from './useWorker'

type PrimaryTabKey = 'copilot' | 'chat' | 'cases' | 'runs'
type OverflowTabKey = 'scripts' | 'schedules' | 'settings'
type TabKey = PrimaryTabKey | OverflowTabKey

const PRIMARY_TABS: { key: PrimaryTabKey; label: string }[] = [
  { key: 'copilot', label: '对话' },
  { key: 'chat', label: '用例编写' },
  { key: 'cases', label: '用例' },
  { key: 'runs', label: '运行' },
]

/** Tabs tucked behind "更多" to keep the bar uncluttered in a narrow side panel. */
const OVERFLOW_TABS: { key: OverflowTabKey; label: string }[] = [
  { key: 'scripts', label: '脚本' },
  { key: 'schedules', label: '定时' },
  { key: 'settings', label: '设置' },
]

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}

function Shell() {
  const worker = useWorker()
  const [tab, setTab] = useState<TabKey>('copilot')
  const [focusCaseId, setFocusCaseId] = useState<string | null>(null)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  const [highlightSites, setHighlightSites] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement | null>(null)

  // Close the "更多" menu on an outside click or Escape, so it behaves like a
  // native menu rather than a toggle that stays open until re-clicked.
  useEffect(() => {
    if (!moreOpen) return
    const onPointer = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  const openCase = useCallback((caseId: string) => {
    setFocusCaseId(caseId)
    setTab('cases')
  }, [])

  const openRun = useCallback((runId: string) => {
    setFocusRunId(runId)
    setTab('runs')
  }, [])

  const openSites = useCallback(() => {
    setHighlightSites(true)
    setTab('settings')
  }, [])

  const { state, loading, error, refresh } = worker
  const activeCount = state.activeRunIds.length

  const counts: Record<TabKey, number> = {
    copilot: 0,
    chat: 0,
    cases: state.cases.length,
    scripts: state.scripts.length,
    runs: state.runs.length,
    schedules: state.schedules.filter((entry) => entry.enabled).length,
    settings: 0,
  }

  const activeOverflow = OVERFLOW_TABS.find((entry) => entry.key === tab)
  const moreCount = OVERFLOW_TABS.reduce((sum, entry) => sum + counts[entry.key], 0)

  return (
    <div className='app'>
      <div className='app__head'>
        <h1 className='app__title'>
          WebTest Pilot <span>测试领航</span>
        </h1>
        <span className='app__head-right'>
          {activeCount > 0 ? (
            <Badge tone='info' title='正在执行的运行数'>
              {activeCount} 个运行中
            </Badge>
          ) : null}
          {/*
            Cancel lives in the header so it is reachable from every tab. It used to
            exist only on a run card inside the Chat transcript, which meant a user
            who had switched to Cases or Scripts could not stop a run at all.

            Only offered for a single active run: with several running, "which one?"
            has no answer here, and the Runs tab is where they are told apart.
          */}
          {activeCount === 1 && state.activeRunIds[0] ? (
            <CancelButton runId={state.activeRunIds[0]} worker={worker} label='取消运行' />
          ) : null}
          {state.settings.bridge.enabled ? (
            <Badge
              tone={state.bridge.connected ? 'ok' : 'warn'}
              title={
                state.bridge.connected
                  ? `本地接口（bridge）已连接：${state.bridge.url}`
                  : `本地接口已启用但未连接${state.bridge.lastError ? `：${state.bridge.lastError}` : ''}`
              }
            >
              bridge
            </Badge>
          ) : null}
        </span>
      </div>

      <div className='app__tabs' role='tablist'>
        {PRIMARY_TABS.map((entry) => (
          <button
            key={entry.key}
            className='app__tab'
            role='tab'
            aria-selected={tab === entry.key}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
            {counts[entry.key] > 0 ? (
              <span className='app__tab-count'>{counts[entry.key]}</span>
            ) : null}
          </button>
        ))}

        <div className='app__more' ref={moreRef}>
          <button
            className={
              'app__tab app__tab--more' + (activeOverflow || moreOpen ? ' is-active' : '')
            }
            aria-haspopup='menu'
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((current) => !current)}
          >
            更多
            {moreCount > 0 ? <span className='app__tab-count'>{moreCount}</span> : null}
            <span className='app__more-caret' aria-hidden='true'>
              ▾
            </span>
          </button>
          {moreOpen ? (
            <div className='app__more-menu' role='menu'>
              {OVERFLOW_TABS.map((entry) => (
                <button
                  key={entry.key}
                  className={'app__more-item' + (tab === entry.key ? ' is-selected' : '')}
                  role='menuitem'
                  onClick={() => {
                    setTab(entry.key)
                    setMoreOpen(false)
                  }}
                >
                  <span>{entry.label}</span>
                  {counts[entry.key] > 0 ? (
                    <span className='app__tab-count'>{counts[entry.key]}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className='app__body'>
        {error !== null ? (
          <div className='stack'>
            <Notice kind='error' title='读取后台状态失败'>
              {error}
              <Button small onClick={() => void refresh()}>
                重试
              </Button>
            </Notice>
          </div>
        ) : null}

        {loading && error === null ? (
          <div className='stack'>
            <span className='faint small'>正在读取后台状态…</span>
          </div>
        ) : (
          <div
            className={
              tab === 'copilot' || tab === 'chat' ? 'app__pane app__pane--fill' : 'app__pane'
            }
            role='tabpanel'
          >
            {tab === 'copilot' ? <CopilotTab worker={worker} /> : null}
            {tab === 'chat' ? (
              <ChatTab worker={worker} onOpenCase={openCase} onOpenRun={openRun} />
            ) : null}
            {tab === 'cases' ? (
              <CasesTab
                worker={worker}
                focusCaseId={focusCaseId}
                onFocusHandled={() => setFocusCaseId(null)}
                onOpenRun={openRun}
                onOpenSettings={openSites}
              />
            ) : null}
            {tab === 'scripts' ? <ScriptsTab worker={worker} onOpenRun={openRun} /> : null}
            {tab === 'runs' ? (
              <RunsTab
                worker={worker}
                focusRunId={focusRunId}
                onFocusHandled={() => setFocusRunId(null)}
                onOpenSettings={openSites}
              />
            ) : null}
            {tab === 'schedules' ? (
              <SchedulesTab worker={worker} onOpenSettings={openSites} onOpenRun={openRun} />
            ) : null}
            {tab === 'settings' ? (
              <SettingsTab
                worker={worker}
                highlightSites={highlightSites}
                onHighlightHandled={() => setHighlightSites(false)}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

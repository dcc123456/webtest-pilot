/**
 * The service worker: the extension's only long-lived coordinator.
 *
 * Every trigger — the side panel, an alarm, the local bridge — funnels through
 * here, which is what keeps the run-lifecycle guarantees in one place instead of
 * three.
 *
 * The MV3 constraint that shapes this file: **the worker can be evicted between
 * any two events.** So there is no meaningful in-memory state beyond what a
 * single in-flight run needs, every handler re-reads what it needs from storage,
 * and startup always reconciles runs that a previous incarnation left dangling.
 *
 * @module background/index
 */

import { artifactUsage, clearArtifacts, deleteRunArtifacts, getArtifact, listRunArtifacts, pruneArtifacts } from '../lib/artifacts'
import { listModels, testConnection } from '../lib/llm'
import { parseCasesMarkdown, toTestCase } from '../lib/markdown'
import { broadcast, type PanelRequest, type PanelResponse, type PanelState } from '../lib/messages'
import { exportPlaywright, exportScriptMarkdown, toScriptJson } from '../lib/script'
import { buildBundle, parseBundle, toBundleJson } from '../lib/share'
import {
  LIMITS,
  activeProvider,
  appendLog,
  clearLogs,
  clearRuns,
  deleteCase,
  deleteRun,
  deleteSchedule,
  deleteScript,
  deleteSecret,
  deleteSkill,
  exportAll,
  getCase,
  getCases,
  getLogs,
  getRuns,
  getSchedule,
  getSchedules,
  getScript,
  getScripts,
  getSecrets,
  getSettings,
  getSkill,
  getSkills,
  importAll,
  newId,
  patchSchedule,
  reconcileRuns,
  saveCase,
  saveCases,
  saveSchedule,
  saveScript,
  saveScripts,
  saveSecret,
  saveSettings,
  saveSkill,
  storageUsage,
} from '../lib/storage'
import type { ScheduleEntry, Settings, TestRun, TestScript } from '../lib/types'
import { SCRIPT_VERSION } from '../lib/types'
import type { RunContext } from './driver'
import { StartError, startRun, type RunObserver, type ToolCallReport } from './orchestrator'
import {
  appendAssistantDelta,
  appendEntry,
  beginTranscript,
  clearTranscripts,
  deleteTranscript,
  endTranscript,
  getTranscript,
  reconcileTranscripts,
} from './transcript'
import { TICK_ALARM, installScheduler, onTick, refreshNextRun, resyncSchedules } from './scheduler'
import { converse, type PendingChatAction } from './converse'
import { conversation, toolEventToBroadcast, applyConversationEvent, restoreConversation } from './conversation'
import { chromeDeps, openContext } from './orchestrator'

/**
 * Cancellation handles for runs executing right now.
 *
 * The only in-memory state in the extension, and deliberately so: it cannot be
 * persisted (an `AbortController` is not serializable), and it does not need to
 * be — if the worker dies, the run dies with it, and `reconcileRuns` marks it
 * interrupted on the next startup.
 */
const active = new Map<string, AbortController>()

// --- Lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap('installed')
})

chrome.runtime.onStartup.addListener(() => {
  void bootstrap('startup')
})

// Also on plain worker wake-up: neither event above fires when Chrome merely
// revives an evicted worker, and that is precisely when reconciliation matters.
void bootstrap('wake')

async function bootstrap(reason: string): Promise<void> {
  try {
    // A run left `running` by a crash would otherwise look active for ever, and
    // a CI client waiting on it would hang instead of failing.
    const repaired = await reconcileRuns()
    for (const run of repaired) {
      await appendLog({
        level: 'warn',
        source: `run:${run.id}`,
        message: `运行「${run.caseName}」被标记为中断：后台在其完成前停止了（${reason}）。`,
      })
    }
    if (repaired.length > 0) broadcast({ type: 'stateChanged' })

    // Same reasoning applied to the commentary: a transcript left `running` by an
    // evicted worker would show a live spinner for a run that is already dead.
    // `active` is empty at this point by definition — it cannot survive eviction —
    // so every `running` transcript here is stale.
    await reconcileTranscripts([...active.keys()])

    await resyncSchedules()

    // Keep screenshot storage inside its budget, and drop artifacts whose run
    // has aged out of the capped history.
    const runs = await getRuns()
    await pruneArtifacts({
      maxBytes: LIMITS.artifactBytes,
      keepRunIds: new Set(runs.map((run) => run.id)),
    })

    const settings = await getSettings()
    if (settings.bridge.enabled) void connectBridge()
  } catch (error) {
    await appendLog({
      level: 'error',
      source: 'startup',
      message: `启动检查失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

chrome.action.onClicked.addListener((tab) => {
  // Opening the panel from the toolbar icon is the primary entry point; there is
  // no popup, because a test run needs a surface that stays open.
  if (typeof tab.windowId === 'number') {
    void chrome.sidePanel.open({ windowId: tab.windowId })
  }
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM) return
  void onTick({
    startRun: async (entry) => runScheduled(entry),
  }).then(({ started }) => {
    if (started > 0) broadcast({ type: 'stateChanged' })
  })
})

// --- Scheduled runs ----------------------------------------------------------

async function runScheduled(entry: ScheduleEntry): Promise<TestRun | undefined> {
  const testCase = await getCase(entry.caseId)
  if (!testCase) return undefined

  const controller = new AbortController()
  const shared = makeObserver()
  const outcome = await startRun({
    testCase,
    trigger: 'schedule',
    useAgent: !entry.preferScript,
    signal: controller.signal,
    observer: {
      ...shared,
      onRun: (run) => {
        // Registered so a scheduled run is cancellable too. Without this the run
        // showed up in "N running" but `cancelRun` reported it had already finished —
        // and a schedule that hits a hanging page could only be stopped by reloading
        // the extension.
        active.set(run.id, controller)
        shared.onRun?.(run)
      },
    },
  })
  active.delete(outcome.run.id)
  await notifyIfNeeded(outcome.run, entry.notify)
  return outcome.run
}

/**
 * Sends a Feishu notification when the policy calls for one.
 *
 * A failed notification is logged, never rethrown: the run's result is already
 * durable, and losing a webhook must not turn a passing run into an error.
 */
async function notifyIfNeeded(run: TestRun, policy?: ScheduleEntry['notify']): Promise<void> {
  // The local notification comes first and is independent of Feishu: it must
  // still appear when no webhook is configured, which is the common case for a
  // developer running schedules on their own machine.
  const { notifyRunLocally } = await import('./notify')
  await notifyRunLocally(run)

  try {
    const settings = await getSettings()
    const { sendFeishuNotification, shouldNotify } = await import('../lib/feishu')
    const effective = policy ?? settings.feishu.notify
    if (!settings.feishu.webhookUrl.trim()) return
    if (!shouldNotify(effective, run.status)) return

    const result = await sendFeishuNotification(settings.feishu, run)
    if (!result.ok) {
      await appendLog({
        level: 'warn',
        source: `run:${run.id}`,
        message: `飞书通知发送失败：${result.error}`,
      })
    }
  } catch (error) {
    await appendLog({
      level: 'warn',
      source: `run:${run.id}`,
      message: `飞书通知发送失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * The observer every trigger uses: records to the transcript, then broadcasts.
 *
 * Both halves matter, and in this order. The **recording** is what survives a panel
 * tab switch and an MV3 worker eviction — it is the source of truth, because the
 * worker owns the run. The **broadcast** is only a fast path so an open panel
 * updates without polling; a broadcast with no receiver is swallowed, which is the
 * normal case for a scheduled run at 3am.
 *
 * Before this existed, the transcript lived in the Chat tab's React state. Switching
 * to any other tab unmounted it, discarding everything and permanently losing the
 * events that arrived while it was away.
 */
function makeObserver(): RunObserver {
  return {
    onRun: (run: TestRun) => {
      // Opens the transcript on the first sighting of the run, so the case name is
      // available for a panel that attaches later.
      void beginTranscriptOnce(run)
      broadcast({ type: 'runUpdated', run })
    },
    onStep: (runId: string, step) => broadcast({ type: 'runStep', runId, step }),
    onStatus: (runId: string, status: TestRun['status'], message?: string) => {
      void (async () => {
        await whenTranscriptReady(runId)
        const stored = await appendEntry(runId, {
          kind: 'status',
          status,
          ...(message ? { message } : {}),
        })
        if (status !== 'running' && status !== 'queued') {
          await endTranscript(runId, status)
          // Released on the terminal status so a long-lived worker does not keep one
          // entry per run it has ever executed.
          transcriptReady.delete(runId)
        }
        broadcast({
          type: 'runStatus',
          runId,
          status,
          ...(message ? { message } : {}),
          ...(stored ? { seq: stored.seq } : {}),
        })
      })()
    },
    onAssistantText: (runId: string, delta: string) => {
      // Broadcast *after* the store assigns a sequence number, and carrying the
      // accumulated text, so a live event and a later replay describe the same entry
      // rather than two. Ordering is guaranteed by the store's write queue.
      void (async () => {
        await whenTranscriptReady(runId)
        const stored = await appendAssistantDelta(runId, delta)
        if (stored?.kind === 'assistant') {
          broadcast({ type: 'assistantText', runId, delta, text: stored.text, seq: stored.seq })
        }
      })()
    },
    onToolCall: (runId: string, report: ToolCallReport) => {
      void (async () => {
        await whenTranscriptReady(runId)
        const stored = await appendEntry(runId, { kind: 'tool', ...report })
        if (stored) broadcast({ type: 'toolCall', runId, seq: stored.seq, ...report })
      })()
    },
    onPhase: (runId: string, text: string) => {
      void (async () => {
        await whenTranscriptReady(runId)
        const stored = await appendEntry(runId, { kind: 'phase', text })
        if (stored) broadcast({ type: 'runPhase', runId, seq: stored.seq, text })
      })()
    },
  }
}

/**
 * Opens a run's transcript exactly once, and lets appenders wait for it.
 *
 * Keyed by run id and holding the *promise*, not a boolean, because the observer's
 * appenders fire without awaiting: `appendEntry` returns `undefined` when no
 * transcript exists yet, so an early `onPhase` racing `beginTranscript` would be
 * dropped. Awaiting this first makes the ordering explicit.
 *
 * In memory rather than derived from storage because it only has to be right for the
 * lifetime of a run: if the worker is evicted mid-run the run dies with it, and
 * `reconcileTranscripts` closes the transcript on the next wake-up.
 */
const transcriptReady = new Map<string, Promise<void>>()

function beginTranscriptOnce(run: TestRun): Promise<void> {
  const existing = transcriptReady.get(run.id)
  if (existing) return existing
  const promise = beginTranscript(run.id, run.caseName)
  transcriptReady.set(run.id, promise)
  return promise
}

/** Resolves once the run's transcript exists, so an append cannot be dropped. */
async function whenTranscriptReady(runId: string): Promise<void> {
  await transcriptReady.get(runId)
}

// --- Bridge ------------------------------------------------------------------

/** Lazily imported so a user who never enables the bridge never loads it. */
async function connectBridge(): Promise<void> {
  const { connect } = await import('./bridge')
  await connect({
    startRun: async (params) => {
      const controller = new AbortController()
      const shared = makeObserver()
      const testCase = params.caseId ? await getCase(params.caseId) : undefined
      const script = params.scriptId ? await getScript(params.scriptId) : undefined
      const outcome = await startRun({
        ...(testCase ? { testCase } : {}),
        ...(script ? { script } : {}),
        trigger: 'bridge',
        ...(params.useAgent ? { useAgent: true } : {}),
        signal: controller.signal,
        observer: {
          ...shared,
          onRun: (run) => {
            // Without this, `cancelRun` below could never find the controller and
            // always answered "no such run" — so a CI job could start a run over the
            // local API but never stop it.
            active.set(run.id, controller)
            shared.onRun?.(run)
          },
        },
      })
      active.delete(outcome.run.id)
      await notifyIfNeeded(outcome.run)
      return outcome.run
    },
    cancelRun: (runId: string) => {
      const controller = active.get(runId)
      if (!controller) return false
      controller.abort()
      return true
    },
  })
}

// --- Panel messaging ---------------------------------------------------------

chrome.runtime.onMessage.addListener((message: PanelRequest, _sender, sendResponse) => {
  // The listener must return `true` synchronously to keep the port open for an
  // async reply; awaiting before returning would close it and the panel would
  // see `undefined`.
  void handlePanelRequest(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PanelResponse)
    })
  return true
})

async function handlePanelRequest(request: PanelRequest): Promise<PanelResponse> {
  switch (request.type) {
    case 'getState':
      return { ok: true, state: await buildState() }

    case 'runCase': {
      const testCase = await getCase(request.caseId)
      if (!testCase) return { ok: false, error: '找不到该测试用例，它可能已被删除。' }
      return startAndReply({ testCase, useAgent: request.useAgent })
    }

    case 'runScript': {
      const script = await getScript(request.scriptId)
      if (!script) return { ok: false, error: '找不到该脚本，它可能已被删除。' }
      const testCase = script.caseId ? await getCase(script.caseId) : undefined
      return startAndReply({ script, ...(testCase ? { testCase } : {}) })
    }

    case 'cancelRun': {
      const controller = active.get(request.runId)
      if (!controller) {
        return { ok: false, error: '该运行已经结束，无法取消。' }
      }
      controller.abort()
      // Recorded in the transcript as well as returned, so the reason a run stopped
      // is visible to a panel that was on another tab when it happened.
      void appendEntry(request.runId, { kind: 'phase', text: '已请求取消，正在停止…' })
      return { ok: true, message: '已请求取消，当前步骤结束后停止。' }
    }

    case 'getTranscript': {
      const transcript = await getTranscript(request.runId)
      return { ok: true, transcript: transcript ?? null }
    }

    case 'getTranscripts': {
      const { listTranscripts } = await import('./transcript')
      return { ok: true, transcripts: await listTranscripts() }
    }

    case 'importMarkdown': {
      const parsed = parseCasesMarkdown(request.markdown)
      if (parsed.cases.length === 0) {
        return {
          ok: false,
          error: parsed.problems[0]?.message ?? '没能从文本中解析出测试用例。',
        }
      }
      const cases = parsed.cases.map((entry) =>
        toTestCase(entry, { id: newId('case'), source: request.source }),
      )
      await saveCases(cases)
      broadcast({ type: 'stateChanged' })
      return { ok: true, cases }
    }

    case 'saveCase': {
      await saveCase(request.testCase)
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'deleteCase': {
      await deleteCase(request.caseId, { withScripts: request.withScripts === true })
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'saveScript': {
      const script = await saveScript(request.script)
      broadcast({ type: 'stateChanged' })
      return { ok: true, script }
    }

    case 'deleteScript': {
      await deleteScript(request.scriptId)
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'exportScript': {
      const script = await getScript(request.scriptId)
      if (!script) return { ok: false, error: '找不到该脚本。' }
      const text =
        request.format === 'playwright'
          ? exportPlaywright(script)
          : request.format === 'markdown'
            ? exportScriptMarkdown(script)
            : toScriptJson(script)
      return { ok: true, text }
    }

    case 'exportScriptBundle': {
      const all = await getScripts()
      // An empty selection means "all", which is what the "export everything"
      // button sends; filtering to nothing would silently produce an empty file.
      const wanted =
        request.scriptIds.length > 0
          ? all.filter((script) => request.scriptIds.includes(script.id))
          : all
      if (wanted.length === 0) return { ok: false, error: '没有可导出的脚本。' }
      const bundle = buildBundle(wanted, await getCases())
      return { ok: true, text: toBundleJson(bundle) }
    }

    case 'importScriptBundle': {
      let parsed: ReturnType<typeof parseBundle>
      try {
        parsed = parseBundle(request.json, (prefix) => newId(prefix))
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (parsed.cases.length > 0) await saveCases(parsed.cases)
      await saveScripts(parsed.scripts)

      // Report secrets the file needs but this profile lacks. Without this the
      // gap is discovered when a run fails partway through a login.
      const have = new Set((await getSecrets()).map((entry) => entry.name))
      const missing = parsed.requiredSecrets.filter((name) => !have.has(name))

      broadcast({ type: 'stateChanged' })
      const parts = [`已导入 ${parsed.scripts.length} 个脚本`]
      if (parsed.cases.length > 0) parts.push(`${parsed.cases.length} 个测试用例`)
      let message = `${parts.join('、')}。`
      if (missing.length > 0) {
        message += `\n\n这些脚本需要以下密钥，但你还没有配置：${missing.join('、')}。请到「设置 → 密钥」添加后再运行。`
      }
      await appendLog({
        level: 'info',
        source: 'import',
        message: `导入脚本文件：${parsed.scripts.length} 个脚本、${parsed.cases.length} 个用例。`,
      })
      return { ok: true, message }
    }

    case 'deleteRun': {
      // Artifacts go with the run: keeping orphaned screenshots would consume
      // the storage budget for evidence nobody can reach.
      await deleteRunArtifacts(request.runId)
      await deleteRun(request.runId)
      // The transcript goes too, for the same reason: commentary about a run nobody
      // can open is just occupied quota.
      await deleteTranscript(request.runId)
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'clearRuns': {
      await clearArtifacts()
      await clearRuns()
      await clearTranscripts()
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'getRunArtifacts':
      return { ok: true, artifacts: await listRunArtifacts(request.runId) }

    case 'getArtifact': {
      const artifact = await getArtifact(request.artifactId)
      if (!artifact) {
        return { ok: false, error: '该截图已被清理（超出存储预算或所属运行已删除）。' }
      }
      return { ok: true, dataUrl: artifact.dataUrl }
    }

    case 'saveSchedule': {
      const saved = await saveSchedule(request.entry)
      // The worker owns `nextRunAt`, so the panel cannot store an inconsistent one.
      await refreshNextRun(saved)
      await resyncSchedules()
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'toggleSchedule': {
      const entry = await getSchedule(request.scheduleId)
      if (!entry) return { ok: false, error: '找不到该定时任务。' }
      const updated = await patchSchedule(request.scheduleId, { enabled: request.enabled })
      if (updated) await refreshNextRun(updated)
      await resyncSchedules()
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'deleteSchedule': {
      await deleteSchedule(request.scheduleId)
      await resyncSchedules()
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'saveSettings': {
      const before = await getSettings()
      await saveSettings(request.patch)
      const after = await getSettings()
      // Schedules depend on nothing in settings, but the bridge does: a URL or
      // token change must reconnect, or the user's edit appears to do nothing.
      if (
        before.bridge.enabled !== after.bridge.enabled ||
        before.bridge.url !== after.bridge.url ||
        before.bridge.token !== after.bridge.token
      ) {
        const { disconnect } = await import('./bridge')
        disconnect()
        if (after.bridge.enabled) void connectBridge()
      }
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'testProvider': {
      try {
        const result = await testConnection(request.profile)
        return {
          ok: true,
          message: result.toolCallsLikelySupported
            ? `连接成功，模型「${request.profile.model}」支持工具调用（function calling）。`
            : '连接成功，但该模型可能不支持工具调用。本插件依赖工具调用来操作页面，建议换用支持的模型。',
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'listModels': {
      try {
        return { ok: true, models: await listModels(request.profile) }
      } catch (error) {
        return {
          ok: false,
          error: `无法获取模型列表：${error instanceof Error ? error.message : String(error)}。可以直接手动填写模型名称。`,
        }
      }
    }

    case 'saveSecret': {
      if (!request.entry.name.trim()) return { ok: false, error: '密钥名称不能为空。' }
      await saveSecret(request.entry)
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'deleteSecret': {
      await deleteSecret(request.name)
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'testFeishu': {
      const settings = await getSettings()
      const { sendFeishuNotification, validateFeishuConfig } = await import('../lib/feishu')
      const problems = validateFeishuConfig(settings.feishu)
      if (problems.length > 0) return { ok: false, error: problems.join('；') }

      const sample: TestRun = {
        id: 'test',
        caseName: '（测试通知）WebTest Pilot 连接检查',
        mode: 'script',
        trigger: 'manual',
        status: 'passed',
        startedAt: Date.now() - 3200,
        finishedAt: Date.now(),
        heartbeatAt: Date.now(),
        steps: [],
        summary: '这是一条测试消息，说明 webhook 配置正确。',
      }
      const result = await sendFeishuNotification(settings.feishu, sample)
      return result.ok
        ? { ok: true, message: '测试消息已发送，请检查飞书群。' }
        : { ok: false, error: result.error }
    }

    case 'connectBridge': {
      await saveSettings({ bridge: { ...(await getSettings()).bridge, enabled: true } })
      await connectBridge()
      return { ok: true, message: '正在连接本地服务…' }
    }

    case 'disconnectBridge': {
      const { disconnect } = await import('./bridge')
      disconnect()
      await saveSettings({ bridge: { ...(await getSettings()).bridge, enabled: false } })
      broadcast({ type: 'bridgeStatus', connected: false })
      return { ok: true }
    }

    case 'exportAll':
      return { ok: true, text: await exportAll() }

    case 'importAll': {
      const counts = await importAll(request.json)
      await resyncSchedules()
      broadcast({ type: 'stateChanged' })
      return {
        ok: true,
        message: `已导入 ${counts.cases} 个用例、${counts.scripts} 个脚本、${counts.schedules} 个定时任务（导入的定时任务默认为停用状态）。`,
      }
    }

    case 'clearLogs': {
      await clearLogs()
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'getStorageUsage': {
      const [storageBytes, artifacts] = await Promise.all([storageUsage(), artifactUsage()])
      return {
        ok: true,
        usage: {
          storageBytes,
          artifactBytes: artifacts.bytes,
          artifactCount: artifacts.count,
        },
      }
    }

    // --- Open-ended conversation --------------------------------------------

    case 'converse': {
      if (conversation.running) {
        return { ok: false, error: '上一轮对话还在进行，请稍候或先取消。' }
      }
      const settings = await getSettings()
      const provider = await activeProvider()
      if (!provider || !provider.apiKey.trim()) {
        return {
          ok: false,
          error: '尚未配置模型（provider）。请在「设置 → 模型」中填写。',
        }
      }

      let activeSkill: import('../lib/types').Skill | null = null
      if (request.skillId) {
        const found = await getSkill(request.skillId)
        if (!found) return { ok: false, error: '找不到所选的技能（skill）。' }
        activeSkill = found
      }
      const skills = await getSkills()
      const catalogue = activeSkill ? [] : skills.filter((skill) => skill.autoMatch)

      const confirmMode = request.confirmMode ?? settings.policy.confirmMode
      conversation.confirmMode = confirmMode
      conversation.activeSkill = activeSkill

      // Take over the user's current tab, the same way a manual run does: no new
      // window, inherited session and data.
      let context: RunContext
      let ownTab: number | undefined
      try {
        const opened = await openContext('', chromeDeps, settings.policy.allowedSites)
        context = opened.context
        ownTab = opened.ownTab
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }

      const secrets = await getSecrets()
      const secretValues = new Map(secrets.map((secret) => [secret.name, secret.value]))

      const controller = new AbortController()
      conversation.abort = controller
      conversation.running = true
      conversation.pending = null
      broadcast({ type: 'stateChanged' })

      const userText = request.message
      emitConversation({ type: 'convUser', text: userText, at: Date.now() })

      // Not awaited: the panel gets its reply now and streams events afterward.
      void runConversation({
        userText,
        context,
        ownTab,
        controller,
        provider,
        settings,
        activeSkill,
        catalogue,
        confirmMode,
        secretValues,
        secretNames: secrets.map((secret) => secret.name),
      })
      return { ok: true }
    }

    case 'cancelConversation': {
      conversation.abort?.abort()
      if (conversation.pending) {
        conversation.pending.resolve(false)
        conversation.pending = null
      }
      return { ok: true }
    }

    case 'approveAction': {
      if (!conversation.pending || conversation.pending.id !== request.pendingId) {
        return { ok: false, error: '该操作已过期或已被处理。' }
      }
      conversation.pending.resolve(request.approved)
      conversation.pending = null
      return { ok: true }
    }

    case 'clearConversation': {
      emitConversation({ type: 'convCleared', at: Date.now() })
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'getConversation': {
      const transcript = await restoreConversation()
      return { ok: true, conversation: transcript }
    }

    case 'setConversationConfirmMode': {
      // Update the live value immediately. An in-flight turn reads it through a
      // getter for each tool call, so this takes effect on the next action
      // without waiting for the next user message.
      conversation.confirmMode = request.mode
      return { ok: true }
    }

    case 'listSkills': {
      return { ok: true, message: JSON.stringify(await getSkills()) }
    }

    case 'saveSkill': {
      await saveSkill(request.skill)
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'deleteSkill': {
      await deleteSkill(request.skillId)
      broadcast({ type: 'stateChanged' })
      return { ok: true }
    }

    case 'saveConversationScript': {
      if (conversation.lastSteps.length === 0) {
        return { ok: false, error: '上一轮对话没有可保存的操作。' }
      }
      const selected =
        request.indices && request.indices.length > 0
          ? request.indices
              .map((index) => conversation.lastSteps[index])
              .filter((step): step is NonNullable<typeof step> => Boolean(step))
          : conversation.lastSteps
      if (selected.length === 0) {
        return { ok: false, error: '没有选择任何步骤。' }
      }
      const script: TestScript = {
        id: newId('script'),
        name: request.name.trim() || '对话录制脚本',
        startUrl: request.startUrl,
        steps: selected,
        version: SCRIPT_VERSION,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await saveScript(script)
      broadcast({ type: 'stateChanged' })
      return { ok: true, message: `已保存脚本「${script.name}」（${selected.length} 步）。` }
    }
  }
}

/**
 * Broadcasts a conversation event and mirrors it into the persisted transcript.
 *
 * The panel gets the live event; the persisted copy is what a remounted tab (or
 * a worker that was evicted and restarted) restores from, so the two must go
 * through the same mutation in lockstep.
 */
function emitConversation(
  event: Parameters<typeof applyConversationEvent>[0],
): void {
  applyConversationEvent(event)
  broadcast(event)
}

/**
 * Drives one conversational turn off the request path.
 *
 * Resolving the panel request before this starts matters: sending a message must
 * feel instant, while the model round and any approval prompts happen as events.
 * Errors are broadcast as a final status rather than thrown, because by the time
 * they occur the request has already returned.
 */
async function runConversation(params: {
  userText: string
  context: RunContext
  ownTab?: number
  controller: AbortController
  provider: Awaited<ReturnType<typeof activeProvider>>
  settings: Settings
  activeSkill: import('../lib/types').Skill | null
  catalogue: import('../lib/types').Skill[]
  confirmMode: import('../lib/types').ConfirmMode
  secretValues: Map<string, string>
  secretNames: string[]
}): Promise<void> {
  const { context, ownTab, controller, provider, settings, activeSkill, catalogue } =
    params
  const driver = chromeDeps.createDriver(settings.policy.allowedSites)
  let assistantText = ''
  try {
    // The context carries a tabId, not a live tab; read the current URL/title for
    // the system prompt so the model knows which page it is on.
    let pageUrl = ''
    let pageTitle = ''
    try {
      const tab = await chrome.tabs.get(context.tabId)
      pageUrl = tab.url ?? ''
      pageTitle = tab.title ?? ''
    } catch {
      /* tab may have closed; the model can still call snapshot */
    }
    const result = await converse(conversation.history, params.userText, {
      driver,
      context,
      provider: {
        apiKey: provider!.apiKey,
        baseUrl: provider!.baseUrl,
        model: provider!.model,
        ...(provider!.label ? { label: provider!.label } : {}),
        ...(provider!.headers ? { headers: provider!.headers } : {}),
        ...(provider!.temperature !== undefined ? { temperature: provider!.temperature } : {}),
        ...(provider!.maxTokens !== undefined ? { maxTokens: provider!.maxTokens } : {}),
      },
      activeSkill: activeSkill ?? undefined,
      catalogue,
      getConfirmMode: () => conversation.confirmMode,
      secretNames: params.secretNames,
      secretValues: params.secretValues,
      selfHeal: settings.policy.selfHeal,
      maxRounds: settings.policy.maxToolRounds,
      allowedSites: settings.policy.allowedSites,
      pageUrl,
      pageTitle,
      signal: controller.signal,
      onText: (delta) => {
        assistantText += delta
        emitConversation({ type: 'convAssistant', text: assistantText, at: Date.now() })
      },
      onStatus: (text) => emitConversation({ type: 'convStatus', text, at: Date.now() }),
      onPending: (action: PendingChatAction) => {
        conversation.pending = {
          id: action.id,
          name: action.name,
          args: action.argsSummary,
          mutating: action.mutating,
          resolve: action.decide,
        }
        emitConversation({
          type: 'convPending',
          pendingId: action.id,
          name: action.name,
          args: action.argsSummary,
          mutating: action.mutating,
          at: Date.now(),
        })
      },
      onTool: (event) => {
        emitConversation(toolEventToBroadcast(event, Date.now()))
      },
    })

    // Persist the wire history so the next turn has multi-turn context, then cap
    // it to avoid unbounded growth.
    conversation.history = result.messages
    conversation.lastSteps = result.steps
    pruneConversationHistory()
    emitConversation({
      type: 'convDone',
      steps: result.steps,
      ...(result.stoppedBecause ? { summary: result.stoppedBecause } : {}),
      at: Date.now(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitConversation({ type: 'convStatus', text: `出错：${message}`, at: Date.now() })
    emitConversation({ type: 'convDone', steps: conversation.lastSteps, summary: message, at: Date.now() })
  } finally {
    conversation.running = false
    conversation.pending = null
    conversation.abort = null
    broadcast({ type: 'stateChanged' })
    await chromeDeps.closeTab(ownTab)
  }
}

/**
 * Trims the in-memory wire history so a long conversation does not grow without
 * bound.
 *
 * The history is a flat list of user/assistant/tool messages. We keep the most
 * recent messages up to a character budget, always starting at a user turn so a
 * tool result is never orphaned from its call.
 */
function pruneConversationHistory(): void {
  const MAX_CHARS = 24_000
  let total = 0
  const kept: typeof conversation.history = []
  for (let i = conversation.history.length - 1; i >= 0; i -= 1) {
    const message = conversation.history[i]
    if (!message) break
    const size = typeof message.content === 'string' ? message.content.length : 0
    if (total + size > MAX_CHARS) break
    kept.unshift(message)
    total += size
  }
  // Never start mid-tool-sequence: if the oldest kept message is a tool result,
  // drop it and any leading tool/assistant fragment until a user message leads.
  while (kept.length > 0 && kept[0]?.role !== 'user') kept.shift()
  conversation.history = kept
}

/** Starts a run from the panel and replies as soon as it is registered. */
async function startAndReply(options: {
  testCase?: Parameters<typeof startRun>[0]['testCase']
  script?: Parameters<typeof startRun>[0]['script']
  useAgent?: boolean
}): Promise<PanelResponse> {
  const controller = new AbortController()
  const shared = makeObserver()
  try {
    // Not awaited to completion: a run takes minutes and the panel needs its id
    // now so it can show progress. Errors surface as run status, not as a
    // rejected message.
    const promise = startRun({
      ...(options.testCase ? { testCase: options.testCase } : {}),
      ...(options.script ? { script: options.script } : {}),
      trigger: 'manual',
      ...(options.useAgent ? { useAgent: true } : {}),
      signal: controller.signal,
      observer: {
        ...shared,
        onRun: (run) => {
          // Registered here because this is the earliest moment the run has an id.
          // A user can press Cancel a second after starting, and an unregistered
          // controller is exactly the "cancel does nothing" complaint.
          active.set(run.id, controller)
          shared.onRun?.(run)
        },
      },
    })

    promise
      .then(async ({ run }) => {
        active.delete(run.id)
        await notifyIfNeeded(run)
        broadcast({ type: 'stateChanged' })
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        await appendLog({ level: 'error', source: 'run', message })
        broadcast({ type: 'stateChanged' })
      })

    // Give the run a moment to register so the panel gets a real run object.
    const settled = await Promise.race([
      promise.then(({ run }) => run),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), 400)
      }),
    ])
    if (settled) return { ok: true, run: settled }

    const runs = await getRuns()
    const latest = runs[0]
    return latest ? { ok: true, run: latest } : { ok: true, message: '运行已启动。' }
  } catch (error) {
    if (error instanceof StartError) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Assembles everything the panel renders, in one read. */
async function buildState(): Promise<PanelState> {
  const [cases, scripts, runs, schedules, settings, secrets, logs, skills] = await Promise.all([
    getCases(),
    getScripts(),
    getRuns(),
    getSchedules(),
    getSettings(),
    getSecrets(),
    getLogs(),
    getSkills(),
  ])

  let bridge = { connected: false, url: settings.bridge.url }
  if (settings.bridge.enabled) {
    try {
      const { status } = await import('./bridge')
      bridge = status()
    } catch {
      /* the bridge module failed to load; report disconnected */
    }
  }

  return {
    cases,
    scripts,
    runs,
    schedules,
    settings,
    // Names only: a secret value must never reach the panel, where it would sit
    // in a renderer process and in React DevTools.
    secretNames: secrets.map((secret) => secret.name),
    skills,
    logs,
    bridge,
    activeRunIds: [...active.keys()],
    conversationActive: conversation.running,
  }
}

// Keep the scheduler installed even if a previous incarnation never got the
// chance; `installScheduler` is idempotent.
void installScheduler()
// Restore any in-progress conversation so a remounted panel or restarted worker
// keeps the transcript rather than starting blank.
void restoreConversation()

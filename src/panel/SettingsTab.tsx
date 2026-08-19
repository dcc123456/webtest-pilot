/**
 * Settings: everything that governs how runs execute.
 *
 * Two rules shape this file more than layout does.
 *
 * **The allow-list section is a safety UI, not a preferences UI.** It is the only
 * boundary between an LLM and every page the user has open, so it explains itself
 * in place, validates with the same `validatePattern` the runner enforces, and
 * offers `suggestPatternForUrl` seeded from the active tab so the safe path is
 * also the easy one. There is no "allow everything" affordance, because the
 * validator refuses one.
 *
 * **Secret values are write-only from here.** `PanelState` carries `secretNames`
 * and nothing else, by design: a value that reached this renderer would sit in a
 * React tree, in DevTools, and in any heap snapshot taken of the panel. So this
 * tab can add a secret and delete one by name, and can never read one back.
 *
 * @module panel/SettingsTab
 */

import { useCallback, useEffect, useId, useState } from 'react'
import { formatBytes } from '../lib/artifacts'
import { is } from '../lib/messages'
import {
  PROVIDER_PRESETS,
  findPreset,
  normalizeBaseUrl,
  profileFromPreset,
  validateProfile,
  type ProviderProfile,
} from '../lib/providers'
import { suggestPatternForUrl, validatePattern } from '../lib/urlmatch'
import type { FeishuConfig, NotifyPolicy, RunPolicy } from '../lib/types'
import {
  Badge,
  Button,
  ConfirmAction,
  CopyButton,
  Empty,
  Field,
  Notice,
  Section,
  Toggle,
  Truncated,
  downloadText,
  shortTime,
  usePending,
  useToast,
} from './components'
import type { WorkerApi } from './useWorker'

type SectionKey = 'provider' | 'sites' | 'policy' | 'secrets' | 'feishu' | 'bridge' | 'data'

export function SettingsTab({
  worker,
  highlightSites,
  onHighlightHandled,
}: {
  worker: WorkerApi
  /** Set when another tab linked here for the allow-list; opens that section. */
  highlightSites: boolean
  onHighlightHandled: () => void
}) {
  // Provider and sites start open because they are the two things that must be
  // configured before anything works at all; the rest are collapsed so the tab
  // is scannable at 400px.
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    provider: true,
    sites: true,
    policy: false,
    secrets: false,
    feishu: false,
    bridge: false,
    data: false,
  })

  useEffect(() => {
    if (!highlightSites) return
    setOpen((current) => ({ ...current, sites: true }))
    onHighlightHandled()
  }, [highlightSites, onHighlightHandled])

  const toggle = useCallback((key: SectionKey, next: boolean) => {
    setOpen((current) => ({ ...current, [key]: next }))
  }, [])

  const { state } = worker

  return (
    <div className='stack'>
      <Section
        title='模型（provider）'
        subtitle={
          state.settings.activeProviderId
            ? `已配置 ${state.settings.providers.length} 个，1 个启用中`
            : '尚未配置，智能体运行不可用'
        }
        open={open.provider}
        onToggle={(next) => toggle('provider', next)}
      >
        <ProviderSection worker={worker} />
      </Section>

      <Section
        title='站点白名单（allowed sites）'
        subtitle={
          state.settings.policy.allowedSites.length === 0
            ? '为空 —— 所有运行都会被拒绝'
            : `${state.settings.policy.allowedSites.length} 条规则`
        }
        open={open.sites}
        onToggle={(next) => toggle('sites', next)}
      >
        <SitesSection worker={worker} />
      </Section>

      <Section
        title='运行策略'
        subtitle='超时、独立窗口、工具调用轮数、截图'
        open={open.policy}
        onToggle={(next) => toggle('policy', next)}
      >
        <PolicySection worker={worker} />
      </Section>

      <Section
        title='密钥（secrets）'
        subtitle={`${state.secretNames.length} 个，面板只能看到名称`}
        open={open.secrets}
        onToggle={(next) => toggle('secrets', next)}
      >
        <SecretsSection worker={worker} />
      </Section>

      <Section
        title='飞书通知'
        subtitle={state.settings.feishu.webhookUrl ? '已配置 webhook' : '未配置'}
        open={open.feishu}
        onToggle={(next) => toggle('feishu', next)}
      >
        <FeishuSection worker={worker} />
      </Section>

      <Section
        title='本地接口（bridge）'
        subtitle={
          state.settings.bridge.enabled
            ? state.bridge.connected
              ? '已连接'
              : '已启用但未连接'
            : '未启用'
        }
        open={open.bridge}
        onToggle={(next) => toggle('bridge', next)}
      >
        <BridgeSection worker={worker} />
      </Section>

      <Section
        title='数据'
        subtitle='导入导出、存储占用、日志'
        open={open.data}
        onToggle={(next) => toggle('data', next)}
      >
        <DataSection worker={worker} />
      </Section>
    </div>
  )
}

// --- 1. Provider ------------------------------------------------------------

function ProviderSection({ worker }: { worker: WorkerApi }) {
  const { state, call } = worker
  const settings = state.settings
  const [draft, setDraft] = useState<ProviderProfile | null>(null)
  const [models, setModels] = useState<string[]>([])
  const modelListId = useId()
  const save = usePending()
  const test = usePending()
  const fetchModels = usePending()
  const toast = useToast()

  const active = settings.providers.find((profile) => profile.id === settings.activeProviderId)
  const editing = draft
  const problems = editing ? validateProfile(editing) : []
  const problemFor = (field: 'label' | 'baseUrl' | 'apiKey' | 'model'): string | undefined =>
    problems.find((problem) => problem.field === field)?.message

  const persist = async (profiles: ProviderProfile[], activeId: string): Promise<void> => {
    await call({ type: 'saveSettings', patch: { providers: profiles, activeProviderId: activeId } })
  }

  const hint = editing ? findPreset(editing.presetId)?.hint : undefined

  return (
    <>
      {settings.providers.length === 0 ? (
        <Notice kind='info'>
          智能体运行（agent）需要一个 OpenAI 兼容的 chat-completions 接口，并且模型必须支持
          工具调用（function calling）—— 页面上的每一个动作都是一次工具调用。
        </Notice>
      ) : null}

      <div className='list'>
        {settings.providers.map((profile) => {
          const isActive = profile.id === settings.activeProviderId
          return (
            <div
              className={isActive ? 'list__item list__item--active' : 'list__item'}
              key={profile.id}
            >
              <span className='list__text'>
                <Truncated text={profile.label} />
                <Truncated text={profile.model} className='faint small' mono />
              </span>
              {isActive ? <Badge tone='info'>启用中</Badge> : null}
              {!isActive ? (
                <Button
                  small
                  onClick={() => void save.run(() => persist(settings.providers, profile.id))}
                >
                  设为启用
                </Button>
              ) : null}
              <Button variant='ghost' small onClick={() => setDraft({ ...profile })}>
                编辑
              </Button>
              <ConfirmAction
                label='删除'
                question={`删除模型配置「${profile.label}」？其中的 API key 也会一并删除。`}
                onConfirm={async () => {
                  const remaining = settings.providers.filter((entry) => entry.id !== profile.id)
                  // Deleting the active profile must promote another one, or the
                  // extension is left configured-but-unusable with no hint why.
                  const nextActive =
                    settings.activeProviderId === profile.id
                      ? (remaining[0]?.id ?? '')
                      : settings.activeProviderId
                  await persist(remaining, nextActive)
                  if (draft?.id === profile.id) setDraft(null)
                }}
              />
            </div>
          )
        })}
      </div>

      {editing === null ? (
        <Field label='添加一个模型配置' hint='选择预设会自动填好 base URL 与建议模型。'>
          <select
            value=''
            onChange={(event) => {
              const preset = findPreset(event.target.value)
              if (!preset) return
              setDraft(
                profileFromPreset(
                  preset,
                  `prv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                ),
              )
              setModels([])
            }}
          >
            <option value=''>选择服务商（provider）…</option>
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <div className='card'>
          <span className='field__label'>
            {settings.providers.some((profile) => profile.id === editing.id) ? '编辑配置' : '新配置'}
          </span>

          {hint ? <span className='faint small wrap-any'>{hint}</span> : null}

          <Field label='名称' error={problemFor('label')}>
            <input
              type='text'
              value={editing.label}
              onChange={(event) => setDraft({ ...editing, label: event.target.value })}
            />
          </Field>

          <Field
            label='Base URL'
            hint='填到 /chat/completions 之前的部分；粘贴了完整地址也会自动修正。'
            error={problemFor('baseUrl')}
          >
            <input
              type='url'
              value={editing.baseUrl}
              onChange={(event) => setDraft({ ...editing, baseUrl: event.target.value })}
              onBlur={() => setDraft({ ...editing, baseUrl: normalizeBaseUrl(editing.baseUrl) })}
            />
          </Field>

          <Field
            label='API key'
            hint='只保存在本机的扩展存储里，导出数据时不会包含。'
            error={problemFor('apiKey')}
          >
            <input
              type='password'
              autoComplete='off'
              value={editing.apiKey}
              onChange={(event) => setDraft({ ...editing, apiKey: event.target.value })}
            />
          </Field>

          <Field
            label='模型（model）'
            hint='火山方舟也可以填专属推理接入点 ID（ep-…）。'
            error={problemFor('model')}
          >
            <input
              type='text'
              list={modelListId}
              value={editing.model}
              onChange={(event) => setDraft({ ...editing, model: event.target.value })}
            />
          </Field>
          <datalist id={modelListId}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>

          <Toggle
            label='该模型支持图片输入（vision）'
            hint='开启后会把页面截图交给模型。这里是手动开关而不是自动探测：给纯文本模型发图片只会返回一个看起来像请求格式错误的 400，各家也没有统一的能力查询接口。'
            checked={editing.supportsVision === true}
            onChange={(value) => setDraft({ ...editing, supportsVision: value })}
          />

          <div className='row row--wrap' style={{ marginTop: 6 }}>
            <Button
              variant='primary'
              small
              pending={save.pending}
              disabled={problems.length > 0}
              onClick={() =>
                void save.run(async () => {
                  const index = settings.providers.findIndex((profile) => profile.id === editing.id)
                  const normalized: ProviderProfile = {
                    ...editing,
                    baseUrl: normalizeBaseUrl(editing.baseUrl),
                  }
                  const profiles =
                    index >= 0
                      ? settings.providers.with(index, normalized)
                      : [...settings.providers, normalized]
                  // The first profile saved becomes active automatically: saving a
                  // provider and still having "no model configured" reads as a bug.
                  const activeId = settings.activeProviderId || normalized.id
                  await persist(profiles, activeId)
                  setDraft(null)
                })
              }
            >
              保存
            </Button>
            <Button
              small
              pending={test.pending}
              disabled={problems.length > 0}
              onClick={() =>
                void test.run(async () => {
                  const response = await call({ type: 'testProvider', profile: editing })
                  toast.success(is.message(response) ? response.message : '连接成功。')
                })
              }
            >
              测试连接
            </Button>
            <Button
              small
              pending={fetchModels.pending}
              // The model field may still be empty here: fetching the list is
              // exactly how a user finds out what to put in it.
              disabled={problems.some((problem) => problem.field !== 'model')}
              onClick={() =>
                void fetchModels.run(async () => {
                  const response = await call({ type: 'listModels', profile: editing })
                  if (!is.models(response)) throw new Error('后台没有返回模型列表。')
                  setModels(response.models)
                  toast.info(`获取到 ${response.models.length} 个模型，已填入输入框的候选列表。`)
                })
              }
            >
              获取模型列表
            </Button>
            <Button variant='ghost' small onClick={() => setDraft(null)}>
              取消
            </Button>
          </div>
        </div>
      )}

      {active && editing === null ? (
        <span className='faint small'>
          当前启用：{active.label} · <span className='mono'>{active.model}</span>
        </span>
      ) : null}
    </>
  )
}

// --- 2. Allowed sites -------------------------------------------------------

function SitesSection({ worker }: { worker: WorkerApi }) {
  const { state, call } = worker
  const patterns = state.settings.policy.allowedSites
  const [input, setInput] = useState('')
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const add = usePending()

  // Read once on mount: the active tab is the site the user is looking at right
  // now, which is almost always the one they came here to allow.
  useEffect(() => {
    let cancelled = false
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (cancelled) return
        const url = tabs[0]?.url
        setSuggestion(url ? suggestPatternForUrl(url) : null)
      })
      .catch(() => {
        // No window, or a restricted page: the manual field still works, so this
        // does not deserve an error message.
        if (!cancelled) setSuggestion(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const problem = input.trim().length > 0 ? validatePattern(input) : null
  const duplicate = patterns.includes(input.trim())

  const savePatterns = async (next: string[]): Promise<void> => {
    await call({
      type: 'saveSettings',
      patch: { policy: { ...state.settings.policy, allowedSites: next } },
    })
  }

  return (
    <>
      <span className='faint small'>
        这是本插件唯一的安全边界：只有匹配这里某一条规则的页面才能被自动化操作，其余页面上的每一步都会硬失败。
        逐步弹窗确认对测试来说不可行（一百步就是一百次确认），所以授权按站点一次性给出。
      </span>

      {patterns.length === 0 ? (
        <Notice kind='warn' title='为空表示禁止一切'>
          默认不提供「允许所有站点」：安装一个插件不应该等于悄悄把用户所有打开的页面（包括网银）交给一个大模型。
        </Notice>
      ) : null}

      <div className='list'>
        {patterns.map((pattern) => {
          const invalid = validatePattern(pattern)
          return (
            <div className='list__item' key={pattern}>
              <span className='list__text'>
                <Truncated text={pattern} mono />
                {invalid ? <span className='field__error'>{invalid.message}</span> : null}
              </span>
              <ConfirmAction
                label='移除'
                question={`移除规则 ${pattern}？之后针对这个站点的运行都会被拒绝。`}
                confirmLabel='确认移除'
                onConfirm={async () => {
                  await savePatterns(patterns.filter((entry) => entry !== pattern))
                }}
              />
            </div>
          )
        })}
      </div>

      {suggestion !== null && !patterns.includes(suggestion) ? (
        <div className='row'>
          <span className='list__text'>
            <span className='faint small'>当前标签页所在站点</span>
            <Truncated text={suggestion} mono />
          </span>
          <Button
            small
            pending={add.pending}
            onClick={() => void add.run(() => savePatterns([...patterns, suggestion]))}
          >
            添加
          </Button>
        </div>
      ) : null}

      <Field
        label='手动添加规则（glob pattern）'
        hint='形如 https://staging.example.com/*。*.example.com 只匹配子域，不含主域本身；写了端口时端口也必须一致。'
        error={problem?.message ?? (duplicate ? '这条规则已经存在。' : undefined)}
      >
        <input
          type='text'
          className='mono'
          value={input}
          placeholder='https://staging.example.com/*'
          onChange={(event) => setInput(event.target.value)}
        />
      </Field>
      <Button
        small
        pending={add.pending}
        disabled={input.trim().length === 0 || problem !== null || duplicate}
        onClick={() =>
          void add.run(async () => {
            await savePatterns([...patterns, input.trim()])
            setInput('')
          })
        }
      >
        添加规则
      </Button>
    </>
  )
}

// --- 3. Run policy ----------------------------------------------------------

function PolicySection({ worker }: { worker: WorkerApi }) {
  const { state, call } = worker
  const policy = state.settings.policy
  const { run } = usePending()

  const patch = (next: Partial<RunPolicy>): void => {
    void run(async () => {
      await call({ type: 'saveSettings', patch: { policy: { ...policy, ...next } } })
    })
  }

  return (
    <>
      <Toggle
        label='手动运行时打开独立窗口'
        hint='默认关闭：直接在你当前的标签页上测试，保留已登录的会话。开启后每次手动运行会新开一个窗口（会从空白页开始，登录态不会带过去）。定时任务和本地接口触发的运行始终使用独立窗口，不受此开关影响。'
        checked={policy.useDedicatedWindow}
        onChange={(value) => patch({ useDedicatedWindow: value })}
      />

      {/* Numeric inputs commit on blur, not on change: saving per keystroke would
          send a settings write for every digit typed, and a half-typed "1" would
          briefly become a 1ms timeout. */}
      <Field label='单步超时（毫秒）' hint='等待元素出现、可点击的时间上限。失焦后保存。'>
        <input
          type='number'
          min={1000}
          step={500}
          defaultValue={policy.stepTimeoutMs}
          onBlur={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value) && value >= 1000) patch({ stepTimeoutMs: value })
          }}
        />
      </Field>

      <Field label='整次运行超时（毫秒）' hint='总时间预算，超出后运行会被记为出错（error）。'>
        <input
          type='number'
          min={10000}
          step={10000}
          defaultValue={policy.runTimeoutMs}
          onBlur={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value) && value >= 10000) patch({ runTimeoutMs: value })
          }}
        />
      </Field>

      <Field
        label='最大工具调用轮数（max tool rounds）'
        hint='一次智能体运行里模型最多来回多少轮，防止模型绕圈时烧掉大量 token。'
      >
        <input
          type='number'
          min={1}
          max={200}
          defaultValue={policy.maxToolRounds}
          onBlur={(event) => {
            const value = Number(event.target.value)
            if (Number.isInteger(value) && value >= 1) patch({ maxToolRounds: value })
          }}
        />
      </Field>

      <Toggle
        label='自动保存脚本（auto-save script）'
        hint='智能体运行通过后自动录制成可回放脚本，下次就不必再调用模型。'
        checked={policy.autoSaveScript}
        onChange={(value) => patch({ autoSaveScript: value })}
      />

      <Toggle
        label='每一步都截图'
        hint='不开启时只在失败处截图。开启后证据更完整，但存储占用明显增加。'
        checked={policy.screenshotEveryStep}
        onChange={(value) => patch({ screenshotEveryStep: value })}
      />

      <Toggle
        label='自愈（self-heal）· 实验性，默认关闭'
        hint='所有选择器（selector）都失效时，允许模型重新定位元素。风险很实在：会自己改选择器的运行可能对着错误的元素报「通过」，所以修复只作为建议保存，需要人工确认。'
        checked={policy.selfHeal}
        onChange={(value) => patch({ selfHeal: value })}
      />
      {policy.selfHeal ? (
        <Notice kind='warn'>
          自愈已开启。请把回放结果当作需要复核的对象：新提出的选择器会标记为「待确认」，不会自动生效。
        </Notice>
      ) : null}
    </>
  )
}

// --- 4. Secrets -------------------------------------------------------------

function SecretsSection({ worker }: { worker: WorkerApi }) {
  const { state, call } = worker
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const add = usePending()
  const toast = useToast()

  const duplicate = state.secretNames.includes(name.trim())

  return (
    <>
      <span className='faint small'>
        测试用例只按名称引用密钥，真实值由后台在注入页面前替换。所以密码不会出现在用例、脚本、导出文件，
        也不会出现在发给模型的内容里。
      </span>
      {/* Only names are listed because only names exist here: `PanelState` carries
          `secretNames` and never the values, deliberately — a value that reached
          the renderer would live in the React tree, in DevTools, and in any heap
          snapshot of the panel. */}
      <span className='faint small'>
        面板永远只能看到名称：值一旦进入渲染进程就会留在组件树和开发者工具里，因此后台从不把它发过来。
        忘记了只能覆盖重填，无法查看。
      </span>

      {state.secretNames.length === 0 ? (
        <Empty
          title='还没有密钥'
          hint='例如添加一个名为 STAGING_PASSWORD 的密钥，然后在步骤里写「输入密码 STAGING_PASSWORD」。'
        />
      ) : (
        <div className='list'>
          {state.secretNames.map((secretName) => (
            <div className='list__item' key={secretName}>
              <span className='list__text'>
                <Truncated text={secretName} mono />
                <span className='faint small'>值已保存，不可查看</span>
              </span>
              <ConfirmAction
                label='删除'
                question={`删除密钥「${secretName}」？引用它的步骤会在运行时失败，需要重新填写。`}
                onConfirm={async () => {
                  await call({ type: 'deleteSecret', name: secretName })
                }}
              />
            </div>
          ))}
        </div>
      )}

      <Field label='名称' hint='建议用大写加下划线，例如 STAGING_PASSWORD。'>
        <input
          type='text'
          className='mono'
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field label='值' error={duplicate ? '同名密钥已存在，保存会覆盖旧值。' : undefined}>
        <input
          type='password'
          autoComplete='off'
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>

      <Button
        small
        pending={add.pending}
        disabled={name.trim().length === 0 || value.length === 0}
        onClick={() =>
          void add.run(async () => {
            await call({ type: 'saveSecret', entry: { name: name.trim(), value } })
            setName('')
            // Cleared right away so the value does not linger in component state
            // any longer than the request needed it.
            setValue('')
            toast.success('密钥已保存。')
          })
        }
      >
        保存密钥
      </Button>
    </>
  )
}

// --- 5. Feishu --------------------------------------------------------------

function FeishuSection({ worker }: { worker: WorkerApi }) {
  const { state, call } = worker
  const feishu = state.settings.feishu
  const [webhookUrl, setWebhookUrl] = useState(feishu.webhookUrl)
  const [secret, setSecret] = useState(feishu.secret ?? '')
  const [mention, setMention] = useState(feishu.mentionOnFailure ?? '')
  const save = usePending()
  const test = usePending()
  const toast = useToast()

  const patch = async (next: Partial<FeishuConfig>): Promise<void> => {
    await call({ type: 'saveSettings', patch: { feishu: { ...feishu, ...next } } })
  }

  return (
    <>
      <span className='faint small'>
        用飞书群自定义机器人（custom robot）的 webhook 推送运行结果。无人值守的运行失败时，
        这通常是唯一会被看到的通知。
      </span>

      <Field label='Webhook URL' hint='在飞书群 → 设置 → 群机器人 → 自定义机器人里获取。'>
        <input
          type='url'
          value={webhookUrl}
          placeholder='https://open.feishu.cn/open-apis/bot/v2/hook/…'
          onChange={(event) => setWebhookUrl(event.target.value)}
        />
      </Field>

      <Field label='签名密钥（signing secret，可选）' hint='仅当机器人开启了签名校验时才需要填写。'>
        <input
          type='password'
          autoComplete='off'
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
      </Field>

      <Field label='消息格式'>
        <select
          value={feishu.format}
          onChange={(event) =>
            void save.run(() =>
              patch({ format: event.target.value === 'text' ? 'text' : 'card' }),
            )
          }
        >
          <option value='card'>卡片（card，信息更丰富）</option>
          <option value='text'>纯文本（部分企业禁用了交互卡片）</option>
        </select>
      </Field>

      <Field label='通知策略（notify policy）'>
        <select
          value={feishu.notify}
          onChange={(event) => {
            const raw = event.target.value
            const next: NotifyPolicy = raw === 'always' || raw === 'never' ? raw : 'failure'
            void save.run(() => patch({ notify: next }))
          }}
        >
          <option value='failure'>仅失败时通知（推荐）</option>
          <option value='always'>每次都通知</option>
          <option value='never'>不通知</option>
        </select>
      </Field>

      <Field
        label='失败时 @ 谁（mention on failure，可选）'
        hint='填 all 表示 @所有人，也可以填 open_id。只会附加在失败通知里。'
      >
        <input
          type='text'
          value={mention}
          placeholder='all'
          onChange={(event) => setMention(event.target.value)}
        />
      </Field>

      <div className='row row--wrap'>
        <Button
          variant='primary'
          small
          pending={save.pending}
          onClick={() =>
            void save.run(async () => {
              await patch({
                webhookUrl: webhookUrl.trim(),
                secret: secret.trim(),
                mentionOnFailure: mention.trim(),
              })
              toast.success('飞书配置已保存。')
            })
          }
        >
          保存
        </Button>
        <Button
          small
          pending={test.pending}
          disabled={webhookUrl.trim().length === 0}
          onClick={() =>
            void test.run(async () => {
              const response = await call({ type: 'testFeishu' })
              toast.success(is.message(response) ? response.message : '测试消息已发送。')
            })
          }
        >
          发送测试消息
        </Button>
      </div>
      {/* `testFeishu` takes no arguments — it reads the stored config — so an
          unsaved edit would be tested against the old webhook. */}
      <span className='faint small'>「发送测试消息」用的是已保存的配置，请先保存再测试。</span>
    </>
  )
}

// --- 6. Bridge --------------------------------------------------------------

/** The command that starts the local bridge. Shown verbatim so it can be copied. */
const BRIDGE_COMMAND = 'npx webtest-pilot serve'

function BridgeSection({ worker }: { worker: WorkerApi }) {
  const { state, call } = worker
  const bridge = state.settings.bridge
  const [url, setUrl] = useState(bridge.url)
  const [token, setToken] = useState(bridge.token)
  const save = usePending()
  const connect = usePending()
  const toast = useToast()

  return (
    <>
      <span className='faint small'>
        本地接口让 CI 或命令行触发运行并取回结果。插件永远是 WebSocket 客户端 ——
        扩展不能监听端口，本地服务也伸不进浏览器，所以只有这一个方向可行。
      </span>

      <div className='row row--wrap'>
        {state.bridge.connected ? (
          <Badge tone='ok'>已连接</Badge>
        ) : bridge.enabled ? (
          <Badge tone='warn'>已启用，未连接</Badge>
        ) : (
          <Badge tone='neutral'>未启用</Badge>
        )}
        {state.bridge.url ? (
          <Truncated text={state.bridge.url} className='faint small' mono />
        ) : null}
      </div>
      {state.bridge.lastError ? (
        <span className='field__error'>{state.bridge.lastError}</span>
      ) : null}

      <div className='field'>
        <span className='field__label'>先在本机启动服务</span>
        <div className='row'>
          <span className='pre list__text'>{BRIDGE_COMMAND}</span>
          <CopyButton text={BRIDGE_COMMAND} label='复制命令' />
        </div>
        <span className='field__hint'>
          启动后会打印出 URL 与随机生成的 token，把它们填到下面。
        </span>
      </div>

      <Field label='WebSocket URL'>
        <input
          type='text'
          className='mono'
          value={url}
          placeholder='ws://127.0.0.1:8787/extension'
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>

      <Field label='Token' hint='必须与本地服务生成的 token 一致，否则连接会被拒绝。'>
        <input
          type='password'
          autoComplete='off'
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>

      <div className='row row--wrap'>
        <Button
          small
          pending={save.pending}
          onClick={() =>
            void save.run(async () => {
              await call({
                type: 'saveSettings',
                patch: { bridge: { ...bridge, url: url.trim(), token: token.trim() } },
              })
              toast.success('本地接口配置已保存。')
            })
          }
        >
          保存
        </Button>
        {bridge.enabled ? (
          <Button
            small
            pending={connect.pending}
            onClick={() =>
              void connect.run(async () => {
                await call({ type: 'disconnectBridge' })
                toast.info('已断开并停用本地接口。')
              })
            }
          >
            断开并停用
          </Button>
        ) : (
          <Button
            variant='primary'
            small
            pending={connect.pending}
            disabled={url.trim().length === 0}
            onClick={() =>
              void connect.run(async () => {
                const response = await call({ type: 'connectBridge' })
                toast.info(is.message(response) ? response.message : '正在连接本地服务…')
              })
            }
          >
            启用并连接
          </Button>
        )}
      </div>
    </>
  )
}

// --- 7. Data ----------------------------------------------------------------

function DataSection({ worker }: { worker: WorkerApi }) {
  const { state, call } = worker
  const [usage, setUsage] = useState<
    { storageBytes: number; artifactBytes: number; artifactCount: number } | null
  >(null)
  const [importText, setImportText] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const measure = usePending()
  const exportRun = usePending()
  const importRun = usePending()
  const toast = useToast()

  const refreshUsage = useCallback(async () => {
    const response = await call({ type: 'getStorageUsage' })
    if (is.usage(response)) setUsage(response.usage)
  }, [call])

  return (
    <>
      <div className='field'>
        <span className='field__label'>导出 / 导入</span>
        <span className='field__hint'>
          导出内容不包含 API key 与密钥值；导入的定时任务一律为停用状态，
          避免刚导入就在一个陌生环境里自动跑起来。
        </span>
        <Button
          small
          pending={exportRun.pending}
          onClick={() =>
            void exportRun.run(async () => {
              const response = await call({ type: 'exportAll' })
              if (!is.text(response)) throw new Error('后台没有返回导出内容。')
              downloadText(
                `webtest-pilot-${new Date().toISOString().slice(0, 10)}.json`,
                response.text,
                'application/json',
              )
              toast.success('已导出为 JSON 文件。')
            })
          }
        >
          导出全部数据
        </Button>
      </div>

      <Field label='粘贴导出过的 JSON 以导入'>
        <textarea
          className='mono'
          rows={3}
          value={importText}
          placeholder='{ "cases": [...], "scripts": [...] }'
          onChange={(event) => setImportText(event.target.value)}
        />
      </Field>
      <Button
        small
        pending={importRun.pending}
        disabled={importText.trim().length === 0}
        onClick={() =>
          void importRun.run(async () => {
            const response = await call({ type: 'importAll', json: importText })
            toast.success(is.message(response) ? response.message : '导入完成。')
            setImportText('')
          })
        }
      >
        导入
      </Button>

      <hr className='divider' />

      <div className='field'>
        <span className='field__label'>存储占用</span>
        {usage ? (
          <span className='dim small'>
            配置与历史 {formatBytes(usage.storageBytes)} · 截图 {formatBytes(usage.artifactBytes)}（
            {usage.artifactCount} 张）
          </span>
        ) : (
          <span className='faint small'>点击下面的按钮读取。</span>
        )}
        <Button small pending={measure.pending} onClick={() => void measure.run(refreshUsage)}>
          {usage ? '重新统计' : '统计存储占用'}
        </Button>
        <span className='field__hint'>
          截图存在 IndexedDB 里并有总量预算，超出后会从最旧的开始清理。
        </span>
      </div>

      <hr className='divider' />

      <div className='field'>
        <div className='row'>
          <span className='field__label'>最近日志（{state.logs.length}）</span>
          <span className='spacer' />
          <Button variant='ghost' small onClick={() => setShowLogs((current) => !current)}>
            {showLogs ? '收起' : '展开'}
          </Button>
        </div>
        {showLogs ? (
          state.logs.length === 0 ? (
            <span className='faint small'>暂无日志。</span>
          ) : (
            <div>
              {[...state.logs]
                .sort((a, b) => b.at - a.at)
                .map((entry, index) => (
                  // Logs are a ring buffer with no ids and duplicate lines are
                  // normal, so position in this sorted view is the only identity.
                  <div className={`log log--${entry.level}`} key={`${entry.at}-${index}`}>
                    <span className='log__at' title={new Date(entry.at).toLocaleString()}>
                      {shortTime(entry.at)}
                    </span>
                    <span className='log__msg'>
                      <span className='faint'>[{entry.source}]</span> {entry.message}
                    </span>
                  </div>
                ))}
            </div>
          )
        ) : null}
        <ConfirmAction
          label='清空日志'
          question={`清空全部 ${state.logs.length} 条日志？定时任务与本地接口的失败原因也会一起消失。`}
          confirmLabel='确认清空'
          disabled={state.logs.length === 0}
          onConfirm={async () => {
            await call({ type: 'clearLogs' })
          }}
        />
      </div>
    </>
  )
}

/**
 * Shared presentational pieces for the side panel.
 *
 * These exist to make three project-wide rules impossible to forget rather than
 * merely documented:
 *
 * - **Destructive actions never fire on one click.** {@link ConfirmAction} owns
 *   an inline two-step flow, so no tab has to reinvent it and none can fall back
 *   to a bare `confirm()` — which in a side panel is a modal the user cannot
 *   place in context and, on some platforms, cannot see at all.
 * - **Nothing swallows an error.** {@link Button} takes a `pending` flag and the
 *   toast API always has an `error` channel, so a failed `{ok:false,error}` has an
 *   obvious place to land.
 * - **Unbounded strings are clipped, not wrapped.** The panel is ~400px wide and
 *   must never scroll sideways, so URLs and selectors go through
 *   {@link Truncated}, which pairs the ellipsis with a `title` tooltip.
 *
 * @module panel/components
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import type { RunStatus } from '../lib/types'

// --- Buttons ----------------------------------------------------------------

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  small?: boolean
  block?: boolean
  /**
   * Shows a spinner and blocks further clicks.
   *
   * Separate from `disabled` so a caller can express "busy" without losing the
   * distinction from "not allowed yet", which reads very differently to a user
   * staring at a button that does nothing.
   */
  pending?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'default',
  small = false,
  block = false,
  pending = false,
  disabled = false,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn']
  if (variant !== 'default') classes.push(`btn--${variant}`)
  if (small) classes.push('btn--sm')
  if (block) classes.push('btn--block')
  return (
    <button
      {...rest}
      type={type}
      className={classes.join(' ')}
      disabled={disabled || pending}
      aria-busy={pending}
    >
      {pending ? <span className='spinner' aria-hidden='true' /> : null}
      {children}
    </button>
  )
}

// --- Text ------------------------------------------------------------------

/** One-line text clipped with an ellipsis, full value in the tooltip. */
export function Truncated({
  text,
  className,
  mono = false,
}: {
  text: string
  className?: string
  mono?: boolean
}) {
  const classes = ['ellipsis']
  if (mono) classes.push('mono')
  if (className) classes.push(className)
  return (
    <span className={classes.join(' ')} title={text}>
      {text}
    </span>
  )
}

// --- Fields ----------------------------------------------------------------

export interface FieldProps {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}

/**
 * Label + hint + error wrapper.
 *
 * The control is nested *inside* the `<label>` rather than linked by id. Implicit
 * association needs no generated id to plumb through, and an id that drifts from
 * its `htmlFor` is a broken label an automated check will not notice but a
 * screen-reader user will hit immediately.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label className='field'>
      <span className='field__label'>{label}</span>
      {children}
      {hint ? <span className='field__hint'>{hint}</span> : null}
      {error ? <span className='field__error'>{error}</span> : null}
    </label>
  )
}

/** A checkbox with a bold label and an optional explanatory line. */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: ReactNode
  hint?: ReactNode
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className='toggle'>
      <input
        type='checkbox'
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className='list__text'>
        <span className='toggle__label'>{label}</span>
        {hint ? <span className='toggle__hint'>{hint}</span> : null}
      </span>
    </label>
  )
}

// --- Status ----------------------------------------------------------------

/**
 * Run status, colour-coded.
 *
 * `failed` and `error` are given different words *and* different hues on
 * purpose. The backend keeps them distinct because they mean opposite things to
 * whoever reads the report: `failed` is a finding about the application under
 * test, `error` is a problem with this tool's setup. Rendering both as a red
 * "failed" pill would send a team hunting for a bug that does not exist.
 */
const STATUS_META: Record<RunStatus, { label: string; tone: string; title: string }> = {
  queued: { label: '排队中', tone: 'neutral', title: '已创建，等待开始执行' },
  running: { label: '运行中', tone: 'info', title: '正在执行' },
  passed: { label: '通过（passed）', tone: 'ok', title: '所有步骤与预期都满足' },
  failed: {
    label: '未达预期（failed）',
    tone: 'fail',
    title: '被测应用没有满足预期，这是一个真实的测试发现，需要排查被测系统',
  },
  error: {
    label: '执行出错（error）',
    tone: 'err',
    title: '本工具没能完成这次尝试（模型不可达、标签页丢失、站点白名单未配置等），需要检查运行环境而不是被测应用',
  },
  cancelled: { label: '已取消', tone: 'neutral', title: '被手动取消' },
  interrupted: {
    label: '被中断（interrupted）',
    tone: 'warn',
    title: '后台在运行结束前停止了（Service Worker 被回收或浏览器关闭）',
  },
}

export function StatusBadge({ status, dot = true }: { status: RunStatus; dot?: boolean }) {
  const meta = STATUS_META[status]
  const classes = ['badge', `badge--${meta.tone}`]
  if (dot) classes.push('badge--dot')
  return (
    <span className={classes.join(' ')} title={meta.title}>
      {meta.label}
    </span>
  )
}

/** Human wording for a status, for prose that cannot host a badge. */
export function statusLabel(status: RunStatus): string {
  return STATUS_META[status].label
}

export function Badge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'ok' | 'fail' | 'err' | 'warn' | 'info' | 'neutral'
  title?: string
  children: ReactNode
}) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  )
}

// --- Notices and empty states ----------------------------------------------

export function Notice({
  kind = 'info',
  title,
  children,
}: {
  kind?: 'info' | 'warn' | 'error'
  title?: string
  children?: ReactNode
}) {
  return (
    <div className={`notice notice--${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {title ? <span className='notice__title'>{title}</span> : null}
      {children}
    </div>
  )
}

/**
 * Empty state.
 *
 * Always carries a hint saying what to do next: an empty list with no guidance
 * is the point where a new user decides the extension is broken.
 */
export function Empty({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className='empty'>
      <span className='empty__title'>{title}</span>
      {hint ? <span className='empty__hint'>{hint}</span> : null}
      {action}
    </div>
  )
}

// --- Collapsible -----------------------------------------------------------

/**
 * Disclosure row.
 *
 * Hand-rolled rather than `<details>` because several tabs need to run work when
 * a row opens — the Runs tab fetches screenshots only on expand — and
 * `<details>` gives no reliable pre-open hook.
 */
export function Collapsible({
  open,
  onToggle,
  summary,
  className,
  children,
}: {
  open: boolean
  onToggle: (next: boolean) => void
  summary: ReactNode
  className?: string
  children: ReactNode
}) {
  const classes = ['collapse']
  if (className) classes.push(className)
  return (
    <div className={classes.join(' ')}>
      <button className='collapse__head' onClick={() => onToggle(!open)} aria-expanded={open}>
        <span className='collapse__chevron' aria-hidden='true'>
          {open ? '▾' : '▸'}
        </span>
        <span className='collapse__summary'>{summary}</span>
      </button>
      {open ? <div className='collapse__body'>{children}</div> : null}
    </div>
  )
}

/** A titled settings section that remembers whether it is expanded. */
export function Section({
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  title: string
  subtitle?: string
  open: boolean
  onToggle: (next: boolean) => void
  children: ReactNode
}) {
  return (
    <section className='section'>
      <button className='section__head' onClick={() => onToggle(!open)} aria-expanded={open}>
        <span className='collapse__chevron' aria-hidden='true'>
          {open ? '▾' : '▸'}
        </span>
        <span className='list__text'>
          <span className='section__title'>{title}</span>
          {subtitle ? <span className='toggle__hint'>{subtitle}</span> : null}
        </span>
      </button>
      {open ? <div className='section__body'>{children}</div> : null}
    </section>
  )
}

// --- Confirmation ----------------------------------------------------------

export interface ConfirmActionProps {
  /** The button that arms the confirmation. */
  label: string
  /** What the user is agreeing to, stated in full — including what is lost. */
  question: string
  confirmLabel?: string
  /** Extra controls shown inside the armed panel, e.g. "also delete the script". */
  extra?: ReactNode
  /** Called when the confirmation panel opens or closes, so a caller can reset `extra` state. */
  onArmedChange?: (armed: boolean) => void
  onConfirm: () => Promise<void> | void
  disabled?: boolean
  block?: boolean
}

/**
 * Two-step destructive action.
 *
 * The confirmation is rendered inline, next to the thing being destroyed, so the
 * user can still see *which* row they are deleting while they decide — a native
 * `confirm()` covers exactly that context.
 */
export function ConfirmAction({
  label,
  question,
  confirmLabel = '确认删除',
  extra,
  onArmedChange,
  onConfirm,
  disabled = false,
  block = false,
}: ConfirmActionProps) {
  const [armed, setArmed] = useState(false)
  const [pending, setPending] = useState(false)

  const arm = (next: boolean): void => {
    setArmed(next)
    onArmedChange?.(next)
  }

  if (!armed) {
    return (
      <Button variant='danger' small block={block} disabled={disabled} onClick={() => arm(true)}>
        {label}
      </Button>
    )
  }

  return (
    <div className='confirm'>
      <span className='confirm__question'>{question}</span>
      {extra}
      <div className='row row--end'>
        <Button small disabled={pending} onClick={() => arm(false)}>
          取消
        </Button>
        <Button
          variant='danger'
          small
          pending={pending}
          onClick={async () => {
            setPending(true)
            try {
              await onConfirm()
              // Only close on success: a failure leaves the panel open so the
              // toast and the row it belongs to stay side by side.
              arm(false)
            } finally {
              setPending(false)
            }
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

// --- Modal -----------------------------------------------------------------

/**
 * Full-panel overlay.
 *
 * Not a centred dialog: at ~400px a floating card with margins leaves no usable
 * width for an editor, so an "overlay" here means "takes the whole panel".
 */
export function Modal({
  title,
  onClose,
  footer,
  children,
}: {
  title: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className='modal' role='dialog' aria-modal='true' aria-label={title}>
      <div className='modal__head'>
        <h2 className='modal__title'>{title}</h2>
        <span className='spacer' />
        <Button variant='ghost' small onClick={onClose} aria-label='关闭'>
          ✕
        </Button>
      </div>
      <div className='modal__body'>{children}</div>
      {footer ? <div className='modal__foot'>{footer}</div> : null}
    </div>
  )
}

// --- Toasts ----------------------------------------------------------------

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

export interface ToastApi {
  success: (text: string) => void
  info: (text: string) => void
  /** For an `{ok:false,error}` reply. Errors are never auto-dismissed. */
  error: (text: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** How long a non-error toast stays. Errors persist until dismissed. */
const TOAST_MS = 4000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current
      nextId.current += 1
      setItems((current) => [...current, { id, kind, text }])
      // An error stays until dismissed: the whole point of surfacing
      // `{ok:false,error}` is that the user can read it, and a four-second
      // window is not enough for a multi-line backend message.
      if (kind !== 'error') {
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          dismiss(id)
        }, TOAST_MS)
        timers.current.add(timer)
      }
    },
    [dismiss],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (text: string) => push('success', text),
      info: (text: string) => push('info', text),
      error: (text: string) => push('error', text),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className='toasts' aria-live='polite'>
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.kind}`}>
            <span className='toast__text'>{item.text}</span>
            <Button variant='ghost' small onClick={() => dismiss(item.id)} aria-label='关闭提示'>
              ✕
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast 必须在 ToastProvider 内使用。')
  return api
}

// --- Clipboard and downloads ----------------------------------------------

/**
 * Copies text, reporting both outcomes.
 *
 * The clipboard write can be refused when the panel is not focused, so the
 * failure path is a visible message rather than a silent no-op that leaves the
 * user pasting stale content.
 */
export function CopyButton({
  text,
  label = '复制',
  small = true,
  block = false,
}: {
  text: string
  label?: string
  small?: boolean
  block?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1800)
    return () => clearTimeout(timer)
  }, [state])

  return (
    <Button
      small={small}
      block={block}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setState('copied')
        } catch {
          setState('failed')
        }
      }}
      title={state === 'failed' ? '复制失败：侧边栏可能没有焦点，请点击面板后重试' : undefined}
    >
      {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : label}
    </Button>
  )
}

/**
 * Saves text as a file.
 *
 * An object URL plus a temporary anchor, because `chrome.downloads` is not in
 * the manifest and adding a permission for a text export the user can also copy
 * would be a poor trade. The URL is revoked on the next tick, once the click has
 * been handed to the browser.
 */
export function downloadText(fileName: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Strips characters a file name cannot carry, so an export never fails silently. */
export function safeFileName(name: string, extension: string): string {
  const base = name.trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'webtest-pilot'
  return `${base}.${extension}`
}

// --- Small helpers ---------------------------------------------------------

/**
 * Tracks one in-flight action.
 *
 * Every async button in the panel needs the same three things — a pending flag,
 * a guard against a second click, and a place for the error to go — and letting
 * each tab hand-roll it is how one of them ends up swallowing a rejection.
 */
export function usePending(): {
  pending: boolean
  run: (body: () => Promise<void>) => Promise<void>
} {
  const [pending, setPending] = useState(false)
  const toast = useToast()

  const run = useCallback(
    async (body: () => Promise<void>) => {
      if (pending) return
      setPending(true)
      try {
        await body()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        setPending(false)
      }
    },
    [pending, toast],
  )

  return { pending, run }
}

/** Local date-time, short enough for a narrow column. */
export function shortTime(at: number | undefined): string {
  if (!at) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

/** Full local timestamp, for a tooltip behind {@link shortTime}. */
export function fullTime(at: number | undefined): string {
  return at ? new Date(at).toLocaleString() : '—'
}

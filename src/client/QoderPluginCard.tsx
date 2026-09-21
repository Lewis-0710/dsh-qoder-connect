/** Qoder status card contributed to Harness Plugin configuration. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
} from '../status-paths.ts'
import type {
  QoderCatalogModelSnapshot,
  QoderCredentialSource,
  QoderProbeAction,
  QoderVariantId,
  QoderWebCreditAccount,
  QoderWebStatus,
} from '../status-paths.ts'
import { isQoderWebStatus } from './status-document.ts'
import type { QoderSettingsKey } from './locales.ts'
import { QuotaSettingsContent, type QuotaSection } from './QuotaSettingsCard.tsx'

/** Localized copy injected by the browser-plugin registration. */
export interface QoderPluginCardInjected {
  t: (key: QoderSettingsKey, params?: Record<string, unknown>) => string
  /** The bound scope over the `qoder-quota` namespace, when available. */
  scope?: SettingsScope<QuotaSection> | undefined
  /** Sign-in state per variant; a toggle is disabled when its variant is out. */
  signedIn?: () => { cn: boolean; global: boolean }
  /**
   * Which product variant this card instance renders.
   */
  variant?: QoderCardVariant
  /**
   * Whether to render as the unified Qoder card (merging quota settings + CN + Global with tabs).
   */
  unified?: boolean
}

/** The browser-visible half of a variant: identity, routes, and copy keys. */
export interface QoderCardVariant {
  id: QoderVariantId
  /** Locale key for the card title. */
  titleKey: QoderSettingsKey
  /** Locale key for the card intro line. */
  introKey: QoderSettingsKey
  /** Locale key for the not-signed-in hint. */
  signedOutKey: QoderSettingsKey
  /** Locale key for the PAT generation guide above the input. */
  patGuideKey: QoderSettingsKey
  /** Locale key for the PAT input placeholder (names the site to generate at). */
  patPlaceholderKey: QoderSettingsKey
  statusPath: string
  probePath: string
  authPath: string
}

/** China Qoder; the plugin's primary card and default. */
export const QODER_CN_CARD: QoderCardVariant = {
  id: 'qoder',
  titleKey: 'title',
  introKey: 'intro',
  signedOutKey: 'signedOutHint',
  patGuideKey: 'patGuide',
  patPlaceholderKey: 'patPlaceholder',
  statusPath: QODER_STATUS_PATH,
  probePath: QODER_PROBE_PATH,
  authPath: QODER_AUTH_PATH,
}

/** International Qoder Global. */
export const QODER_GLOBAL_CARD: QoderCardVariant = {
  id: 'qoder-global',
  titleKey: 'titleAI',
  introKey: 'introAI',
  signedOutKey: 'signedOutHintAI',
  patGuideKey: 'patGuideAI',
  patPlaceholderKey: 'patPlaceholderAI',
  statusPath: QODER_GLOBAL_STATUS_PATH,
  probePath: QODER_GLOBAL_PROBE_PATH,
  authPath: QODER_GLOBAL_AUTH_PATH,
}

/** Both cards, in display order (China first). */
export const QODER_CARD_VARIANTS: readonly QoderCardVariant[] = [QODER_CN_CARD, QODER_GLOBAL_CARD]
/** Props delivered by the Plugin configuration item slot. */
export type QoderPluginCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<QoderPluginCardInjected>

const POLL_INTERVAL_MS = 60_000

const cardStyle: CSSProperties = {
  listStyle: 'none',
  borderWidth: '0.5px',
  borderStyle: 'solid',
  borderColor: 'var(--dsw-alias-border-l4)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}
const cardHoverStyle: CSSProperties = { borderColor: 'var(--dsw-alias-label-dimmed)' }
const cardOpenStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  border: 0,
  borderRadius: 12,
  padding: '14px 16px',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  appearance: 'none',
}
const headerFocusStyle: CSSProperties = {
  outline: '2px solid var(--dsw-alias-brand-primary)',
  outlineOffset: -2,
}
const headTextStyle: CSSProperties = { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 4 }
const nameStyle: CSSProperties = { fontSize: 15, lineHeight: 1.4, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }

function ChevronDownIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

const chevronStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  color: 'var(--dsw-alias-label-tertiary)',
  transition: 'transform .16s',
}
const cardBodyStyle: CSSProperties = {
  borderTop: '.5px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  padding: '12px 0 8px',
}

const bodyStyle: CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = {
  boxSizing: 'border-box',
  padding: '5px 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
}
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 2 }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
const contextPreferenceStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 9,
  padding: '10px 12px',
  border: '.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: 1.5,
}
const contextPreferenceCopyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const contextPickerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  flexWrap: 'wrap',
}
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }

const patRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const patInputStyle: CSSProperties = {
  boxSizing: 'border-box',
  flex: 1,
  minWidth: 200,
  padding: '6px 10px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
}

const tabBarStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  marginTop: 4,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}
const tabStyle: CSSProperties = {
  padding: '6px 12px',
  border: 0,
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
}
const tabActiveStyle: CSSProperties = {
  borderBottom: '2px solid var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 600,
}
const tabPanelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 16 }

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid var(--dsw-alias-button-primary-fill)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}

/* ---- Segmented Tab Switcher styles (Figure 1) ---- */
const segmentedContainerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-layer-1, rgba(20, 20, 20, 0.6))',
  border: '1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))',
  borderRadius: 8,
  padding: 3,
  gap: 4,
  marginTop: 14,
  marginBottom: 16,
}

function segmentedTabItemStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '6px 12px',
    borderRadius: 6,
    border: active ? '1px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.18))' : '1px solid transparent',
    background: active ? 'var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.08))' : 'transparent',
    color: active ? 'var(--dsw-alias-label-primary, #fff)' : 'var(--dsw-alias-label-tertiary, #8c8c8c)',
    fontWeight: active ? 500 : 400,
    fontSize: 13,
    lineHeight: '18px',
    cursor: 'pointer',
    appearance: 'none',
    outline: 'none',
    transition: 'all .16s ease',
  }
}

function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-brand-primary, #1677ff)',
  }
}

function dotStyle(status: 'loading' | QoderWebStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #8c8c8c)'
  return { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', background: color }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value)
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}

function formatCycleReset(time: string): string {
  const parsed = Date.parse(time)
  if (!Number.isNaN(parsed)) return formatTime(parsed)
  return time
}

function patSourceText(source: QoderCredentialSource, t: QoderPluginCardInjected['t']): string {
  if (source === 'env') return t('patSourceEnv')
  if (source === 'cli') return t('patSourceCli')
  return t('patSourceCard')
}

function CreditBar({ label, remain, size, unlimited, packageEndTime, t }: {
  label: string
  remain: number
  size: number
  unlimited?: boolean | undefined
  packageEndTime?: string | undefined
  t: QoderPluginCardInjected['t']
}): React.ReactNode {
  const expiry = packageEndTime === undefined
    ? null
    : <p style={modelRateStyle}>{t('quotaExpires')} {formatCycleReset(packageEndTime)}</p>
  if (unlimited === true) {
    const quotaText = t('unlimitedQuota')
    return (
      <div style={quotaGroupStyle}>
        <div style={quotaLabelStyle}>
          <span>{label}</span>
          <span>{quotaText}</span>
        </div>
        <div
          style={progressTrackStyle}
          role="progressbar"
          aria-label={label}
          aria-valuetext={quotaText}
        />
        <p style={bodyStyle}>{quotaText}</p>
        {expiry}
      </div>
    )
  }
  const sizeKnown = size > 0
  const detail = sizeKnown
    ? t('exactRemaining', { remain: formatNumber(remain), size: formatNumber(size) })
    : t('creditPackageUnknownSize', { remain: formatNumber(remain) })
  const percent = sizeKnown ? (remain / size) * 100 : undefined
  const display = percent === undefined
    ? t('percentUnknown')
    : t('percentRemaining', { percent: formatPercent(percent) })
  return (
    <div style={quotaGroupStyle}>
      <div style={quotaLabelStyle}>
        <span>{label}</span>
        <span>{display}</span>
      </div>
      <div
        style={progressTrackStyle}
        role="progressbar"
        aria-label={label}
        {...percent === undefined
          ? { 'aria-valuetext': detail }
          : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }}
      >
        {percent === undefined ? null : <div style={progressFillStyle(percent)} />}
      </div>
      <p style={bodyStyle}>{detail}</p>
      {expiry}
    </div>
  )
}

function maxDeclaredWindow(model: QoderCatalogModelSnapshot): number | undefined {
  const windows = model.supportedContextWindows ?? []
  return windows.length > 0 ? Math.max(...windows) : undefined
}

function ContextTable({ models, t, useMaximumContextWindow, disabled, onUseMaximumContextWindow }: {
  models: readonly QoderCatalogModelSnapshot[] | undefined
  t: QoderPluginCardInjected['t']
  useMaximumContextWindow?: boolean
  disabled?: boolean
  onUseMaximumContextWindow?: (enabled: boolean) => void
}): React.ReactNode {
  const known = (models ?? [])
    .filter(model => model.contextWindow !== undefined)
    .sort((a, b) => (b.contextWindow as number) - (a.contextWindow as number))
  const canSelectMaximum = known.some(model => {
    const max = maxDeclaredWindow(model)
    return max !== undefined && max > (model.defaultContextWindow ?? model.contextWindow ?? 0)
  })
  const showPreference = onUseMaximumContextWindow !== undefined && (canSelectMaximum || useMaximumContextWindow === true)
  if (known.length === 0 && !showPreference) return null
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('contextHeading')}</h3>
      {showPreference && onUseMaximumContextWindow !== undefined ? (
        <label style={contextPreferenceStyle}>
          <input
            type="checkbox"
            checked={useMaximumContextWindow === true}
            disabled={disabled}
            onChange={event => { onUseMaximumContextWindow(event.currentTarget.checked) }}
          />
          <span style={contextPreferenceCopyStyle}>
            <span>{t('useMaximumContextWindow')}</span>
            <span style={modelRateStyle}>{t('useMaximumContextWindowHint')}</span>
          </span>
        </label>
      ) : null}
      {known.map(model => {
        const capacity = model.contextWindow as number
        const max = maxDeclaredWindow(model)
        const alternative = max !== undefined && max > capacity ? max : undefined
        return (
          <div key={model.id} style={quotaLabelStyle}>
            <span>{model.name}</span>
            <span style={contextPickerRowStyle}>
              <span>{formatTokens(capacity)}</span>
              {alternative !== undefined
                ? <span style={modelRateStyle}>{t('contextUpTo', { size: formatTokens(alternative) })}</span>
                : model.defaultContextWindow !== undefined && model.defaultContextWindow < capacity
                  ? <span style={modelRateStyle}>{t('contextDefault', { size: formatTokens(model.defaultContextWindow) })}</span>
                  : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}

/** Render Qoder PAT state, quota, catalog, and context capacities as one expandable card. */
export function QoderPluginCard(props: QoderPluginCardProps) {
  const { t, scope, signedIn, variant, unified } = props
  if (t === undefined) throw new Error('Qoder plugin card requires its translation function')

  const isUnified = unified === true
  const [activeVariantId, setActiveVariantId] = useState<QoderVariantId>('qoder')
  const currentVariant = isUnified
    ? (activeVariantId === 'qoder' ? QODER_CN_CARD : QODER_GLOBAL_CARD)
    : (variant ?? QODER_CN_CARD)

  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [headerFocused, setHeaderFocused] = useState(false)
  const [status, setStatus] = useState<QoderWebStatus>()
  const [signedInState, setSignedInState] = useState<boolean>()
  const [readFailure, setReadFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [patDraft, setPatDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [patBusy, setPatBusy] = useState(false)
  const [patError, setPatError] = useState<string>()
  const [patNotice, setPatNotice] = useState<string>()
  const patInput = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<'status' | 'context' | 'details'>('status')
  const mounted = useRef(true)
  const readSeq = useRef(0)
  const manualControllers = useRef(new Set<AbortController>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of manualControllers.current) controller.abort()
      manualControllers.current.clear()
    }
  }, [])

  const trackController = useCallback((): AbortController => {
    const controller = new AbortController()
    manualControllers.current.add(controller)
    return controller
  }, [])

  const authKey = status === undefined || status.status === 'error' ? undefined : status.authKey

  const refresh = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const seq = ++readSeq.current
    const current = (): boolean => mounted.current && signal?.aborted !== true && seq === readSeq.current
    try {
      const response = await fetch(currentVariant.statusPath, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!isQoderWebStatus(value)) throw new Error(t('statusResponseInvalid'))
      if (!current()) return false
      setStatus(value)
      if (value.status === 'signed-in') setSignedInState(true)
      else if (value.status === 'signed-out') setSignedInState(false)
      setReadFailure(undefined)
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('requestFailed')
      if (current()) {
        setReadFailure(message)
        setStatus(previous => previous === undefined ? { status: 'error', message } : previous)
      }
      return false
    }
  }, [currentVariant.statusPath, t])

  useEffect(() => {
    if (!open) return
    setStatus(undefined)
    setSignedInState(undefined)
    setReadFailure(undefined)
    setPatDraft('')
    setReplacing(false)
    setPatError(undefined)
    setPatNotice(undefined)
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [open, currentVariant.statusPath, refresh])

  useEffect(() => {
    if (!open || signedInState === false) return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refresh, signedInState])

  const manualRefresh = async (): Promise<void> => {
    setBusy(true)
    const controller = trackController()
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
  }

  const refreshModels = useCallback(async (): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setBusy(true)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'refresh' } satisfies QoderProbeAction),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      }
      manualControllers.current.delete(controller)
      return
    } finally {
      if (mounted.current) setBusy(false)
    }
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
    }
  }, [currentVariant.probePath, refresh, status, t, trackController])

  const control = useCallback(async (action: QoderProbeAction): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setBusy(true)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify(action),
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = typeof value === 'object' && value !== null && 'error' in value
          ? String((value as Record<string, unknown>)['error'])
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      if (action.action === 'set-maximum-context-window'
        && (typeof value !== 'object' || value === null || (value as Record<string, unknown>)['state'] !== 'updated')) {
        const reason = typeof value === 'object' && value !== null && 'reason' in value
          ? String((value as Record<string, unknown>)['reason'])
          : t('requestFailed')
        throw new Error(reason)
      }
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
  }, [currentVariant.probePath, refresh, status, t, trackController])

  const savePat = useCallback(async (): Promise<void> => {
    const key = authKey
    const pat = patDraft.trim()
    if (key === undefined || pat === '' || patBusy) return
    setPatBusy(true)
    setPatError(undefined)
    setPatNotice(undefined)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.authPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'save-pat', pat }),
      })
      const value: unknown = await response.json().catch(() => undefined)
      const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
      const detail = typeof record['error'] === 'string' ? record['error'] : `HTTP ${response.status}`
      if (!response.ok) {
        setPatError(t('patSaveFailed', { message: detail }))
        return
      }
      if (record['ok'] !== true) {
        setPatError(detail === 'qoder_invalid_pat' || detail === 'qoder_missing_pat'
          ? t('patInvalid')
          : t('patSaveFailed', { message: detail }))
        return
      }
      setPatDraft('')
      setReplacing(false)
      setPatNotice(t('patSaved'))
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setPatError(t('patSaveFailed', {
          message: error instanceof Error ? error.message : t('requestFailed'),
        }))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setPatBusy(false)
    }
  }, [authKey, currentVariant.authPath, patBusy, patDraft, refresh, t, trackController])

  const clearPat = useCallback(async (): Promise<void> => {
    const key = authKey
    if (key === undefined || patBusy) return
    setPatBusy(true)
    setPatError(undefined)
    setPatNotice(undefined)
    setReplacing(false)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.authPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'clear' }),
      })
      const value: unknown = await response.json().catch(() => undefined)
      const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
      if (!response.ok || record['ok'] !== true) {
        const detail = typeof record['error'] === 'string' ? record['error'] : `HTTP ${response.status}`
        setPatError(t('patSaveFailed', { message: detail }))
        return
      }
      setPatDraft('')
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setPatError(t('patSaveFailed', {
          message: error instanceof Error ? error.message : t('requestFailed'),
        }))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setPatBusy(false)
    }
  }, [authKey, currentVariant.authPath, patBusy, refresh, t, trackController])

  const beginReplace = useCallback((): void => {
    setPatDraft('')
    setPatError(undefined)
    setPatNotice(undefined)
    setReplacing(true)
    requestAnimationFrame(() => { patInput.current?.focus() })
  }, [])

  const patEntry = (): React.ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={bodyStyle}>{t(currentVariant.patGuideKey)}</p>
      <div style={patRowStyle}>
        <input
          ref={patInput}
          type="password"
          value={patDraft}
          placeholder={t(currentVariant.patPlaceholderKey)}
          aria-label={t('patHeading')}
          disabled={patBusy}
          onChange={event => { setPatDraft(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void savePat()
            }
          }}
          style={patInputStyle}
        />
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={patBusy || busy || patDraft.trim() === ''}
          onClick={() => { void savePat() }}
        >
          {patBusy ? t('patSaving') : t('patSave')}
        </button>
        {replacing ? (
          <button
            type="button"
            style={buttonStyle}
            disabled={patBusy}
            onClick={() => {
              setReplacing(false)
              setPatDraft('')
              setPatError(undefined)
            }}
          >
            {t('cancel')}
          </button>
        ) : null}
      </div>
      {patError === undefined ? null : <p style={errorStyle}>{patError}</p>}
      {patNotice === undefined ? null : <p style={bodyStyle}>{patNotice}</p>}
    </div>
  )

  const cardTitle = isUnified ? t('unifiedTitle') : t(currentVariant.titleKey)
  const cardIntro = isUnified ? t('unifiedIntro') : t(currentVariant.introKey)

  const label = status === undefined
    ? t('loading')
    : status.status === 'signed-in'
      ? t('signedIn')
      : status.status === 'error'
        ? t('requestFailed')
        : t('signedOut')

  const patSummaryLine = (pat: NonNullable<Extract<QoderWebStatus, { status: 'signed-in' }>['pat']>): React.ReactNode => {
    const parts = [
      patSourceText(pat.source, t),
      pat.savedAtMs === undefined ? null : t('patSavedAt', { time: formatTime(pat.savedAtMs) }),
      pat.patTail === undefined ? null : t('patTail', { tail: `****${pat.patTail}` }),
    ].filter(part => part !== null)
    return <p style={bodyStyle}>{parts.join(' · ')}</p>
  }

  // Derive status dot for the tab switcher
  const reported = signedIn?.() ?? { cn: false, global: false }
  const cnDotStatus: 'loading' | QoderWebStatus['status'] = isUnified && activeVariantId === 'qoder'
    ? (status === undefined ? 'loading' : status.status)
    : (reported.cn ? 'signed-in' : 'signed-out')
  const globalDotStatus: 'loading' | QoderWebStatus['status'] = isUnified && activeVariantId === 'qoder-global'
    ? (status === undefined ? 'loading' : status.status)
    : (reported.global ? 'signed-in' : 'signed-out')

  return (
    <li
      style={{ ...cardStyle, ...hovered ? cardHoverStyle : {}, ...open ? cardOpenStyle : {} }}
      onMouseEnter={() => { setHovered(true) }}
      onMouseLeave={() => { setHovered(false) }}
    >
      <button
        type="button"
        style={{ ...headerStyle, ...headerFocused ? headerFocusStyle : {} }}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${cardTitle}`}
        onClick={() => { setOpen(!open) }}
        onFocus={event => {
          let keyboard = true
          try {
            keyboard = event.currentTarget.matches(':focus-visible')
          } catch {
            keyboard = true
          }
          if (keyboard) setHeaderFocused(true)
        }}
        onBlur={() => { setHeaderFocused(false) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{cardTitle}</span>
          <span style={descriptionStyle}>{cardIntro}</span>
        </span>
        <span style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>
          <ChevronDownIcon />
        </span>
      </button>
      {open ? (
        <div style={cardBodyStyle}>
          {isUnified ? (
            <>
              {/* Top section: Qoder 侧栏设置 */}
              <QuotaSettingsContent t={t} scope={scope} signedIn={signedIn ?? (() => ({ cn: false, global: false }))} />
              {/* Segmented Tab Switcher (Figure 1) */}
              <div style={segmentedContainerStyle} role="tablist" aria-label="Qoder Version Selection">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeVariantId === 'qoder'}
                  style={segmentedTabItemStyle(activeVariantId === 'qoder')}
                  onClick={() => setActiveVariantId('qoder')}
                >
                  <span style={dotStyle(cnDotStatus)} aria-hidden="true" />
                  <span>{t('variantTabCN')}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeVariantId === 'qoder-global'}
                  style={segmentedTabItemStyle(activeVariantId === 'qoder-global')}
                  onClick={() => setActiveVariantId('qoder-global')}
                >
                  <span style={dotStyle(globalDotStatus)} aria-hidden="true" />
                  <span>{t('variantTabGlobal')}</span>
                </button>
              </div>
            </>
          ) : null}

          <h3 style={quotaTitleStyle}>{t('accountHeading')}</h3>
          <div style={rowStyle}>
            <div style={statusStyle} role="status" aria-busy={status === undefined}>
              <span aria-hidden="true" style={dotStyle(status === undefined ? 'loading' : status.status)} />
              <span>{label}</span>
            </div>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void manualRefresh() }}>
              {busy ? t('refreshing') : t('refresh')}
            </button>
            {status?.status !== 'signed-in' || status.authKey === undefined
              ? null
              : <>
                  <button type="button" style={buttonStyle} disabled={busy || patBusy} onClick={beginReplace}>
                    {t('patReplace')}
                  </button>
                  <button type="button" style={buttonStyle} disabled={busy || patBusy} onClick={() => { void clearPat() }}>
                    {patBusy ? t('patClearing') : t('patClear')}
                  </button>
                </>}
          </div>
          {readFailure === undefined || signedInState === undefined
            ? null
            : <p style={errorStyle}>{t('statusRefreshFailed', { message: readFailure })}</p>}
          {status?.status === 'signed-in'
            ? <>
                {status.pat === undefined ? null : patSummaryLine(status.pat)}
                {replacing ? patEntry() : null}
                {status.jobTokenRefreshedAt === undefined
                  ? null
                  : <p style={bodyStyle}>{t('jobTokenRefreshed', { time: formatTime(status.jobTokenRefreshedAt) })}</p>}
                {status.catalog === undefined
                  ? null
                  : <div style={rowStyle}>
                      <span style={bodyStyle}>
                        {status.catalog.source === 'live' && status.catalog.fetchedAt !== undefined
                          ? t('catalogLive', { time: formatTime(status.catalog.fetchedAt) })
                          : status.catalog.source === 'saved' && status.catalog.fetchedAt !== undefined
                            ? t('catalogSaved', { time: formatTime(status.catalog.fetchedAt) })
                            : t('catalogFallback')}
                      </span>
                      <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void refreshModels() }}>
                        {busy ? t('refreshingModels') : t('refreshModels')}
                      </button>
                    </div>}
                {status.catalog?.error === undefined
                  ? null
                  : <p style={errorStyle}>{t('catalogError', { message: status.catalog.error })}</p>}
                <div role="tablist" style={tabBarStyle}>
                  {(['status', 'context', 'details'] as const).map(id => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => { setTab(id) }}
                      style={{ ...tabStyle, ...(tab === id ? tabActiveStyle : {}) }}
                    >
                      {t(id === 'status' ? 'tabStatus' : id === 'context' ? 'tabContext' : 'tabDetails')}
                    </button>
                  ))}
                </div>

                {tab === 'status' ? (
                  <div style={tabPanelStyle}>
                    {status.credits === undefined ? null : (
                      <div style={quotaListStyle}>
                        <div style={rowStyle}>
                          <h3 style={quotaTitleStyle}>{t('creditsHeading')}</h3>
                          <span style={bodyStyle}>{status.credits.unlimited === true
                            ? t('creditsTotalUnlimited')
                            : t('creditsUsed', { percent: formatPercent(status.credits.total) })}</span>
                        </div>
                        {status.credits.cycleResetTime === undefined ? null : (
                          <p style={descriptionStyle}>
                            {t('cycleResetAt', { time: formatCycleReset(status.credits.cycleResetTime) })}
                          </p>
                        )}
                      </div>
                    )}
                    {status.creditsError === undefined ? null
                      : <p style={errorStyle}>{t('creditsError', { message: status.creditsError })}</p>}
                  </div>
                ) : tab === 'context' ? (
                  <div style={tabPanelStyle}>
                    <ContextTable
                      models={status.models}
                      t={t}
                      disabled={busy}
                      {...status.useMaximumContextWindow === undefined ? {} : { useMaximumContextWindow: status.useMaximumContextWindow }}
                      onUseMaximumContextWindow={(enabled: boolean) => { void control({ action: 'set-maximum-context-window', enabled }) }}
                    />
                  </div>
                ) : (
                  <div style={tabPanelStyle}>
                    {status.credits === undefined ? null : (
                      <div style={quotaListStyle}>
                        <h3 style={quotaTitleStyle}>{t('creditsDetailHeading')}</h3>
                        {status.credits.accounts
                          .filter((account: QoderWebCreditAccount) => account.remain > 0 || account.unlimited === true)
                          .map((account, index) => (
                            <CreditBar
                              key={`${account.packageName}-${String(index)}`}
                              label={account.packageName}
                              remain={account.remain}
                              size={account.size}
                              unlimited={account.unlimited}
                              packageEndTime={account.packageEndTime}
                              t={t}
                            />
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            : null}
          {status?.status === 'signed-out'
            ? <>
                <p style={status.reason === undefined ? bodyStyle : errorStyle}>
                  {status.reason ?? t(currentVariant.signedOutKey)}
                </p>
                {authKey === undefined ? null : patEntry()}
              </>
            : null}
          {status?.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
        </div>
      ) : null}
    </li>
  )
}

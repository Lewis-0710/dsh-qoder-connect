/**
 * Qoder models for DeepSeek Harness, driven by Personal Access Tokens.
 * Registers one provider per product variant — `qoder` for the China region
 * and `qoder-global` for the international one — while streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 *
 * The two variants are assembled by the same factory and differ only in their
 * {@link QoderVariant} descriptor: each gets its own credential store,
 * transport, catalog, upstream client, shim, adapter, probe state, and routes.
 * Neither variant's startup, catalog fetch, or credential state can stop the
 * other from registering — a user with only one token sees only that group.
 *
 * @module dsh-qoder-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { QoderCredentialStore, qoderCredentialIdentity } from './auth.ts'
import { createAuthKey, registerQoderAuthRoute } from './auth-route.ts'
import { FALLBACK_QODER_MODELS, QoderCatalog } from './catalog.ts'
import { qoderCatalogPath, QoderCatalogStore } from './catalog-store.ts'
import { createQoderAdapter } from './adapter.ts'
import { createQoderShim } from './shim.ts'
import { QoderProbeService } from './probe-service.ts'
import { newestFirst, QoderProbeStore, qoderProbePath } from './probe-store.ts'
import { QoderUpstreamClient, validateApiKey } from './upstream.ts'
import { createQoderTransport, type QoderTransport } from './qoder/transport/index.ts'
import { getMachineId } from './qoder/transport/machine-id.ts'
import { qoderMachineIdPath } from './paths.ts'
import { registerQoderStatusRoute } from './web-status.ts'
import { createProbeKey, registerQoderProbeRoute } from './probe-route.ts'
import { CheckInScheduler, JsonFileCheckInStore } from './checkin-scheduler.ts'
import type { QoderModelInfo } from './catalog.ts'
import type { QoderWebCatalog, QoderWebProbeSection } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { emitJobTokenHint, emitJobTokenRefreshFailedHint, installJobTokenHint } from './job-token-hint.ts'
import { QODER_CONNECT_VERSION } from './version.ts'
import { CHINA_VARIANT, GLOBAL_VARIANT, QODER_VARIANTS, type QoderVariant } from './variants.ts'

export { QODER_PROVIDER, QODER_STREAM_IDLE_TIMEOUT_MS, createQoderAdapter, type QoderAdapter } from './adapter.ts'
export { createQoderShim, type QoderShim, type ShimLogger } from './shim.ts'
export {
  FALLBACK_QODER_MODELS,
  QoderCatalog,
  type QoderModelBilling,
  type QoderModelInfo,
  type QoderModelReasoning,
} from './catalog.ts'
export { qoderCatalogPath, QoderCatalogStore, type QoderCatalogStoreOptions } from './catalog-store.ts'
export {
  fingerprintModel,
  QoderProbeStore,
  qoderProbePath,
  QODER_PROBE_FILENAME,
  type QoderProbeRecord,
  type QoderProbeValidation,
} from './probe-store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe.ts'
export { QoderProbeService, type QoderProbeStatus } from './probe-service.ts'
export {
  CHINA_VARIANT,
  GLOBAL_VARIANT,
  QODER_VARIANTS,
  variantFor,
  type QoderVariant,
  type QoderVariantId,
} from './variants.ts'
export {
  patTail,
  qoderCredentialIdentity,
  QoderCredentialStore,
  qoderOwnAuthPath,
  qoderPluginDataDir,
  QODER_AUTH_FILENAME,
  QODER_DATA_DIR_ENV,
  QODER_DATA_DIR_NAME,
  QODER_PAT_ENV_CN,
  QODER_PAT_ENV_GLOBAL,
  type QoderAuthStatus,
  type QoderCredential,
} from './auth.ts'
export {
  createAuthKey,
  qoderAuthHandler,
  registerQoderAuthRoute,
  type QoderAuthRouteOptions,
  type QoderAuthSaveResult,
} from './auth-route.ts'
export {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
  type QoderAuthRequest,
  type QoderCatalogModelSnapshot,
  type QoderPatSummary,
  type QoderProbeAction,
  type QoderWebCatalog,
  type QoderWebCredits,
  type QoderWebCreditAccount,
  type QoderWebProbeModel,
  type QoderWebProbeSection,
  type QoderWebStatus,
} from './status-paths.ts'
export {
  classifyUpstreamError,
  kindFromQoderFailure,
  KIND_STATUS,
  modelInfoOf,
  normalizeCredits,
  QoderUpstreamClient,
  type QoderCatalogFetch,
  type QoderChatResult,
  type QoderCredits,
  type QoderCreditAccount,
  type QoderEffort,
  type UpstreamErrorKind,
} from './upstream.ts'
export {
  QODER_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  qoderHostHeartbeatPath,
  type QoderHostHeartbeat,
} from './host-heartbeat.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-qoder'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning the China card's section.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'qoder'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
export const QODER_SETTINGS_NS = 'qoder' as SettingsNamespace

/**
 * Settings namespace owning the global card's section.
 *
 * One namespace per card, not one shared: the settings Plugins tab dispatches a
 * card by rendering `settings.plugin.item` with `entryKey = ns` for each
 * namespace the Host serves, and skips an entry whose key names no served
 * namespace. With a single installed section, the global card registers
 * into the slot but is never rendered — the card list is built from the Host's
 * sections, not from the slot's entries. Each card therefore needs its own
 * installed section whose namespace equals the card's slot key.
 */
export const QODER_GLOBAL_SETTINGS_NS = 'qoder-global' as SettingsNamespace

/**
 * Settings namespace owning the shared quota-card section.
 *
 * One card above the two variant cards configures both sidebar quota widgets
 * (China and global) from a single place, so its toggles cannot live in
 * either variant's section — they are per-variant fields on a cross-variant
 * card. The Plugins tab dispatches by namespace, so this section is what makes
 * that card render (see {@link QODER_GLOBAL_SETTINGS_NS} for the mechanism).
 */
export const QODER_QUOTA_SETTINGS_NS = 'qoder-quota' as SettingsNamespace

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * A startup-only catalog fetch cannot notice a token saved while DSH is
 * already running, so the model group would not appear until a restart. This
 * poll is a cheap existence/parse read of at most a few local files: it never
 * contacts the network and never runs a reasoning probe.
 *
 * `DSH_QODER_POLL_MS` overrides it. That exists so the sweep can be
 * exercised end to end in tests and shortened while diagnosing a slow
 * sign-in on a real machine; it is not a product setting and no UI exposes it.
 * The value is clamped to a sane range so a mistaken override cannot turn the
 * poll into a busy loop.
 */
const CREDENTIAL_POLL_MS = 30_000

/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs(): number {
  const override = Number(process.env['DSH_QODER_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * How long to wait before retrying a catalog fetch that failed.
 *
 * The credential sweep deliberately does not re-fetch a catalog it already has
 * (the same token carries no new model information). But a *failed* fetch must
 * not be treated the same way: without a retry, one transient network blip at
 * startup would leave the group on the built-in fallback roster until the user
 * noticed and pressed refresh. This bound keeps that recovery automatic while
 * still honoring the "not every round" rule — at most one attempt per
 * interval, and none at all once a live catalog lands.
 *
 * Expressed as a multiple of the sweep rather than a fixed duration so the two
 * stay in proportion under the `DSH_QODER_POLL_MS` override.
 */
const CATALOG_RETRY_SWEEPS = 10

/** Plugin configuration. */
export interface Config {
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean
  /** Use the largest context window the global catalog explicitly offers. */
  useMaximumContextWindow?: boolean
  /** The China variant's own maximum-window preference, persisted in its section. */
  useMaximumContextWindowCN?: boolean
  /**
   * Per-model context-window overrides for the global variant (model id →
   * tokens). Kept for schema compatibility; the card no longer writes
   * per-model overrides because the upstream honours only the default and
   * the maximum, nothing between.
   */
  modelContextWindows?: Record<string, number>
  /** The China variant's per-model overrides; see {@link Config.modelContextWindows}. */
  modelContextWindowsCN?: Record<string, number>
  /** Show the China variant's sidebar quota card. */
  sidebarQuotaCN?: boolean
  /** Show the global variant's sidebar quota card. */
  sidebarQuotaGlobal?: boolean
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for China variant. */
  autoCheckInCN?: boolean
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for Global variant. */
  autoCheckInGlobal?: boolean
  /**
   * Sidebar quota refresh interval in milliseconds. One shared value (both
   * cards poll on it) because the two widgets hit the same rate-limited
   * billing family; the floor guards against a typo hammering the quota
   * endpoint, which serves no cache.
   */
  quotaPollMs?: number
}

/** Probe authorization (shared by the plugin schema and the China section). */
const PROBE_CONSENT_FIELD = z.boolean().default(false)
  .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)')
const MAXIMUM_CONTEXT_WINDOW_FIELD = z.boolean().default(true)
  .description('Use the largest context window declared by Qoder Global when alternatives are available (on by default)')
/** The China variant's own maximum-window preference. */
const MAXIMUM_CONTEXT_WINDOW_CN_FIELD = z.boolean().default(true)
  .description('Use the largest context window declared by Qoder (China) when alternatives are available (on by default)')
/**
 * Per-model window overrides (model id → tokens). The card writes one entry
 * per selector change; the field is optional so an absent map means "no
 * overrides" rather than a default object the host must keep in sync.
 */
const MODEL_CONTEXT_WINDOWS_FIELD = z.dict(z.number().min(1), z.string())
  .description('Per-model context-window overrides for Qoder Global (model id → tokens)')
/** Sidebar quota toggle (one per variant; both live on the shared quota card). */
const QUOTA_TOGGLE_FIELD = z.boolean().default(false)
  .description('Show this variant’s remaining-credit card in the sidebar footer (off by default)')
/** Automatic check-in toggle. */
const AUTO_CHECK_IN_FIELD = z.boolean().default(false)
  .description('每天 10:00 (UTC+8) 自动签到领取算力额度（默认关闭）')
/**
 * Quota poll interval: default 5 minutes, floor 1 minute. The status route
 * performs a live upstream billing call per request with no cache, so an
 * aggressively small interval translates directly into upstream load; the
 * floor is the smallest value the UI offers rather than a silent clamp —
 * smaller staged values fail Host validation and refuse to save.
 */
export const QUOTA_POLL_DEFAULT_MS = 300_000
export const QUOTA_POLL_MIN_MS = 60_000
const QUOTA_POLL_FIELD = z.number()
  .default(QUOTA_POLL_DEFAULT_MS)
  .min(QUOTA_POLL_MIN_MS)
  .description('Sidebar quota card refresh interval in milliseconds (default 300000, minimum 60000)')

export const Config: z<Config> = z.object({
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
  useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
  modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
  modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
  sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
  sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
  autoCheckInCN: AUTO_CHECK_IN_FIELD,
  autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
  quotaPollMs: QUOTA_POLL_FIELD,
})

/**
 * The China card's settings section: only the fields that card edits.
 *
 * A section is what makes its namespace "served", which is what the Plugins
 * tab dispatches a card by — so the schema and the card must stay split the
 * same way. `probeConsent` lives here because it predates the second variant;
 * it gates no current code path (only manual, per-click-confirmed probes run),
 * so it is left where existing users set it rather than moved and re-asked.
 */
const CHINA_SECTION: z<Config> = z.object({
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
  modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
})

/** The global card's settings section and its context-window preferences. */
const GLOBAL_SECTION: z<Config> = z.object({
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
  modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
})

/**
 * The shared quota card's section: both sidebar toggles and the poll interval.
 *
 * Only these fields — the card edits nothing else, and the Plugins tab pairs a
 * card with the section whose namespace it names, so a stray field here would
 * render as a control no other surface reads.
 */
const QUOTA_SECTION: z<Config> = z.object({
  sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
  sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
  autoCheckInCN: AUTO_CHECK_IN_FIELD,
  autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
  quotaPollMs: QUOTA_POLL_FIELD,
})

/** One variant's live runtime, assembled by {@link createVariantRuntime}. */
interface VariantRuntime {
  variant: QoderVariant
  store: QoderCredentialStore
  client: QoderUpstreamClient
  transport: QoderTransport
  catalog: QoderCatalog
  probeStore: QoderProbeStore
  probeService: QoderProbeService
  /**
   * The last catalogs that loaded, keyed by account.
   *
   * Sits between the live fetch and the built-in roster in the degradation
   * order: a restart, or a fetch that fails while offline, serves what this
   * token was last actually shown instead of the one-off snapshot compiled
   * into the plugin.
   */
  savedCatalogs: QoderCatalogStore
  /** The static roster this variant falls back to. */
  fallback: readonly QoderModelInfo[]
  /**
   * Where the served models came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch) →
   * `fallback` (the roster compiled into the plugin).
   */
  catalogSource: 'live' | 'saved' | 'fallback'
  /** When the served catalog was fetched, for `live` and `saved`. */
  catalogFetchedAtMs: number | undefined
  /** Why the last catalog attempt failed, when it did. */
  catalogError: string | undefined
  /** When the last catalog attempt started, for the retry backoff. */
  lastFetchAtMs: number
  /**
   * Bumped whenever this variant's catalog generation changes — a token
   * switch, a sign-out, or a new fetch superseding an older one. A request
   * carries the generation it started under and refuses to write back if the
   * generation has moved on, so a slow answer can never resurrect data the
   * plugin has since decided to drop (spec §5: late responses are discarded).
   */
  catalogGeneration: number
  /**
   * The in-flight catalog fetch, scoped to the identity and generation it began
   * under. A caller may only join the same scope; a token change cancels the
   * old request and immediately starts one for the newly adopted account.
   */
  inflightFetch: CatalogFetch | undefined
  /** Notify the model directory that this variant's answers changed. */
  invalidate: () => void
  /** Whether the provider registered successfully. */
  registered: boolean
  /**
   * When the self-heal last auto-refreshed this variant's job token, epoch ms.
   * Recorded by the transport's `onJobTokenRefreshed` callback and surfaced on
   * the card's status document, so the otherwise invisible recovery shows.
   */
  jobTokenRefreshedAt: () => number | undefined
}

/** One catalog request plus the identity state it is allowed to update. */
interface CatalogFetch {
  identity: string
  generation: number
  controller: AbortController
  promise: Promise<void>
}

/** Stable identity key used by credentials, probe records, and catalog entries. */
const credentialIdentity = qoderCredentialIdentity

/** The settings namespace a variant's card and provider directory entry use. */
function settingsNamespaceFor(variant: QoderVariant): SettingsNamespace {
  return variant.id === CHINA_VARIANT.id ? QODER_SETTINGS_NS : QODER_GLOBAL_SETTINGS_NS
}

/**
 * The static catalog a variant serves before its first successful fetch.
 *
 * Both regions share one roster transcribed from the transport's built-in
 * model defaults: unlike the WorkBuddy-era endpoints, the Qoder pools are
 * region-specific only in what discovery lists, and inventing a second roster
 * from nothing would misdescribe whichever variant it was not captured from.
 */
function fallbackFor(_variant: QoderVariant): readonly QoderModelInfo[] {
  return FALLBACK_QODER_MODELS
}

/**
 * The hint row's summary line: what happened, and when.
 *
 * Named here rather than in the hint module because the text is this plugin's
 * user-facing wording, and the transport callback that produces it runs before
 * the plugin's own scope exists.
 */
function jobTokenHintText(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  return `jobToken 已自动刷新（${time}）— 旧令牌被上游拒绝，已自动重换并恢复`
}

/**
 * The failed-heal row's summary line.
 *
 * Deliberately does not name a cause: the upstream rejection that survived a
 * fresh token is not necessarily an authorization problem at all, and the real
 * reason travels in the failure message itself (see the SSE envelope body).
 * Claiming "quota" or "revoked" here would be a guess presented as a finding.
 */
function jobTokenRefreshFailedHintText(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  return `jobToken 已重换但仍被上游拒绝（${time}）— 自愈未恢复，请查看上方错误详情`
}

/** Build one variant's stores, transport, and probe state. */
function createVariantRuntime(
  ctx: Context,
  config: Config,
  variant: QoderVariant,
  current: () => Config,
  identityOf: (variantId: string) => string | undefined,
): VariantRuntime {
  const store = new QoderCredentialStore({ variant, logger: ctx.logger })
  // The self-heal's auto-refresh record, surfaced on the card. Per variant:
  // each region's transport reports its own refreshes.
  let jobTokenRefreshedAt: number | undefined
  const transport = createQoderTransport({
    region: variant.region,
    resolvePat: () => store.patPromise(),
    // Keep the machine-id seed inside the plugin's own data directory
    // (state/) instead of letting the transport write it near $HOME.
    resolveMachineId: () => getMachineId([qoderMachineIdPath()]),
    onJobTokenRefreshed: info => {
      jobTokenRefreshedAt = info.at
      ctx.logger.warn(
        `dsh-qoder-connect: ${variant.displayName} job token was auto-refreshed after an upstream rejection`,
      )
      // The visible channel: one line in the conversation that triggered the
      // refresh (the request this heal happened inside).
      emitJobTokenHint(info.at, jobTokenHintText(info.at))
    },
    onJobTokenRefreshFailed: info => {
      // The heal ran and lost. Announced at most once per outage by the
      // transport, so a long rejection storm prints one row, not one per retry.
      ctx.logger.warn(
        `dsh-qoder-connect: ${variant.displayName} job token refresh did not recover the chat (upstream status ${info.status ?? 'unknown'})`,
      )
      emitJobTokenRefreshFailedHint(info.at, jobTokenRefreshFailedHintText(info.at))
    },
  })
  // The attachment service may not exist when the client is constructed (and
  // a headless profile never has one), so the client gets a stable proxy that
  // resolves the real store per request.
  const attachments: Pick<AttachmentStore, 'saveImage'> = {
    saveImage: async request => {
      const service = ctx.get('attachments')
      if (service === undefined) {
        throw new Error('dsh-qoder-connect: no attachment service is available to store images')
      }
      return await service.saveImage(request)
    },
  }
  const client = new QoderUpstreamClient({
    region: variant.region,
    providerId: variant.id,
    getPat: () => store.patPromise(),
    transport,
    attachments,
  })
  const fallback = fallbackFor(variant)
  const catalog = new QoderCatalog(fallback)
  if (variant.id !== CHINA_VARIANT.id) {
    catalog.setUseMaximumContextWindow(config.useMaximumContextWindow === true)
  } else {
    catalog.setUseMaximumContextWindow(config.useMaximumContextWindowCN === true)
    if (config.modelContextWindowsCN !== undefined) catalog.setModelContextWindows(config.modelContextWindowsCN)
  }
  // Start hidden: a variant must serve no models until a token has actually
  // been adopted, so a signed-out variant is empty rather than showing a roster
  // whose models could only fail. `adoptIdentity` is what reveals it, and it
  // treats "never seen, still signed out" as no change — which is only correct
  // if the pre-adoption state is already hidden.
  catalog.setVisible(false)
  const probeStore = new QoderProbeStore({
    pluginVersion: QODER_CONNECT_VERSION,
    path: qoderProbePath(variant.probeFilename),
  })
  // One file per variant, for the same reason the probe records are split: the
  // two regions can disagree about rates and windows for shared model ids, so
  // a saved China roster must never be served as a global one.
  const savedCatalogs = new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) })
  const probeService = new QoderProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => current().probeConsent === true,
    // Observations are per account: the service reads and writes its records
    // against this identity, so one token's detected levels never answer for
    // another's, and an in-flight sweep cannot store under a new token.
    account: () => identityOf(variant.id),
  })
  return {
    variant,
    store,
    client,
    transport,
    catalog,
    probeStore,
    probeService,
    savedCatalogs,
    fallback,
    catalogSource: 'fallback',
    catalogFetchedAtMs: undefined,
    catalogError: undefined,
    lastFetchAtMs: 0,
    catalogGeneration: 0,
    inflightFetch: undefined,
    invalidate: () => {},
    registered: false,
    jobTokenRefreshedAt: () => jobTokenRefreshedAt,
  }
}

/** The catalog provenance the card displays. */
function catalogSection(runtime: VariantRuntime): QoderWebCatalog {
  return {
    // The source is what the models on screen actually came from, so the card
    // can distinguish a fresh fetch from a saved one from the built-in roster —
    // "stale" and "offline" are different problems for the user.
    source: runtime.catalogSource,
    // The served catalog's own fetch time, which for a saved list is when it
    // was fetched, not when the process started.
    ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
    ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
  }
}

/**
 * Whether a model can be probed by hand: it reasons and the upstream declares
 * no effort set for it.
 *
 * Deliberately *not* filtered by whether a result already exists. Dropping a
 * model once it has been detected made the list shrink with use, so
 * re-detecting one model — after an upstream change, say — meant clearing every
 * other result first. The list stays stable and the card marks which entries
 * already have an answer.
 */
function isProbeCandidate(info: QoderModelInfo): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime: VariantRuntime, consent: boolean): QoderWebProbeSection {
  const models = runtime.catalog.current()
  // Read results through the *same* judgement the adapter uses, rather than
  // straight from the store. A raw record can be stale in ways the adapter
  // already discounts — its catalog row changed, it aged past the TTL, or the
  // upstream has since declared an effort set (which always wins) — and showing
  // one would have the card promise levels the model picker does not offer. A
  // model the upstream dropped leaves the catalog entirely, so it drops out
  // here too.
  const results = models.flatMap(info => {
    const record = runtime.probeService.recordFor(info.id)
    if (record === undefined) return []
    return [{
      id: info.id,
      name: info.name,
      validation: record.validation,
      efforts: record.efforts,
      probedAt: record.probedAtMs,
    }]
  })
  return {
    consent,
    running: runtime.probeService.isRunning(),
    candidates: models.filter(isProbeCandidate).map(info => info.id),
    // Newest first: a detection the user just ran belongs at the top, not
    // appended below every earlier one.
    results: newestFirst(results),
  }
}

/**
 * Run a detached promise without letting its failure kill the host.
 *
 * Node terminates the whole process on an unhandled rejection (exit code 1),
 * which the desktop shell reports as the backend having "exited unexpectedly"
 * — so a failing heartbeat write, loopback close, or background sweep in this
 * plugin would take the entire Harness down with it. Every fire-and-forget
 * call therefore carries a handler; a failure is a diagnostic, never a reason
 * for the host to die.
 */
function detach(ctx: Context, work: Promise<unknown>, what: string): void {
  void work.catch((error: unknown) => {
    ctx.logger.warn(`dsh-qoder-connect: ${what} failed`, error)
  })
}

/**
 * Start one variant: its loopback endpoint, provider registration, and
 * configuration-card wiring.
 *
 * Registration waits for the shim to hold a port, because the provider's
 * models read the shim origin at construction time. A failure here is
 * contained to this variant: the caller logs it and the other keeps working.
 *
 * @returns whether the provider registered.
 */
async function startVariant(ctx: Context, runtime: VariantRuntime): Promise<boolean> {
  const { variant, store, client, catalog, probeService } = runtime
  const shim = createQoderShim({
    store,
    client,
    catalog,
    providerId: variant.id,
    logger: ctx.logger,
  })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} loopback endpoint failed to start`, error)
    return false
  }

  try {
    // Constructed only once the listener holds a port: the provider's models
    // read the shim origin at construction time.
    const qoder = createQoderAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      observe: modelId => probeService.recordFor(modelId),
    })
    runtime.invalidate = () => {
      qoder.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    let releaseAdapter: (() => void) | undefined
    let releaseDirectory: (() => void) | undefined
    try {
      releaseAdapter = ctx.llm.registerAdapter([variant.id], qoder.adapter)
      releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: variant.id,
        displayName: variant.displayName,
        // Each variant's directory entry joins its own installed section; the
        // Models settings page resolves `settingsNs` against the served
        // namespaces, so a shared ns would render both providers onto one card.
        settingsNs: settingsNamespaceFor(variant),
        settingsPath: [],
        declared: false,
      }])
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        // Registration threw; release whichever half landed.
        releaseAdapter?.()
        releaseDirectory?.()
      }
    }
    try {
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseDirectory?.()
        detach(ctx, shim.close(), 'loopback endpoint close')
      })
    } catch {
      // The plugin was disposed during registration; release immediately — the
      // plugin-level disposer already closed every shim.
      releaseAdapter?.()
      releaseDirectory?.()
      detach(ctx, shim.close(), 'loopback endpoint close')
    }
    runtime.registered = true
    return true
  } catch (error: unknown) {
    ctx.logger.error(`dsh-qoder-connect: ${variant.displayName} provider registration failed`, error)
    detach(ctx, shim.close(), 'loopback endpoint close')
    return false
  }
}

/**
 * Start both variants: their loopback endpoints, the `qoder` and
 * `qoder-global` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a token saved after startup working
 * without re-registering the provider.
 */
export function apply(ctx: Context, config: Config): void {
  // Live configuration source: starts as the applied config and is replaced by
  // the settings section's source once one is installed, so edits reach the
  // probe consent gate without a restart.
  let current = (): Config => config

  /** Timers and in-flight work belonging to this plugin instance. */
  let stopped = false
  const timers: NodeJS.Timeout[] = []
  /**
   * The account identity each variant last published a catalog for. Keeps a
   * same-token sweep from re-fetching, and lets a late response from a
   * previous identity be discarded instead of overwriting a newer one.
   */
  const lastIdentities = new Map<string, string>()

  const runtimes = QODER_VARIANTS.map(variant => createVariantRuntime(
    ctx,
    config,
    variant,
    () => current(),
    id => lastIdentities.get(id),
  ))

  const checkInStore = new JsonFileCheckInStore()
  const checkInScheduler = new CheckInScheduler({
    targets: runtimes.map(runtime => ({
      variantId: runtime.variant.id,
      service: (runtime.transport as unknown as { checkInService: any }).checkInService,
      getPat: async () => runtime.store.patPromise(),
      onClaimed: () => {
        void runtime.client.fetchCredits().catch(() => undefined)
      },
    })),
    isEnabled: variantId => {
      const cfg = current()
      if (variantId === CHINA_VARIANT.id) return cfg.autoCheckInCN === true
      return cfg.autoCheckInGlobal === true
    },
    store: checkInStore,
  })
  checkInScheduler.start()

  // The session-visible hint row for a self-heal: appends the harness's own
  // log-only `command/run` + `command/done` pair to the running conversation,
  // so the recovery shows as one line and registers nothing globally.
  installJobTokenHint(ctx)

  // Same-origin routes backing each Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  const probeKey = createProbeKey()
  /**
   * The in-process key authorizing PAT writes, minted separately from the
   * probe key.
   *
   * Separate keys rather than one shared secret because the two authorize
   * different powers: one spends credit on a probe, the other stores a
   * credential. A single key handed to both would let a defect in either card
   * reach the other's authority.
   */
  const authKey = createAuthKey()
  let setMaximumContextWindow: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  let setMaximumContextWindowCN: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  /**
   * Point a variant at an account identity, invalidating whatever the previous
   * one left behind.
   *
   * One helper for all four transitions (sweep sign-in, sweep sign-out, manual
   * refresh, card save) because each of them used to do its own partial
   * version, and the manual path forgot pieces the sweep did. Every transition
   * bumps {@link VariantRuntime.catalogGeneration}, which is what makes an
   * in-flight request from before the change refuse to write back.
   *
   * Probe observations are dropped whenever the account actually changes —
   * including sign-out, and including the "signed out, then in as someone else"
   * sequence that used to look like a first sighting and let the new account
   * inherit the old one's detected levels. They are deliberately NOT cleared on
   * a first sign-in: no previous account's data could leak there, and clearing
   * would delete records this very account owns (written before a restart, or
   * seeded while all of this is running).
   *
   * @param identity - the account now in effect, or `undefined` when signed out.
   */
  const adoptIdentity = (runtime: VariantRuntime, identity: string | undefined): void => {
    const id = runtime.variant.id
    const known = lastIdentities.get(id)
    if (known === identity) return
    const hadCredential = known !== undefined
    if (identity === undefined) lastIdentities.delete(id)
    else lastIdentities.set(id, identity)
    // Any change of identity invalidates in-flight work and recorded answers.
    runtime.catalogGeneration += 1
    runtime.inflightFetch?.controller.abort()
    runtime.inflightFetch = undefined
    if (hadCredential && known !== identity) {
      runtime.probeStore.clear()
      runtime.invalidate()
    }
    if (identity === undefined) {
      // Signed out: hide the group, and drop the models so they are not left
      // registered-but-invisible if visibility ever flips back. The signed-out
      // account's saved catalog is forgotten as well — it is that account's
      // data, and it is keyed by identity so nothing else can serve it, but
      // keeping it would only be useful if that same account returned, and the
      // file is not a place to accumulate departed accounts' catalogs.
      if (known !== undefined) runtime.savedCatalogs.delete(known)
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
      runtime.catalogError = undefined
      if (runtime.catalog.setVisible(false)) runtime.invalidate()
      return
    }
    // Serve this account's best-known catalog until a fetch lands. The saved
    // catalog is preferred over the built-in roster: the roster is a snapshot
    // taken once, while the saved one is what this account (from this source)
    // was actually served. This covers both a switch and a restart — on a
    // restart `hadCredential` is false, and the saved catalog is exactly what
    // stops the group from falling back to the compiled-in list.
    const saved = runtime.savedCatalogs.get(identity)
    if (saved !== undefined) {
      runtime.catalog.set([...saved.models])
      runtime.catalogSource = 'saved'
      runtime.catalogFetchedAtMs = saved.fetchedAtMs
    } else {
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
    }
    runtime.catalogError = undefined
    runtime.catalog.setVisible(true)
    runtime.invalidate()
  }

  ctx.inject(['webServer'], webCtx => {
    for (const runtime of runtimes) {
      registerQoderStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        client: runtime.client,
        models: () => runtime.catalog.current(),
        catalog: () => catalogSection(runtime),
        probe: () => probeSection(runtime, current().probeConsent === true),
        probeKey,
        authKey,
        ...(runtime.variant.id === CHINA_VARIANT.id
          ? { useMaximumContextWindow: () => current().useMaximumContextWindowCN === true }
          : { useMaximumContextWindow: () => current().useMaximumContextWindow === true }),
        jobTokenRefreshedAt: runtime.jobTokenRefreshedAt,
        checkIn: () => checkInStore.read(runtime.variant.id),
      })
      registerQoderAuthRoute(webCtx, {
        path: runtime.variant.authPath,
        save: async pat => {
          // Validate against the region this variant owns *before* anything is
          // written: a token that cannot answer discovery is refused with a
          // stable code, and the file never holds a credential the plugin has
          // not seen work.
          if (!await validateApiKey(pat, runtime.variant.region)) {
            return { ok: false, error: 'qoder_invalid_pat' as const }
          }
          const credential = await runtime.store.save(pat)
          // Saving a token is the one transition the sweep would otherwise only
          // notice on its next tick; adopt it here so the model group appears
          // at once.
          const identity = credentialIdentity(credential)
          adoptIdentity(runtime, identity)
          // AWAIT the fetch: the card re-reads the status the moment this answer
          // lands, so returning first left it rendering the built-in roster
          // until the next poll or a manual refresh. `fetchCatalog` contains
          // its own failures (they surface as `catalog.error`), so a slow or
          // failing upstream can never turn a valid save into an error.
          await fetchCatalog(runtime, identity)
          return { ok: true, status: await runtime.store.status() }
        },
        clear: async () => {
          await runtime.store.clear()
          adoptIdentity(runtime, undefined)
        },
      }, authKey)
      registerQoderProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        probe: async modelId => {
          // The authenticated manual endpoint is called only after per-model confirmation.
          const result = await runtime.probeService.probe(modelId, true)
          if (result.state === 'ok') runtime.invalidate()
          return result
        },
        clear: () => { runtime.probeStore.clear(); runtime.invalidate() },
        refresh: async () => {
          if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
          // Re-read the credential first: the user pressed this because the list
          // looks wrong, and a token saved since the last sweep is the common
          // cause. Re-registering is unnecessary — visibility is what changes,
          // and the sweep owns that.
          let credential
          try {
            credential = await runtime.store.current()
          } catch (error: unknown) {
            // A refused credential (wrong region, unreadable file) is a report,
            // not a crash out of the route.
            return {
              state: 'failed',
              reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
            }
          }
          if (credential === undefined) {
            adoptIdentity(runtime, undefined)
            return { state: 'signed-out' }
          }
          const identity = credentialIdentity(credential)
          // Same transition the sweep performs: a switch reached through the
          // manual path must drop the previous account's data *now*, not when
          // the fetch lands, or a failed fetch leaves those models pickable.
          adoptIdentity(runtime, identity)
          await fetchCatalog(runtime, identity)
          return runtime.catalogError === undefined
            ? { state: 'refreshed', reason: `${runtime.catalog.current().length} models` }
            : { state: 'failed', reason: runtime.catalogError }
        },
        ...runtime.variant.id === CHINA_VARIANT.id
          ? {
              setMaximumContextWindow: async enabled => {
                if (setMaximumContextWindowCN === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setMaximumContextWindowCN(enabled)
              },
            }
          : {
              setMaximumContextWindow: async enabled => {
                if (setMaximumContextWindow === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setMaximumContextWindow(enabled)
              },
            },
      }, probeKey)
    }
  })

  // Each settings section is what makes its namespace "served" — which is how
  // both the Plugins tab (card dispatch) and the Models settings page (provider
  // directory join) find this plugin's halves. One section per card, because the
  // tab renders a card by `entryKey = ns` and never interprets one: a section
  // that is not installed leaves its card registered but undispatched, and a
  // provider whose `settingsNs` names no section joins nothing.
  //
  // DSH 0.1.2 moved the helper from a free function (`installSettingsSection`)
  // onto the provider service (`settings.installSection`), so the wiring now has
  // to wait for a settings service to exist — exactly what the inject below
  // does. Without one the plugin still serves its models; it simply has no
  // user-editable sections, as before.
  ctx.inject(['settings'], settingsCtx => {
    /** Section sources; each falls back to its own slice when its side unloads. */
    const sources: { cn: () => Config, global: () => Config, quota: () => Config } = {
      cn: () => config,
      global: () => config,
      quota: () => config,
    }
    /** Merge all sections into the whole config the rest of the plugin reads. */
    const merged = (): Config => ({
      ...sources.cn().probeConsent === undefined ? {} : { probeConsent: sources.cn().probeConsent },
      ...sources.cn().useMaximumContextWindowCN === undefined ? {} : { useMaximumContextWindowCN: sources.cn().useMaximumContextWindowCN },
      ...sources.cn().modelContextWindowsCN === undefined ? {} : { modelContextWindowsCN: sources.cn().modelContextWindowsCN },
      ...sources.global().useMaximumContextWindow === undefined ? {} : { useMaximumContextWindow: sources.global().useMaximumContextWindow },
      ...sources.global().modelContextWindows === undefined ? {} : { modelContextWindows: sources.global().modelContextWindows },
      ...sources.quota().sidebarQuotaCN === undefined ? {} : { sidebarQuotaCN: sources.quota().sidebarQuotaCN },
      ...sources.quota().sidebarQuotaGlobal === undefined ? {} : { sidebarQuotaGlobal: sources.quota().sidebarQuotaGlobal },
      ...sources.quota().quotaPollMs === undefined ? {} : { quotaPollMs: sources.quota().quotaPollMs },
    })
    const applyMaximumContextWindow = (next: Config): void => {
      let changed = false
      for (const runtime of runtimes) {
        const isChina = runtime.variant.id === CHINA_VARIANT.id
        const preference = isChina ? next.useMaximumContextWindowCN : next.useMaximumContextWindow
        if (runtime.catalog.setUseMaximumContextWindow(preference === true)) changed = true
        const overrides = isChina ? next.modelContextWindowsCN : next.modelContextWindows
        if (overrides !== undefined && runtime.catalog.setModelContextWindows(overrides)) changed = true
      }
      if (changed) {
        for (const runtime of runtimes) runtime.invalidate()
      }
    }
    const repointStores = (): void => {
      applyMaximumContextWindow(merged())
    }
    settingsCtx.settings.installSection(ctx, QODER_SETTINGS_NS, CHINA_SECTION, config, {
      setSource(source) { sources.cn = source as () => Config; current = merged },
      onChange: repointStores,
    })
    settingsCtx.settings.installSection(ctx, QODER_GLOBAL_SETTINGS_NS, GLOBAL_SECTION, config, {
      setSource(source) { sources.global = source as () => Config; current = merged },
      onChange: repointStores,
    })
    settingsCtx.settings.installSection(ctx, QODER_QUOTA_SETTINGS_NS, QUOTA_SECTION, config, {
      setSource(source) { sources.quota = source as () => Config; current = merged },
      onChange: () => {},
    })
    setMaximumContextWindow = async enabled => {
      await settingsCtx.settings.update(QODER_GLOBAL_SETTINGS_NS, { useMaximumContextWindow: enabled })
      return { state: 'updated' }
    }
    setMaximumContextWindowCN = async enabled => {
      await settingsCtx.settings.update(QODER_SETTINGS_NS, { useMaximumContextWindowCN: enabled })
      return { state: 'updated' }
    }
  })

  ctx.effect(() => () => {
    stopped = true
    checkInScheduler.dispose()
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    detach(ctx, clearHostHeartbeat(), 'host heartbeat cleanup')
  })

  /**
   * Fetch one variant's catalog for the current credential.
   *
   * Shared by the credential sweep and the card's manual refresh, and written
   * so that concurrent callers cost one request and cannot interleave badly:
   *
   * - **One request at a time.** A second caller joins the in-flight fetch
   *   instead of starting its own (spec §5: one catalog request per variant at
   *   a time).
   * - **Generation-checked write-back.** The request records the generation it
   *   started under and writes nothing if the generation moved on — which is
   *   what a slow answer from a superseded account must not do. Checking only
   *   the *identity* was not enough: two refreshes for the same account can
   *   still finish out of order, and the older one would win.
   * - **`resolve()`, not `current()`.** A catalog fetch demands a usable token;
   *   the difference from `current()` is that its absence surfaces as the same
   *   classified `MISSING_CREDENTIAL` failure every other request path reports,
   *   rather than as a silent "no credential" that would hide a bad file on
   *   disk behind an env override.
   */
  const fetchCatalog = async (runtime: VariantRuntime, identity: string): Promise<void> => {
    const inflight = runtime.inflightFetch
    const generation = runtime.catalogGeneration
    if (inflight !== undefined && inflight.identity === identity && inflight.generation === generation) {
      return inflight.promise
    }
    // A caller should normally reach this only after `adoptIdentity()` has
    // already cancelled a previous generation. Keep this guard local as well:
    // no stale request may prevent the current account from fetching now.
    inflight?.controller.abort()
    const controller = new AbortController()
    let run: Promise<void>
    run = (async (): Promise<void> => {
      let models: readonly QoderModelInfo[]
      try {
        // Establish the identity that owns this fetch from the file-backed
        // credential; discovery itself reads the token through the same store.
        const credential = await runtime.store.resolve()
        const resolvedIdentity = credentialIdentity(credential)
        if (resolvedIdentity !== identity) {
          adoptIdentity(runtime, resolvedIdentity)
          await fetchCatalog(runtime, resolvedIdentity)
          return
        }
        models = await runtime.client.fetchModels(controller.signal)
        // The token can also change while the upstream request is in flight.
        // Re-read before publishing so the just-finished roster still belongs
        // to the credential that is currently in effect.
        const latest = await runtime.store.current()
        const latestIdentity = latest === undefined ? undefined : credentialIdentity(latest)
        if (latestIdentity !== identity) {
          adoptIdentity(runtime, latestIdentity)
          if (latestIdentity !== undefined) await fetchCatalog(runtime, latestIdentity)
          return
        }
      } catch (error: unknown) {
        // Report only if this attempt is still the current one; a failure from
        // a superseded attempt must not overwrite the newer state's error.
        if (stopped || runtime.catalogGeneration !== generation) return
        runtime.lastFetchAtMs = Date.now()
        runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error)
        ctx.logger.warn(
          `dsh-qoder-connect: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`,
          error,
        )
        runtime.invalidate()
        return
      }
      if (stopped || runtime.catalogGeneration !== generation) return
      runtime.lastFetchAtMs = Date.now()
      runtime.catalog.set([...models])
      runtime.catalogSource = 'live'
      runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now()
      runtime.catalogError = undefined
      // Remember it for this account, so a restart — or a later fetch that
      // fails — can serve what this account was actually shown rather than the
      // snapshot compiled into the plugin. A failure to persist is reported and
      // swallowed: the live catalog is already serving, and `fetchCatalog`
      // promises its callers that it never rejects (an escaped rejection from a
      // background sweep would terminate the host).
      if (lastIdentities.get(runtime.variant.id) === identity) {
        try {
          runtime.savedCatalogs.set(identity, {
            source: runtime.client.lastCatalog?.source ?? 'unknown',
            fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
            models: [...models],
          })
        } catch (error: unknown) {
          ctx.logger.warn(
            `dsh-qoder-connect: ${runtime.variant.displayName} catalog could not be saved for this account`,
            error,
          )
        }
      }
      runtime.invalidate()
    })().finally(() => {
      if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = undefined
    })
    runtime.inflightFetch = { identity, generation, controller, promise: run }
    return run
  }

  /**
   * Reconcile one variant with its credentials.
   *
   * Four transitions matter, and each is a different action:
   *
   * - **none → some** (first sighting): reveal the group and fetch a catalog.
   * - **none → some, identity changed**: additionally drop the previous
   *   account's observations, so another token's probe answers cannot be read
   *   as the new one's.
   * - **some → none**: hide the group and stop serving its models.
   * - **same identity**: nothing to do — a PAT neither rotates nor expires, so
   *   re-fetching on every sweep would hit the catalog endpoint for no new
   *   information.
   */
  const syncVariant = async (runtime: VariantRuntime): Promise<void> => {
    if (stopped || !runtime.registered) return
    const credential = await runtime.store.current().catch((error: unknown) => {
      // A region mismatch or an unreadable file is reported, not swallowed as
      // "signed out": the user needs to know which file to fix.
      ctx.logger.warn(`dsh-qoder-connect: ${runtime.variant.displayName} credential read failed`, error)
      return undefined
    })
    if (stopped) return

    if (credential === undefined) {
      adoptIdentity(runtime, undefined)
      return
    }

    const identity = credentialIdentity(credential)
    const known = lastIdentities.get(runtime.variant.id)
    if (known === identity && runtime.catalog.isVisible()) {
      // Same account, already showing something. One case still needs a fetch:
      // an earlier attempt failed, so the group is on the fallback roster and
      // nothing else will ever replace it. Retry on a slow backoff rather than
      // every sweep, so a persistent outage does not become a request loop.
      // Any non-live source is stale: both the saved catalog and the built-in
      // roster are worth replacing with a fresh fetch on the same backoff.
      const stale = runtime.catalogSource !== 'live'
      const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS
      if (stale && due) await fetchCatalog(runtime, identity)
      return
    }

    adoptIdentity(runtime, identity)
    await fetchCatalog(runtime, identity)
  }

  /** Run one reconcile sweep across both variants. */
  const syncAll = async (): Promise<void> => {
    for (const runtime of runtimes) await syncVariant(runtime)
  }

  /**
   * Start both variants, then begin the credential sweep.
   *
   * The chain carries its own failure handler: without one, a rejection here
   * would be an unhandled rejection — which Node turns into process
   * termination, taking the whole Harness down over one plugin's startup.
   */
  detach(ctx, Promise.all(runtimes.map(async runtime => startVariant(ctx, runtime))).then(() => {
    if (stopped) return
    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal; a stale heartbeat
    // after a crash is detected by PID in the reader. Written when at least one
    // variant registered, since that is what "the host bundle serves models"
    // means for this plugin.
    if (runtimes.some(runtime => runtime.registered)) detach(ctx, writeHostHeartbeat(), 'host heartbeat write')

    detach(ctx, syncAll(), 'credential sweep')
    const timer = setInterval(() => { detach(ctx, syncAll(), 'credential sweep') }, credentialPollMs())
    timer.unref?.()
    timers.push(timer)
  }), 'variant startup')
}

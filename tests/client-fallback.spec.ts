/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
} from '../src/status-paths.ts'

/**
 * The client entry degrades a slot-API breaking change (the rc.6→rc.7
 * `id`→`key` rename that caused the red "Failed to load plugins" banner)
 * to a console.error, so the host provider keeps working without a banner.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages, and its dashboard internals need the DOM); instead we replicate the
 * try/catch shape from `src/client/index.tsx` and assert it swallows a
 * simulated throw at each guarded boundary.
 *
 * DRIFT WARNING: the `apply()` below is a manual mirror of the real `apply()`
 * in `src/client/index.tsx` (see the NOTE on that function). It is NOT the
 * product code, so these tests prove the fallback boundaries work — they cannot
 * by themselves detect a regression in the real entry. The final case closes
 * that gap mechanically: it reads the entry off disk and requires every
 * `console.error` message, every `ctx.effect` label, and the locale namespace
 * it registers to appear VERBATIM in this file's own source. Change the real
 * entry's guarded body or one of those literals without updating the mirror,
 * and that case fails.
 */

/** The variant ids, mirroring `QODER_CARD_VARIANTS` in QoderPluginCard.tsx. */
const CARD_VARIANT_IDS = ['qoder', 'qoder-global'] as const

/** The status routes per variant id, mirroring VARIANT_STATUS in the entry. */
const VARIANT_STATUS: Record<string, string> = {
  qoder: QODER_STATUS_PATH,
  'qoder-global': QODER_GLOBAL_STATUS_PATH,
}

/**
 * The configuration-face constants, mirroring src/client/index.tsx.
 *
 * `QUOTA_SETTINGS_NAMESPACE` is the 0.1.5 namespace the Host serves this
 * plugin's quota section under; `ENTRY_ID` is the 0.1.7 `configForms` key,
 * which is the PROFILE ENTRY ID (this bundle's patch inserts the row as
 * `llm-qoder`), not the package name. The `SHARED_*` pair is the《插件设置》
 * block the three connect plugins rendezvous on.
 */
const QUOTA_SETTINGS_NAMESPACE = 'qoder-quota'
/** Minimal component stand-in: the mirror never renders anything. */
const Component = (): null => null

/**
 * Mirror of src/client/index.tsx apply() body.
 */
function apply(ctx: any): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, { zh: {}, en: {} }), 'dsh-qoder-connect: settings copy')
    const t = ctx.locale.bind(namespace)

    let quotaScope: any
    const adoptQuotaScope = (scope: any): void => {
      quotaScope = scope
      const applySnapshot = (): void => {
        const value = scope.getSnapshot().value
        void value
      }
      applySnapshot()
      scope.subscribe(applySnapshot)
    }

    // Unified Qoder plugin configuration card:
    // 恢复入口至「设置 - 插件 - 插件配置」(settings.plugin.item)
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'qoder',
      priority: 50,
      inject: () => ({
        t,
        scope: quotaScope,
        signedIn: () => ({ cn: false, global: false }),
        unified: true,
      }),
    }, Component))

    // Dashboard internals stand-ins (see the note above).
    const QUOTA_PANEL_ID = 'qoder-quota-panel'
    const CONVERSATION_PANEL_ID = 'conversation'
    let dashboardRequestedPath: string = QODER_STATUS_PATH
    /** Whether the dashboard is the CURRENT center panel (its mount owns this). */
    let quotaPanelOpen = false
    const notifyDashboard = (): void => {}
    const refreshDashboard = async (_options: { force?: boolean } = {}): Promise<void> => {}

    ctx.effect(() => Component(), 'dsh-qoder-connect: quota styles')

    const panelFace = (): any => ({
      t,
      statusPaths: [QODER_STATUS_PATH, QODER_GLOBAL_STATUS_PATH],
      refresh: () => { void refreshDashboard({ force: true }) },
      onVariantPicked: (path: string) => {
        dashboardRequestedPath = path
        notifyDashboard()
        void refreshDashboard()
      },
      close: () => {
        const layout = ctx.get('layout') as { selectPanel: (id: string | null) => void } | undefined
        if (typeof layout?.selectPanel !== 'function') return
        try {
          layout.selectPanel(null)
        } catch {
          try {
            layout.selectPanel(CONVERSATION_PANEL_ID)
          } catch (error: unknown) {
            console.error('[dsh-qoder-connect] could not close the quota panel:', error)
          }
        }
      },
    })
    void panelFace

    try {
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: QUOTA_PANEL_ID, locale: 'panel.qoder-quota', inject: panelFace },
        Component,
      ))
    } catch (error: unknown) {
      console.error('[dsh-qoder-connect] could not register the quota dashboard:', error)
    }

    ctx.inject(['layout'], (layoutCtx: any) => {
      const layout = layoutCtx.get('layout') as { selectPanel: (id: string | null) => void } | undefined
      if (typeof layout?.selectPanel !== 'function') return
      try {
        for (const variantId of CARD_VARIANT_IDS) {
          const statusPath = VARIANT_STATUS[variantId]
          if (statusPath === undefined) continue
          const injected = {
            t,
            statusPath,
            // Toggle semantics: the card of the variant ALREADY showing closes
            // the panel; the other card switches to it and keeps it open.
            open: () => {
              if (quotaPanelOpen && dashboardRequestedPath === statusPath) {
                layout.selectPanel(null)
                return
              }
              dashboardRequestedPath = statusPath
              notifyDashboard()
              void refreshDashboard()
              layout.selectPanel(QUOTA_PANEL_ID)
            },
          }
          layoutCtx.slots.inject('sidebar.footer.action', () => layoutCtx.slots.register({
            name: 'sidebar.footer.action',
            id: variantId === 'qoder' ? 'qoder-quota' : 'qoder-global-quota',
            order: variantId === 'qoder' ? 20 : 21,
            locale: 'panel.qoder-quota',
            inject: () => injected,
          }, Component))
        }
      } catch (error: unknown) {
        console.error('[dsh-qoder-connect] could not register the sidebar footer card:', error)
      }
    })

    ctx.inject(['modelDirectories'], (scope: any) => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'qoder-probe',
        order: 10,
        inject: () => ({ t }),
      }, Component))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    console.error('[dsh-qoder-connect] client card failed to load (host provider unaffected):', error)
  }
}

interface FakeContext {
  readonly ctx: any
  readonly injections: string[]
  readonly registerCalls: Record<string, unknown>[]
}

/**
 * A stand-in for the DSH client context. `throwOn` names the service call that
 * must fail, which is how each test moves a different guarded boundary.
 *
 * `host` picks which configuration service exists, because exactly one of the
 * two ever does: DSH 0.1.5 serves `settingsScope` and the Plugins-tab card list,
 * DSH 0.1.7 serves `configForms` and the shared 《插件设置》 block instead. A
 * `ctx.inject` whose service is absent never calls back — that is the property
 * the entry relies on, so the stand-in reproduces it rather than handing every
 * callback a context.
 */
function fakeContext(
  throwOn: { slot?: string; scopeBind?: boolean; containerRace?: boolean } = {},
  host: '0.1.5' | '0.1.7' = '0.1.5',
): FakeContext {
  const injections: string[] = []
  const registerCalls: Record<string, unknown>[] = []
  const slots = {
    inject: (name: string, factory: () => unknown) => {
      if (throwOn.slot !== undefined && throwOn.slot === name) {
        throw new Error(`keyed slot "${name}" requires options.key`)
      }
      injections.push(name)
      // The mirror's factories only run when the settings page renders; the
      // register call is recorded here so a test can assert the contribution.
      const contribution = factory()
      if (typeof contribution === 'function') return contribution
      return () => {}
    },
    register: (options: Record<string, unknown>, component: unknown) => {
      registerCalls.push({ ...options, component })
      return () => {}
    },
    entries: (name: string) => registerCalls
      .filter(call => call['name'] === name)
      .map(call => ({ options: { id: call['id'] } })),
  }
  const layout = { selectPanel: () => {} }
  const ctx: any = {
    effect: (fn: () => unknown) => { fn() },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots,
    get: (name: string) => (name === 'layout' ? layout : undefined),
    inject: (deps: string[], cb: (scope: any) => void) => {
      if (throwOn.slot !== undefined && deps.includes(throwOn.slot)) return
      cb({ get: ctx.get, slots })
    },
  }
  return { ctx, injections, registerCalls }
}

/** Console.error calls captured as strings. */
function useErrorSpy(): { errors: string[]; restore: () => void } {
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
  return { errors, restore: () => spy.mockRestore() }
}

describe('client card fallback', () => {
  it('swallows a slot registration failure instead of throwing', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx } = fakeContext({ slot: 'settings.plugin.item' })

    // Must not throw — the whole point of the fallback.
    expect(() => apply(ctx)).not.toThrow()

    // The error is visible in the console for developers.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('[dsh-qoder-connect] client card failed to load')
    expect(errors[0]).toContain('requires options.key')

    restore()
  })

  it('still registers the sidebar cards and the composer entry when the panel slot breaks', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections } = fakeContext({ slot: 'main' })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('could not register the quota dashboard')
    // A dead dashboard cell must not take the rest of the plugin with it.
    expect(injections).toContain('sidebar.footer.action')
    expect(injections).toContain('conversation.input.right')

    restore()
  })

  it('still registers the composer entry when the sidebar footer seat breaks', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections } = fakeContext({ slot: 'sidebar.footer.action' })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('could not register the sidebar footer card')
    expect(injections).toContain('conversation.input.right')

    restore()
  })

  it('contributes unified card, the panel seat, and the probe seat', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections, registerCalls } = fakeContext()

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])
    expect(injections.filter(name => name === 'settings.plugin.item')).toHaveLength(1)
    expect(injections).toContain('main')
    expect(injections).toContain('sidebar.footer.action')
    expect(injections).toContain('conversation.input.right')

    // The seats this plugin claims, by their Qoder keys and ids.
    const pluginKeys = registerCalls.flatMap(call => typeof call['key'] === 'string' ? [call['key']] : [])
    expect(pluginKeys.sort()).toEqual(['qoder', 'qoder-quota-panel'])
    const seatIds = registerCalls.flatMap(call => typeof call['id'] === 'string' ? [call['id']] : [])
    expect(seatIds.sort()).toEqual(['qoder-global-quota', 'qoder-probe', 'qoder-quota'])
    // The probe seat belongs to the international-or-not composer chrome this
    // plugin owns; its route pair is what the control reads.
    expect(QODER_PROBE_PATH).toBe('/plugins/dsh-qoder-connect/probe')

    restore()
  })

})

describe('mirror stays verbatim with src/client/index.tsx', () => {
  const entrySource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const mirrorSource = readFileSync(new URL(import.meta.url), 'utf8')

  it('every console.error message in the entry is mirrored word for word', () => {
    const messages = [...entrySource.matchAll(/console\.error\(\s*'([^']+)'/g)].map(match => match[1]!)
    expect(messages).toHaveLength(4)
    for (const message of messages) {
      expect(mirrorSource).toContain(message)
    }
  })

  it('every effect label and locale namespace in the entry is mirrored', () => {
    const labels = [...entrySource.matchAll(/,\s*'(dsh-qoder-connect: [^']+)'/g)].map(match => match[1]!)
    expect(labels).toEqual(['dsh-qoder-connect: settings copy', 'dsh-qoder-connect: quota styles'])
    for (const label of labels) expect(mirrorSource).toContain(label)
    // The two locale namespaces and the settings namespace the scope binds.
    expect(entrySource).toContain("'settings.qoder'")
    expect(entrySource).toContain("'panel.qoder-quota'")
    expect(mirrorSource).toContain("'settings.qoder'")
    expect(mirrorSource).toContain("'panel.qoder-quota'")
  })

  it('the entry has no legacy brand literal left anywhere', () => {
    // Assembled at runtime so this spec's own source stays out of its way.
    const legacy = ['work', 'buddy'].join('')
    expect(entrySource.toLowerCase()).not.toContain(legacy)
    expect(mirrorSource.toLowerCase()).not.toContain(legacy)
  })

  it('every seat this plugin claims in the entry is claimed by the mirror too', () => {
    // The registration identity of the plugin: slot names plus the keys/ids it
    // contributes. A rename on one side and not the other is exactly the drift
    // the mirror obligation warns about.
    const seats = [
      'settings.plugin.item', 'conversation.input.right', 'sidebar.footer.action',
      'qoder-global-quota', 'qoder-quota-panel', 'qoder-probe',
    ]
    for (const seat of seats) {
      expect(entrySource).toContain(seat)
      expect(mirrorSource).toContain(seat)
    }
  })
})

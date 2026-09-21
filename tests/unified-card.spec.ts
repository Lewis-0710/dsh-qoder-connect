import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderPluginCard, type QoderPluginCardProps } from '../src/client/QoderPluginCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { QoderSettingsKey } from '../src/client/locales.ts'
import { noteQuotaSignIn } from '../src/client/quota-settings-store.ts'
import { QODER_AUTH_PATH, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../src/status-paths.ts'

const t = (key: QoderSettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

describe('Unified Qoder Plugin Card', () => {
  let view: ReactTestRenderer | undefined
  const request = vi.fn()
  const postedActions: { url: string; body: unknown }[] = []

  beforeEach(() => {
    postedActions.length = 0
    request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postedActions.push({ url, body })
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      }
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', savedAtMs: 1700000000000, patTail: '1111' },
            authKey: 'cn-auth-key',
            credits: { total: 30, accounts: [] },
            models: [],
          }),
        }
      }
      if (path === QODER_GLOBAL_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-out',
            region: 'global',
            authKey: 'global-auth-key',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => cb(0))
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    noteQuotaSignIn('qoder', false)
    noteQuotaSignIn('qoder-global', false)
    vi.unstubAllGlobals()
  })

  async function mountUnified(): Promise<void> {
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: true, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
    const props = {
      t: t as QoderPluginCardProps['t'],
      unified: true,
      scope: fakeScope as any,
      signedIn: () => ({ cn: true, global: false }),
    } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => {
      view = create(createElement(QoderPluginCard, props))
    })
  }

  it('renders the unified title and intro in collapsed state', async () => {
    await mountUnified()
    const json = JSON.stringify(view!.toJSON())
    expect(json).toContain(en.unifiedTitle)
    expect(json).toContain(en.unifiedIntro)
  })

  it('expands to show quota settings at the top, followed by the segmented tabs', async () => {
    await mountUnified()
    // Click header to expand
    const headerBtn = view!.root.findAllByType('button')[0]!
    await act(async () => { headerBtn.props.onClick() })

    const json = JSON.stringify(view!.toJSON())
    // 1. Top section: Quota settings
    expect(json).toContain(en.quotaToggleCN)
    expect(json).toContain(en.quotaToggleGlobal)
    expect(json).toContain(en.quotaPollLabel)

    // 2. Segmented Tabs
    expect(json).toContain(en.variantTabCN)
    expect(json).toContain(en.variantTabGlobal)

    // 3. Default active is CN (signed-in in our mock)
    expect(json).toContain(t('patTail', { tail: '****1111' }))
  })

  it('switches between China and Global tabs when clicked', async () => {
    await mountUnified()
    // Click header to expand
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })

    // Find the segmented tab buttons: China and Global
    const tabList = view!.root.find(n => n.props.role === 'tablist' && n.props['aria-label'] === 'Qoder Version Selection')
    const tabButtons = tabList.findAllByType('button')
    expect(tabButtons).toHaveLength(2)

    // Click Global tab (second tab)
    const globalTab = tabButtons[1]!
    await act(async () => { globalTab.props.onClick() })

    let json = JSON.stringify(view!.toJSON())
    // Global is signed out in mock, so it shows signed-out hint and Global PAT guide
    expect(json).toContain(en.signedOutHintAI)
    expect(json).toContain(en.patGuideAI)

    // Click China tab again (first tab)
    const cnTab = tabButtons[0]!
    await act(async () => { cnTab.props.onClick() })

    json = JSON.stringify(view!.toJSON())
    expect(json).toContain(t('patTail', { tail: '****1111' }))
  })

  it('reactively enables sidebar quota toggle when user signs in or saves PAT', async () => {
    let cnSignedIn = false
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postedActions.push({ url, body })
        if (body.action === 'save-pat') {
          cnSignedIn = true
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      }
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => cnSignedIn ? ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', savedAtMs: 1700000000000, patTail: '2222' },
            authKey: 'cn-auth-key',
            credits: { total: 50, accounts: [] },
            models: [],
          }) : ({
            status: 'signed-out',
            region: 'china',
            authKey: 'cn-auth-key',
          }),
        }
      }
      if (path === QODER_GLOBAL_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-out',
            region: 'global',
            authKey: 'global-auth-key',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: false, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
    const props = {
      t: t as QoderPluginCardProps['t'],
      unified: true,
      scope: fakeScope as any,
    } as unknown as Parameters<typeof QoderPluginCard>[0]

    await act(async () => {
      view = create(createElement(QoderPluginCard, props))
    })

    // Expand the card
    const headerBtn = view!.root.findAllByType('button')[0]!
    await act(async () => { headerBtn.props.onClick() })

    // Find the toggle switches: first one is China quota toggle
    const switches = view!.root.findAll(n => n.props.role === 'switch')
    expect(switches.length).toBeGreaterThanOrEqual(2)
    const cnSwitch = switches[0]!
    // Initially disabled because cn is signed out
    expect(cnSwitch.props.disabled).toBe(true)

    // Fill in PAT input and click save
    const patInput = view!.root.find(n => n.type === 'input' && n.props.type === 'password')
    await act(async () => {
      patInput.props.onChange({ target: { value: 'test-pat-token' } })
    })

    // Click save button
    const saveBtn = view!.root.findAll(n => n.type === 'button' && n.props.children === en.patSave)[0]!
    await act(async () => {
      await saveBtn.props.onClick()
    })

    // After saving PAT, China switch must be reactively enabled!
    const updatedSwitches = view!.root.findAll(n => n.props.role === 'switch')
    const updatedCnSwitch = updatedSwitches[0]!
    expect(updatedCnSwitch.props.disabled).toBe(false)
  })
})

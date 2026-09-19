/**
 * Live end-to-end check (NOT part of the offline test suite):
 * adapter -> pi-ai -> loopback shim -> real Qoder upstream, driven by a
 * Personal Access Token. Run from the package root, after `pnpm run build`:
 *
 *   node --experimental-strip-types scripts/live-e2e.mjs [--global]
 *
 * The credential is whatever the store resolves — a saved card PAT under
 * DSH_QODER_DATA_DIR, or the environment fallback (QODER_PERSONAL_ACCESS_TOKEN
 * for the international arm, QODER_CN_PERSONAL_ACCESS_TOKEN for China).
 * Nothing is asserted against production behavior: if the upstream is simply
 * unreachable, the script skips (exit 0) rather than reporting a failure.
 *
 * `createQoderTransport` is not part of the published lib surface, so the
 * transport factory is imported from source (hence the strip-types flag);
 * everything else comes from the built lib.
 */
import {
  CHINA_VARIANT,
  GLOBAL_VARIANT,
  QoderCatalog,
  QoderCredentialStore,
  QoderUpstreamClient,
  createQoderAdapter,
  createQoderShim,
} from '../lib/index.js'
import { createQoderTransport } from '../src/qoder/transport/index.ts'

const variant = process.argv.includes('--global') ? GLOBAL_VARIANT : CHINA_VARIANT
console.log(`variant: ${variant.id} (region ${variant.region})`)

const store = new QoderCredentialStore({ variant })
const credential = await store.current()
if (credential === undefined) {
  console.error(
    'no Personal Access Token resolved — save one through the settings card, '
    + `or set ${variant.region === 'global' ? 'QODER_PERSONAL_ACCESS_TOKEN' : 'QODER_CN_PERSONAL_ACCESS_TOKEN'}`,
  )
  process.exit(1)
}
const pat = credential.pat

const transport = createQoderTransport({
  region: variant.region,
  resolvePat: async () => pat,
})
const client = new QoderUpstreamClient({
  region: variant.region,
  providerId: variant.id,
  getPat: async () => pat,
  transport,
})

// Reachability pre-check before wiring the seat together. A network that is
// down is not a code failure, so this path skips clean; anything the upstream
// actively answers back (401, quota, malformed) is a real failure to show.
let models
try {
  models = await client.fetchModels()
} catch (error) {
  const text = `${error instanceof Error ? error.message : String(error)} ${error instanceof Error ? error.cause ?? '' : ''}`
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|timeout|abort/iu.test(text)) {
    console.log(`SKIP: upstream unreachable (${text.trim().slice(0, 200)})`)
    process.exit(0)
  }
  console.error(`upstream refused the credential: ${text.trim().slice(0, 300)}`)
  process.exit(1)
}
console.log(`upstream catalog (${models.length}): ${models.map(model => model.id).join(', ')}`)

const catalog = new QoderCatalog(models)
const shim = createQoderShim({ store, client, catalog, providerId: variant.id })
await shim.ready
console.log('shim listening:', shim.baseUrl())

const { adapter } = createQoderAdapter({ providerId: variant.id, shim, store, catalog })
const staticList = await adapter.listModels(variant.id)
console.log('adapter catalog:', staticList.map(model => model.id).join(', '))
const resolved = await adapter.resolveModel(variant.id, 'auto')
console.log('resolved auto:', JSON.stringify(resolved))

console.log('streaming one reply …')
let text = ''
let usage
for await (const chunk of adapter.stream({
  provider: variant.id,
  model: 'auto',
  system: '你是简洁的中文助手。',
  messages: [{
    id: 'e2e-1',
    role: 'user',
    content: [{ type: 'text', text: '只回复八个字以内：链路验证成功' }],
    source: { kind: 'user' },
  }],
})) {
  if (chunk.type === 'text-delta' || chunk.type === 'text') {
    text += chunk.text ?? chunk.delta ?? ''
  } else if (chunk.type === 'usage' || chunk.usage !== undefined) {
    usage = chunk.usage ?? chunk
  }
}
console.log('reply:', JSON.stringify(text))
console.log('usage:', usage !== undefined ? JSON.stringify(usage) : '(none reported)')

const credits = await client.fetchCredits()
console.log('cycle usage %:', credits.total, credits.unlimited === true ? '(unlimited)' : `(packages: ${credits.accounts.length})`)
await shim.close()
console.log('E2E OK')

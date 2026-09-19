#!/usr/bin/env node
/**
 * Shim security verification: proves the hardened Qoder shim rejects hostile
 * inbound requests and unauthenticated local processes, while accepting the
 * plugin's own legitimate client.
 *
 * Usage: node scripts/verify-shim-hardening.mjs   (after `pnpm run build`)
 *
 * It spins up the shim with a fake upstream, then fires six raw HTTP
 * requests at it:
 *   1. hostile Host (DNS-rebinding shape)          -> expect 403
 *   2. hostile browser Origin (cross-site page)    -> expect 403
 *   3. non-JSON Content-Type (simple CSRF shape)   -> expect 415
 *   4. legitimate shape with the shared secret     -> expect 200
 *   5. legitimate shape WITHOUT the secret         -> expect 401
 *   6. legitimate shape with a wrong secret        -> expect 401
 * Exits 0 only when all six behave as hardened code should.
 */
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHINA_VARIANT,
  QoderCatalog,
  QoderCredentialStore,
  createQoderShim,
} from '../lib/index.js'

function rawRequest(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const dir = await mkdtemp(join(tmpdir(), 'qoder-verify-'))

const store = new QoderCredentialStore({
  variant: CHINA_VARIANT,
  ownPath: join(dir, CHINA_VARIANT.ownFilename),
})
await store.save('pt-hardening-check')

const shim = createQoderShim({
  store,
  providerId: 'qoder',
  catalog: new QoderCatalog(),
  client: {
    async chatStream() {
      return {
        ok: true,
        response: new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      }
    },
  },
})
await shim.ready
const port = Number(new URL(shim.baseUrl()).port)

let failures = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected}`)
  if (!ok) failures += 1
}

// 1. DNS-rebinding shape: hostile Host
check('hostile Host rejected (DNS rebinding)',
  (await rawRequest(port, 'GET', '/healthz', { host: 'evil.com' })).status, 403)

// 2. Cross-site browser page: hostile Origin
check('hostile Origin rejected (browser CSRF)',
  (await rawRequest(port, 'POST', '/v1/chat/completions', {
    host: `127.0.0.1:${port}`, origin: 'https://evil.com', 'content-type': 'application/json',
  }, JSON.stringify({ model: 'ultimate', messages: [] }))).status, 403)

// 3. Simple-request CSRF shape: non-JSON Content-Type (bearer present so the
//    401 gate is not what's being tested here)
check('non-JSON Content-Type rejected (415)',
  (await rawRequest(port, 'POST', '/v1/chat/completions', {
    host: `127.0.0.1:${port}`, 'content-type': 'text/plain',
    authorization: `Bearer ${shim.token()}`,
  }, JSON.stringify({ model: 'ultimate', messages: [] }))).status, 415)

// 4. Legitimate loopback client shape with the shared-secret bearer
check('legitimate loopback request (with bearer) accepted',
  (await rawRequest(port, 'POST', '/v1/chat/completions', {
    host: `127.0.0.1:${port}`, 'content-type': 'application/json',
    authorization: `Bearer ${shim.token()}`,
  }, JSON.stringify({ model: 'ultimate', messages: [] }))).status, 200)

// 5. Loopback shape WITHOUT the bearer — a hostile local process that knows
//    the port but cannot read the secret out of the plugin's memory.
check('loopback request without bearer rejected (local attacker)',
  (await rawRequest(port, 'GET', '/healthz', {
    host: `127.0.0.1:${port}`,
  })).status, 401)

// 6. Wrong bearer — must also be rejected.
check('wrong bearer rejected',
  (await rawRequest(port, 'POST', '/v1/chat/completions', {
    host: `127.0.0.1:${port}`, 'content-type': 'application/json',
    authorization: 'Bearer not-the-real-secret',
  }, JSON.stringify({ model: 'ultimate', messages: [] }))).status, 401)

await shim.close()
await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nSHIM HARDENING VERIFIED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runLocalCarryExitV2NoNeonIssueTick } from '../../scripts/research/carry-local-exit-v2-no-neon-issue.mjs'

const now = () => new Date('2026-10-07T12:11:00.000Z')

function client(url) {
  return {
    url,
    provider: new URL(url).origin,
    async request() {
      throw Error('unexpected_rpc_request')
    },
    async send() {
      throw Error('unexpected_rpc_send')
    },
  }
}

test('constructs the designated verifier alongside eight configured clients', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'carry-exit-v2-verifier-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const configured = Array.from({ length: 8 }, (_, index) =>
    client(`https://rpc-${index}.example/rpc`),
  )
  const verifier = client('https://verification.example/rpc')
  const transportUrls = []
  const issued = []
  const issuer =
    (family) =>
    async ({ primary, secondary }) => {
      issued.push({ family, primary: primary?.url, secondary: secondary?.url })
      return { status: 'unavailable', reason: 'fixture' }
    }

  const result = await runLocalCarryExitV2NoNeonIssueTick({
    sourcePreparation: { enabled: false },
    root,
    now,
    minFreeBytes: 0,
    clients: configured,
    verificationUrl: verifier.url,
    transport: (url) => {
      transportUrls.push(url)
      return verifier
    },
    chooseMorphoOrigin: (urls, _route, getClient) => getClient(urls[0]),
    chooseDirectOrigin: (urls, _route, getClient) => getClient(urls[0]),
    issueMorpho: issuer('morpho'),
    issueDirect: issuer('direct'),
    issueSyncVault: issuer('sync_vault'),
  })

  assert.deepEqual(transportUrls, [verifier.url])
  assert.equal(issued.length, 3)
  assert.ok(issued.every((entry) => entry.secondary === verifier.url))
  assert.ok(issued.every((entry) => entry.primary === configured[0].url))
  assert.ok(result.results.every((entry) => entry.reason === 'fixture'))
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from 'viem'
import { collect, readValidatedReceipts, sourceIdentity } from './curve-vault-flow-ledger.mjs'

const source = sourceIdentity()
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const hex = (n) => `0x${n.toString(16)}`
const stat = () => ({ bavail: 10_000_000, bsize: 4096 })
const asset = encodeFunctionResult({
  abi: parseAbi(['function asset() view returns (address)']),
  functionName: 'asset',
  result: source.asset,
})
const BASE = 1_790_000_000

function vaultLog(kind, block, amount) {
  const topic0 = source.streams.find((stream) => stream.kind === kind).topic0
  const actor = hash(1)
  return {
    address: source.vault,
    topics: kind === 'deposit' ? [topic0, actor, actor] : [topic0, actor, actor, actor],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, amount]),
    blockNumber: hex(block),
    blockHash: hash(block),
    transactionHash: hash(100 + block),
    transactionIndex: hex(0),
    logIndex: hex(0),
    removed: false,
  }
}

function rpc(logs) {
  return {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? 12 : Number(BigInt(params[0]))
        return {
          number: hex(n),
          hash: hash(n),
          timestamp: hex(BASE + (n - 10) * 400_000),
        }
      }
      if (method === 'eth_call') return asset
      if (method === 'eth_getLogs') {
        const filter = params[0]
        const topics = Array.isArray(filter.topics[0]) ? filter.topics[0] : [filter.topics[0]]
        return logs.filter(
          (row) =>
            Number(BigInt(row.blockNumber)) >= Number(BigInt(filter.fromBlock)) &&
            Number(BigInt(row.blockNumber)) <= Number(BigInt(filter.toBlock)) &&
            topics.includes(row.topics[0]),
        )
      }
      throw new Error(`Unexpected method ${method}`)
    },
  }
}

test('missing and injected sidecars never expose gross or net maxima', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corroborated-flow-'))
  const primaryOut = join(dir, 'primary')
  const sidecarOut = join(dir, 'sidecars')
  const logs = [
    vaultLog('deposit', 11, 20n * 10n ** 18n),
    vaultLog('withdraw', 12, 50n * 10n ** 18n),
  ]
  try {
    await collect({
      client: rpc(logs),
      out: primaryOut,
      source,
      fromBlock: 10,
      toBlock: 12,
      range: 3,
      maxChunks: 1,
      rpcHost: 'primary.example',
      now: () => new Date('2026-09-28T12:00:00.000Z'),
      stat,
    })
    const [{ summarizeCorroboratedFlow }, { reconcileReceipt }] = await Promise.all([
      import('./scrvusd-corroborated-flow-summary.mjs'),
      import('./scrvusd-flow-second-provider.mjs'),
    ])
    const options = { primaryOut, sidecarOut, source }
    const missing = summarizeCorroboratedFlow(options)
    assert.equal(missing.historical.reason, 'second_provider_coverage_incomplete')
    assert.equal(missing.historical.maximumObservedCompleteWindow, undefined)
    assert.equal(missing.current.status, 'unavailable')

    const receipt = readValidatedReceipts({ out: primaryOut, source })[0]
    await reconcileReceipt({
      receipt,
      primaryOut,
      out: sidecarOut,
      secondRpcUrl: 'https://secondary.example/rpc',
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body)
        const result = await rpc(logs).request(request)
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) }
      },
      source,
      stat,
    })
    const injected = summarizeCorroboratedFlow(options)
    assert.equal(injected.historical.reason, 'injected_transport_unattested')
    assert.equal(injected.historical.maximumObservedCompleteWindowNetDepletion, undefined)
    assert.equal(injected.current.status, 'unavailable')

    // Test-only substitute for a URL-bound fetch. Local SHA seals are not
    // signatures; provider ownership remains unverified even after this path.
    const sidecarPath = join(sidecarOut, `${receipt.sha256}.json`)
    const { sha256: _oldSha, ...body } = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    const urlBound = { ...body, transportMode: 'url_bound_fetch' }
    const sha256 = createHash('sha256').update(JSON.stringify(urlBound)).digest('hex')
    writeFileSync(sidecarPath, `${JSON.stringify({ ...urlBound, sha256 })}\n`)
    const historical = summarizeCorroboratedFlow(options)
    assert.equal(historical.operatorIndependence, 'unverified')
    assert.equal(historical.historical.status, 'research_only')
    assert.equal(historical.historical.publishable, false)
    assert.equal(historical.historical.forecastEligible, false)
    assert.equal(historical.historical.maximumObservedCompleteWindow['24h'].status, 'observed')
    assert.equal(
      historical.historical.maximumObservedCompleteWindowNetDepletion['7d'].status,
      'observed',
    )
    assert.equal(
      historical.current.reason,
      'archive_to_live_bridge_or_holder_executability_unproven',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('empty primary history remains unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corroborated-flow-empty-'))
  try {
    const { summarizeCorroboratedFlow } = await import('./scrvusd-corroborated-flow-summary.mjs')
    const result = summarizeCorroboratedFlow({
      primaryOut: dir,
      sidecarOut: join(dir, 'sidecars'),
      source,
    })
    assert.equal(result.historical.reason, 'no_primary_receipts')
    assert.equal(result.historical.maximumObservedCompleteWindow, undefined)
    assert.equal(result.current.status, 'unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

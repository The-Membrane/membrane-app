import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FROZEN_ROUTES, TOPICS, preflight } from './carry-direct-vault-flow-preflight.mjs'
import {
  MAX_TICK_RPC_BYTES,
  MAX_TICK_RPC_CALLS,
  captureNext,
  createPlan,
  validateProof,
  verify,
} from './carry-direct-vault-gross-flow.mjs'

const URLs = ['https://one.example', 'https://two.example']
const blockHash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const word = (value) => value.slice(2).padStart(64, '0')
const addressWord = (value) => `0x${word(value)}`

function fixture({ eventBlock = null, upgraded = false, runtimeAfter100 = false } = {}) {
  const requests = []
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    requests.push({ host: new URL(url).hostname, request })
    const [arg] = request.params
    let result
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const n = arg === 'finalized' ? 108 : Number(BigInt(arg))
      result = {
        number: `0x${n.toString(16)}`,
        hash: blockHash(n),
        parentHash: blockHash(n - 1),
        timestamp: `0x${(1_700_000_000 + n * 12).toString(16)}`,
      }
    } else if (request.method === 'eth_getCode')
      result =
        runtimeAfter100 && Number(BigInt(request.params[1].blockHash)) > 100
          ? '0x60026000'
          : '0x60016000'
    else if (request.method === 'eth_call') {
      const route = FROZEN_ROUTES.find((item) => item.vault === arg.to)
      result = addressWord(route.asset)
    } else if (request.method === 'eth_getStorageAt')
      result = addressWord(FROZEN_ROUTES[2].implementation)
    else if (request.method === 'eth_getLogs') {
      const filter = arg
      if (Array.isArray(filter.address))
        result = upgraded ? [{ address: FROZEN_ROUTES[0].vault }] : []
      else if (
        eventBlock !== null &&
        filter.address === FROZEN_ROUTES[1].vault &&
        Number(BigInt(filter.fromBlock)) <= eventBlock &&
        Number(BigInt(filter.toBlock)) >= eventBlock
      )
        result = [
          {
            address: FROZEN_ROUTES[1].vault,
            blockNumber: `0x${eventBlock.toString(16)}`,
            blockHash: blockHash(eventBlock),
            transactionHash: blockHash(999),
            logIndex: '0x0',
            removed: false,
            topics: [
              TOPICS.deposit,
              addressWord(FROZEN_ROUTES[1].vault),
              addressWord(FROZEN_ROUTES[1].vault),
            ],
            data: `0x${'0'.repeat(63)}5${'0'.repeat(63)}1`,
          },
        ]
      else result = []
    } else throw Error('unexpected_method')
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  const preflightImpl = (args) => preflight({ ...args, toBlock: args.toBlock ?? 100 })
  return { fetchImpl, preflightImpl, requests }
}

test('append-only recorder seals contiguous eventful range with event-block identity replay', async () => {
  const out = mkdtempSync(join(tmpdir(), 'direct-vault-flow-'))
  try {
    const source = fixture({ eventBlock: 107 })
    const plan = await createPlan({ urls: URLs, out, ...source })
    assert.equal(plan.anchor.number, 100)
    assert.equal(verify(out).ranges, 0)
    const captured = await captureNext({ urls: URLs, out, ...source })
    assert.equal(captured.captured, 1)
    assert.equal(captured.through, 108)
    assert.ok(captured.rpcCalls <= MAX_TICK_RPC_CALLS)
    assert.ok(captured.rpcBytes <= MAX_TICK_RPC_BYTES)
    assert.equal(captured.ranges[0].grossTotals[1].depositCount, 1)
    assert.equal(captured.ranges[0].grossTotals[1].depositAssetsRaw, '5')
    assert.equal(captured.ranges[0].grossTotals[1].holderPayout, undefined)
    assert.equal(verify(out).ranges, 1)
    const row = JSON.parse(readFileSync(join(out, 'range-00000001.json')))
    assert.equal(row.from, 101)
    assert.equal(row.to, 108)
    assert.equal(row.eventBlockProofs.length, 1)
    assert.equal(row.identityTiming, 'end_of_block_event_schema_at_tracked_address')
    assert.equal(row.holderPayout, 'not_measured')
    assert.equal(
      source.requests.filter(
        (entry) =>
          entry.request.method === 'eth_getLogs' && Array.isArray(entry.request.params[0].address),
      ).length,
      2,
    )
    row.grossTotals[1].depositCount = 2
    writeFileSync(join(out, 'range-00000001.json'), `${JSON.stringify(row)}\n`)
    assert.throws(() => verify(out), /file_sha/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('observed proxy upgrade prevents cursor advance', async () => {
  const out = mkdtempSync(join(tmpdir(), 'direct-vault-upgrade-'))
  try {
    const source = fixture({ upgraded: true })
    await createPlan({ urls: URLs, out, ...source })
    await assert.rejects(captureNext({ urls: URLs, out, ...source }), /upgrade_observed/)
    assert.equal(verify(out).ranges, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('runtime drift without an Upgraded log also prevents cursor advance', async () => {
  const out = mkdtempSync(join(tmpdir(), 'direct-vault-runtime-'))
  try {
    const source = fixture({ runtimeAfter100: true })
    await createPlan({ urls: URLs, out, ...source })
    await assert.rejects(captureNext({ urls: URLs, out, ...source }), /identity_drift/)
    assert.equal(verify(out).ranges, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('preflight proof verifier rejects route mutation', async () => {
  const source = fixture()
  const proof = await source.preflightImpl({ urls: URLs, fetchImpl: source.fetchImpl })
  assert.equal(validateProof(proof).range.to, 100)
  proof.routes[0].vault = FROZEN_ROUTES[1].vault
  assert.throws(() => validateProof(proof), /proof_route/)
  proof.routes[0].vault = FROZEN_ROUTES[0].vault
  const runtimeSha = proof.routes[0].witnesses[0].runtime.sha256
  proof.routes[0].witnesses[0].runtime.sha256 = '0'.repeat(64)
  assert.throws(() => validateProof(proof), /proof_raw_runtime/)
  proof.routes[0].witnesses[0].runtime.sha256 = runtimeSha
  proof.routes[0].status = 'standard_events_observed'
  assert.throws(() => validateProof(proof), /proof_status/)
})

test('oversized local receipt is rejected before parsing', () => {
  const out = mkdtempSync(join(tmpdir(), 'direct-vault-oversize-'))
  try {
    const path = join(out, 'plan.json')
    writeFileSync(path, 'x')
    truncateSync(path, 2 * 1024 * 1024 + 1)
    assert.throws(() => verify(out), /file_oversize/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

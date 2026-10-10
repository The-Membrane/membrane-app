import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  collectPrestate,
  EXPECTED_SLOTS,
  loadPinnedSlots,
  RPC_TRANSPORT_OPTIONS,
  verifyReceipts,
} from './morpho-v2-route-prestate-screen.mjs'

const pinned = loadPinnedSlots()
const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const stat = () => ({ bavail: 4_000_000_000, bsize: 1 })
const abi = parseAbi([
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
])
function mock(
  index,
  {
    missing = false,
    failure = false,
    drift = false,
    truncate = false,
    supply = 100n,
    assets = 200n,
  } = {},
) {
  const slot = pinned.slots[index],
    preHash = H(1000 + slot.preBlock)
  let anchorReads = 0
  const calls = []
  const rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? slot.anchorBlock + 10 : Number(BigInt(params[0]))
      if (n === slot.anchorBlock) {
        anchorReads++
        return {
          number: `0x${n.toString(16)}`,
          hash: drift && anchorReads > 1 ? H(5) : slot.anchorBlockHash,
          parentHash: preHash,
        }
      }
      return {
        number: `0x${n.toString(16)}`,
        hash: n === slot.preBlock ? preHash : H(n),
        parentHash: H(n - 1),
      }
    }
    if (method === 'eth_getCode') return missing ? '0x' : '0x6000'
    if (method === 'eth_call') {
      if (failure) throw new Error('historical state unavailable: secret-rpc-key')
      if (truncate) return '0x'
      const name = ['asset', 'liquidityAdapter', 'totalSupply', 'totalAssets'].find(
        (candidate) => params[0].data === encodeFunctionData({ abi, functionName: candidate }),
      )
      if (!name) throw new Error('Unknown selector')
      const value = {
        asset: slot.asset,
        liquidityAdapter:
          slot.sourceExpectedPreRoute || '0x1111111111111111111111111111111111111111',
        totalSupply: supply,
        totalAssets: assets,
      }[name]
      return encodeFunctionResult({ abi, functionName: name, result: value })
    }
    throw new Error(`Unexpected ${method}`)
  }
  return { rpc, calls, preHash }
}
function output() {
  return mkdtempSync(join(tmpdir(), 'morpho-prestate-test-'))
}
function firstReceipt(out) {
  return join(
    out,
    readdirSync(out)
      .filter((name) => name.endsWith('.json'))
      .sort()[0],
  )
}

test('full physically pinned plan retains all unique vault x B-1 slots', () => {
  assert.equal(pinned.slots.length, EXPECTED_SLOTS)
  assert.equal(new Set(pinned.slots.map((s) => `${s.vault}:${s.preBlock}`)).size, EXPECTED_SLOTS)
  assert.equal(pinned.plan.sourceVerification, 'physically-pinned-factory-route-header')
  const indices = [...new Set(pinned.slots.map((s) => s.anchorIndex))]
  assert.deepEqual(
    indices,
    Array.from({ length: 116 }, (_, i) => i),
  )
  for (const index of indices) {
    const rows = pinned.slots.filter((s) => s.anchorIndex === index)
    assert.equal(rows[0].role, 'treated')
    assert.deepEqual(
      rows.slice(1).map((s) => s.vault),
      rows
        .slice(1)
        .map((s) => s.vault)
        .sort(),
    )
  }
})

test('production HTTP transport has no retry and the same response ceiling as the wrapper', () => {
  assert.deepEqual(RPC_TRANSPORT_OPTIONS, {
    retryCount: 0,
    timeout: 12_000,
    maxResponseBodySize: 256 * 1024,
  })
})

test('guard fires before any RPC', async () => {
  const { rpc, calls } = mock(0)
  const out = join(output(), 'nested', 'receipts')
  await assert.rejects(
    collectPrestate({
      out,
      pinned,
      rpc,
      fromIndex: 0,
      maxSlots: 1,
      stat: () => ({ bavail: 2_000_000_000, bsize: 1 }),
    }),
    /disk reserve/,
  )
  assert.equal(calls.length, 0)
})

test('raw positive screen pins B-1 and is immutable on replay', async () => {
  const out = output(),
    { rpc, calls, preHash } = mock(0)
  const first = await collectPrestate({ out, pinned, rpc, fromIndex: 0, maxSlots: 1, stat })
  assert.equal(first.coveredSlots, 1)
  assert.equal(first.attemptCoverageComplete, false)
  assert.equal(first.fundedRiskSetEstablished, false)
  assert.match(first.assurance, /no external immutable timestamp or hash anchor/)
  assert.deepEqual(first.gaps[0], { fromIndex: 1, toIndex: EXPECTED_SLOTS - 1 })
  const row = JSON.parse(readFileSync(firstReceipt(out))).rows[0]
  assert.equal(row.status, 'funded-screen')
  assert.equal(row.preHeader.hash, preHash)
  assert.equal(row.totalSupplyRaw, '100')
  assert.equal(row.totalAssetsRaw, '200')
  assert.equal(
    JSON.parse(readFileSync(firstReceipt(out))).receiptOrigin,
    'collector-local-write-once-unanchored',
  )
  assert.ok(
    calls.some(
      ({ method, params }) =>
        method === 'eth_call' && params[1].blockHash === preHash && params[1].requireCanonical,
    ),
  )
  const count = calls.length
  await assert.rejects(
    collectPrestate({ out, pinned, rpc, fromIndex: 0, maxSlots: 1, stat }),
    /already covered/,
  )
  assert.equal(calls.length, count)
  assert.equal(verifyReceipts({ out, pinned }).coveredSlots, 1)
})

test('missing code and RPC failure have distinct durable ledger statuses', async () => {
  for (const [options, status] of [
    [{ missing: true }, 'missing-code'],
    [{ failure: true }, 'read-failure'],
  ]) {
    const out = output(),
      { rpc } = mock(0, options)
    await collectPrestate({ out, pinned, rpc, fromIndex: 0, maxSlots: 1, stat })
    const receipt = JSON.parse(readFileSync(firstReceipt(out)))
    assert.equal(receipt.rows[0].status, status)
    assert.equal(receipt.counts[status], 1)
    if (status === 'read-failure') {
      assert.equal(receipt.rows[0].failure, 'rpc-read-error')
      assert.ok(!JSON.stringify(receipt).includes('secret-rpc-key'))
    }
  }
})

test('both-zero and discordant totals do not become positive funded screens', async () => {
  for (const [options, status] of [
    [{ supply: 0n, assets: 0n }, 'unfunded-screen'],
    [{ supply: 100n, assets: 0n }, 'discordant-screen'],
    [{ supply: 0n, assets: 100n }, 'discordant-screen'],
  ]) {
    const out = output(),
      { rpc } = mock(0, options)
    await collectPrestate({ out, rpc, fromIndex: 0, maxSlots: 1, stat })
    const receipt = JSON.parse(readFileSync(firstReceipt(out)))
    assert.equal(receipt.rows[0].status, status)
    assert.equal(receipt.counts[status], 1)
    assert.equal(readdirSync(out).filter((name) => name.endsWith('.tmp')).length, 0)
  }
})

test('control without a source pre-B route remains adapter-unattested', async () => {
  const index = pinned.slots.findIndex((slot) => !slot.sourceExpectedPreRoute)
  assert.ok(index >= 0)
  const out = output(),
    { rpc } = mock(index)
  await collectPrestate({ out, rpc, fromIndex: index, maxSlots: 1, stat })
  const name = `00000-${String(index).padStart(5, '0')}-${String(index).padStart(5, '0')}.json`
  const row = JSON.parse(readFileSync(join(out, name))).rows[0]
  assert.equal(row.status, 'adapter-unattested')
  assert.equal(row.totalsScreen, 'positive-both')
})

test('zero-adapter control stays inactive despite positive raw totals', async () => {
  const index = pinned.slots.findIndex(
    (slot) =>
      slot.role === 'candidate-control' &&
      slot.sourceExpectedPreRoute === '0x0000000000000000000000000000000000000000',
  )
  assert.ok(index >= 0)
  const out = output(),
    { rpc } = mock(index)
  await collectPrestate({ out, rpc, fromIndex: index, maxSlots: 1, stat })
  const row = JSON.parse(readFileSync(firstReceipt(out))).rows[0]
  assert.equal(row.status, 'inactive-zero-adapter')
  assert.equal(row.totalsScreen, 'positive-both')
})

test('repeated failed attempts remain immutable while a later retry resolves the slot', async () => {
  const out = output(),
    failed = mock(0, { failure: true })
  const afterFailure = await collectPrestate({
    out,
    rpc: failed.rpc,
    fromIndex: 0,
    maxSlots: 1,
    stat,
  })
  assert.equal(afterFailure.attemptedSlots, 1)
  assert.equal(afterFailure.resolvedSlots, 0)
  assert.equal(afterFailure.retryableFailureSlots, 1)
  assert.equal(afterFailure.gaps[0].fromIndex, 0)
  const originalBytes = readFileSync(firstReceipt(out))
  const repeated = await collectPrestate({ out, rpc: failed.rpc, fromIndex: 0, maxSlots: 1, stat })
  assert.equal(repeated.attemptedSlots, 1)
  assert.equal(repeated.resolvedSlots, 0)
  assert.equal(repeated.retryableFailureSlots, 1)
  assert.equal(repeated.receipts.length, 2)
  const secondBytes = readFileSync(join(out, repeated.receipts[1].file))
  const good = mock(0)
  const afterRetry = await collectPrestate({ out, rpc: good.rpc, fromIndex: 0, maxSlots: 1, stat })
  assert.equal(afterRetry.attemptedSlots, 1)
  assert.equal(afterRetry.resolvedSlots, 1)
  assert.equal(afterRetry.retryableFailureSlots, 0)
  assert.equal(afterRetry.receipts.length, 3)
  assert.deepEqual(readFileSync(firstReceipt(out)), originalBytes)
  assert.deepEqual(readFileSync(join(out, repeated.receipts[1].file)), secondBytes)
  await assert.rejects(
    collectPrestate({ out, rpc: good.rpc, fromIndex: 0, maxSlots: 1, stat }),
    /already covered/,
  )
})

test('drift and malformed provider return fail closed without receipt', async () => {
  for (const options of [{ drift: true }, { truncate: true }]) {
    const out = output(),
      { rpc } = mock(0, options)
    await assert.rejects(
      collectPrestate({ out, pinned, rpc, fromIndex: 0, maxSlots: 1, stat }),
      /changed|truncat/,
    )
    assert.equal(verifyReceipts({ out, pinned }).coveredSlots, 0)
  }
})

test('RPC timeout aborts the whole range with no immutable receipt', async () => {
  const out = output(),
    { rpc } = mock(0)
  const slow = (method, params) =>
    method === 'eth_call' ? new Promise(() => {}) : rpc(method, params)
  await assert.rejects(
    collectPrestate({ out, rpc: slow, fromIndex: 0, maxSlots: 1, timeoutMs: 100, stat }),
    /RPC timeout/,
  )
  assert.equal(verifyReceipts({ out }).coveredSlots, 0)
})

test('tampered receipt fails offline verification', async () => {
  const out = output(),
    { rpc } = mock(0)
  await collectPrestate({ out, pinned, rpc, fromIndex: 0, maxSlots: 1, stat })
  const path = firstReceipt(out)
  const receipt = JSON.parse(readFileSync(path))
  receipt.rows[0].totalAssetsRaw = '900'
  writeFileSync(path, JSON.stringify(receipt) + '\n')
  assert.throws(() => verifyReceipts({ out, pinned }), /Invalid receipt/)
})

test('offline verifier rejects whitespace changes to physical receipt bytes', async () => {
  const out = output(),
    { rpc } = mock(0)
  await collectPrestate({ out, rpc, fromIndex: 0, maxSlots: 1, stat })
  const path = firstReceipt(out)
  writeFileSync(path, ` ${readFileSync(path, 'utf8')}`)
  assert.throws(() => verifyReceipts({ out }), /Noncanonical receipt bytes/)
})

test('CLI catches exceptions without echoing input or a stack', () => {
  const secret = 'secret-rpc-url-marker'
  const child = spawnSync(
    process.execPath,
    ['scripts/research/morpho-v2-route-prestate-screen.mjs', secret],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  assert.equal(child.status, 1)
  assert.equal(child.stderr, 'MORPHO_PRESTATE_SCREEN_FAILED\n')
  assert.ok(!child.stderr.includes(secret))
  assert.ok(!child.stderr.includes('Error:'))
})

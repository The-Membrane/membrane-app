import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionResult, parseAbi } from 'viem'
import {
  capture,
  MIN_ASSETS_RAW,
  parseFirstPage,
  save,
  validateReceipt,
  verify,
} from './scrvusd-index-holder-seed.mjs'

const abi = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
])
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`
const hash = (x) => `0x${x.repeat(64)}`
const identity = { chainId: 1, vault: addr(1), crvUsd: addr(2) }
const anchor = { number: '0x10', hash: hash('a'), timestamp: '0x6ab90e00' }
const blockTime = Number(BigInt(anchor.timestamp)) * 1000
const page = () => ({
  items: Array.from({ length: 50 }, (_, i) => ({
    address: { hash: addr(i + 10) },
    value: String(50 - i),
    arbitrary: `untrusted-${i}`,
  })),
  next_page_params: { items_count: 50, value: '1' },
})
const url = `https://eth.blockscout.com/api/v2/tokens/${identity.vault}/holders`
const reseal = (receipt) => {
  const { sha256: _sha256, ...rest } = receipt
  return { ...rest, sha256: createHash('sha256').update(JSON.stringify(rest)).digest('hex') }
}
function fixture({
  body = page(),
  code = {},
  max = {},
  balance = {},
  fail = null,
  changed = false,
  source = identity,
  times = [blockTime + 60_000, blockTime + 61_000, blockTime + 62_000],
} = {}) {
  let clock = 0
  let canonicalReads = 0
  let lastCall = null
  const client = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') return anchor
        canonicalReads++
        return { ...anchor, hash: changed && canonicalReads > 1 ? hash('b') : anchor.hash }
      }
      if (method === 'eth_getCode') {
        assert.deepEqual(params[1], { blockHash: anchor.hash, requireCanonical: true })
        return params[0] === source.vault ? '0x6000' : (code[params[0]] ?? '0x')
      }
      if (method === 'eth_call') {
        assert.deepEqual(params[1], { blockHash: anchor.hash, requireCanonical: true })
        const bytes = params[0].data
        const selector = bytes.slice(0, 10)
        const name =
          selector === '0x38d52e0f'
            ? 'asset'
            : selector === '0x70a08231'
              ? 'balanceOf'
              : 'maxWithdraw'
        const holder = `0x${bytes.slice(-40)}`
        if (holder === fail) throw new Error('credential-bearing endpoint')
        lastCall = name
        const result =
          name === 'asset'
            ? source.crvUsd
            : name === 'balanceOf'
              ? (balance[holder] ?? 1n)
              : (max[holder] ?? MIN_ASSETS_RAW)
        return encodeFunctionResult({ abi, functionName: name, result })
      }
      throw new Error(`Unexpected method ${method} after ${lastCall}`)
    },
  }
  return capture({
    client,
    identity: source,
    fetchPage: async (requested) => {
      assert.equal(requested, url)
      return { status: 200, url: requested, body }
    },
    now: () => times[Math.min(clock++, times.length - 1)],
  })
}

test('exact 50 ordered unique entries and continuation are mandatory', () => {
  assert.equal(parseFirstPage(page()).length, 50)
  const short = page()
  short.items.pop()
  assert.throws(() => parseFirstPage(short))
  const noNext = page()
  delete noNext.next_page_params
  assert.throws(() => parseFirstPage(noNext))
  const duplicate = page()
  duplicate.items[1].address.hash = duplicate.items[0].address.hash
  assert.throws(() => parseFirstPage(duplicate))
  const outOfOrder = page()
  outOfOrder.items[1].value = '999'
  assert.throws(() => parseFirstPage(outOfOrder))
})

test('all 50 pinned reads retained; eligible ranking is pinned maxWithdraw', async () => {
  const first = addr(10),
    second = addr(11),
    contract = addr(12),
    dust = addr(13)
  const receipt = await fixture({
    code: { [contract]: '0x6000' },
    max: { [first]: MIN_ASSETS_RAW, [second]: 2n * MIN_ASSETS_RAW, [dust]: 1n },
  })
  assert.equal(receipt.results.length, 50)
  assert.deepEqual(receipt.candidates.slice(0, 2), [second, first])
  assert.equal(receipt.results[2].status, 'contract')
  assert.equal(receipt.results[3].status, 'dust_or_empty')
  assert.equal(receipt.page.rows[0].listedSharesRaw, '50')
  validateReceipt(receipt, { identity, nowMs: receipt.captureEndMs })
})

test('one ambiguous RPC read suppresses all candidates and preserves error row', async () => {
  const receipt = await fixture({ fail: addr(11) })
  assert.equal(receipt.status, 'unavailable')
  assert.deepEqual(receipt.candidates, [])
  assert.equal(receipt.results[1].readError, 'rpc_unavailable')
})

test('offline verifier catches source, ranking, timestamp, and SHA tamper', async () => {
  const receipt = await fixture()
  assert.throws(() => validateReceipt({ ...receipt, status: 'unavailable' }, { identity }))
  assert.throws(() => validateReceipt(reseal({ ...receipt, extra: true }), { identity }))
  assert.throws(() =>
    validateReceipt(
      reseal({
        ...receipt,
        page: {
          ...receipt.page,
          rawItems: receipt.page.rawItems.map((item, i) =>
            i === 0 ? { ...item, value: '999' } : item,
          ),
        },
      }),
      { identity },
    ),
  )
  assert.throws(() =>
    validateReceipt(reseal({ ...receipt, source: { ...identity, chainId: 2 } }), { identity }),
  )
  assert.throws(() =>
    validateReceipt(reseal({ ...receipt, candidates: receipt.candidates.toReversed() }), {
      identity,
    }),
  )
  assert.throws(() =>
    validateReceipt(reseal({ ...receipt, captureEndMs: receipt.captureEndMs + 31 * 60_000 }), {
      identity,
      nowMs: receipt.captureEndMs + 31 * 60_000,
    }),
  )
  assert.throws(() => validateReceipt(receipt, { identity, nowMs: receipt.captureEndMs - 1 }))
})

test('stale or future anchor and canonical hash disagreement are rejected', async () => {
  await assert.rejects(fixture({ times: [blockTime + 31 * 60_000, blockTime + 32 * 60_000] }))
  await assert.rejects(fixture({ times: [blockTime - 1, blockTime - 1] }))
  await assert.rejects(fixture({ changed: true }))
  await assert.rejects(
    fixture({ times: [blockTime + 60_000, blockTime + 61_000, blockTime + 12 * 60_000] }),
  )
})

test('sealed file verifies offline, cannot overwrite, and respects disk reserve', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'index-seed-'))
  try {
    const receipt = await fixture()
    const stat = () => ({ bavail: 1_000_000, bsize: 4096 })
    const file = save({ receipt, out: directory, identity, stat })
    assert.ok(file.endsWith('.json'))
    assert.deepEqual(verify({ out: directory, identity }), { count: 1, latestBlock: 16 })
    assert.throws(() => save({ receipt, out: directory, identity, stat }))
    assert.throws(() =>
      save({
        receipt: reseal({ ...receipt, captureEndMs: receipt.captureEndMs + 1 }),
        out: directory,
        identity,
        stat: () => ({ bavail: 0, bsize: 4096 }),
      }),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

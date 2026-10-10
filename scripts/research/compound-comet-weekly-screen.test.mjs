import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  EXPECTED,
  GRID,
  MARKETS,
  blocks,
  collect,
  coverage,
  summarize,
} from './compound-comet-weekly-screen.mjs'

const at = (block) => 1_700_000_000 + (block - GRID.first) * 12
function row(market, block, cash = 101_000_000) {
  return {
    market: market.name,
    comet: market.comet,
    base: market.base,
    decimals: 6,
    block,
    at: at(block),
    cashRaw: String(cash * 1e6),
    cashUsdAssumingPeg: cash,
    withdrawPaused: false,
    totalSupplyRaw: '200000000000000',
    totalBorrowRaw: '100000000000000',
    totalSupplyBaseRaw: '200000000000000',
    totalBorrowBaseRaw: '100000000000000',
    baseSupplyIndexRaw: '1000000000000000',
    baseBorrowIndexRaw: '1000000000000000',
    lastAccrualTime: at(block),
  }
}

test('weekly grid has fixed endpoints and count', () => {
  assert.equal(EXPECTED, 57)
  assert.equal(blocks()[0], GRID.first)
  assert.equal(blocks().at(-1), GRID.last)
})

test('coverage rejects missing, duplicate, foreign, and unpinned rows', () => {
  const all = MARKETS.flatMap((market) => blocks().map((block) => row(market, block)))
  assert.equal(coverage(all).complete, true)
  assert.equal(coverage(all.slice(1)).complete, false)
  assert.throws(() => coverage([...all, all[0]]), /duplicate/i)
  assert.throws(() => coverage([...all, { ...all[0], market: 'foreign' }]), /unknown market/i)
  assert.throws(() => coverage([{ ...all[0], block: all[0].block + 1 }]), /invalid/i)
})

test('summary keeps 70/30 split and boundary downcrossing separate', () => {
  const all = MARKETS.flatMap((market) => blocks().map((block) => row(market, block)))
  const subject = all.filter((r) => r.market === 'cUSDCv3')
  subject[10].cashUsdAssumingPeg = 9_000_000
  subject[10].cashRaw = String(9_000_000 * 1e6)
  subject[11].cashUsdAssumingPeg = 101_000_000
  subject[11].cashRaw = String(101_000_000 * 1e6)
  subject[39].cashUsdAssumingPeg = 500_000
  subject[39].cashRaw = String(500_000 * 1e6)
  subject[40].cashUsdAssumingPeg = 500_000
  subject[40].cashRaw = String(500_000 * 1e6)
  const result = summarize(all).markets.cUSDCv3
  assert.equal(result.trainCount, 39)
  assert.equal(result.holdoutCount, 18)
  assert.equal(result.splits.train.scenarios['10000000'].rawDowncrossings, 1)
  assert.equal(result.splits.holdout.scenarios['1000000'].rawDowncrossings, 0)
  assert.equal(result.splits.holdout.scenarios['1000000'].boundaryDowncrossing, true)
  assert.equal(result.splits.holdout.scenarios['1000000'].belowSamples, 2)
})

test('collector pins every call, verifies base identity, resumes without repeating success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'comet-weekly-test-'))
  const out = join(directory, 'rows.json')
  const seen = []
  const mock = {
    async getBlock({ blockNumber }) {
      return { timestamp: BigInt(at(Number(blockNumber))) }
    },
    async multicall({ blockNumber, allowFailure, contracts }) {
      assert.equal(allowFailure, false)
      assert.equal(contracts.length, 7)
      assert(contracts.every((c) => c.address && c.functionName))
      const market = MARKETS.find(
        (m) => m.comet.toLowerCase() === contracts[0].address.toLowerCase(),
      )
      seen.push(`${market.name}:${blockNumber}`)
      return [
        market.base,
        6,
        200_000_000_000_000n,
        false,
        300_000_000_000_000n,
        100_000_000_000_000n,
        {
          totalSupplyBase: 300_000_000_000_000n,
          totalBorrowBase: 100_000_000_000_000n,
          baseSupplyIndex: 1_000_000_000_000_000n,
          baseBorrowIndex: 1_000_000_000_000_000n,
          lastAccrualTime: BigInt(at(Number(blockNumber))),
        },
      ]
    },
  }
  try {
    const partial = await collect({ out, maxNew: 2, client: mock })
    assert.equal(partial.status, 'partial')
    assert.equal(partial.coverage.present, 2)
    assert.equal(partial.failedReadCount, 0)
    await collect({ out, maxNew: 1, client: mock })
    assert.equal(seen.length, 3)
    assert.equal(seen[2], `${MARKETS[0].name}:${blocks()[2]}`)
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).rows.length, 3)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('failed base verification is retained as incomplete and retried on resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'comet-weekly-fail-'))
  const out = join(directory, 'rows.json')
  let correct = false
  const mock = {
    async getBlock({ blockNumber }) {
      return { timestamp: BigInt(at(Number(blockNumber))) }
    },
    async multicall({ contracts }) {
      return [
        correct ? MARKETS[0].base : MARKETS[1].base,
        6,
        1_000_000_000_000n,
        false,
        2n,
        1n,
        {
          totalSupplyBase: 2n,
          totalBorrowBase: 1n,
          baseSupplyIndex: 1n,
          baseBorrowIndex: 1n,
          lastAccrualTime: 1n,
        },
      ]
    },
  }
  try {
    const first = await collect({ out, maxNew: 1, client: mock })
    assert.equal(first.status, 'partial')
    assert.equal(first.failedReadCount, 1)
    assert.equal(first.rows.length, 0)
    correct = true
    const second = await collect({ out, maxNew: 1, client: mock })
    assert.equal(second.failedReadCount, 0)
    assert.equal(second.rows.length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

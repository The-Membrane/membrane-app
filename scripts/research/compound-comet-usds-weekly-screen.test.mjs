import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  validRow,
} from './compound-comet-usds-weekly-screen.mjs'
import { collect as collectUsdcUsdt } from './compound-comet-weekly-screen.mjs'

const market = MARKETS[0]
const at = (block) => 1_700_000_000 + (block - GRID.first) * 12
function row(block, cash = 101_000_000) {
  return {
    market: market.name,
    comet: market.comet,
    base: market.base,
    decimals: 18,
    block,
    at: at(block),
    cashRaw: (BigInt(cash) * 10n ** 18n).toString(),
    cashUsdAssumingPeg: cash,
    withdrawPaused: false,
    totalSupplyRaw: '200000000000000000000000000',
    totalBorrowRaw: '100000000000000000000000000',
    totalSupplyBaseRaw: '200000000000000000000000000',
    totalBorrowBaseRaw: '100000000000000000000000000',
    baseSupplyIndexRaw: '1000000000000000',
    baseBorrowIndexRaw: '1000000000000000',
    lastAccrualTime: at(block),
  }
}

test('USDS uses the existing 57-block grid and distinct verified market identity', () => {
  assert.equal(EXPECTED, 57)
  assert.equal(blocks()[0], 23_229_806)
  assert.equal(blocks().at(-1), 26_052_206)
  assert.equal(market.decimals, 18)
  assert.equal(validRow(row(blocks()[0])), true)
  assert.equal(validRow({ ...row(blocks()[0]), decimals: 6 }), false)
  assert.equal(validRow({ ...row(blocks()[0]), base: '0xdead' }), false)
})

test('USDS coverage requires every pinned sample and summary separates boundary crossing', () => {
  const all = blocks().map((block) => row(block))
  assert.equal(coverage(all).complete, true)
  assert.equal(coverage(all.slice(1)).complete, false)
  assert.throws(() => coverage([...all, all[0]]), /duplicate/i)
  all[39] = row(blocks()[39], 500_000)
  all[40] = row(blocks()[40], 500_000)
  const result = summarize(all).markets.cUSDSv3
  assert.equal(result.trainCount, 39)
  assert.equal(result.holdoutCount, 18)
  assert.equal(result.splits.holdout.scenarios['1000000'].rawDowncrossings, 0)
  assert.equal(result.splits.holdout.scenarios['1000000'].boundaryDowncrossing, true)
  assert.equal(result.splits.holdout.scenarios['1000000'].belowSamples, 2)
})

test('USDS collector pins identity, preserves partial failures, resumes and cannot mix old market artifact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'comet-usds-weekly-test-'))
  const out = join(directory, 'rows.json')
  const wrongOut = join(directory, 'wrong.json')
  let correct = false
  const seen = []
  const mock = {
    async getBlock({ blockNumber }) {
      return { timestamp: BigInt(at(Number(blockNumber))) }
    },
    async multicall({ blockNumber, allowFailure, contracts }) {
      assert.equal(allowFailure, false)
      assert.equal(contracts.length, 7)
      assert(contracts.every((c) => c.address && c.functionName))
      assert.equal(contracts[0].address, market.comet)
      assert.equal(contracts[2].args[0], market.comet)
      seen.push(Number(blockNumber))
      return [
        correct ? market.base : '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        18,
        200_000_000n * 10n ** 18n,
        false,
        300_000_000n * 10n ** 18n,
        100_000_000n * 10n ** 18n,
        {
          totalSupplyBase: 300_000_000n * 10n ** 18n,
          totalBorrowBase: 100_000_000n * 10n ** 18n,
          baseSupplyIndex: 1_000_000_000_000_000n,
          baseBorrowIndex: 1_000_000_000_000_000n,
          lastAccrualTime: BigInt(at(Number(blockNumber))),
        },
      ]
    },
  }
  try {
    const failure = await collect({ out, maxNew: 1, client: mock })
    assert.equal(failure.status, 'partial')
    assert.equal(failure.failedReadCount, 1)
    assert.equal(failure.coverage.present, 0)
    correct = true
    const repaired = await collect({ out, maxNew: 2, client: mock })
    assert.equal(repaired.coverage.present, 2)
    assert.equal(repaired.failedReadCount, 0)
    assert.equal(seen.length, 5) // failed read retried 3 times, then two successes
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).rows[0].decimals, 18)
    await collect({ out: wrongOut, maxNew: 0 })
    await assert.rejects(() => collectUsdcUsdt({ out: wrongOut, maxNew: 0 }), /identity mismatch/i)
    const corrupt = JSON.parse(readFileSync(wrongOut, 'utf8'))
    corrupt.status = 'complete'
    writeFileSync(wrongOut, JSON.stringify(corrupt))
    await assert.rejects(() => collect({ out: wrongOut, maxNew: 0 }), /coverage\/status mismatch/i)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

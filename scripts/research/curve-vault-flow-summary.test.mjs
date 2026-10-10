import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from 'viem'
import { collect, readValidatedReceipts, sourceIdentity } from './curve-vault-flow-ledger.mjs'
import { summarize, summarizeReceipts } from './curve-vault-flow-summary.mjs'

const source = sourceIdentity()
const DAY = 86_400
const BASE = 1_790_000_000
const q = (n) => `0x${n.toString(16)}`
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const topicAddress = (n) => `0x${n.toString(16).padStart(64, '0')}`
const assetAbi = parseAbi(['function asset() view returns (address)'])
const assetResult = encodeFunctionResult({
  abi: assetAbi,
  functionName: 'asset',
  result: source.asset,
})
const now = () => new Date('2026-09-27T20:00:00.000Z')
const stat = () => ({ bavail: 10_000_000, bsize: 4096 })
const event = (kind, blockNumber, amount, index = 0) => ({
  address: source.vault,
  blockNumber: q(blockNumber),
  blockHash: hash(blockNumber),
  transactionHash: hash(blockNumber * 1000 + index + 1),
  transactionIndex: q(index),
  logIndex: q(index),
  removed: false,
  topics:
    kind === 'deposit'
      ? [source.streams[0].topic0, topicAddress(1), topicAddress(2)]
      : [source.streams[1].topic0, topicAddress(1), topicAddress(3), topicAddress(2)],
  data: encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }],
    [BigInt(amount) * 10n ** 18n, BigInt(amount) * 10n ** 18n],
  ),
})

function client(logs, finalized) {
  return {
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? finalized : Number(BigInt(params[0]))
        return { number: q(n), hash: hash(n), timestamp: q(BASE + (n - 10) * DAY) }
      }
      if (method === 'eth_call') return assetResult
      if (method === 'eth_getLogs') {
        const from = Number(BigInt(params[0].fromBlock))
        const to = Number(BigInt(params[0].toBlock))
        const topics = Array.isArray(params[0].topics[0])
          ? params[0].topics[0]
          : [params[0].topics[0]]
        return logs.filter(
          (log) =>
            Number(BigInt(log.blockNumber)) >= from &&
            Number(BigInt(log.blockNumber)) <= to &&
            topics.includes(log.topics[0]),
        )
      }
      throw new Error('Unexpected mock RPC method')
    },
  }
}

const withOut = async (fn) => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-flow-summary-'))
  try {
    await fn(out)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
const fill = async (out, logs, finalized = 18, maxChunks = 3) =>
  collect({
    client: client(logs, finalized),
    out,
    source,
    fromBlock: 10,
    maxChunks,
    range: 3,
    rpcHost: 'example.org',
    now,
    stat,
  })

test('empty ledger and partial window are unavailable, not zero observed flow', async () =>
  withOut(async (out) => {
    const empty = summarize({ out, source })
    assert.equal(empty.status, 'unavailable')
    assert.equal(empty.maximumObservedCompleteWindow['24h'].status, 'unavailable')
    assert.equal(empty.maximumObservedCompleteWindowNetDepletion['24h'].status, 'unavailable')
    await fill(out, [], 10, 1)
    const partial = summarize({ out, source })
    assert.equal(partial.coverage.consecutiveBlocks, 1)
    assert.equal(partial.totals.grossWithdrawalsRaw, '0')
    assert.equal(partial.maximumObservedCompleteWindow['24h'].status, 'unavailable')
    assert.equal(partial.maximumObservedCompleteWindow['7d'].status, 'unavailable')
    assert.equal(partial.maximumObservedCompleteWindowNetDepletion['24h'].status, 'unavailable')
    assert.equal(partial.maximumObservedCompleteWindowNetDepletion['7d'].status, 'unavailable')
  }))

test('certified quiet coverage yields zero maximum for complete 24h and 7d windows', async () =>
  withOut(async (out) => {
    await fill(out, [])
    const result = summarize({ out, source })
    assert.equal(readValidatedReceipts({ out, source }).length, 3)
    assert.equal(result.coverage.fromBlock, 10)
    assert.equal(result.coverage.throughBlock, 18)
    assert.equal(result.coverage.consecutiveBlocks, 9)
    assert.equal(result.unit, 'crvUSD')
    assert.equal(result.rawDecimals, 18)
    for (const horizon of ['24h', '7d']) {
      const maximum = result.maximumObservedCompleteWindow[horizon]
      assert.equal(maximum.status, 'observed')
      assert.equal(maximum.grossWithdrawalsRaw, '0')
      assert.equal(maximum.withdrawEventCount, 0)
      assert.equal(maximum.startUtc, result.coverage.fromUtc)
      const net = result.maximumObservedCompleteWindowNetDepletion[horizon]
      assert.equal(net.status, 'observed')
      assert.equal(net.netDepletionRaw, '0')
      assert.equal(net.depositEventCount, 0)
      assert.equal(net.withdrawEventCount, 0)
      assert.equal(net.startUtc, result.coverage.fromUtc)
    }
  }))

test('gross totals and exact half-open maximum windows count each withdrawal once', async () =>
  withOut(async (out) => {
    const logs = [
      event('deposit', 10, 50),
      event('withdraw', 11, 100),
      event('withdraw', 12, 200),
      event('withdraw', 18, 500),
    ]
    await fill(out, logs)
    const result = summarize({ out, source })
    assert.equal(result.totals.grossDepositsRaw, `${50n * 10n ** 18n}`)
    assert.equal(result.totals.grossWithdrawalsCrvUsd, '800')
    assert.equal(result.totals.depositEventCount, 1)
    assert.equal(result.totals.withdrawEventCount, 3)
    const day = result.maximumObservedCompleteWindow['24h']
    assert.equal(day.grossWithdrawalsCrvUsd, '500')
    assert.equal(day.withdrawEventCount, 1)
    assert.equal(day.startUtc, new Date((BASE + 8 * DAY - DAY + 1) * 1000).toISOString())
    const week = result.maximumObservedCompleteWindow['7d']
    assert.equal(week.grossWithdrawalsCrvUsd, '700')
    assert.equal(week.withdrawEventCount, 2)
    assert.equal(week.startUtc, new Date((BASE + DAY + 1) * 1000).toISOString())
    assert.equal(week.endExclusiveUtc, new Date((BASE + 8 * DAY + 1) * 1000).toISOString())
    const netDay = result.maximumObservedCompleteWindowNetDepletion['24h']
    assert.equal(netDay.netDepletionRaw, `${500n * 10n ** 18n}`)
    assert.equal(netDay.grossDepositsRaw, '0')
    assert.equal(netDay.grossWithdrawalsRaw, `${500n * 10n ** 18n}`)
  }))

test('all-inflow complete windows retain a negative signed maximum', async () =>
  withOut(async (out) => {
    const logs = Array.from({ length: 9 }, (_, i) => event('deposit', 10 + i, 1))
    await fill(out, logs)
    const result = summarize({ out, source })
    assert.equal(result.maximumObservedCompleteWindow['24h'].grossWithdrawalsRaw, '0')
    assert.equal(
      result.maximumObservedCompleteWindowNetDepletion['24h'].netDepletionRaw,
      '-1000000000000000000',
    )
    assert.equal(
      result.maximumObservedCompleteWindowNetDepletion['7d'].netDepletionRaw,
      '-7000000000000000000',
    )
  }))

test('net maximum includes the boundary where a deposit leaves a complete window', async () =>
  withOut(async (out) => {
    await fill(out, [event('deposit', 11, 100), event('withdraw', 12, 20)], 13, 2)
    const result = summarize({ out, source })
    const net = result.maximumObservedCompleteWindowNetDepletion['24h']
    assert.equal(net.status, 'observed')
    assert.equal(net.netDepletionRaw, `${20n * 10n ** 18n}`)
    assert.equal(net.startUtc, new Date((BASE + DAY + 1) * 1000).toISOString())
    assert.equal(net.depositEventCount, 0)
    assert.equal(net.withdrawEventCount, 1)
    assert.equal(result.maximumObservedCompleteWindow['24h'].grossWithdrawalsCrvUsd, '20')
    assert.equal(result.maximumObservedCompleteWindowNetDepletion['7d'].status, 'unavailable')
  }))

test('tampered or missing middle receipt fails rather than reducing gross flow', async () =>
  withOut(async (out) => {
    await fill(out, [event('withdraw', 14, 200)])
    const files = readdirSync(out)
      .filter((name) => name.endsWith('.json'))
      .sort()
    const middle = join(out, files[1])
    const original = readFileSync(middle, 'utf8')
    const modified = JSON.parse(original)
    modified.events[0].assetsRaw = '1'
    writeFileSync(middle, `${JSON.stringify(modified)}\n`)
    assert.throws(() => summarize({ out, source }), /SHA mismatch/)
    writeFileSync(middle, original)
    rmSync(middle)
    assert.throws(() => summarize({ out, source }), /gap or overlap|Invalid vault flow receipt/)
  }))

test('collector rejects a transaction/log coordinate repeated in a later receipt', async () =>
  withOut(async (out) => {
    const first = event('withdraw', 11, 100)
    const second = event('withdraw', 14, 200)
    second.transactionHash = first.transactionHash
    await assert.rejects(fill(out, [first, second]), /Duplicate vault flow event across receipts/)
    assert.equal(readValidatedReceipts({ out, source }).length, 1)
    assert.equal(summarize({ out, source }).totals.grossWithdrawalsCrvUsd, '100')
  }))

test('as-of summary over a verified prefix excludes later receipts', async () =>
  withOut(async (out) => {
    await fill(out, [event('withdraw', 18, 500)])
    const receipts = readValidatedReceipts({ out, source })
    const earlier = summarizeReceipts({ receipts: receipts.slice(0, 2), source })
    const later = summarizeReceipts({ receipts, source })
    assert.equal(earlier.totals.grossWithdrawalsCrvUsd, '0')
    assert.equal(later.totals.grossWithdrawalsCrvUsd, '500')
    assert.deepEqual(later, summarize({ out, source }))
  }))

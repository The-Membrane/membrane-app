import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeEventTopics, parseAbiItem } from 'viem'

import { apply } from './apply-carry-usd3-exit-ddl.mjs'
import {
  audit,
  discoverTransferCandidates,
  issue,
  receiptProvesTransfer,
  score,
  scoreDecision,
} from './record-carry-usd3-exit-outcomes.mjs'

const VAULT = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
const ROUTE = 'USDC → USD3 [USDC]'
const OWNER = `0x${'1'.repeat(40)}`
const TX = `0x${'2'.repeat(64)}`
const HASH = `0x${'3'.repeat(64)}`
const EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

function transfer() {
  const topics = encodeEventTopics({
    abi: [EVENT],
    eventName: 'Transfer',
    args: { from: `0x${'0'.repeat(40)}`, to: OWNER },
  })
  return {
    address: VAULT,
    transactionHash: TX,
    blockHash: HASH,
    blockNumber: 100n,
    logIndex: 7,
    topics,
    data: `0x${'a'.padStart(64, '0')}`,
    args: { to: OWNER, value: 10n },
  }
}

test('receipt proof binds exact vault Transfer log and recipient', () => {
  const log = transfer()
  const receipt = {
    status: 'success',
    transactionHash: TX,
    blockHash: HASH,
    blockNumber: 100n,
    logs: [{ ...log }],
  }
  assert.equal(receiptProvesTransfer(log, receipt), true)
  assert.equal(receiptProvesTransfer(log, { ...receipt, blockHash: `0x${'4'.repeat(64)}` }), false)
  assert.equal(receiptProvesTransfer(log, { ...receipt, logs: [{ ...log, data: '0x' }] }), false)
  assert.equal(
    receiptProvesTransfer(log, { ...receipt, logs: [{ ...log, address: OWNER }] }),
    false,
  )
  assert.equal(receiptProvesTransfer(log, { ...receipt, status: 'reverted' }), false)
})

test('candidate search is bounded to finalized head and 2048 prior blocks', async () => {
  const ranges = []
  const client = {
    getLogs: async ({ fromBlock, toBlock }) => {
      ranges.push([fromBlock, toBlock])
      return []
    },
  }
  assert.deepEqual(await discoverTransferCandidates(client, { number: 5000n }), [])
  assert.equal(ranges.length, 8)
  assert.deepEqual(ranges[0], [4745n, 5000n])
  assert.deepEqual(ranges.at(-1), [2953n, 3208n])
})

test('H1 score requires physical and finalized source time in ±15 minute window', () => {
  const target = Date.parse('2026-09-29T12:00:00Z')
  const row = { target_at: new Date(target).toISOString() }
  assert.equal(scoreDecision(row, target, target - 15 * 60_000 - 1), 'wait')
  assert.equal(scoreDecision(row, target - 15 * 60_000 - 1, target), 'wait')
  assert.equal(scoreDecision(row, target, target), 'probe')
  assert.equal(scoreDecision(row, target + 15 * 60_000 + 1, target), 'target_block_outside_window')
  assert.equal(scoreDecision(row, target, target + 15 * 60_000 + 1), 'target_window_missed')
  assert.equal(
    scoreDecision(row, Number.NEGATIVE_INFINITY, target + 15 * 60_000 + 1),
    'target_window_missed',
  )
})

test('issue freezes same-holder Q and source only after receipt, EOA, shares, claim and quote', async () => {
  const now = Date.now()
  const payloads = []
  const log = transfer()
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('carry_usd3_exit_issue(')) {
      payloads.push(JSON.parse(values[0]))
      return [{ carry_usd3_exit_issue: 1 }]
    }
    return []
  }
  const client = {
    getBlock: async () => ({ number: 500n, hash: HASH }),
    getLogs: async () => [log],
    getTransactionReceipt: async () => ({
      status: 'success',
      transactionHash: TX,
      blockHash: HASH,
      blockNumber: 100n,
      logs: [log],
    }),
    getCode: async () => '0x',
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 100n : 1000n),
  }
  const quoteReader = async (_client, request) => ({
    status: 'checked_at_finalized_block',
    routeKey: request.routeKey,
    vault: {
      address: request.destinationAddress,
      assetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      implementation: '0xd1f1c3f485063712873285bf4ef25ab068f13893',
      assetDecimals: 6,
      shareDecimals: 6,
      identity: 'pinned_vault_asset_and_implementation',
    },
    request: { assetsRaw: request.assetsRaw },
    source: {
      chainId: 1,
      blockNumber: 500,
      blockHash: HASH,
      blockTime: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
    position: { balanceSharesRaw: '100', maxWithdrawAssetsRaw: '1000' },
    simulation: { status: 'success' },
  })
  const result = await issue(sql, client, now, quoteReader)
  assert.deepEqual(result, { issued: 1, unavailable: 0, replayed: 0 })
  assert.equal(payloads[0].holder, OWNER)
  assert.equal(payloads[0].assetsRaw, '100')
  assert.equal(payloads[0].transferTxHash, TX)
  assert.equal(payloads[0].transferLogIndex, 7)
  assert.equal(payloads[0].issueSimulation, 'success')
  assert.match(payloads[0].callerChecksumSha256, /^[0-9a-f]{64}$/)

  const badImplementationQuote = async (...args) => {
    const quote = await quoteReader(...args)
    return {
      ...quote,
      vault: { ...quote.vault, implementation: OWNER },
    }
  }
  assert.deepEqual(await issue(sql, client, now, badImplementationQuote), {
    issued: 0,
    unavailable: 1,
    replayed: 0,
  })
  assert.equal(payloads[1].unavailableReason, 'candidate_check_unavailable')
})

test('unverified receipt yields explicit unavailable attempt', async () => {
  const now = Date.now()
  const payloads = []
  const sql = async (strings, ...values) => {
    if (strings.join('?').includes('carry_usd3_exit_issue(')) {
      payloads.push(JSON.parse(values[0]))
      return [{}]
    }
    return []
  }
  const client = {
    getBlock: async () => ({ number: 500n, hash: HASH }),
    getLogs: async () => [transfer()],
    getCode: async () => '0x',
    getTransactionReceipt: async () => ({ status: 'reverted', logs: [] }),
  }
  assert.deepEqual(await issue(sql, client, now), { issued: 0, unavailable: 1, replayed: 0 })
  assert.equal(payloads[0].unavailableReason, 'candidate_check_unavailable')
  assert.equal(payloads[0].holder, null)
  assert.equal(payloads[0].assetsRaw, null)
})

test('holder claim below frozen Q is censored, not an EVM exit failure', async () => {
  const now = Date.now()
  const row = {
    id: '5',
    route_key: ROUTE,
    vault: VAULT,
    holder: OWNER,
    assets_raw: '100',
    source_block: '100',
    target_at: new Date(now).toISOString(),
  }
  const payloads = []
  const sql = async (strings, ...values) => {
    if (strings.join('?').includes('WITH actionable')) return [row]
    if (strings.join('?').includes('carry_usd3_exit_score(')) {
      payloads.push(JSON.parse(values[0]))
      return [{}]
    }
    throw new Error('unexpected SQL')
  }
  const client = { getBlock: async () => ({ timestamp: BigInt(Math.floor(now / 1000)) }) }
  const quoteReader = async (_client, request) => ({
    status: 'checked_at_finalized_block',
    routeKey: request.routeKey,
    vault: {
      address: request.destinationAddress,
      assetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      implementation: '0xd1f1c3f485063712873285bf4ef25ab068f13893',
      assetDecimals: 6,
      shareDecimals: 6,
      identity: 'pinned_vault_asset_and_implementation',
    },
    request: { assetsRaw: request.assetsRaw },
    source: {
      chainId: 1,
      blockNumber: 101,
      blockHash: HASH,
      blockTime: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
    position: { maxWithdrawAssetsRaw: '99', balanceSharesRaw: '9', previewSharesRaw: '10' },
    simulation: { status: 'position_insufficient' },
  })
  const result = await score(sql, client, now, quoteReader)
  assert.equal(result.position_insufficient, 1)
  assert.equal(result.evm_revert, 0)
  assert.equal(payloads[0].holderClaimRaw, '99')
  assert.equal(payloads[0].holderSharesRaw, '9')
  assert.equal(payloads[0].previewSharesRaw, '10')
  assert.equal(payloads[0].assetsRaw, '100')
})

test('a lower future maxWithdraw does not hide a holder-covered EVM exit revert', async () => {
  const now = Date.now()
  const row = {
    id: '6',
    route_key: ROUTE,
    vault: VAULT,
    holder: OWNER,
    assets_raw: '100',
    source_block: '100',
    target_at: new Date(now).toISOString(),
  }
  let recorded
  const sql = async (strings, ...values) => {
    if (strings.join('?').includes('WITH actionable')) return [row]
    if (strings.join('?').includes('carry_usd3_exit_score(')) {
      recorded = JSON.parse(values[0])
      return [{}]
    }
    throw new Error('unexpected SQL')
  }
  const client = { getBlock: async () => ({ timestamp: BigInt(Math.floor(now / 1000)) }) }
  const quoteReader = async (_client, request) => ({
    status: 'checked_at_finalized_block',
    routeKey: request.routeKey,
    vault: {
      address: request.destinationAddress,
      assetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      implementation: '0xd1f1c3f485063712873285bf4ef25ab068f13893',
      assetDecimals: 6,
      shareDecimals: 6,
      identity: 'pinned_vault_asset_and_implementation',
    },
    request: { assetsRaw: request.assetsRaw },
    source: {
      chainId: 1,
      blockNumber: 101,
      blockHash: HASH,
      blockTime: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
    position: { maxWithdrawAssetsRaw: '99', balanceSharesRaw: '100', previewSharesRaw: '10' },
    simulation: { status: 'evm_revert' },
  })
  const result = await score(sql, client, now, quoteReader)
  assert.equal(result.evm_revert, 1)
  assert.equal(result.position_insufficient, 0)
  assert.equal(recorded.status, 'evm_revert')
  assert.equal(recorded.holderClaimRaw, '99')
  assert.equal(recorded.holderSharesRaw, '100')
})

test('a successful withdrawal survives an overestimated share preview', async () => {
  const now = Date.now()
  const row = {
    id: '7',
    route_key: ROUTE,
    vault: VAULT,
    holder: OWNER,
    assets_raw: '100',
    source_block: '100',
    target_at: new Date(now).toISOString(),
  }
  let recorded
  const sql = async (strings, ...values) => {
    if (strings.join('?').includes('WITH actionable')) return [row]
    if (strings.join('?').includes('carry_usd3_exit_score(')) {
      recorded = JSON.parse(values[0])
      return [{}]
    }
    throw new Error('unexpected SQL')
  }
  const client = { getBlock: async () => ({ timestamp: BigInt(Math.floor(now / 1000)) }) }
  const quoteReader = async (_client, request) => ({
    status: 'checked_at_finalized_block',
    routeKey: request.routeKey,
    vault: {
      address: request.destinationAddress,
      assetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      implementation: '0xd1f1c3f485063712873285bf4ef25ab068f13893',
      assetDecimals: 6,
      shareDecimals: 6,
      identity: 'pinned_vault_asset_and_implementation',
    },
    request: { assetsRaw: request.assetsRaw },
    source: {
      chainId: 1,
      blockNumber: 101,
      blockHash: HASH,
      blockTime: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
    position: { maxWithdrawAssetsRaw: '99', balanceSharesRaw: '9', previewSharesRaw: '10' },
    simulation: { status: 'success', sharesBurnedRaw: '9' },
  })
  const result = await score(sql, client, now, quoteReader)
  assert.equal(result.success, 1)
  assert.equal(result.position_insufficient, 0)
  assert.equal(recorded.sharesBurnedRaw, '9')
})

test('audit counts missing ticks and keeps forecast false', async () => {
  const sql = async (strings) => {
    const query = strings.join('?')
    if (query.includes('FROM carry_usd3_exit_attempts GROUP BY status'))
      return [{ status: 'issued', n: 2 }]
    if (query.includes('FROM carry_usd3_exit_outcomes GROUP BY status')) return []
    if (query.includes('count(*)::integer AS n FROM carry_usd3_exit_outcomes o')) return [{ n: 0 }]
    if (query.includes('WITH bounds AS'))
      return [
        {
          first_slot: '100',
          last_slot: '101',
          expected: '2',
          missing: '1',
          first_missing_slot: '100',
        },
      ]
    throw new Error('unexpected SQL')
  }
  const result = await audit(sql)
  assert.equal(result.scheduled.missingAttempts, 1)
  assert.equal(result.futureExitForecast, false)
})

test('DDL guards direct insert identity, H1 timing, append-only and quota', async () => {
  const statements = []
  const sql = Object.assign(
    async (strings) => {
      statements.push(strings.join('?'))
      return []
    },
    {
      query: async (statement) => {
        statements.push(statement)
        return []
      },
    },
  )
  await apply(sql)
  const guard = statements.find((s) => s.includes('FUNCTION guard_carry_usd3_exit_insert'))
  assert.match(guard, /NEW\.route_key IS DISTINCT FROM issue\.route_key/)
  assert.match(guard, /NEW\.target_at <> NEW\.issued_at \+ interval '1 hour'/)
  assert.match(guard, /NEW\.source_block <= issue\.source_block/)
  assert.ok(statements.some((s) => s.includes('carry_usd3_exit_outcomes_share_status_check')))
  assert.ok(statements.some((s) => s.includes('shares_burned_raw <= holder_shares_raw')))
  assert.ok(
    statements.some((s) =>
      s.includes('holder_claim_raw IS NOT NULL AND holder_claim_raw >= assets_raw'),
    ),
  )
  assert.ok(
    statements.some((s) => s.includes('preview_shares_raw IS NOT NULL AND preview_shares_raw > 0')),
  )
  assert.ok(
    statements.some((s) => s.includes("status = 'success' AND shares_burned_raw IS NOT NULL")),
  )
  assert.equal(statements.filter((s) => s.includes('_insert_guard BEFORE INSERT')).length, 2)
  assert.equal(statements.filter((s) => s.includes('_truncate BEFORE TRUNCATE')).length, 2)
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionData, parseAbi, toEventSelector } from 'viem'
import { SILO, VAULT, WITHDRAW_TOPIC } from './susde-public-pending-exit-common.mjs'
import {
  capturePreanchor,
  verifyPreanchor,
  FROM,
  TO,
  MAX_RPC_CALLS,
} from './susde-public-preanchor-request-proof.mjs'

const holder = '0x6142eb927529974c5cded66dafc57cb5aaaf73ab'
const txHash = `0x${'e'.repeat(64)}`
const block = FROM
const blockTimestamp = '0x6abda003'
const sufficientDisk = () => ({ bavail: 2_147_483_648n, bsize: 1n })
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const header = (n) => ({
  number: `0x${n.toString(16)}`,
  hash: hash(n),
  parentHash: hash(n - 1n),
  timestamp: blockTimestamp,
})
const word = (n) => n.toString(16).padStart(64, '0')
const event = {
  address: VAULT,
  topics: [WITHDRAW_TOPIC, topic(holder), topic(SILO), topic(holder)],
  data: `0x${word(100n)}${word(50n)}`,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: hash(block),
  transactionHash: txHash,
  transactionIndex: '0x1',
  logIndex: '0x2',
  removed: false,
}
const ABI = parseAbi(['function cooldownAssets(uint256 assets,address owner) returns (uint256)'])
const OWNER_SHARES_ABI = parseAbi([
  'function cooldownShares(uint256 shares,address owner) returns (uint256)',
])
const SELF_ASSETS_ABI = parseAbi(['function cooldownAssets(uint256 assets) returns (uint256)'])
const SELF_ABI = parseAbi(['function cooldownShares(uint256 shares) returns (uint256)'])
const READ_ABI = parseAbi(['function cooldownDuration() view returns (uint24)'])
const DURATION_DATA = encodeFunctionData({ abi: READ_ABI, functionName: 'cooldownDuration' })
const UPDATE_TOPIC = toEventSelector('CooldownDurationUpdated(uint24,uint24)').toLowerCase()
const earlyUpdate = {
  ...event,
  topics: [UPDATE_TOPIC],
  data: `0x${word(604800n)}${word(0n)}`,
  logIndex: '0x1',
}
const tx = {
  hash: txHash,
  blockHash: hash(block),
  blockNumber: event.blockNumber,
  transactionIndex: '0x1',
  from: holder,
  to: VAULT,
  input: encodeFunctionData({ abi: ABI, functionName: 'cooldownAssets', args: [100n, holder] }),
}
const selfTx = {
  ...tx,
  input: encodeFunctionData({ abi: SELF_ABI, functionName: 'cooldownShares', args: [50n] }),
}
const selfAssetsTx = {
  ...tx,
  input: encodeFunctionData({ abi: SELF_ASSETS_ABI, functionName: 'cooldownAssets', args: [100n] }),
}
const ownerSharesTx = {
  ...tx,
  input: encodeFunctionData({
    abi: OWNER_SHARES_ABI,
    functionName: 'cooldownShares',
    args: [50n, holder],
  }),
}
const receipt = {
  transactionHash: txHash,
  blockHash: hash(block),
  blockNumber: event.blockNumber,
  status: '0x1',
  logs: [event],
}
const issue = {
  sequence: 3,
  sha256: 'a'.repeat(64),
  holder,
  pendingAssetsRaw: '100',
  cooldownEndUtc: new Date((Number(BigInt(blockTimestamp)) + 604800) * 1000).toISOString(),
  screened: [
    {
      status: 'selected',
      discoveryBlock: block.toString(),
      discoveryTransactionHash: txHash,
      discoveryLogIndex: '2',
      receiptProof: {
        status: '0x1',
        transactionHash: txHash,
        blockHash: hash(block),
        blockNumber: event.blockNumber,
        witnessBlockHash: hash(block),
        discoveryLog: { ...event, blockTimestamp },
        receiptLog: { ...event, blockTimestamp },
      },
    },
  ],
  anchor: { blockNumber: TO.toString(), blockHash: hash(TO) },
}
const loadIssue = async () => [null, null, issue]

function peer(provider, changes = {}, onStart = () => {}) {
  return {
    provider,
    async request(method, params) {
      onStart(provider, method)
      if (method === changes.failMethod) throw Error('secret URL path and response body')
      if (method === 'eth_chainId') return changes.chainId ?? '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = BigInt(params[0])
        if (changes.badAnchor && n === TO) return { ...header(n), hash: hash(n + 1n) }
        return header(n)
      }
      if (method === 'eth_getLogs') {
        const [{ fromBlock, toBlock }] = params
        if (params[0].topics[0] === UPDATE_TOPIC) return changes.durationUpdates ?? []
        const inRange = BigInt(fromBlock) <= block && BigInt(toBlock) >= block
        return inRange ? (changes.logs ?? [event]) : []
      }
      if (method === 'eth_getTransactionByHash') return changes.transaction ?? tx
      if (method === 'eth_getTransactionReceipt') return changes.receipt ?? receipt
      if (method === 'eth_call') {
        const data = params[0].data
        assert.equal(params[1].blockHash, hash(block - 1n))
        if (data === DURATION_DATA)
          return encodeAbiParameters([{ type: 'uint24' }], [changes.duration ?? 604800])
        return encodeAbiParameters([{ type: 'address' }], [SILO])
      }
      throw Error(`unexpected method ${method}`)
    },
  }
}

async function run(t, right = {}, left = {}, issueOverride = issue, observedStarts = []) {
  const out = await mkdtemp(join(tmpdir(), 'susde-preanchor-test-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  let clock = 0
  const starts = observedStarts
  const onStart = (provider, method) => starts.push({ provider, method, at: clock })
  const clients = () => [
    peer('https://a.example', left, onStart),
    peer('https://b.example', right, onStart),
  ]
  return {
    out,
    starts,
    result: await capturePreanchor({
      out,
      clients,
      loadIssue: async () => [null, null, issueOverride],
      now: () => new Date('2026-10-02T00:00:00.000Z'),
      nowMs: () => clock,
      statfs: sufficientDisk,
      sleep: async (ms) => {
        clock += ms
      },
    }),
  }
}

test('bounded two-origin proof seals one pre-anchor cooldown request without payout claim', async (t) => {
  const { out, result, starts } = await run(t)
  assert.equal(result.status, 'complete')
  assert.ok(result.calls <= MAX_RPC_CALLS)
  assert.equal(result.calls, 36)
  assert.equal(starts.length, 36)
  for (const provider of ['https://a.example', 'https://b.example']) {
    const times = starts.filter((row) => row.provider === provider).map((row) => row.at)
    assert.equal(times.length, 18)
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 200)
  }
  assert.equal(result.blockNumber, block.toString())
  assert.equal(result.assetsRaw, '100')
  const verified = await verifyPreanchor(out, undefined, loadIssue)
  assert.equal(verified.rows.length, 1)
  assert.equal(verified.rows[0].sameEpisodePayoutProven, false)
  assert.equal(verified.rows[0].cryptographicAbsenceProven, false)
  assert.equal(verified.rows[0].twoOriginObservedLogAgreement, true)
  assert.equal(verified.rows[0].headerChainContinuityProven, false)
  assert.equal(verified.rows[0].cooldownAtExecutionProven, false)
  assert.equal(FROM, 26093684n)
})

test('prefers two working historical-log hosts over an unreliable intervening host', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'susde-preanchor-hosts-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  const origins = []
  const clients = () => [
    peer('https://eth-mainnet.g.alchemy.com', {}, (provider) => origins.push(provider)),
    peer('https://mainnet.infura.io', { failMethod: 'eth_getBlockByNumber' }, (provider) =>
      origins.push(provider),
    ),
    peer('https://rpc.ankr.com', {}, (provider) => origins.push(provider)),
  ]
  let clock = 0
  const result = await capturePreanchor({
    out,
    clients,
    loadIssue,
    nowMs: () => clock,
    statfs: sufficientDisk,
    sleep: async (ms) => {
      clock += ms
    },
  })
  assert.equal(result.status, 'complete')
  assert.equal(origins.includes('https://mainnet.infura.io'), false)
})

test('rejects origin disagreement and noncanonical anchor', async (t) => {
  await assert.rejects(
    run(t, { logs: [{ ...event, transactionHash: `0x${'f'.repeat(64)}` }] }),
    /preanchor_origin_disagreement/,
  )
  await assert.rejects(run(t, { badAnchor: true }), /preanchor_anchor_disagreement/)
})

test('rejects ambiguous requests and malformed selected transaction', async (t) => {
  const extra = { ...event, transactionHash: `0x${'f'.repeat(64)}`, logIndex: '0x3' }
  await assert.rejects(
    run(t, { logs: [event, extra] }, { logs: [event, extra] }),
    /preanchor_ambiguous_request/,
  )
  await assert.rejects(
    run(t, { transaction: { ...tx, from: SILO } }, { transaction: { ...tx, from: SILO } }),
    /preanchor_transaction_invalid/,
  )
})

test('rejects disabled cooldown at the transaction parent block', async (t) => {
  await assert.rejects(run(t, { duration: 0 }, { duration: 0 }), /preanchor_cooldown_call_invalid/)
})

test('accepts the observed one-argument cooldownShares selector with exact holder shares', async (t) => {
  assert.equal(selfTx.input.slice(0, 10), '0x9343d9e1')
  const { out, result } = await run(t, { transaction: selfTx }, { transaction: selfTx })
  assert.equal(result.status, 'complete')
  assert.equal((await verifyPreanchor(out, undefined, loadIssue)).rows.length, 1)
  const wrongShares = {
    ...selfTx,
    input: encodeFunctionData({ abi: SELF_ABI, functionName: 'cooldownShares', args: [51n] }),
  }
  await assert.rejects(
    run(t, { transaction: wrongShares }, { transaction: wrongShares }),
    /preanchor_cooldown_call_invalid/,
  )
})

test('accepts deployed one-argument cooldownAssets only for exact holder assets', async (t) => {
  assert.equal(selfAssetsTx.input.slice(0, 10), '0xcdac52ed')
  const { out, result } = await run(t, { transaction: selfAssetsTx }, { transaction: selfAssetsTx })
  assert.equal(result.status, 'complete')
  assert.equal(result.assetsRaw, '100')
  assert.equal((await verifyPreanchor(out, undefined, loadIssue)).rows.length, 1)
  const wrongAssets = {
    ...selfAssetsTx,
    input: encodeFunctionData({
      abi: SELF_ASSETS_ABI,
      functionName: 'cooldownAssets',
      args: [101n],
    }),
  }
  await assert.rejects(
    run(t, { transaction: wrongAssets }, { transaction: wrongAssets }),
    /preanchor_cooldown_call_invalid/,
  )
})

test('preserves archival two-argument cooldownShares parsing', async (t) => {
  const { out, result } = await run(
    t,
    { transaction: ownerSharesTx },
    { transaction: ownerSharesTx },
  )
  assert.equal(result.status, 'complete')
  assert.equal((await verifyPreanchor(out, undefined, loadIssue)).rows.length, 1)
})

test('rejects a same-block duration update before the selected request', async (t) => {
  await assert.rejects(
    run(t, { durationUpdates: [earlyUpdate] }, { durationUpdates: [earlyUpdate] }),
    /preanchor_same_block_duration_change/,
  )
})

test('rejects an unrelated same-holder request by discovery transaction or log index', async (t) => {
  const wrongTx = structuredClone(issue)
  wrongTx.screened[0].discoveryTransactionHash = `0x${'f'.repeat(64)}`
  await assert.rejects(run(t, {}, {}, wrongTx), /preanchor_issue_discovery_mismatch/)
  const wrongLog = structuredClone(issue)
  wrongLog.screened[0].discoveryLogIndex = '3'
  await assert.rejects(run(t, {}, {}, wrongLog), /preanchor_issue_discovery_mismatch/)
  const wrongReceipt = structuredClone(issue)
  wrongReceipt.screened[0].receiptProof.receiptLog = { ...event, logIndex: '0x3' }
  await assert.rejects(run(t, {}, {}, wrongReceipt), /preanchor_issue_discovery_mismatch/)
})

test('rejects a selected event amount different from issue 3 pending assets', async (t) => {
  const wrongAmount = structuredClone(issue)
  wrongAmount.pendingAssetsRaw = '101'
  await assert.rejects(run(t, {}, {}, wrongAmount), /preanchor_issue_discovery_mismatch/)
})

test('rejects a cooldown end that does not follow the selected block timestamp', async (t) => {
  const wrongTiming = structuredClone(issue)
  wrongTiming.cooldownEndUtc = new Date(Date.parse(issue.cooldownEndUtc) + 1000).toISOString()
  await assert.rejects(run(t, {}, {}, wrongTiming), /preanchor_cooldown_timing_mismatch/)
})

test('RPC failures name only host and method, and stop queued work', async (t) => {
  const starts = []
  await assert.rejects(
    run(t, { failMethod: 'eth_getTransactionReceipt' }, {}, issue, starts),
    (error) => {
      assert.match(
        error.message,
        /preanchor_rpc_unavailable host=b\.example method=eth_getTransactionReceipt/,
      )
      assert.doesNotMatch(error.message, /secret|https?:\/\//)
      return true
    },
  )
  const bMethods = starts
    .filter((row) => row.provider === 'https://b.example')
    .map((row) => row.method)
  assert.equal(bMethods.at(-1), 'eth_getTransactionReceipt')
  assert.equal(bMethods.filter((method) => method === 'eth_getTransactionReceipt').length, 1)
})

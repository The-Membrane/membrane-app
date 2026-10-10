import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  parseAbiItem,
  toEventHash,
} from 'viem'
import {
  IMPLEMENTATION_SLOT,
  RESERVE_BYTES,
  collect as collectCheckpoint,
  readValidatedCheckpoints,
} from './susds-finalized-checkpoint.mjs'
import {
  collect,
  classifySusdsFlowError,
  createPlan,
  parseOptions,
  readValidatedReceipts,
  recorderRpcRing,
  selectRpc,
  summarizeReceipts,
  verify,
} from './susds-vault-flow-ledger.mjs'

const VAULT = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'
const USDS = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
const IMPL = '0x1234567890123456789012345678901234567890'
const ACTOR = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const BASE = Math.floor(Date.now() / 1000) - 120
const HASH = (n) => `0x${n.toString(16).padStart(64, '0')}`
const Q = (n) => `0x${n.toString(16)}`
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
])
const EVENTS = {
  deposit: parseAbiItem(
    'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  ),
  withdraw: parseAbiItem(
    'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  ),
}
const stat = () => ({ bavail: 2, bsize: RESERVE_BYTES })
const now = () => new Date((BASE + 10) * 1000)
const planNow = () => new Date((BASE + 100) * 1000)
const tmp = () => mkdtempSync(join(tmpdir(), 'susds-flow-'))
function event(kind, blockNumber, logIndex, amount) {
  const args =
    kind === 'deposit'
      ? { sender: ACTOR, owner: OTHER }
      : { sender: ACTOR, receiver: OTHER, owner: ACTOR }
  return {
    address: VAULT,
    topics: encodeEventTopics({
      abi: [EVENTS[kind]],
      eventName: kind === 'deposit' ? 'Deposit' : 'Withdraw',
      args,
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [BigInt(amount), BigInt(amount)],
    ),
    blockNumber: Q(blockNumber),
    blockHash: HASH(blockNumber),
    transactionHash: HASH(1000 + logIndex),
    transactionIndex: '0x0',
    logIndex: Q(logIndex),
    removed: false,
  }
}
function provider({
  logs = [],
  truncated = false,
  reorg = false,
  codeDrift = false,
  upgrade = false,
  finalized = 103,
} = {}) {
  const calls = []
  let reads101 = 0
  const client = {
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? finalized : Number(BigInt(params[0]))
        const hash = reorg && n === 101 && ++reads101 > 1 ? HASH(999) : HASH(n)
        return { number: Q(n), hash, parentHash: HASH(n - 1), timestamp: Q(BASE + (n - 100) * 12) }
      }
      if (method === 'eth_call') {
        const name = decodeFunctionData({ abi: ABI, data: params[0].data }).functionName
        const values = {
          asset: USDS,
          decimals: 18,
          totalAssets: 2_000_000n,
          totalSupply: 1_000_000n,
          convertToAssets: 2_000_000_000_000_000_000n,
        }
        return encodeFunctionResult({ abi: ABI, functionName: name, result: values[name] })
      }
      if (method === 'eth_getCode') {
        if (params[0].toLowerCase() === VAULT) return codeDrift ? '0x60056006' : '0x60016002'
        if (params[0].toLowerCase() === IMPL) return '0x60036004'
      }
      if (method === 'eth_getStorageAt') {
        assert.equal(params[1], IMPLEMENTATION_SLOT)
        return `0x${'0'.repeat(24)}${IMPL.slice(2)}`
      }
      if (method === 'eth_getLogs') {
        const { fromBlock, toBlock, topics } = params[0]
        if (
          upgrade &&
          topics[0] ===
            toEventHash(
              parseAbiItem('event Upgraded(address indexed implementation)'),
            ).toLowerCase()
        )
          return [{}]
        const selected = logs.filter(
          (log) =>
            Number(BigInt(log.blockNumber)) >= Number(BigInt(fromBlock)) &&
            Number(BigInt(log.blockNumber)) <= Number(BigInt(toBlock)) &&
            (Array.isArray(topics[0])
              ? topics[0].includes(log.topics[0])
              : topics[0] === log.topics[0]),
        )
        if (truncated && Array.isArray(topics[0]) && topics[0].length === 2)
          return selected.slice(0, 1)
        return selected
      }
      throw new Error(`Unexpected method ${method}`)
    },
  }
  return { client, calls }
}
async function setup() {
  const root = tmp(),
    checkpointOut = join(root, 'checkpoints'),
    out = join(root, 'ledger')
  await collectCheckpoint({
    client: provider({ finalized: 100 }).client,
    out: checkpointOut,
    now,
    stat,
  })
  return { root, checkpointOut, out }
}
async function scan(f, options = {}) {
  return collect({
    client: provider(options).client,
    out: f.out,
    checkpointOut: f.checkpointOut,
    rpcHost: 'example.invalid',
    now: planNow,
    stat,
    range: 2,
    maxChunks: 2,
  })
}

test('quiet pages seal checkpoint-anchored backfill and disclose pre-plan block time', async () => {
  const f = await setup()
  try {
    const result = await scan(f)
    assert.equal(result.receipts, 2)
    assert.equal(result.fromBlock, 101)
    assert.equal(result.throughBlock, 103)
    const receipts = readValidatedReceipts({ out: f.out, checkpointOut: f.checkpointOut })
    assert.equal(receipts[0].planCreatedAtUtc, planNow().toISOString())
    const summary = summarizeReceipts(receipts)
    assert.equal(summary.coverage.planCreatedAtUtc, planNow().toISOString())
    assert.equal(
      summary.coverage.blockTimeRelativeToPlan,
      'all_block_timestamps_before_plan_second',
    )
    assert.equal(receipts[0].events.length, 0)
    assert.equal(verify({ out: f.out, checkpointOut: f.checkpointOut }).status, 'verified')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('mixed event order, amounts, gross flows, and signed net are separate', async () => {
  const f = await setup()
  try {
    const logs = [
      event('withdraw', 102, 2, 7),
      event('deposit', 101, 0, 3),
      event('withdraw', 102, 1, 5),
    ]
    await scan(f, { logs })
    const receipts = readValidatedReceipts({ out: f.out, checkpointOut: f.checkpointOut })
    assert.deepEqual(
      receipts.flatMap((r) => r.events).map((e) => e.assetsRaw),
      ['3', '5', '7'],
    )
    const summary = summarizeReceipts(receipts)
    assert.equal(summary.totals.grossDepositsRaw, '3')
    assert.equal(summary.totals.grossWithdrawalsRaw, '12')
    assert.equal(summary.totals.signedNetDepletionRaw, '9')
    assert.equal(summary.maximumObservedCompleteWindowGrossWithdrawals['24h'].status, 'unavailable')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('combined/separate mismatch cannot seal a page', async () => {
  const f = await setup()
  try {
    await assert.rejects(
      scan(f, {
        logs: [event('deposit', 101, 0, 3), event('withdraw', 101, 1, 5)],
        truncated: true,
      }),
      /disagree/,
    )
    assert.equal(verify({ out: f.out, checkpointOut: f.checkpointOut }).receipts, 0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('reorg, implementation drift, duplicate log and tampered receipt fail closed', async () => {
  const f = await setup()
  try {
    await assert.rejects(scan(f, { reorg: true }), /parent|hash|drift/i)
    await assert.rejects(scan(f, { codeDrift: true }), /identity changed/)
    await assert.rejects(scan(f, { upgrade: true }), /implementation upgrade/)
    await assert.rejects(
      scan(f, { logs: [event('withdraw', 101, 0, 5), event('withdraw', 101, 0, 5)] }),
      /Duplicate/,
    )
    assert.equal(verify({ out: f.out, checkpointOut: f.checkpointOut }).receipts, 0)
    const result = await scan(f)
    const path = result.paths[0]
    const row = JSON.parse(readFileSync(path))
    row.range.from.hash = HASH(999)
    writeFileSync(path, JSON.stringify(row) + '\n')
    assert.throws(() => verify({ out: f.out, checkpointOut: f.checkpointOut }), /seal mismatch/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('plan binds exact source implementation and checkpoint physical seal', async () => {
  const f = await setup()
  try {
    const entry = readValidatedCheckpoints({ out: f.checkpointOut })[0]
    const plan = createPlan({ checkpoint: entry, rpcHost: 'example.invalid', now })
    assert.equal(plan.startBlock, 101)
    assert.equal(plan.checkpoint.physicalSha256, entry.physicalSha256)
    assert.equal(
      plan.checkpoint.implementationCodeHash,
      entry.checkpoint.contract.implementationCodeHash,
    )
    const corrupt = { ...entry, physicalSha256: 'f'.repeat(64) }
    assert.notEqual(
      createPlan({ checkpoint: corrupt, rpcHost: 'example.invalid', now }).sha256,
      plan.sha256,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('complete windows include quiet start, both edges, and negative signed net', () => {
  const at = (kind, time, amount) => ({ kind, blockTimestamp: time, assetsRaw: String(amount) })
  const receipts = [
    {
      range: { from: { number: 1, timestamp: 1 }, to: { number: 2, timestamp: 604_801 } },
      events: [at('deposit', 1, 10), at('withdraw', 86_400, 4), at('deposit', 86_402, 8)],
    },
  ]
  const summary = summarizeReceipts(receipts)
  assert.equal(
    summary.maximumObservedCompleteWindowGrossWithdrawals['24h'].grossWithdrawalsRaw,
    '4',
  )
  assert.equal(
    summary.maximumObservedCompleteWindowSignedNetDepletion['24h'].signedNetDepletionRaw,
    '4',
  )
  assert.equal(
    summary.maximumObservedCompleteWindowSignedNetDepletion['7d'].signedNetDepletionRaw,
    '-4',
  )
  assert.equal(summary.maximumObservedCompleteWindowGrossWithdrawals['7d'].grossWithdrawalsRaw, '4')
})

test('CLI RPC source reads the recorder ring and selects the requested host', () => {
  const config = {
    get: (key) =>
      key === 'RECORDER_RPC_URL' ? 'https://first.invalid,https://second.invalid' : undefined,
  }
  assert.deepEqual(selectRpc(recorderRpcRing({ env: {}, config }), 1), {
    url: 'https://second.invalid/',
    host: 'second.invalid',
  })
  assert.equal(
    recorderRpcRing({ env: { RECORDER_RPC_URL: 'https://override.invalid' }, config }),
    'https://override.invalid',
  )
  assert.throws(() => selectRpc(recorderRpcRing({ env: {}, config }), 2), /index unavailable/)
})

test('CLI accepts all three bounded run options and rejects malformed pairs', () => {
  assert.deepEqual(
    parseOptions(['--run', '--rpc-index', '1', '--range', '32', '--max-chunks', '1']),
    {
      mode: '--run',
      values: { '--rpc-index': 1, '--range': 32, '--max-chunks': 1 },
    },
  )
  assert.deepEqual(parseOptions(['--verify']), { mode: '--verify', values: {} })
  assert.throws(() => parseOptions(['--run', '--range']), /options/)
  assert.throws(() => parseOptions(['--run', '--range', '32', '--range', '64']), /option/)
  assert.throws(
    () =>
      parseOptions([
        '--run',
        '--range',
        '32',
        '--max-chunks',
        '1',
        '--rpc-index',
        '0',
        '--range',
        '2',
      ]),
    /options/,
  )
})

test('CLI failure categories never disclose provider messages or credentialed URLs', () => {
  const secret = 'https://user:private-token@example.invalid/rpc?api_key=secret'
  const cases = [
    [Object.assign(new Error(secret), { status: 429 }), 'rate_limited'],
    [new Error('sUSDS flow disk reserve reached'), 'disk_reserve'],
    [new Error('sUSDS vault or implementation identity changed'), 'invalid_source'],
    [new TypeError('fetch failed', { cause: new Error(secret) }), 'transport_timeout'],
    [Object.assign(new Error(secret), { code: 'ETIMEDOUT' }), 'transport_timeout'],
    [new Error(secret), 'unknown'],
  ]
  for (const [error, expected] of cases) {
    const category = classifySusdsFlowError(error)
    assert.equal(category, expected)
    assert.equal(category.includes(secret), false)
  }
  const circular = { message: secret }
  circular.cause = circular
  assert.equal(classifySusdsFlowError(circular), 'unknown')
})

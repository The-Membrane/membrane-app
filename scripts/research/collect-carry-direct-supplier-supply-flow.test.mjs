import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  collectDirectSupplierFlowSegment,
  verifyDirectSupplierFlowSegment,
  verifyDirectSupplierFlowSegments,
  SUPPLY_STUDY_V2,
} from './collect-carry-direct-supplier-flow.mjs'
import {
  backfillDirectSupplierFlow,
  MIN_FREE_BYTES,
} from './backfill-carry-direct-supplier-flow.mjs'

const H99 = `0x${'99'.repeat(32)}`
const H100 = `0x${'ab'.repeat(32)}`
const H101 = `0x${'bc'.repeat(32)}`
const TX = `0x${'aa'.repeat(32)}`
const HOLDER = '0x1111111111111111111111111111111111111111'
const BENEFICIARY = '0x2222222222222222222222222222222222222222'
const amount = 1_000_000n
const transferAbi = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const aaveSupplyAbi = parseAbiItem(
  'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
)
const cometSupplyAbi = parseAbiItem(
  'event Supply(address indexed from,address indexed dst,uint256 amount)',
)
const MARKETS = [
  ['aaveV3Usdc', 'aave', 'USDC → supply on Aave V3'],
  ['aaveV3Usde', 'aave', 'USDe → supply on Aave V3'],
  ['sparkLendUsdt', 'spark', 'USDT → supply on Spark'],
  ['compoundV3Usdc', 'comet', 'USDC → supply on Compound v3'],
]

function event(address, abi, args, index) {
  return {
    address,
    blockNumber: '0x64',
    blockHash: H100,
    transactionHash: TX,
    transactionIndex: '0x0',
    logIndex: `0x${index.toString(16)}`,
    removed: false,
    topics: encodeEventTopics({ abi: [abi], eventName: abi.name, args }),
    data: encodeAbiParameters(
      abi.inputs.filter((input) => !input.indexed),
      abi.inputs.filter((input) => !input.indexed).map((input) => args[input.name]),
    ),
  }
}

function scenario(
  kind,
  routeKey,
  { transferAmount = amount, includeTransfer = true, includeSupply = true } = {},
) {
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (entry) => entry.kind === kind && entry.routeKey === routeKey,
  )
  assert.ok(route)
  const transfer = event(
    route.asset,
    transferAbi,
    { from: HOLDER, to: route.destination, value: transferAmount },
    1,
  )
  const supply =
    kind === 'comet'
      ? event(route.withdrawTarget, cometSupplyAbi, { from: HOLDER, dst: BENEFICIARY, amount }, 2)
      : event(
          route.withdrawTarget,
          aaveSupplyAbi,
          { reserve: route.asset, user: HOLDER, onBehalfOf: BENEFICIARY, amount, referralCode: 0 },
          2,
        )
  const logs = [includeTransfer ? transfer : null, includeSupply ? supply : null].filter(Boolean)
  const receipt = {
    status: '0x1',
    blockNumber: '0x64',
    blockHash: H100,
    transactionHash: TX,
    transactionIndex: '0x0',
    logs,
  }
  return { route, supply, receipt }
}

function rpc({ supply, receipt }) {
  return {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'finalized' ? 101 : Number(BigInt(params[0]))
        if (number === 100)
          return { number: '0x64', hash: H100, parentHash: H99, timestamp: '0x3e8' }
        if (number === 101)
          return { number: '0x65', hash: H101, parentHash: H100, timestamp: '0x3f4' }
      }
      if (method === 'eth_getLogs') return supply ? [supply] : []
      if (method === 'eth_getTransactionReceipt') return receipt
      throw Error('unexpected_rpc')
    },
  }
}

async function collect(marketKey, source, secondary = source) {
  return collectDirectSupplierFlowSegment({
    marketKey,
    flowKind: 'supply',
    fromBlock: 100,
    toBlock: 100,
    primary: rpc(source),
    secondary: rpc(secondary),
    primaryOrigin: 'https://first.example',
    secondaryOrigin: 'https://second.example',
  })
}

for (const [marketKey, kind, routeKey] of MARKETS) {
  test(`${marketKey} gross supply needs an exact custodial transfer and sealed paired receipt`, async () => {
    const source = scenario(kind, routeKey)
    const { document, verified } = await collect(marketKey, source)
    assert.equal(document.study, SUPPLY_STUDY_V2)
    assert.equal(verified.supplies.length, 1)
    assert.equal(verified.withdrawals.length, 0)
    assert.equal(verified.supplies[0].reconciliation.evidence.amountRaw, amount.toString())
    assert.equal(verified.supplies[0].reconciliation.evidence.beneficiary, BENEFICIARY)
    assert.equal(verifyDirectSupplierFlowSegments([document]).supplies.length, 1)
    assert.deepEqual(verified.coverage.intervals, [
      {
        startMs: 1_000_000,
        endMs: 1_012_000,
        finalized: true,
        receiptsComplete: true,
        ambiguousReceipts: 0,
      },
    ])
  })
}

test('supply without exact underlying inflow cannot seal complete coverage', async () => {
  const [, kind, routeKey] = MARKETS[0]
  await assert.rejects(
    () => collect('aaveV3Usdc', scenario(kind, routeKey, { transferAmount: amount + 1n })),
    /ambiguous_direct_supplier_receipt/,
  )
})

test('two RPC origins must agree even about a quiet supply range', async () => {
  const [, kind, routeKey] = MARKETS[0]
  const observed = scenario(kind, routeKey)
  const quiet = { supply: null, receipt: observed.receipt }
  await assert.rejects(
    () => collect('aaveV3Usdc', observed, quiet),
    /direct_provider_log_disagreement/,
  )
  const result = await collect('aaveV3Usdc', quiet)
  assert.equal(result.verified.supplies.length, 0)
  assert.equal(result.verified.coverage.intervals[0].receiptsComplete, true)
})

test('supply replay rejects changed asset filter even when attacker recomputes local SHA', async () => {
  const [, kind, routeKey] = MARKETS[0]
  const { document } = await collect('aaveV3Usdc', scenario(kind, routeKey))
  const changed = structuredClone(document)
  changed.filter.topics[1] = `0x${'00'.repeat(32)}`
  const { sha256, ...body } = changed
  changed.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  assert.throws(() => verifyDirectSupplierFlowSegment(changed), /direct_market_filter_mismatch/)
})

test('bounded supply backfill writes a separate immutable namespace and resumes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-supply-'))
  try {
    const source = scenario('aave', 'USDC → supply on Aave V3')
    const options = {
      marketKey: 'aaveV3Usdc',
      flowKind: 'supply',
      fromBlock: 100,
      toBlock: 100,
      outDir: dir,
      maxSegments: 1,
      rpcUrls: 'https://first.example,https://second.example',
      clientFactory: () => rpc(source),
      stat: () => ({ bavail: 2 * MIN_FREE_BYTES, bsize: 1 }),
    }
    const first = await backfillDirectSupplierFlow(options)
    assert.equal(first.status, 'complete')
    assert.equal(first.reconciledSupplies, 1)
    assert.equal(first.reconciledWithdrawals, 0)
    assert.deepEqual(readdirSync(dir).sort(), [
      '.direct-flow-publication-supply-aaveV3Usdc-100-100.json',
      'supply-aaveV3Usdc-100-100.json',
    ])
    const resumed = await backfillDirectSupplierFlow(options)
    assert.equal(resumed.newSegments, 0)
    assert.equal(resumed.resumedSegments, 1)
    assert.equal(resumed.reconciledSupplies, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

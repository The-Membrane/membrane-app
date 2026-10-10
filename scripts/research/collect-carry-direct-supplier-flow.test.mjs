import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import {
  collectDirectSupplierFlowSegment,
  selectDirectRpcOrigins,
  verifyDirectSupplierFlowSegment,
  verifyDirectSupplierFlowSegments,
} from './collect-carry-direct-supplier-flow.mjs'

const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const SPARK_POOL = '0xc13e21b648a5ee794902342038ff3adab66be987'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const ATOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const USDE_ATOKEN = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
const SPARK_ATOKEN = '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f'
const COMET = '0xc3d688b66703497daa19211eedff47f25384cdc3'
const ZERO = '0x0000000000000000000000000000000000000000'
const HOLDER = '0x1111111111111111111111111111111111111111'
const RECEIVER = '0x2222222222222222222222222222222222222222'
const TX = `0x${'aa'.repeat(32)}`
const H99 = `0x${'99'.repeat(32)}`
const H100 = `0x${'ab'.repeat(32)}`
const H101 = `0x${'bc'.repeat(32)}`
const WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
)
const BORROW = parseAbiItem(
  'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)',
)
const SUPPLY = parseAbiItem(
  'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
)
const COMET_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed src,address indexed to,uint256 amount)',
)
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)

function event(address, abi, args, index) {
  const nonindexed = abi.inputs.filter((input) => !input.indexed)
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
      nonindexed,
      nonindexed.map((input) => args[input.name]),
    ),
  }
}

function withCompleteIndices(events) {
  const sorted = [...events].sort((a, b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)))
  const complete = []
  for (const item of sorted) {
    const index = Number(BigInt(item.logIndex))
    for (
      let i = (complete.at(-1) ? Number(BigInt(complete.at(-1).logIndex)) : index - 1) + 1;
      i < index;
      i++
    ) {
      complete.push(event(USDT, TRANSFER, { from: HOLDER, to: RECEIVER, value: 1n }, i))
    }
    complete.push(item)
  }
  return complete
}

const amount = 1_000_000n
const payout = event(USDC, TRANSFER, { from: ATOKEN, to: RECEIVER, value: amount }, 1)
const withdraw = event(POOL, WITHDRAW, { reserve: USDC, user: HOLDER, to: RECEIVER, amount }, 2)
const borrow = event(
  POOL,
  BORROW,
  {
    reserve: USDC,
    user: HOLDER,
    onBehalfOf: HOLDER,
    amount,
    interestRateMode: 2,
    borrowRate: 1n,
    referralCode: 0,
  },
  3,
)
const baseReceipt = {
  status: '0x1',
  blockNumber: '0x64',
  blockHash: H100,
  transactionHash: TX,
  transactionIndex: '0x0',
  logs: [payout, withdraw],
}

function rpc({ logs = [withdraw], receipt = baseReceipt, headerHash = H100 } = {}) {
  const calls = []
  const client = {
    async request({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'finalized' ? 101 : Number(BigInt(params[0]))
        if (number === 100)
          return { number: '0x64', hash: headerHash, parentHash: H99, timestamp: '0x3e8' }
        if (number === 101)
          return { number: '0x65', hash: H101, parentHash: headerHash, timestamp: '0x3f4' }
      }
      if (method === 'eth_getLogs') {
        const start = Number(BigInt(params[0].fromBlock))
        const end = Number(BigInt(params[0].toBlock))
        return logs.filter((item) => {
          const block = Number(BigInt(item.blockNumber))
          return block >= start && block <= end
        })
      }
      if (method === 'eth_getTransactionReceipt') return receipt
      throw new Error(`unexpected_${method}`)
    },
  }
  return { client, calls }
}

async function collect(first = rpc(), second = rpc()) {
  return collectDirectSupplierFlowSegment({
    primary: first.client,
    secondary: second.client,
    primaryOrigin: 'https://primary.example',
    secondaryOrigin: 'https://secondary.example',
    marketKey: 'aaveV3Usdc',
    fromBlock: 100,
    toBlock: 100,
  })
}

test('reconstructs one exact supplier payout and a complete inclusive block segment', async () => {
  const first = rpc()
  const second = rpc()
  const { document, verified } = await collect(first, second)
  assert.equal(verified.withdrawals.length, 1)
  assert.equal(verified.withdrawals[0].reconciliation.evidence.amountRaw, amount.toString())
  assert.deepEqual(verified.coverage.intervals, [
    {
      startMs: 1_000_000,
      endMs: 1_012_000,
      finalized: true,
      receiptsComplete: true,
      ambiguousReceipts: 0,
    },
  ])
  assert.equal(document.sourceAgreement, 'two_public_rpc_origins_agree_not_absolute_completeness')
  assert.equal(first.calls.filter((call) => call.method === 'eth_getLogs').length, 1)
  assert.deepEqual(
    first.calls.find((call) => call.method === 'eth_getLogs').params[0].fromBlock,
    '0x64',
  )
  assert.equal(verifyDirectSupplierFlowSegments([document]).withdrawals.length, 1)
})

test('Aave USDe segment filters only its reserve and replays an exact USDe receipt', async () => {
  const usdePayout = event(USDE, TRANSFER, { from: USDE_ATOKEN, to: RECEIVER, value: amount }, 1)
  const usdeWithdraw = event(
    POOL,
    WITHDRAW,
    { reserve: USDE, user: HOLDER, to: RECEIVER, amount },
    2,
  )
  const receipt = { ...baseReceipt, logs: [usdePayout, usdeWithdraw] }
  const first = rpc({ logs: [usdeWithdraw], receipt })
  const second = rpc({ logs: [usdeWithdraw], receipt })
  const result = await collectDirectSupplierFlowSegment({
    primary: first.client,
    secondary: second.client,
    primaryOrigin: 'https://primary.example',
    secondaryOrigin: 'https://secondary.example',
    marketKey: 'aaveV3Usde',
    fromBlock: 100,
    toBlock: 100,
  })
  assert.equal(result.verified.withdrawals.length, 1)
  assert.equal(result.verified.withdrawals[0].reconciliation.underlying, USDE)
  assert.equal(result.verified.withdrawals[0].reconciliation.destination, USDE_ATOKEN)
  assert.equal(result.document.filter.address, POOL)
  assert.notDeepEqual(result.document.filter.topics, (await collect()).document.filter.topics)
  assert.equal(first.calls.filter((call) => call.method === 'eth_getLogs').length, 1)
})

test('two Aave withdrawals in one receipt produce distinct Q event rows, including equal amounts and different holders', async () => {
  const secondPayout = event(USDC, TRANSFER, { from: ATOKEN, to: HOLDER, value: amount }, 3)
  const secondWithdraw = event(
    POOL,
    WITHDRAW,
    { reserve: USDC, user: RECEIVER, to: HOLDER, amount },
    4,
  )
  const logs = [withdraw, secondWithdraw]
  const fullReceipt = { ...baseReceipt, logs: [payout, withdraw, secondPayout, secondWithdraw] }
  const first = rpc({ logs, receipt: fullReceipt })
  const second = rpc({ logs, receipt: fullReceipt })
  const { document, verified } = await collect(first, second)
  assert.equal(document.receipts.length, 1)
  assert.equal(verified.candidateCount, 2)
  assert.deepEqual(
    verified.withdrawals.map((row) => [
      row.logIndex,
      row.reconciliation.evidence.holder,
      row.reconciliation.evidence.payoutLogIndex,
      row.reconciliation.evidence.amountRaw,
    ]),
    [
      [2, HOLDER, 1, amount.toString()],
      [4, RECEIVER, 3, amount.toString()],
    ],
  )
  assert.deepEqual(
    verifyDirectSupplierFlowSegment(document).withdrawals.map((row) => row.logIndex),
    [2, 4],
  )
})

test('exact USDC candidate completeness ignores another-reserve Withdraw and accepts the observed mixed local payout shape', async () => {
  const otherReserve = event(
    POOL,
    WITHDRAW,
    { reserve: WETH, user: HOLDER, to: RECEIVER, amount },
    478,
  )
  const earlierPayout = event(USDC, TRANSFER, { from: ATOKEN, to: HOLDER, value: amount }, 479)
  const wethSupply = event(
    POOL,
    SUPPLY,
    { reserve: WETH, user: HOLDER, onBehalfOf: HOLDER, amount, referralCode: 0 },
    497,
  )
  const localPayout = event(USDC, TRANSFER, { from: ATOKEN, to: RECEIVER, value: amount }, 506)
  const localWithdraw = event(
    POOL,
    WITHDRAW,
    { reserve: USDC, user: HOLDER, to: RECEIVER, amount },
    507,
  )
  const mixed = {
    ...baseReceipt,
    logs: withCompleteIndices([
      otherReserve,
      earlierPayout,
      wethSupply,
      localPayout,
      localWithdraw,
    ]),
  }
  const { document, verified } = await collect(
    rpc({ logs: [localWithdraw], receipt: mixed }),
    rpc({ logs: [localWithdraw], receipt: mixed }),
  )
  assert.equal(verified.candidateCount, 1)
  assert.equal(verified.withdrawals[0].reconciliation.evidence.payoutLogIndex, 506)
  assert.equal(verifyDirectSupplierFlowSegment(document).withdrawals.length, 1)
})

test('collector rejects omitted candidate or missing and mismatched local payouts', async () => {
  const secondPayout = event(USDC, TRANSFER, { from: ATOKEN, to: HOLDER, value: amount }, 3)
  const secondWithdraw = event(
    POOL,
    WITHDRAW,
    { reserve: USDC, user: RECEIVER, to: HOLDER, amount },
    4,
  )
  const fullReceipt = { ...baseReceipt, logs: [payout, withdraw, secondPayout, secondWithdraw] }
  await assert.rejects(
    collect(rpc({ receipt: fullReceipt }), rpc({ receipt: fullReceipt })),
    /incomplete_direct_withdraw_candidates/,
  )
  const candidates = [withdraw, secondWithdraw]
  for (const logs of [
    [
      payout,
      withdraw,
      event(USDT, TRANSFER, { from: HOLDER, to: RECEIVER, value: 1n }, 3),
      secondWithdraw,
    ],
    [
      payout,
      withdraw,
      event(USDC, TRANSFER, { from: ATOKEN, to: HOLDER, value: amount - 1n }, 3),
      secondWithdraw,
    ],
  ]) {
    const ambiguousReceipt = { ...baseReceipt, logs }
    await assert.rejects(
      collect(
        rpc({ logs: candidates, receipt: ambiguousReceipt }),
        rpc({ logs: candidates, receipt: ambiguousReceipt }),
      ),
      /ambiguous_direct_supplier_receipt/,
    )
  }
  const laterActivity = {
    ...baseReceipt,
    logs: [
      payout,
      withdraw,
      secondPayout,
      secondWithdraw,
      event(USDC, TRANSFER, { from: ATOKEN, to: HOLDER, value: 1n }, 5),
      { ...borrow, logIndex: '0x6' },
    ],
  }
  const accepted = await collect(
    rpc({ logs: candidates, receipt: laterActivity }),
    rpc({ logs: candidates, receipt: laterActivity }),
  )
  assert.equal(accepted.verified.withdrawals.length, 2)
})

test('two empty exact-market Withdraw responses seal a complete zero-event range; Borrow is excluded', async () => {
  const first = rpc({ logs: [], receipt: { ...baseReceipt, logs: [payout, borrow] } })
  const second = rpc({ logs: [], receipt: { ...baseReceipt, logs: [payout, borrow] } })
  const { document, verified } = await collect(first, second)
  assert.equal(verified.candidateCount, 0)
  assert.deepEqual(verified.withdrawals, [])
  assert.deepEqual(
    document.logSets.map((set) => set.logs),
    [[], []],
  )
  assert.equal(
    first.calls.some((call) => call.method === 'eth_getTransactionReceipt'),
    false,
  )
})

test('Spark and Comet use their distinct frozen emitters and receipt semantics', async () => {
  const sparkPayout = event(USDT, TRANSFER, { from: SPARK_ATOKEN, to: RECEIVER, value: amount }, 1)
  const sparkWithdraw = event(
    SPARK_POOL,
    WITHDRAW,
    { reserve: USDT, user: HOLDER, to: RECEIVER, amount },
    2,
  )
  const sparkReceipt = { ...baseReceipt, logs: [sparkPayout, sparkWithdraw] }
  const sparkPrimary = rpc({ logs: [sparkWithdraw], receipt: sparkReceipt })
  const sparkSecondary = rpc({ logs: [sparkWithdraw], receipt: sparkReceipt })
  const spark = await collectDirectSupplierFlowSegment({
    primary: sparkPrimary.client,
    secondary: sparkSecondary.client,
    primaryOrigin: 'https://primary.example',
    secondaryOrigin: 'https://secondary.example',
    marketKey: 'sparkLendUsdt',
    fromBlock: 100,
    toBlock: 100,
  })
  assert.equal(spark.verified.withdrawals.length, 1)
  assert.equal(spark.document.filter.address, SPARK_POOL)

  const cometPayout = event(USDC, TRANSFER, { from: COMET, to: RECEIVER, value: amount }, 1)
  const cometWithdraw = event(COMET, COMET_WITHDRAW, { src: HOLDER, to: RECEIVER, amount }, 2)
  const cometBurn = event(COMET, TRANSFER, { from: HOLDER, to: ZERO, value: amount + 1n }, 3)
  const cometReceipt = { ...baseReceipt, logs: [cometPayout, cometWithdraw, cometBurn] }
  const cometPrimary = rpc({ logs: [cometWithdraw], receipt: cometReceipt })
  const cometSecondary = rpc({ logs: [cometWithdraw], receipt: cometReceipt })
  const comet = await collectDirectSupplierFlowSegment({
    primary: cometPrimary.client,
    secondary: cometSecondary.client,
    primaryOrigin: 'https://primary.example',
    secondaryOrigin: 'https://secondary.example',
    marketKey: 'compoundV3Usdc',
    fromBlock: 100,
    toBlock: 100,
  })
  assert.equal(
    comet.verified.withdrawals[0].reconciliation.evidence.burnedSharesRaw,
    String(amount + 1n),
  )
  assert.equal(comet.document.filter.address, COMET)

  const borrowerReceipt = { ...baseReceipt, logs: [cometPayout, cometWithdraw] }
  const borrower = await collectDirectSupplierFlowSegment({
    primary: rpc({ logs: [cometWithdraw], receipt: borrowerReceipt }).client,
    secondary: rpc({ logs: [cometWithdraw], receipt: borrowerReceipt }).client,
    primaryOrigin: 'https://primary.example',
    secondaryOrigin: 'https://secondary.example',
    marketKey: 'compoundV3Usdc',
    fromBlock: 100,
    toBlock: 100,
  })
  assert.equal(borrower.verified.withdrawals.length, 0)
  assert.equal(borrower.verified.unclassifiedWithdrawals.length, 1)
  assert.equal(borrower.verified.unclassifiedWithdrawals[0].eventAmountRaw, String(amount))
  assert.equal(
    borrower.verified.unclassifiedWithdrawals[0].reason,
    'mixed_or_multiple_market_flows',
  )
  assert.equal(borrower.verified.coverage.intervals[0].receiptsComplete, false)
  assert.equal(borrower.verified.coverage.intervals[0].ambiguousReceipts, 1)
  assert.equal(verifyDirectSupplierFlowSegment(borrower.document).unclassifiedWithdrawals.length, 1)
})

test('disagreeing providers cannot certify even an empty range', async () => {
  await assert.rejects(collect(rpc(), rpc({ logs: [] })), /direct_provider_log_disagreement/)
  await assert.rejects(
    collect(rpc(), rpc({ headerHash: H99 })),
    /direct_provider_header_disagreement/,
  )
})

test('receipt must match canonical candidate and both providers', async () => {
  await assert.rejects(
    collect(rpc(), rpc({ receipt: { ...baseReceipt, blockHash: H101 } })),
    /direct_provider_receipt_disagreement/,
  )
  const wrong = { ...baseReceipt, logs: [payout] }
  await assert.rejects(
    collect(rpc({ receipt: wrong }), rpc({ receipt: wrong })),
    /candidate_missing_from_receipt/,
  )
})

test('collector and sealed replay reject missing or reordered transaction logs before local pairing', async () => {
  const laterWithdraw = { ...withdraw, logIndex: '0x3' }
  const incomplete = { ...baseReceipt, logs: [payout, laterWithdraw] }
  await assert.rejects(
    collect(
      rpc({ logs: [laterWithdraw], receipt: incomplete }),
      rpc({ logs: [laterWithdraw], receipt: incomplete }),
    ),
    /incomplete_direct_receipt_log_sequence/,
  )
  const reordered = { ...baseReceipt, logs: [withdraw, payout] }
  await assert.rejects(
    collect(rpc({ receipt: reordered }), rpc({ receipt: reordered })),
    /incomplete_direct_receipt_log_sequence/,
  )
  const { document } = await collect()
  const resealed = structuredClone(document)
  for (const origin of ['primary', 'secondary']) {
    resealed.receipts[0][origin].logs[0].logIndex = 0
  }
  delete resealed.sha256
  resealed.sha256 = createHash('sha256').update(JSON.stringify(resealed)).digest('hex')
  assert.throws(
    () => verifyDirectSupplierFlowSegment(resealed),
    /incomplete_direct_receipt_log_sequence/,
  )
})

test('Borrow intervening between the Aave payout and Withdraw withholds complete coverage', async () => {
  const intervening = { ...borrow, logIndex: '0x2' }
  const laterWithdraw = { ...withdraw, logIndex: '0x3' }
  const mixed = { ...baseReceipt, logs: [payout, intervening, laterWithdraw] }
  await assert.rejects(
    collect(
      rpc({ logs: [laterWithdraw], receipt: mixed }),
      rpc({ logs: [laterWithdraw], receipt: mixed }),
    ),
    /ambiguous_direct_supplier_receipt/,
  )
})

test('sealed evidence rejects tampering and missing pair', async () => {
  const { document } = await collect()
  const tampered = structuredClone(document)
  tampered.blocks[0].timestampSec += 1
  assert.throws(() => verifyDirectSupplierFlowSegment(tampered), /direct_segment_digest_mismatch/)
  const missingPair = structuredClone(document)
  missingPair.logSets.pop()
  assert.throws(
    () => verifyDirectSupplierFlowSegment(missingPair),
    /direct_segment_digest_mismatch/,
  )
})

test('rejects unbounded and unfinalized ranges before publication', async () => {
  await assert.rejects(
    collectDirectSupplierFlowSegment({
      primary: rpc().client,
      secondary: rpc().client,
      primaryOrigin: 'https://primary.example',
      secondaryOrigin: 'https://secondary.example',
      marketKey: 'aaveV3Usdc',
      fromBlock: 0,
      toBlock: 64,
    }),
    /invalid_direct_segment_range/,
  )
  await assert.rejects(
    collectDirectSupplierFlowSegment({
      primary: rpc().client,
      secondary: rpc().client,
      primaryOrigin: 'https://primary.example',
      secondaryOrigin: 'https://secondary.example',
      marketKey: 'aaveV3Usdc',
      fromBlock: 100,
      toBlock: 101,
    }),
    /direct_range_not_finalized/,
  )
})

test('CLI origin selection falls back to comma-separated RECORDER_RPC_URL', () => {
  const pair = selectDirectRpcOrigins({
    rpcUrl: 'https://one.example/key, https://two.example/key, https://three.example/key',
  })
  assert.deepEqual(pair, {
    primaryUrl: 'https://one.example/key',
    secondaryUrl: 'https://two.example/key',
    primaryOrigin: 'https://one.example',
    secondaryOrigin: 'https://two.example',
  })
  assert.equal(
    selectDirectRpcOrigins({
      primaryRpc: 'https://explicit-one.example/key',
      secondaryRpc: 'https://explicit-two.example/key',
      rpcUrl: 'https://one.example/key,https://two.example/key',
    }).primaryOrigin,
    'https://explicit-one.example',
  )
  assert.throws(
    () => selectDirectRpcOrigins({ rpcUrl: 'https://one.example/a,https://one.example/b' }),
    /two_distinct_direct_rpc_origins_required/,
  )
})

test('empty 64-block segment reads only boundary headers from each origin', async () => {
  const first = sparseRpc()
  const second = sparseRpc()
  const { document, verified } = await collectDirectSupplierFlowSegment({
    primary: first.client,
    secondary: second.client,
    primaryOrigin: 'https://primary.example',
    secondaryOrigin: 'https://secondary.example',
    marketKey: 'aaveV3Usdc',
    fromBlock: 100,
    toBlock: 163,
  })
  assert.deepEqual(
    document.blocks.map((point) => point.number),
    [100, 164],
  )
  assert.equal(document.headerCoverage, 'sparse_boundary_candidate_blocks')
  assert.equal(verified.withdrawals.length, 0)
  assert.equal(first.calls.filter((call) => call.method === 'eth_getBlockByNumber').length, 3)
  assert.equal(second.calls.filter((call) => call.method === 'eth_getBlockByNumber').length, 3)
  assert.equal(first.calls.filter((call) => call.method === 'eth_getLogs').length, 7)
  assert.equal(second.calls.filter((call) => call.method === 'eth_getLogs').length, 7)
  assert.deepEqual(
    document.logQueries[0].slices.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]),
    [
      [100, 109],
      [110, 119],
      [120, 129],
      [130, 139],
      [140, 149],
      [150, 159],
      [160, 163],
    ],
  )
})

test('interior withdrawal adds only its candidate header and pins event time', async () => {
  const at = 132
  const blockHash = sparseHash(at)
  const place = (item) => ({ ...item, blockNumber: `0x${at.toString(16)}`, blockHash })
  const interiorPayout = place(payout)
  const interiorWithdraw = place(withdraw)
  const interiorReceipt = {
    ...baseReceipt,
    blockNumber: `0x${at.toString(16)}`,
    blockHash,
    logs: [interiorPayout, interiorWithdraw],
  }
  const first = sparseRpc({ logs: [interiorWithdraw], receipt: interiorReceipt })
  const second = sparseRpc({ logs: [interiorWithdraw], receipt: interiorReceipt })
  const { document, verified } = await collectDirectSupplierFlowSegment({
    primary: first.client,
    secondary: second.client,
    primaryOrigin: 'https://primary.example',
    secondaryOrigin: 'https://secondary.example',
    marketKey: 'aaveV3Usdc',
    fromBlock: 100,
    toBlock: 163,
  })
  assert.deepEqual(
    document.blocks.map((point) => point.number),
    [100, 132, 164],
  )
  assert.equal(verified.withdrawals[0].timestampMs, (1_000 + 32 * 12) * 1000)
  assert.equal(first.calls.filter((call) => call.method === 'eth_getBlockByNumber').length, 4)
  assert.equal(second.calls.filter((call) => call.method === 'eth_getBlockByNumber').length, 4)
  assert.equal(first.calls.filter((call) => call.method === 'eth_getLogs').length, 7)
  assert.equal(document.logQueries[0].slices.filter((slice) => slice.logs.length > 0).length, 1)
  const missingCandidate = structuredClone(document)
  missingCandidate.blocks.splice(1, 1)
  delete missingCandidate.sha256
  missingCandidate.sha256 = createHash('sha256')
    .update(JSON.stringify(missingCandidate))
    .digest('hex')
  assert.throws(
    () => verifyDirectSupplierFlowSegment(missingCandidate),
    /invalid_direct_candidate_log/,
  )
  await assert.rejects(
    collectDirectSupplierFlowSegment({
      primary: first.client,
      secondary: sparseRpc({
        logs: [interiorWithdraw],
        receipt: interiorReceipt,
        headerOverride: { blockNumber: 132, hash: sparseHash(999) },
      }).client,
      primaryOrigin: 'https://primary.example',
      secondaryOrigin: 'https://secondary.example',
      marketKey: 'aaveV3Usdc',
      fromBlock: 100,
      toBlock: 163,
    }),
    /direct_provider_header_disagreement/,
  )
})

test('cross-slice provider disagreement withholds the segment', async () => {
  const at = 132
  const candidate = { ...withdraw, blockNumber: `0x${at.toString(16)}`, blockHash: sparseHash(at) }
  await assert.rejects(
    collectDirectSupplierFlowSegment({
      primary: sparseRpc().client,
      secondary: sparseRpc({ logs: [candidate] }).client,
      primaryOrigin: 'https://primary.example',
      secondaryOrigin: 'https://secondary.example',
      marketKey: 'aaveV3Usdc',
      fromBlock: 100,
      toBlock: 163,
    }),
    /direct_provider_log_disagreement/,
  )
})

test('verifier rejects a resealed missing or overlapping log slice', async () => {
  const { document } = await collectDirectSupplierFlowSegment({
    primary: sparseRpc().client,
    secondary: sparseRpc().client,
    primaryOrigin: 'https://primary.example',
    secondaryOrigin: 'https://secondary.example',
    marketKey: 'aaveV3Usdc',
    fromBlock: 100,
    toBlock: 163,
  })
  const gap = structuredClone(document)
  gap.logQueries[0].slices[1].fromBlock = 111
  delete gap.sha256
  gap.sha256 = createHash('sha256').update(JSON.stringify(gap)).digest('hex')
  assert.throws(() => verifyDirectSupplierFlowSegment(gap), /invalid_direct_log_slice/)

  const duplicate = structuredClone(document)
  duplicate.logQueries[1].slices.push(structuredClone(duplicate.logQueries[1].slices[0]))
  delete duplicate.sha256
  duplicate.sha256 = createHash('sha256').update(JSON.stringify(duplicate)).digest('hex')
  assert.throws(() => verifyDirectSupplierFlowSegment(duplicate), /incomplete_direct_log_slices/)
})

test('CLI never prints a vendor error or credential-bearing URL', () => {
  const file = new URL('./collect-carry-direct-supplier-flow.mjs', import.meta.url)
  const result = spawnSync(
    process.execPath,
    [
      file.pathname,
      '--market',
      'unsupported',
      '--from',
      '100',
      '--to',
      '100',
      '--out',
      '/tmp/direct-collector-no-write.json',
      '--primary-rpc',
      'https://one.example/private-token-one',
      '--secondary-rpc',
      'https://two.example/private-token-two',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'direct_collector_failed\n')
  assert.equal(result.stdout, '')
})

test('verifier still accepts prior full-header sealed documents', async () => {
  const { document } = await collect()
  const legacy = structuredClone(document)
  delete legacy.headerCoverage
  delete legacy.sha256
  legacy.sha256 = createHash('sha256').update(JSON.stringify(legacy)).digest('hex')
  assert.equal(verifyDirectSupplierFlowSegment(legacy).withdrawals.length, 1)
})

test('v2 segments seal local capture clocks and preserve unknown availability for v1', async () => {
  const { document } = await collect()
  const verified = verifyDirectSupplierFlowSegment(document)
  assert.equal(verified.availability.status, 'capture_clock_only')
  assert.equal(verified.availability.firstLocalReceiptAt, null)
  assert.equal(verified.availability.availableAtIssue, false)
  assert.equal(verified.availability.captureStartedAt, document.captureStartedAt)
  assert.equal(verified.availability.captureCompletedAt, document.captureCompletedAt)
  assert.deepEqual(verifyDirectSupplierFlowSegments([document]).segmentAvailability, [
    {
      fromBlock: 100,
      toBlock: 100,
      status: 'capture_clock_only',
      reason: 'post_publication_receipt_unverified',
      firstLocalReceiptAt: null,
      availableAtIssue: false,
      captureClockBasis: 'local_operator_clock_unwitnessed',
      captureStartedAt: document.captureStartedAt,
      captureCompletedAt: document.captureCompletedAt,
    },
  ])

  const legacy = structuredClone(document)
  legacy.study = 'carry-direct-supplier-flow-receipts-v1'
  delete legacy.captureStartedAt
  delete legacy.captureCompletedAt
  delete legacy.sha256
  legacy.sha256 = createHash('sha256').update(JSON.stringify(legacy)).digest('hex')
  assert.deepEqual(verifyDirectSupplierFlowSegment(legacy).availability, {
    status: 'unknown',
    reason: 'legacy_segment_without_capture_clock',
    firstLocalReceiptAt: null,
    availableAtIssue: false,
  })
})

test('v2 capture clocks fail closed on reversal, missing clock and digest tampering', async () => {
  const { document } = await collect()
  const reversed = structuredClone(document)
  reversed.captureStartedAt = new Date(Date.parse(document.captureCompletedAt) + 1000).toISOString()
  delete reversed.sha256
  reversed.sha256 = createHash('sha256').update(JSON.stringify(reversed)).digest('hex')
  assert.throws(() => verifyDirectSupplierFlowSegment(reversed), /direct_capture_clock_invalid/)

  const beforeSource = structuredClone(document)
  beforeSource.captureStartedAt = '1970-01-01T00:00:00.000Z'
  delete beforeSource.sha256
  beforeSource.sha256 = createHash('sha256').update(JSON.stringify(beforeSource)).digest('hex')
  assert.throws(() => verifyDirectSupplierFlowSegment(beforeSource), /direct_capture_clock_invalid/)

  const missing = structuredClone(document)
  delete missing.captureCompletedAt
  delete missing.sha256
  missing.sha256 = createHash('sha256').update(JSON.stringify(missing)).digest('hex')
  assert.throws(() => verifyDirectSupplierFlowSegment(missing), /direct_capture_clock_invalid/)

  const tampered = structuredClone(document)
  tampered.captureStartedAt = '2026-10-01T00:00:00.000Z'
  assert.throws(() => verifyDirectSupplierFlowSegment(tampered), /direct_segment_digest_mismatch/)
})

function sparseHash(number) {
  return `0x${number.toString(16).padStart(64, '0')}`
}

function sparseRpc({ logs = [], receipt = baseReceipt, headerOverride = null } = {}) {
  const calls = []
  const client = {
    async request({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'finalized' ? 164 : Number(BigInt(params[0]))
        if (number < 100 || number > 164) throw new Error('unexpected_sparse_header')
        return {
          number: `0x${number.toString(16)}`,
          hash: headerOverride?.blockNumber === number ? headerOverride.hash : sparseHash(number),
          parentHash: sparseHash(number - 1),
          timestamp: `0x${(1_000 + (number - 100) * 12).toString(16)}`,
        }
      }
      if (method === 'eth_getLogs') {
        const start = Number(BigInt(params[0].fromBlock))
        const end = Number(BigInt(params[0].toBlock))
        return logs.filter((item) => {
          const block = Number(BigInt(item.blockNumber))
          return block >= start && block <= end
        })
      }
      if (method === 'eth_getTransactionReceipt') return receipt
      throw new Error(`unexpected_${method}`)
    },
  }
  return { client, calls }
}

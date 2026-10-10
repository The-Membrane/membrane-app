import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import { reconcileDirectSupplierWithdrawal } from './carry-direct-supplier-withdrawal-receipt.mjs'

const HOLDER = '0x1111111111111111111111111111111111111111'
const RECEIVER = '0x2222222222222222222222222222222222222222'
const ZERO = '0x0000000000000000000000000000000000000000'
const TX = `0x${'ab'.repeat(32)}`
const BLOCK = `0x${'cd'.repeat(32)}`
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const AAVE_ATOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const AAVE_USDE_ATOKEN = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
const COMET = '0xc3d688b66703497daa19211eedff47f25384cdc3'
const SPARK_ATOKEN = '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f'
const AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const SPARK_POOL = '0xc13e21b648a5ee794902342038ff3adab66be987'
const AAVE_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
)
const AAVE_BORROW = parseAbiItem(
  'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)',
)
const AAVE_SUPPLY = parseAbiItem(
  'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
)
const COLLATERAL_DISABLED = parseAbiItem(
  'event ReserveUsedAsCollateralDisabled(address indexed reserve,address indexed user)',
)
const COMET_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed src,address indexed to,uint256 amount)',
)
const COMET_SUPPLY = parseAbiItem(
  'event Supply(address indexed from,address indexed dst,uint256 amount)',
)
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const amount = 10n ** 30n + 123n

function log(address, abi, args, logIndex) {
  const fields = abi.inputs.filter((field) => !field.indexed)
  return {
    address,
    logIndex,
    transactionHash: TX,
    blockHash: BLOCK,
    topics: encodeEventTopics({ abi: [abi], eventName: abi.name, args }),
    data: encodeAbiParameters(
      fields,
      fields.map((field) => args[field.name]),
    ),
  }
}
const receipt = (logs) => ({ status: 'success', transactionHash: TX, blockHash: BLOCK, logs })
function withCompleteIndices(events) {
  const sorted = [...events].sort((a, b) => a.logIndex - b.logIndex)
  const complete = []
  for (const item of sorted) {
    for (let i = (complete.at(-1)?.logIndex ?? item.logIndex - 1) + 1; i < item.logIndex; i++) {
      complete.push(log(USDT, TRANSFER, { from: HOLDER, to: RECEIVER, value: 1n }, i))
    }
    complete.push(item)
  }
  return complete
}
const run = (marketKey, logs, holder = HOLDER, selectedWithdrawLogIndex) =>
  reconcileDirectSupplierWithdrawal({
    marketKey,
    holder,
    receipt: receipt(logs),
    selectedWithdrawLogIndex,
  })

function aaveLogs(pool = AAVE_POOL, token = USDC, atoken = AAVE_ATOKEN) {
  return [
    log(token, TRANSFER, { from: atoken, to: RECEIVER, value: amount }, 1),
    log(pool, AAVE_WITHDRAW, { reserve: token, user: HOLDER, to: RECEIVER, amount }, 2),
  ]
}
function cometLogs(burn = amount) {
  return [
    log(USDC, TRANSFER, { from: COMET, to: RECEIVER, value: amount }, 1),
    log(COMET, COMET_WITHDRAW, { src: HOLDER, to: RECEIVER, amount }, 2),
    log(COMET, TRANSFER, { from: HOLDER, to: ZERO, value: burn }, 3),
  ]
}

function twoPoolWithdrawals(pool = AAVE_POOL, token = USDC, atoken = AAVE_ATOKEN) {
  return [
    log(token, TRANSFER, { from: atoken, to: RECEIVER, value: amount }, 1),
    log(pool, AAVE_WITHDRAW, { reserve: token, user: HOLDER, to: RECEIVER, amount }, 2),
    log(token, TRANSFER, { from: atoken, to: HOLDER, value: amount }, 3),
    log(pool, AAVE_WITHDRAW, { reserve: token, user: RECEIVER, to: HOLDER, amount }, 4),
  ]
}

test('Aave and Spark pair every same-market withdrawal before selecting one, even with equal amounts and different holders', () => {
  for (const [key, logs] of [
    ['aaveV3Usdc', twoPoolWithdrawals()],
    ['aaveV3Usde', twoPoolWithdrawals(AAVE_POOL, USDE, AAVE_USDE_ATOKEN)],
    ['sparkLendUsdt', twoPoolWithdrawals(SPARK_POOL, USDT, SPARK_ATOKEN)],
  ]) {
    const first = run(key, logs, HOLDER, 2)
    const second = run(key, logs, RECEIVER, 4)
    assert.equal(first.status, 'reconciled_supplier_withdrawal')
    assert.equal(first.evidence.payoutLogIndex, 1)
    assert.equal(second.status, 'reconciled_supplier_withdrawal')
    assert.equal(second.evidence.payoutLogIndex, 3)
    assert.equal(second.evidence.amountRaw, first.evidence.amountRaw)
    assert.equal(run(key, logs).status, 'ambiguous')
    assert.equal(run(key, logs, HOLDER, 99).status, 'ambiguous')
    assert.equal(run(key, logs, HOLDER, 4).status, 'ambiguous')
  }
})

test('Aave USDe accepts exact USDe payout and rejects a USDC reserve under the same Pool', () => {
  const exact = run('aaveV3Usde', aaveLogs(AAVE_POOL, USDE, AAVE_USDE_ATOKEN))
  assert.equal(exact.status, 'reconciled_supplier_withdrawal')
  assert.equal(exact.underlying, USDE)
  assert.equal(exact.destination, AAVE_USDE_ATOKEN)
  assert.equal(run('aaveV3Usde', aaveLogs()).status, 'ambiguous')
})

test('identical amount, holder, and receiver still require two uniquely indexed payouts', () => {
  const base = twoPoolWithdrawals()
  const identical = [
    base[0],
    base[1],
    log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: RECEIVER, value: amount }, 3),
    log(AAVE_POOL, AAVE_WITHDRAW, { reserve: USDC, user: HOLDER, to: RECEIVER, amount }, 4),
  ]
  const first = run('aaveV3Usdc', identical, HOLDER, 2)
  const second = run('aaveV3Usdc', identical, HOLDER, 4)
  assert.equal(first.status, 'reconciled_supplier_withdrawal')
  assert.equal(second.status, 'reconciled_supplier_withdrawal')
  assert.equal(first.evidence.payoutLogIndex, 1)
  assert.equal(second.evidence.payoutLogIndex, 3)
})

test('multi-withdrawal receipts reject missing, mismatched, or reused local custody payouts', () => {
  const base = twoPoolWithdrawals()
  for (const logs of [
    [base[0], base[1], base[3]],
    [
      base[0],
      base[1],
      {
        ...base[2],
        data: log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: HOLDER, value: amount - 1n }, 3).data,
      },
      base[3],
    ],
    [
      base[0],
      base[1],
      {
        ...base[2],
        topics: log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: RECEIVER, value: amount }, 3).topics,
      },
      base[3],
    ],
    [base[0], base[1], { ...base[0], logIndex: 3 }, base[3]],
    [base[0], base[1], { ...base[2], logIndex: 2 }, base[3]],
  ]) {
    assert.equal(run('aaveV3Usdc', logs, HOLDER, 2).status, 'ambiguous')
    assert.equal(run('aaveV3Usdc', logs, RECEIVER, 4).status, 'ambiguous')
  }
})

test('multi-withdrawal receipt rejects intervening Borrow and conservative Comet remains single-withdrawal only', () => {
  const base = twoPoolWithdrawals()
  const borrow = log(
    AAVE_POOL,
    AAVE_BORROW,
    {
      reserve: USDC,
      user: HOLDER,
      onBehalfOf: HOLDER,
      amount,
      interestRateMode: 2,
      borrowRate: 1n,
      referralCode: 0,
    },
    4,
  )
  const intervening = [...base.slice(0, 3), borrow, { ...base[3], logIndex: 5 }]
  assert.equal(run('aaveV3Usdc', intervening, HOLDER, 2).status, 'ambiguous')
  const comet = cometLogs()
  const second = [
    log(USDC, TRANSFER, { from: COMET, to: RECEIVER, value: amount }, 4),
    log(COMET, COMET_WITHDRAW, { src: HOLDER, to: RECEIVER, amount }, 5),
    log(COMET, TRANSFER, { from: HOLDER, to: ZERO, value: amount }, 6),
  ]
  assert.equal(run('compoundV3Usdc', [...comet, ...second], HOLDER, 2).status, 'ambiguous')
})

test('Aave and Spark Pool Withdraw reconcile exact aToken underlying payout', () => {
  for (const [key, logs] of [
    ['aaveV3Usdc', aaveLogs()],
    ['sparkLendUsdt', aaveLogs(SPARK_POOL, USDT, SPARK_ATOKEN)],
  ]) {
    const row = run(key, logs)
    assert.equal(row.status, 'reconciled_supplier_withdrawal')
    assert.equal(row.evidence.amountRaw, amount.toString())
    assert.equal(row.evidence.receiver, RECEIVER)
  }
})

test('Aave accepts subsequent receiver and unrelated custody transfers outside the local pair', () => {
  const base = aaveLogs()
  const onward = log(USDC, TRANSFER, { from: RECEIVER, to: HOLDER, value: amount / 2n }, 3)
  assert.equal(run('aaveV3Usdc', [...base, onward]).status, 'reconciled_supplier_withdrawal')
  const secondMarketPayout = log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: HOLDER, value: 1n }, 4)
  assert.equal(
    run('aaveV3Usdc', [...base, onward, secondMarketPayout]).status,
    'reconciled_supplier_withdrawal',
  )
})

test('Aave rejects borrow-only and a Borrow intervening between payout and withdrawal', () => {
  const borrow = log(
    AAVE_POOL,
    AAVE_BORROW,
    {
      reserve: USDC,
      user: HOLDER,
      onBehalfOf: HOLDER,
      amount,
      interestRateMode: 2,
      borrowRate: 1n,
      referralCode: 0,
    },
    2,
  )
  assert.equal(run('aaveV3Usdc', [aaveLogs()[0], borrow]).status, 'unproven')
  assert.equal(
    run('aaveV3Usdc', [aaveLogs()[0], borrow, { ...aaveLogs()[1], logIndex: 3 }]).status,
    'ambiguous',
  )
  const supply = log(
    AAVE_POOL,
    AAVE_SUPPLY,
    {
      reserve: USDC,
      user: HOLDER,
      onBehalfOf: HOLDER,
      amount,
      referralCode: 0,
    },
    2,
  )
  assert.equal(
    run('aaveV3Usdc', [aaveLogs()[0], supply, { ...aaveLogs()[1], logIndex: 3 }]).status,
    'ambiguous',
  )
})

test('Aave observed mixed receipt pairs only the local USDC payout after unrelated earlier activity', () => {
  const unrelated = log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: HOLDER, value: amount }, 479)
  const wethSupply = log(
    AAVE_POOL,
    AAVE_SUPPLY,
    { reserve: WETH, user: HOLDER, onBehalfOf: HOLDER, amount, referralCode: 0 },
    497,
  )
  const local = log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: RECEIVER, value: amount }, 506)
  const operation = log(
    AAVE_POOL,
    AAVE_WITHDRAW,
    { reserve: USDC, user: HOLDER, to: RECEIVER, amount },
    507,
  )
  const row = run(
    'aaveV3Usdc',
    withCompleteIndices([unrelated, wethSupply, local, operation]),
    HOLDER,
    507,
  )
  assert.equal(row.status, 'reconciled_supplier_withdrawal')
  assert.equal(row.evidence.payoutLogIndex, 506)
})

test('Spark mixed receipt pairs local USDT payout despite a later unrelated reserve Supply', () => {
  const events = [
    log(SPARK_ATOKEN, TRANSFER, { from: HOLDER, to: ZERO, value: amount }, 1335),
    log(SPARK_ATOKEN, TRANSFER, { from: HOLDER, to: ZERO, value: amount }, 1336),
    log(USDT, TRANSFER, { from: SPARK_ATOKEN, to: RECEIVER, value: amount }, 1337),
    log(SPARK_POOL, AAVE_WITHDRAW, { reserve: USDT, user: HOLDER, to: RECEIVER, amount }, 1338),
    log(
      SPARK_POOL,
      AAVE_SUPPLY,
      { reserve: WETH, user: HOLDER, onBehalfOf: HOLDER, amount, referralCode: 0 },
      1340,
    ),
  ]
  const row = run('sparkLendUsdt', withCompleteIndices(events), HOLDER, 1338)
  assert.equal(row.status, 'reconciled_supplier_withdrawal')
  assert.equal(row.evidence.payoutLogIndex, 1337)
  assert.equal(row.evidence.withdrawLogIndex, 1338)
  assert.equal(row.evidence.amountRaw, amount.toString())
  assert.equal(row.evidence.burnLogIndex, null)
})

test('Spark rejects cross-asset, recipient, nonlocal, missing-log, duplicate-pair and borrow-only shapes', () => {
  const payout = log(USDT, TRANSFER, { from: SPARK_ATOKEN, to: RECEIVER, value: amount }, 1)
  const withdraw = log(
    SPARK_POOL,
    AAVE_WITHDRAW,
    { reserve: USDT, user: HOLDER, to: RECEIVER, amount },
    2,
  )
  const wrongReserve = log(
    SPARK_POOL,
    AAVE_WITHDRAW,
    { reserve: WETH, user: HOLDER, to: RECEIVER, amount },
    2,
  )
  const wrongRecipient = log(USDT, TRANSFER, { from: SPARK_ATOKEN, to: HOLDER, value: amount }, 1)
  const borrow = log(
    SPARK_POOL,
    AAVE_BORROW,
    {
      reserve: USDT,
      user: HOLDER,
      onBehalfOf: HOLDER,
      amount,
      interestRateMode: 2,
      borrowRate: 1n,
      referralCode: 0,
    },
    2,
  )
  const intervening = log(
    SPARK_POOL,
    AAVE_SUPPLY,
    { reserve: WETH, user: HOLDER, onBehalfOf: HOLDER, amount, referralCode: 0 },
    2,
  )
  assert.equal(run('sparkLendUsdt', [payout, wrongReserve]).status, 'ambiguous')
  assert.equal(run('sparkLendUsdt', [wrongRecipient, withdraw]).status, 'ambiguous')
  assert.equal(
    run('sparkLendUsdt', [payout, intervening, { ...withdraw, logIndex: 3 }]).status,
    'ambiguous',
  )
  assert.equal(run('sparkLendUsdt', [payout, { ...withdraw, logIndex: 3 }]).status, 'ambiguous')
  assert.equal(
    run('sparkLendUsdt', [payout, withdraw, { ...withdraw, logIndex: 3 }], HOLDER, 2).status,
    'ambiguous',
  )
  assert.equal(run('sparkLendUsdt', [payout, borrow]).status, 'unproven')
  assert.equal(
    run('sparkLendUsdt', [payout, borrow, { ...withdraw, logIndex: 3 }]).status,
    'ambiguous',
  )
})

test('Spark selects only the USDT reserve pair when another reserve Withdraw occurs elsewhere', () => {
  const other = log(
    SPARK_POOL,
    AAVE_WITHDRAW,
    { reserve: WETH, user: HOLDER, to: RECEIVER, amount },
    0,
  )
  const row = run('sparkLendUsdt', [other, ...aaveLogs(SPARK_POOL, USDT, SPARK_ATOKEN)], HOLDER, 2)
  assert.equal(row.status, 'reconciled_supplier_withdrawal')
  assert.equal(row.evidence.payoutLogIndex, 1)
})

test('Aave local payout allows only a matching collateral-disabled event between payout and Withdraw', () => {
  const payoutLog = aaveLogs()[0]
  const operationLog = { ...aaveLogs()[1], logIndex: 3 }
  const collateral = log(AAVE_POOL, COLLATERAL_DISABLED, { reserve: USDC, user: HOLDER }, 2)
  assert.equal(
    run('aaveV3Usdc', [payoutLog, collateral, operationLog]).status,
    'reconciled_supplier_withdrawal',
  )
  for (const intervening of [
    log(AAVE_POOL, COLLATERAL_DISABLED, { reserve: USDT, user: HOLDER }, 2),
    log(AAVE_POOL, COLLATERAL_DISABLED, { reserve: USDC, user: RECEIVER }, 2),
    log(USDC, TRANSFER, { from: HOLDER, to: RECEIVER, value: amount }, 2),
    log(
      AAVE_POOL,
      AAVE_SUPPLY,
      { reserve: WETH, user: HOLDER, onBehalfOf: HOLDER, amount, referralCode: 0 },
      2,
    ),
  ]) {
    assert.equal(run('aaveV3Usdc', [payoutLog, intervening, operationLog]).status, 'ambiguous')
  }
  const flashloanPayout = log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: RECEIVER, value: amount }, 1)
  assert.equal(
    run('aaveV3Usdc', [
      flashloanPayout,
      collateral,
      { ...operationLog, logIndex: 4 },
      log(USDC, TRANSFER, { from: HOLDER, to: RECEIVER, value: 1n }, 3),
    ]).status,
    'ambiguous',
  )
})

test('Aave ignores another-reserve Withdraw outside the exact USDC local pair', () => {
  const otherReserve = log(
    AAVE_POOL,
    AAVE_WITHDRAW,
    { reserve: WETH, user: HOLDER, to: RECEIVER, amount },
    0,
  )
  const row = run('aaveV3Usdc', [otherReserve, ...aaveLogs()], HOLDER, 2)
  assert.equal(row.status, 'reconciled_supplier_withdrawal')
  assert.equal(row.evidence.payoutLogIndex, 1)
})

test('Aave cannot infer a delivered payout when Withdraw sends underlying back to its aToken', () => {
  const selfPayout = log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: AAVE_ATOKEN, value: amount }, 1)
  const selfWithdraw = log(
    AAVE_POOL,
    AAVE_WITHDRAW,
    { reserve: USDC, user: HOLDER, to: AAVE_ATOKEN, amount },
    2,
  )
  assert.equal(run('aaveV3Usdc', [selfPayout, selfWithdraw]).status, 'ambiguous')
})

test('a missing or reordered receipt log between payout and Withdraw cannot manufacture adjacency', () => {
  const payoutLog = aaveLogs()[0]
  const withdrawLog = { ...aaveLogs()[1], logIndex: 3 }
  const middle = log(USDT, TRANSFER, { from: HOLDER, to: RECEIVER, value: 1n }, 2)
  assert.equal(run('aaveV3Usdc', [payoutLog, withdrawLog]).status, 'ambiguous')
  assert.equal(run('aaveV3Usdc', [payoutLog, middle, withdrawLog]).status, 'ambiguous')
  assert.equal(run('aaveV3Usdc', [middle, payoutLog, withdrawLog]).status, 'ambiguous')
})

test('Aave rejects wrong reserve, source, recipient, payout and duplicate operation', () => {
  const base = aaveLogs()
  assert.equal(
    run('aaveV3Usdc', [
      base[0],
      log(AAVE_POOL, AAVE_WITHDRAW, { reserve: USDT, user: HOLDER, to: RECEIVER, amount }, 2),
    ]).status,
    'ambiguous',
  )
  assert.equal(run('aaveV3Usdc', base, RECEIVER).status, 'ambiguous')
  assert.equal(
    run('aaveV3Usdc', [
      log(USDC, TRANSFER, { from: AAVE_ATOKEN, to: HOLDER, value: amount }, 1),
      base[1],
    ]).status,
    'ambiguous',
  )
  assert.equal(run('aaveV3Usdc', [...base, { ...base[1], logIndex: 3 }]).status, 'ambiguous')
})

test('Comet requires an exact payout and a covering share burn, allowing index rounding', () => {
  const row = run('compoundV3Usdc', cometLogs())
  assert.equal(row.status, 'reconciled_supplier_withdrawal')
  assert.equal(row.evidence.burnedSharesRaw, amount.toString())
  assert.equal(run('compoundV3Usdc', cometLogs(0n)).status, 'ambiguous')
  assert.equal(run('compoundV3Usdc', cometLogs(amount - 1n)).status, 'ambiguous')
  assert.equal(
    run('compoundV3Usdc', cometLogs(amount + 1n)).status,
    'reconciled_supplier_withdrawal',
  )
  assert.equal(run('compoundV3Usdc', cometLogs().slice(0, 2)).status, 'ambiguous')
})

test('Comet rejects payout without Withdraw, unrelated burn and multiple payouts', () => {
  const base = cometLogs()
  assert.equal(run('compoundV3Usdc', [base[0], { ...base[2], logIndex: 2 }]).status, 'unproven')
  assert.equal(
    run('compoundV3Usdc', [
      base[0],
      base[1],
      log(COMET, TRANSFER, { from: RECEIVER, to: ZERO, value: amount }, 3),
    ]).status,
    'ambiguous',
  )
  assert.equal(run('compoundV3Usdc', [...base, { ...base[0], logIndex: 4 }]).status, 'ambiguous')
  assert.equal(
    run('compoundV3Usdc', [
      ...base,
      log(COMET, COMET_SUPPLY, { from: HOLDER, dst: HOLDER, amount }, 4),
    ]).status,
    'ambiguous',
  )
})

test('invalid envelope and reverted receipt never reconcile', () => {
  const logs = aaveLogs()
  assert.equal(run('aaveV3Usdc', [{ ...logs[0], blockHash: TX }, logs[1]]).status, 'ambiguous')
  assert.equal(run('aaveV3Usdc', [{ ...logs[0], logIndex: 2 }, logs[1]]).status, 'ambiguous')
  assert.equal(
    reconcileDirectSupplierWithdrawal({
      marketKey: 'aaveV3Usdc',
      holder: HOLDER,
      receipt: { ...receipt(logs), status: 'reverted' },
    }).status,
    'ambiguous',
  )
  assert.throws(() => run('unknown', logs), /unsupported_direct_market/)
})

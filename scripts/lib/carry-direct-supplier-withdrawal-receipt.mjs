// Pure, conservative classifier for a complete Ethereum transaction receipt.
// A result describes a witnessed payout, never an executable quote or a full exit.
import { decodeEventLog, padHex, parseAbiItem, toEventSelector } from 'viem'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const SPARK_POOL = '0xc13e21b648a5ee794902342038ff3adab66be987'

const EVENTS = {
  aaveWithdraw: parseAbiItem(
    'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
  ),
  aaveBorrow: parseAbiItem(
    'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)',
  ),
  aaveSupply: parseAbiItem(
    'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
  ),
  aaveRepay: parseAbiItem(
    'event Repay(address indexed reserve,address indexed user,address indexed repayer,uint256 amount,bool useATokens)',
  ),
  aaveCollateralDisabled: parseAbiItem(
    'event ReserveUsedAsCollateralDisabled(address indexed reserve,address indexed user)',
  ),
  cometWithdraw: parseAbiItem(
    'event Withdraw(address indexed src,address indexed to,uint256 amount)',
  ),
  cometSupply: parseAbiItem(
    'event Supply(address indexed from,address indexed dst,uint256 amount)',
  ),
  cometWithdrawCollateral: parseAbiItem(
    'event WithdrawCollateral(address indexed src,address indexed to,address indexed asset,uint256 amount)',
  ),
  transfer: parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
}
const TOPICS = Object.fromEntries(
  Object.entries(EVENTS).map(([kind, abi]) => [kind, toEventSelector(abi).toLowerCase()]),
)
const frozenMarket = (kind, routeKey, venueKind, pool) => {
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (entry) => entry.kind === kind && entry.routeKey === routeKey,
  )
  if (!route) throw Error('frozen_direct_market_missing')
  return { ...route, underlying: route.asset, venueKind, pool }
}
const MARKETS = Object.freeze({
  aaveV3Usdc: frozenMarket('aave', 'USDC → supply on Aave V3', 'aave_v3_atoken', AAVE_POOL),
  aaveV3Usde: frozenMarket('aave', 'USDe → supply on Aave V3', 'aave_v3_atoken', AAVE_POOL),
  sparkLendUsdt: frozenMarket('spark', 'USDT → supply on Spark', 'spark_lend_atoken', SPARK_POOL),
  compoundV3Usdc: frozenMarket('comet', 'USDC → supply on Compound v3', 'compound_v3_comet', null),
})
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const address = (value) => (ADDRESS.test(lower(value)) ? lower(value) : null)
const index = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
const result = (status, reason, market, receipt, evidence = null) => ({
  status,
  reason,
  routeKey: market.routeKey,
  venueKind: market.venueKind,
  destination: lower(market.destination),
  underlying: lower(market.underlying),
  transactionHash: lower(receipt.transactionHash),
  evidence,
})

function decode(log, kind) {
  return decodeEventLog({ abi: [EVENTS[kind]], topics: log.topics, data: log.data, strict: true })
    .args
}

/**
 * Caller supplies the complete receipt, its pinned market key, and the supplier.
 * This pure check cannot attest RPC completeness, finality, or account history.
 */
export function reconcileDirectSupplierWithdrawal({
  marketKey,
  holder,
  receipt,
  selectedWithdrawLogIndex,
}) {
  const market = MARKETS[marketKey]
  if (!market) throw new Error('unsupported_direct_market')
  const owner = address(holder)
  if (!owner) throw new Error('invalid_supplier_address')
  if (
    !receipt ||
    receipt.status !== 'success' ||
    !HASH.test(lower(receipt.transactionHash)) ||
    !HASH.test(lower(receipt.blockHash)) ||
    !Array.isArray(receipt.logs)
  ) {
    return result('ambiguous', 'invalid_or_unsuccessful_receipt', market, receipt ?? {})
  }
  const logs = []
  const seen = new Set()
  let priorLogIndex = null
  // Ethereum receipt logs occupy consecutive block-global indices within a
  // transaction. A missing middle log could hide an intervening Pool action.
  for (const log of receipt.logs) {
    const n = index(log?.logIndex)
    if (
      n === null ||
      seen.has(n) ||
      (priorLogIndex !== null && n !== priorLogIndex + 1) ||
      !address(log.address) ||
      !Array.isArray(log.topics) ||
      !log.topics.every((topic) => HASH.test(lower(topic))) ||
      !HEX.test(lower(log.data)) ||
      lower(log.transactionHash) !== lower(receipt.transactionHash) ||
      lower(log.blockHash) !== lower(receipt.blockHash)
    ) {
      return result('ambiguous', 'invalid_or_incomplete_log_envelope', market, receipt)
    }
    seen.add(n)
    priorLogIndex = n
    logs.push({ ...log, address: lower(log.address), topics: log.topics.map(lower), logIndex: n })
  }
  const underlying = lower(market.underlying)
  const destination = lower(market.destination)
  const pool = market.pool
  const operationKind = pool ? 'aaveWithdraw' : 'cometWithdraw'
  const emitter = pool ?? destination
  const allOperations = logs.filter(
    (log) => log.address === emitter && log.topics[0] === TOPICS[operationKind],
  )
  const reserveTopic = padHex(underlying, { size: 32 }).toLowerCase()
  const operations = pool
    ? allOperations.filter((log) => log.topics[1] === reserveTopic)
    : allOperations
  const mixedTopics = pool
    ? [TOPICS.aaveBorrow, TOPICS.aaveSupply, TOPICS.aaveRepay]
    : [TOPICS.cometSupply, TOPICS.cometWithdrawCollateral]
  const mixedLogs = logs.filter(
    (log) => log.address === emitter && mixedTopics.includes(log.topics[0]),
  )
  // A router may transfer the received asset again later in the same tx.
  // Only transfers leaving this market's custody can prove its payout.
  const custodyTopic = padHex(destination, { size: 32 }).toLowerCase()
  const payouts = logs.filter(
    (log) =>
      log.address === underlying &&
      log.topics[0] === TOPICS.transfer &&
      log.topics[1] === custodyTopic,
  )
  const burns = pool
    ? []
    : logs.filter((log) => log.address === destination && log.topics[0] === TOPICS.transfer)
  if (operations.length === 0)
    return result(
      allOperations.length > 0 ? 'ambiguous' : 'unproven',
      allOperations.length > 0 ? 'wrong_direct_reserve' : 'withdraw_event_absent',
      market,
      receipt,
    )
  if (
    (!pool && mixedLogs.length > 0) ||
    (!pool && (operations.length !== 1 || payouts.length !== 1 || burns.length !== 1))
  ) {
    return result('ambiguous', 'mixed_or_multiple_market_flows', market, receipt)
  }
  try {
    let selectedOperationLog
    let selectedPayoutLog
    if (pool) {
      const orderedOperations = [...operations].sort((a, b) => a.logIndex - b.logIndex)
      const orderedPayouts = [...payouts].sort((a, b) => a.logIndex - b.logIndex)
      const localPairs = []
      for (const [i, operationLog] of orderedOperations.entries()) {
        const previousOperationIndex = orderedOperations[i - 1]?.logIndex ?? -1
        // Both Aave and Spark transfer the underlying from aToken custody
        // before Pool Withdraw. Require that payout to be local to this exact
        // reserve's Withdraw, without attributing earlier router activity.
        const payoutLog = orderedPayouts.findLast(
          (entry) =>
            entry.logIndex > previousOperationIndex && entry.logIndex < operationLog.logIndex,
        )
        if (!payoutLog) return result('ambiguous', 'withdraw_payout_mismatch', market, receipt)
        const operation = decode(operationLog, operationKind)
        const payout = decode(payoutLog, 'transfer')
        const between = logs.filter(
          (entry) => entry.logIndex > payoutLog.logIndex && entry.logIndex < operationLog.logIndex,
        )
        const collateral =
          between.length === 1 &&
          between[0].address === emitter &&
          between[0].topics[0] === TOPICS.aaveCollateralDisabled
            ? decode(between[0], 'aaveCollateralDisabled')
            : null
        if (
          between.length > 1 ||
          (between.length === 1 &&
            (!collateral ||
              lower(collateral.reserve) !== underlying ||
              lower(collateral.user) !== lower(operation.user)))
        ) {
          return result('ambiguous', 'nonlocal_pool_withdraw_payout', market, receipt)
        }
        if (
          !address(operation.user) ||
          !address(operation.to) ||
          lower(operation.to) === ZERO ||
          lower(operation.to) === destination ||
          lower(operation.reserve) !== underlying ||
          lower(payout.from) !== destination ||
          lower(payout.to) !== lower(operation.to) ||
          operation.amount <= 0n ||
          payout.value !== operation.amount ||
          payoutLog.logIndex <= previousOperationIndex ||
          payoutLog.logIndex >= operationLog.logIndex
        ) {
          return result('ambiguous', 'withdraw_payout_mismatch', market, receipt)
        }
        localPairs.push({ operationLog, payoutLog })
      }
      if (selectedWithdrawLogIndex === undefined) {
        if (orderedOperations.length !== 1)
          return result('ambiguous', 'withdraw_selection_required', market, receipt)
        selectedOperationLog = orderedOperations[0]
        selectedPayoutLog = localPairs[0].payoutLog
      } else {
        const selectedIndex = index(selectedWithdrawLogIndex)
        const position = orderedOperations.findIndex((entry) => entry.logIndex === selectedIndex)
        if (position < 0) return result('ambiguous', 'withdraw_selection_invalid', market, receipt)
        selectedOperationLog = orderedOperations[position]
        selectedPayoutLog = localPairs[position].payoutLog
      }
    } else {
      selectedOperationLog = operations[0]
      selectedPayoutLog = payouts[0]
      if (
        selectedWithdrawLogIndex !== undefined &&
        selectedWithdrawLogIndex !== selectedOperationLog.logIndex
      )
        return result('ambiguous', 'withdraw_selection_invalid', market, receipt)
    }
    const operation = decode(selectedOperationLog, operationKind)
    const payout = decode(selectedPayoutLog, 'transfer')
    const amount = operation.amount
    const receiver = lower(operation.to)
    const source = pool ? lower(operation.user) : lower(operation.src)
    if (
      source !== owner ||
      !address(receiver) ||
      receiver === ZERO ||
      (pool && lower(operation.reserve) !== underlying) ||
      lower(payout.from) !== destination ||
      lower(payout.to) !== receiver ||
      amount <= 0n ||
      payout.value !== amount ||
      selectedPayoutLog.logIndex >= selectedOperationLog.logIndex
    ) {
      return result('ambiguous', 'withdraw_payout_mismatch', market, receipt)
    }
    let burnLogIndex = null
    let burnedSharesRaw = null
    if (!pool) {
      const burn = decode(burns[0], 'transfer')
      // Comet may cross from supply into debt in one Withdraw. Its synthetic
      // burn is index-rounded and can exceed the payout even without borrowing;
      // a burn below the payout cannot cover the full supplier withdrawal.
      if (
        lower(burn.from) !== owner ||
        lower(burn.to) !== ZERO ||
        burn.value < amount ||
        burns[0].logIndex <= selectedOperationLog.logIndex
      ) {
        return result('ambiguous', 'comet_borrow_or_share_burn_mismatch', market, receipt)
      }
      burnLogIndex = burns[0].logIndex
      burnedSharesRaw = burn.value.toString()
    }
    return result('reconciled_supplier_withdrawal', 'exact_receipt_payout', market, receipt, {
      holder: owner,
      receiver,
      amountRaw: amount.toString(),
      withdrawLogIndex: selectedOperationLog.logIndex,
      payoutLogIndex: selectedPayoutLog.logIndex,
      burnLogIndex,
      burnedSharesRaw,
    })
  } catch {
    return result('ambiguous', 'malformed_market_event', market, receipt)
  }
}

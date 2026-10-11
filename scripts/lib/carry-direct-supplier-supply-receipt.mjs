// A witnessed underlying inflow into a direct lending market. This is gross
// supplier deposit evidence, not net reserve replenishment or holder exitability.
import { decodeEventLog, parseAbiItem, toEventSelector } from 'viem'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const ZERO = '0x0000000000000000000000000000000000000000'
const EVENTS = {
  aave: parseAbiItem(
    'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
  ),
  comet: parseAbiItem('event Supply(address indexed from,address indexed dst,uint256 amount)'),
  transfer: parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
}
const TOPICS = Object.fromEntries(
  Object.entries(EVENTS).map(([key, abi]) => [key, toEventSelector(abi).toLowerCase()]),
)
const IDENTITIES = Object.freeze({
  aaveV3Usdc: ['aave', 'USDC → supply on Aave V3'],
  aaveV3Usde: ['aave', 'USDe → supply on Aave V3'],
  sparkLendUsdt: ['spark', 'USDT → supply on Spark'],
  compoundV3Usdc: ['comet', 'USDC → supply on Compound v3'],
})
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const decode = (log, abi) =>
  decodeEventLog({ abi: [abi], topics: log.topics, data: log.data, strict: true }).args

export function reconcileDirectSupplierSupply({ marketKey, receipt, selectedSupplyLogIndex }) {
  const identity = IDENTITIES[marketKey]
  if (!identity) throw new Error('unsupported_direct_market')
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (entry) => entry.kind === identity[0] && entry.routeKey === identity[1],
  )
  if (!route) throw new Error('frozen_direct_market_missing')
  const emitter = lower(route.withdrawTarget)
  const asset = lower(route.asset)
  const custody = lower(route.destination)
  const kind = identity[0] === 'comet' ? 'comet' : 'aave'
  const result = (status, reason, evidence = null) => ({
    status,
    reason,
    marketKey,
    routeKey: route.routeKey,
    destination: custody,
    underlying: asset,
    transactionHash: lower(receipt?.transactionHash),
    evidence,
  })
  if (
    receipt?.status !== 'success' ||
    !HASH.test(lower(receipt.blockHash)) ||
    !HASH.test(lower(receipt.transactionHash)) ||
    !Array.isArray(receipt.logs)
  ) {
    return result('ambiguous', 'invalid_or_unsuccessful_receipt')
  }
  let previous = null
  for (const log of receipt.logs) {
    if (
      !ADDRESS.test(lower(log.address)) ||
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      (previous !== null && log.logIndex !== previous + 1) ||
      lower(log.blockHash) !== lower(receipt.blockHash) ||
      lower(log.transactionHash) !== lower(receipt.transactionHash) ||
      !Array.isArray(log.topics) ||
      !log.topics.every((topic) => HASH.test(lower(topic))) ||
      !HEX.test(lower(log.data))
    )
      return result('ambiguous', 'incomplete_receipt_logs')
    previous = log.logIndex
  }
  const candidates = receipt.logs.filter(
    (log) =>
      lower(log.address) === emitter &&
      lower(log.topics[0]) === TOPICS[kind] &&
      (kind === 'comet' || lower(log.topics[1]) === `0x${asset.slice(2).padStart(64, '0')}`),
  )
  if (!Number.isSafeInteger(selectedSupplyLogIndex) || selectedSupplyLogIndex < 0) {
    return result('ambiguous', 'supply_selection_required')
  }
  const selected = candidates.find((log) => log.logIndex === selectedSupplyLogIndex)
  if (!selected) return result('ambiguous', 'supply_selection_invalid')
  try {
    const args = decode(selected, EVENTS[kind])
    const supplier = lower(kind === 'comet' ? args.from : args.user)
    const beneficiary = lower(kind === 'comet' ? args.dst : args.onBehalfOf)
    const amount = args.amount
    if (
      !ADDRESS.test(supplier) ||
      supplier === ZERO ||
      !ADDRESS.test(beneficiary) ||
      beneficiary === ZERO ||
      amount <= 0n ||
      (kind !== 'comet' && lower(args.reserve) !== asset)
    ) {
      return result('ambiguous', 'invalid_supply_event')
    }
    const transfers = receipt.logs
      .filter((log) => lower(log.address) === asset && lower(log.topics[0]) === TOPICS.transfer)
      .map((log) => ({ log, args: decode(log, EVENTS.transfer) }))
      .filter(
        ({ args: transfer }) =>
          lower(transfer.from) === supplier &&
          lower(transfer.to) === custody &&
          transfer.value === amount &&
          transfer.value > 0n &&
          transfer.value !== (1n << 256n) - 1n,
      )
    const priorSupply = candidates.filter((candidate) => candidate.logIndex < selected.logIndex)
    const lowerBound = priorSupply.at(-1)?.logIndex ?? -1
    const local = transfers.filter(
      ({ log }) => log.logIndex > lowerBound && log.logIndex < selected.logIndex,
    )
    if (local.length !== 1) return result('ambiguous', 'supply_transfer_mismatch')
    // The previous Supply boundary makes this transfer exclusive to one event.
    return result('reconciled_supplier_supply', null, {
      supplier,
      beneficiary,
      amountRaw: amount.toString(),
      supplyLogIndex: selected.logIndex,
      transferLogIndex: local[0].log.logIndex,
    })
  } catch {
    return result('ambiguous', 'supply_decode_failed')
  }
}

// Research-only transaction witness. A complete receipt can show a direct
// Borrow -> underlying -> vault deposit path, never retained financed TVL.
export const ROUTES = Object.freeze({
  gho_sgho: Object.freeze({
    chainId: 1,
    pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
    underlying: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    vault: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    payoutSource: 'mint_zero_address',
  }),
  usde_susde: Object.freeze({
    chainId: 1,
    pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
    underlying: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    vault: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
    // Historical address book only; exact-B Pool reserve attestation is required.
    payoutSource: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
  }),
})

const ADDRESS = /^0x[0-9a-f]{40}$/i
const HASH = /^0x[0-9a-f]{64}$/i
const ZERO = '0x0000000000000000000000000000000000000000'
const CAVEAT =
  'Observed same-transaction flow only. Complete receipt, transaction-prestate balance, and reserve payout-source attestations are caller assertions, not independently verified here. Fungible funds may be commingled later; this does not prove current holder ownership, retained debt-financed shares, route TVL, or realized return.'

const lower = (value) => String(value).toLowerCase()
const same = (a, b) => lower(a) === lower(b)
const raw = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error('invalid_raw_amount')
  return BigInt(value)
}
const fail = (reason, extra = {}) => ({
  classification: 'ambiguous',
  reasons: [...new Set(Array.isArray(reason) ? reason : [reason])],
  caveat: CAVEAT,
  ...extra,
})

function validateInput(input) {
  const { route, chainId, blockNumber, blockHash, transactionHash, logs } = input ?? {}
  const config = ROUTES[route]
  if (!config) throw new Error('unsupported_route')
  if (chainId !== config.chainId) throw new Error('chain_mismatch')
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1) throw new Error('invalid_block')
  if (!HASH.test(blockHash ?? '') || !HASH.test(transactionHash ?? '')) {
    throw new Error('invalid_hash')
  }
  if (!Array.isArray(logs)) throw new Error('invalid_logs')
  const indices = new Set()
  for (const log of logs) {
    if (
      log.chainId !== chainId ||
      log.blockNumber !== blockNumber ||
      !same(log.blockHash, blockHash) ||
      !same(log.transactionHash, transactionHash)
    ) {
      throw new Error('inter_transaction_or_block_log')
    }
    if (!Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || indices.has(log.logIndex)) {
      throw new Error('duplicate_or_invalid_log_index')
    }
    indices.add(log.logIndex)
    if (!ADDRESS.test(log.address ?? '')) throw new Error('invalid_log_address')
  }
  return config
}

/**
 * Input `logs` must be the entire ordered transaction receipt, with unrelated
 * logs retained as kind `other`. `completeTransactionLogs` is an explicit
 * provenance assertion by the caller, not evidence produced by this function.
 * `prestate` is block-(B-1); `transactionPrestate` is immediately before tx.
 * Both, the finalized block/header, and any USDe reserve payout source require
 * external attestation. This pure function does not query consensus or traces.
 * All event arguments and token amounts are normalized decimal raw strings.
 */
export function classifyObservedFinancedFlow(input) {
  const config = validateInput(input)
  const { logs, blockNumber, prestate, transactionPrestate } = input
  const reasons = []
  if (input.completeTransactionLogs !== true)
    reasons.push('transaction_log_completeness_unasserted')
  if (input.finalizedBlock !== true || !HASH.test(input.parentHash ?? '')) {
    reasons.push('finalized_block_header_unattested')
  }

  const borrow = logs.filter((log) => log.kind === 'borrow' && same(log.address, config.pool))
  const deposits = logs.filter((log) => log.kind === 'deposit' && same(log.address, config.vault))
  const underlying = logs.filter(
    (log) => log.kind === 'transfer' && same(log.address, config.underlying),
  )
  const shares = logs.filter((log) => log.kind === 'transfer' && same(log.address, config.vault))
  if (borrow.length !== 1) reasons.push(borrow.length ? 'multiple_borrows' : 'missing_borrow')
  if (deposits.length !== 1) reasons.push(deposits.length ? 'multiple_deposits' : 'missing_deposit')
  if (borrow.length !== 1 || deposits.length !== 1) return fail(reasons)

  const b = borrow[0]
  const d = deposits[0]
  if (!same(b.asset, config.underlying) || b.interestRateMode !== 2) {
    reasons.push('wrong_borrow_asset_or_rate_mode')
  }
  for (const address of [b.user, b.onBehalfOf, d.sender, d.owner]) {
    if (!ADDRESS.test(address ?? '')) throw new Error('invalid_event_address')
  }
  const user = lower(b.user)
  if (!same(b.onBehalfOf, user)) reasons.push('delegated_borrow')
  if (!same(d.sender, user) || !same(d.owner, user)) reasons.push('router_or_other_owner')

  if (
    !prestate ||
    prestate.chainId !== input.chainId ||
    prestate.blockNumber !== blockNumber - 1 ||
    !HASH.test(prestate.blockHash ?? '') ||
    !same(prestate.blockHash, input.parentHash) ||
    !same(prestate.wallet, user) ||
    !same(prestate.asset, config.underlying) ||
    prestate.finalized !== true
  ) {
    reasons.push('block_prestate_balance_unverified')
  } else if (raw(prestate.balanceRaw) !== 0n) {
    reasons.push('preexisting_underlying_balance')
  }
  if (
    !transactionPrestate ||
    transactionPrestate.chainId !== input.chainId ||
    transactionPrestate.blockNumber !== blockNumber ||
    !same(transactionPrestate.blockHash, input.blockHash) ||
    !same(transactionPrestate.transactionHash, input.transactionHash) ||
    !same(transactionPrestate.wallet, user) ||
    !same(transactionPrestate.asset, config.underlying) ||
    transactionPrestate.source !== 'pre_transaction_state' ||
    transactionPrestate.verified !== true
  ) {
    reasons.push('transaction_prestate_balance_unverified')
  } else if (raw(transactionPrestate.balanceRaw) !== 0n) {
    reasons.push('same_block_prior_funding_or_preexisting_balance')
  }

  const borrowed = raw(b.amountRaw)
  const assets = raw(d.assetsRaw)
  const minted = raw(d.sharesRaw)
  if (borrowed === 0n || assets === 0n || minted === 0n) reasons.push('zero_amount')
  if (borrowed !== assets) reasons.push('borrow_deposit_amount_mismatch')

  const payout = underlying.filter((log) => same(log.to, user))
  const vaultReceipt = underlying.filter(
    (log) => same(log.from, user) && same(log.to, config.vault),
  )
  if (payout.length !== 1)
    reasons.push(payout.length ? 'mixed_underlying_inflows' : 'missing_borrow_payout')
  if (vaultReceipt.length !== 1) {
    reasons.push(vaultReceipt.length ? 'mixed_vault_transfers' : 'missing_underlying_transfer')
  }
  if (underlying.length !== 2) reasons.push('mixed_underlying_flows')
  if (payout.length === 1 && raw(payout[0].valueRaw) !== borrowed) {
    reasons.push('borrow_payout_amount_mismatch')
  }
  if (payout.length === 1) {
    if (config.payoutSource === 'mint_zero_address') {
      if (!same(payout[0].from, ZERO)) reasons.push('borrow_payout_source_mismatch')
    } else {
      const source = input.reservePayoutSource
      if (
        !source ||
        source.chainId !== input.chainId ||
        source.blockNumber !== blockNumber ||
        !same(source.blockHash, input.blockHash) ||
        !same(source.pool, config.pool) ||
        !same(source.asset, config.underlying) ||
        !same(source.aToken, config.payoutSource) ||
        source.verified !== true
      ) {
        reasons.push('reserve_payout_source_unattested')
      } else if (!same(payout[0].from, source.aToken)) {
        reasons.push('borrow_payout_source_mismatch')
      }
    }
  }
  if (vaultReceipt.length === 1 && raw(vaultReceipt[0].valueRaw) !== assets) {
    reasons.push('vault_transfer_shortfall')
  }

  const mint = shares.filter((log) => same(log.from, ZERO) && same(log.to, user))
  if (mint.length !== 1) reasons.push(mint.length ? 'multiple_share_mints' : 'missing_share_mint')
  if (shares.length !== 1) reasons.push('mixed_share_flows')
  if (mint.length === 1 && raw(mint[0].valueRaw) !== minted) reasons.push('share_mint_mismatch')

  if (payout.length === 1 && vaultReceipt.length === 1 && mint.length === 1) {
    // Aave may emit Borrow after payout; ERC4626 may emit Deposit after mint.
    // Require only the monetary transfer order, with all events before Deposit.
    if (
      !(
        payout[0].logIndex < vaultReceipt[0].logIndex &&
        b.logIndex < vaultReceipt[0].logIndex &&
        vaultReceipt[0].logIndex < mint[0].logIndex &&
        b.logIndex < d.logIndex &&
        mint[0].logIndex < d.logIndex
      )
    ) {
      reasons.push('flow_log_order_mismatch')
    }
  }
  if (reasons.length) return fail(reasons)
  return {
    classification: 'direct_observed_flow',
    route: input.route,
    chainId: input.chainId,
    blockNumber,
    blockHash: lower(input.blockHash),
    transactionHash: lower(input.transactionHash),
    borrower: user,
    owner: user,
    borrowedAssetsRaw: borrowed.toString(),
    depositedAssetsRaw: assets.toString(),
    mintedSharesRaw: minted.toString(),
    caveat: CAVEAT,
  }
}

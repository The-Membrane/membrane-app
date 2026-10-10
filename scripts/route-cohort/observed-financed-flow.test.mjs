import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROUTES, classifyObservedFinancedFlow } from './observed-financed-flow.mjs'

const H = `0x${'a'.repeat(64)}`
const T = `0x${'b'.repeat(64)}`
const P = `0x${'c'.repeat(64)}`
const USER = `0x${'1'.repeat(40)}`
const OTHER = `0x${'2'.repeat(40)}`
const ZERO = `0x${'0'.repeat(40)}`

function fixture(route = 'gho_sgho') {
  const c = ROUTES[route]
  const log = (kind, address, logIndex, args = {}) => ({
    kind,
    address,
    chainId: 1,
    blockNumber: 100,
    blockHash: H,
    transactionHash: T,
    logIndex,
    ...args,
  })
  return {
    route,
    chainId: 1,
    blockNumber: 100,
    blockHash: H,
    transactionHash: T,
    completeTransactionLogs: true,
    prestate: {
      chainId: 1,
      blockNumber: 99,
      blockHash: P,
      wallet: USER,
      asset: c.underlying,
      balanceRaw: '0',
      finalized: true,
    },
    logs: [
      log('transfer', c.underlying, 1, {
        from: route === 'gho_sgho' ? ZERO : c.payoutSource,
        to: USER,
        valueRaw: '100',
      }),
      log('borrow', c.pool, 2, {
        asset: c.underlying,
        user: USER,
        onBehalfOf: USER,
        amountRaw: '100',
        interestRateMode: 2,
      }),
      log('transfer', c.underlying, 3, { from: USER, to: c.vault, valueRaw: '100' }),
      log('transfer', c.vault, 4, { from: ZERO, to: USER, valueRaw: '98' }),
      log('deposit', c.vault, 5, {
        sender: USER,
        owner: USER,
        assetsRaw: '100',
        sharesRaw: '98',
      }),
    ],
    parentHash: P,
    finalizedBlock: true,
    transactionPrestate: {
      chainId: 1,
      blockNumber: 100,
      blockHash: H,
      transactionHash: T,
      wallet: USER,
      asset: c.underlying,
      balanceRaw: '0',
      source: 'pre_transaction_state',
      verified: true,
    },
    ...(route === 'usde_susde'
      ? {
          reservePayoutSource: {
            chainId: 1,
            blockNumber: 100,
            blockHash: H,
            pool: c.pool,
            asset: c.underlying,
            aToken: c.payoutSource,
            verified: true,
          },
        }
      : {}),
  }
}

const result = (input) => classifyObservedFinancedFlow(input)
const hasReason = (input, reason) => {
  const got = result(input)
  assert.equal(got.classification, 'ambiguous')
  assert.ok(got.reasons.includes(reason), `${reason}: ${JSON.stringify(got.reasons)}`)
}

for (const route of Object.keys(ROUTES)) {
  test(`strict same-transaction observed flow for ${route}`, () => {
    const got = result(fixture(route))
    assert.equal(got.classification, 'direct_observed_flow')
    assert.equal(got.depositedAssetsRaw, '100')
    assert.equal(got.mintedSharesRaw, '98')
    assert.match(got.caveat, /does not prove current holder ownership/)
  })
}

test('same-wallet preexisting funds and unknown prestate are not financed proof', () => {
  const existing = fixture()
  existing.prestate.balanceRaw = '1'
  hasReason(existing, 'preexisting_underlying_balance')
  const absent = fixture()
  delete absent.prestate
  hasReason(absent, 'block_prestate_balance_unverified')
  const sameBlockPrior = fixture()
  sameBlockPrior.transactionPrestate.balanceRaw = '100'
  hasReason(sameBlockPrior, 'same_block_prior_funding_or_preexisting_balance')
  const noTxWitness = fixture()
  delete noTxWitness.transactionPrestate
  hasReason(noTxWitness, 'transaction_prestate_balance_unverified')
})

test('complete transaction receipt assertion is required', () => {
  const input = fixture()
  input.completeTransactionLogs = false
  hasReason(input, 'transaction_log_completeness_unasserted')
})

test('payout must come from Aave source and USDe source must be attested at B', () => {
  const unrelated = fixture()
  unrelated.logs[0].from = OTHER
  hasReason(unrelated, 'borrow_payout_source_mismatch')
  const usde = fixture('usde_susde')
  delete usde.reservePayoutSource
  hasReason(usde, 'reserve_payout_source_unattested')
  const forged = fixture('usde_susde')
  forged.logs[0].from = OTHER
  hasReason(forged, 'borrow_payout_source_mismatch')
})

test('finalized block and parent linkage are required assertions', () => {
  const unfinalized = fixture()
  unfinalized.finalizedBlock = false
  hasReason(unfinalized, 'finalized_block_header_unattested')
  const wrongParent = fixture()
  wrongParent.prestate.blockHash = H
  hasReason(wrongParent, 'block_prestate_balance_unverified')
})

test('mixed same-wallet funds and multiple events stay ambiguous', () => {
  const mixed = fixture()
  mixed.logs.push({ ...mixed.logs[0], logIndex: 6, valueRaw: '1' })
  hasReason(mixed, 'mixed_underlying_inflows')
  const borrow = fixture()
  borrow.logs.push({ ...borrow.logs[1], logIndex: 6 })
  hasReason(borrow, 'multiple_borrows')
  const deposit = fixture()
  deposit.logs.push({ ...deposit.logs[4], logIndex: 6 })
  hasReason(deposit, 'multiple_deposits')
})

test('delegation and intermediary owner/sender are distinct ambiguities', () => {
  const delegated = fixture()
  delegated.logs[1].onBehalfOf = OTHER
  hasReason(delegated, 'delegated_borrow')
  const router = fixture()
  router.logs[4].sender = OTHER
  hasReason(router, 'router_or_other_owner')
})

test('unrelated transaction/block logs and duplicate indices are rejected', () => {
  const otherTx = fixture()
  otherTx.logs[2].transactionHash = P
  assert.throws(() => result(otherTx), /inter_transaction_or_block_log/)
  const otherBlock = fixture()
  otherBlock.logs[2].blockNumber = 101
  assert.throws(() => result(otherBlock), /inter_transaction_or_block_log/)
  const duplicate = fixture()
  duplicate.logs[2].logIndex = 2
  assert.throws(() => result(duplicate), /duplicate_or_invalid_log_index/)
})

test('log order, missing transfer and shortfall do not pass', () => {
  const reversed = fixture()
  reversed.logs[0].logIndex = 6
  hasReason(reversed, 'flow_log_order_mismatch')
  const borrowAfterFunding = fixture()
  borrowAfterFunding.logs[1].logIndex = 7
  hasReason(borrowAfterFunding, 'flow_log_order_mismatch')
  const missing = fixture()
  missing.logs.splice(2, 1)
  hasReason(missing, 'missing_underlying_transfer')
  const shortfall = fixture()
  shortfall.logs[2].valueRaw = '99'
  hasReason(shortfall, 'vault_transfer_shortfall')
})

test('wrong asset, non-variable mode and share mint mismatch do not pass', () => {
  const asset = fixture()
  asset.logs[1].asset = OTHER
  hasReason(asset, 'wrong_borrow_asset_or_rate_mode')
  const mode = fixture()
  mode.logs[1].interestRateMode = 1
  hasReason(mode, 'wrong_borrow_asset_or_rate_mode')
  const share = fixture()
  share.logs[3].valueRaw = '97'
  hasReason(share, 'share_mint_mismatch')
})

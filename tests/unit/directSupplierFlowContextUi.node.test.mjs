import assert from 'node:assert/strict'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import directMarkets from '../../lib/carry/directSupplyMarketConstants.ts'

const { isMatchingDirectSupplierFlowContext, isMatchingDirectSupplierSupplyContext } = workbench
const { DIRECT_SUPPLY_MARKETS } = directMarkets
const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const startMs = Date.parse('2026-09-29T00:00:00Z')
const valid = {
  status: 'observed',
  marketKey: 'aaveV3Usdc',
  routeKey: market.routeKey,
  destination: market.destination.toLowerCase(),
  underlying: market.underlying.toLowerCase(),
  underlyingDecimals: market.decimals,
  coverage: {
    startMs,
    endMs: startMs + 2 * 86_400_000,
    finalized: true,
    receiptsComplete: true,
  },
  payoutCount: 4,
  unclassifiedWithdrawalCount: 0,
  sameAddressSettledCount: 1,
  largestSameAddressSinglePayoutRaw: '1800000000',
  max24hGrossWithdrawal: {
    status: 'observed',
    amountRaw: '3000000000',
    startMs,
    endMs: startMs + 86_400_000,
  },
  evidenceKind: 'sealed_public_receipt_replay',
  calibratedForecast: false,
}

const matches = (value, routeKey = market.routeKey, destination = market.destination) =>
  isMatchingDirectSupplierFlowContext(value, 'aaveV3Usdc', routeKey, destination)

test('accepts exact frozen route, destination, units, and sealed historical summary', () => {
  assert.equal(matches(valid), true)
})

test('rejects selected-route changes and mismatched market identities', () => {
  assert.equal(matches(valid, DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey), false)
  assert.equal(matches(valid, market.routeKey, DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination), false)
  assert.equal(matches({ ...valid, underlyingDecimals: 18 }), false)
  assert.equal(
    matches({ ...valid, underlying: DIRECT_SUPPLY_MARKETS.aaveV3Usde.underlying }),
    false,
  )
  assert.equal(matches({ ...valid, calibratedForecast: true }), false)
})

test('accepts a verified short span with its 24-hour maximum unavailable', () => {
  assert.equal(
    matches({
      ...valid,
      coverage: { ...valid.coverage, endMs: startMs + 21 * 3_600_000 },
      max24hGrossWithdrawal: { status: 'unavailable', reason: 'coverage_under_24h' },
    }),
    true,
  )
  assert.equal(
    matches({
      ...valid,
      max24hGrossWithdrawal: { status: 'unavailable', amountRaw: '0' },
    }),
    false,
  )
})

test('accepts incomplete Compound payout classification with a separate Comet event maximum', () => {
  const compound = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
  assert.equal(
    isMatchingDirectSupplierFlowContext(
      {
        ...valid,
        marketKey: 'compoundV3Usdc',
        routeKey: compound.routeKey,
        destination: compound.destination.toLowerCase(),
        underlying: compound.underlying.toLowerCase(),
        underlyingDecimals: compound.decimals,
        coverage: { ...valid.coverage, receiptsComplete: false },
        payoutCount: 5,
        unclassifiedWithdrawalCount: 10,
        grossCometWithdrawEvents: { eventCount: 15, amountRaw: '12345678' },
        max24hGrossCometWithdrawEvents: {
          status: 'observed',
          amountRaw: '10000000',
          eventCount: 10,
          startMs,
          endMs: startMs + 86_400_000,
        },
        max24hGrossWithdrawal: { status: 'unavailable', reason: 'unclassified_withdrawals' },
      },
      'compoundV3Usdc',
      compound.routeKey,
      compound.destination,
    ),
    true,
  )
  assert.equal(
    matches({ ...valid, coverage: { ...valid.coverage, receiptsComplete: false } }),
    false,
  )
})

test('gross supply summary stays route-bound and does not masquerade as net capacity', () => {
  const supply = {
    status: 'observed',
    marketKey: 'aaveV3Usdc',
    routeKey: market.routeKey,
    destination: market.destination.toLowerCase(),
    underlying: market.underlying.toLowerCase(),
    underlyingDecimals: market.decimals,
    coverage: {
      startMs,
      endMs: startMs + 10 * 3_600_000,
      finalized: true,
      receiptsComplete: true,
    },
    supplyEventCount: 4,
    grossUnderlyingInflowRaw: '9007199254740993',
    max24hGrossUnderlyingInflow: { status: 'unavailable', reason: 'coverage_under_24h' },
    evidenceKind: 'sealed_public_receipt_replay',
    interpretation: 'gross_underlying_inflow_not_net_replenishment_or_holder_exit',
    calibratedForecast: false,
  }
  const matchesSupply = (value) =>
    isMatchingDirectSupplierSupplyContext(value, 'aaveV3Usdc', market.routeKey, market.destination)
  assert.equal(matchesSupply(supply), true)
  assert.equal(matchesSupply({ ...supply, underlyingDecimals: 18 }), false)
  assert.equal(matchesSupply({ ...supply, calibratedForecast: true }), false)
  assert.equal(matchesSupply({ ...supply, interpretation: 'net_replenishment' }), false)
  assert.equal(
    matchesSupply({
      ...supply,
      max24hGrossUnderlyingInflow: {
        status: 'observed',
        amountRaw: '1',
        eventCount: 1,
        startMs,
        endMs: startMs + 86_400_000,
      },
    }),
    false,
  )
})

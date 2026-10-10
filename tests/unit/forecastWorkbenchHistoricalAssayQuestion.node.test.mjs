import assert from 'node:assert/strict'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'

const { historicalAssayQuestion } = workbench
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'

const bridge = {
  routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
  exitSize: '100',
  exitAssetSymbol: 'USDT',
  exitAssetDecimals: 6,
  selectedAsset: USDC,
  selectedAssetDecimals: 6,
  payoutAsset: USDT,
  fluidBridgeUsdcLegSize: '1.25',
  verifiedFluidBridgeUsdcLeg: true,
}

test('Fluid USDT history asks the explicit USDC first-leg amount, never the USDT payout Q', () => {
  assert.deepEqual(historicalAssayQuestion(bridge), {
    status: 'ready',
    amountUnits: '1.25',
    requestedRaw: '1250000',
    asset: USDC,
    assetDecimals: 6,
    assetSymbol: 'USDC',
  })
  assert.equal(historicalAssayQuestion(bridge).requestedRaw === '100000000', false)
})

test('Fluid history refuses an unverified or invalid first-leg amount', () => {
  assert.deepEqual(historicalAssayQuestion({ ...bridge, selectedAsset: USDT }), {
    status: 'abstain',
    reason: 'asset_identity_unverified',
  })
  assert.deepEqual(historicalAssayQuestion({ ...bridge, selectedAssetDecimals: 18 }), {
    status: 'abstain',
    reason: 'asset_identity_unverified',
  })
  assert.deepEqual(historicalAssayQuestion({ ...bridge, payoutAsset: USDC }), {
    status: 'abstain',
    reason: 'asset_identity_unverified',
  })
  assert.deepEqual(historicalAssayQuestion({ ...bridge, verifiedFluidBridgeUsdcLeg: false }), {
    status: 'abstain',
    reason: 'asset_identity_unverified',
  })
  assert.deepEqual(historicalAssayQuestion({ ...bridge, fluidBridgeUsdcLegSize: '1.0000001' }), {
    status: 'abstain',
    reason: 'amount_invalid',
  })
})

test('staged share and PT assays never inherit payout amount units', () => {
  for (const routeKey of [
    'AUSD → Staked USDat [USDat]',
    'PYUSD → StakingVault [wYLDS]',
    'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
    'GHO → UmbrellaStakeToken [GHO]',
  ]) {
    assert.deepEqual(historicalAssayQuestion({ ...bridge, routeKey, exitSize: '1.25' }), {
      status: 'abstain',
      reason: 'stage_units_differ',
    })
  }
})

test('whole-queue sUSDe assay cannot be relabeled as the user exit amount', () => {
  assert.deepEqual(historicalAssayQuestion({ ...bridge, routeKey: 'USDe → Staked USDe [USDe]' }), {
    status: 'abstain',
    reason: 'assay_not_user_amount',
  })
})

test('direct asset history requires matching visible units and verified asset identity', () => {
  const direct = {
    ...bridge,
    routeKey: 'GHO → sGho [GHO]',
    exitSize: '1.25',
    exitAssetSymbol: 'GHO',
    exitAssetDecimals: 18,
    selectedAsset: GHO,
    selectedAssetDecimals: 18,
    payoutAsset: GHO,
  }
  assert.deepEqual(historicalAssayQuestion(direct), {
    status: 'ready',
    amountUnits: '1.25',
    requestedRaw: '1250000000000000000',
    asset: GHO,
    assetDecimals: 18,
    assetSymbol: 'GHO',
  })
  assert.deepEqual(historicalAssayQuestion({ ...direct, selectedAsset: null }), {
    status: 'abstain',
    reason: 'asset_identity_unverified',
  })
  assert.deepEqual(historicalAssayQuestion({ ...direct, exitAssetSymbol: 'USDT' }), {
    status: 'abstain',
    reason: 'asset_identity_unverified',
  })
})

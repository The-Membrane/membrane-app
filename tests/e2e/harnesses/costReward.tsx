/** Local browser harness only. Synthetic positions never enter app routes or generated data. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Box, ChakraProvider } from '@chakra-ui/react'

import { CostRewardContent } from '@/components/PositionV0/CostRewardTracker'
import { buildCostReward } from '@/lib/position/costReward'
import { RATE_HISTORY } from '@/lib/position/rateHistory'
import type { ProtocolPosition } from '@/lib/position-sim/types'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const p: ProtocolPosition = {
  protocol: 'aave-v3',
  chainId: 1,
  venueAddress: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  usdValuationBasis: 'source-oracle',
  label: 'Synthetic test position',
  collateral: [
    {
      symbol: 'USDC',
      address: USDC,
      decimals: 6,
      amount: 20000,
      priceUsd: 1,
      valueUsd: 20000,
      liquidationThreshold: 0.8,
      maxLtv: 0.75,
      liquidationBonus: 0.05,
      supplyApr: 0.03,
      supplyAprSource: 'Synthetic test rate',
      supplyAprFeeBasis: 'protocol-fee-net',
    },
  ],
  debt: [
    {
      symbol: 'USDT',
      address: USDT,
      decimals: 6,
      amount: 10000,
      priceUsd: 1,
      valueUsd: 10000,
      borrowApr: 0.04,
      borrowRateBasis: 'variable',
    },
  ],
  totalCollateralUsd: 20000,
  totalDebtUsd: 10000,
  ltv: 0.5,
  liquidationLtv: 0.8,
  healthFactor: 1.6,
  provenance: { kind: 'onchain', label: 'Synthetic test receipt', at: Date.now(), block: 100 },
}
const state = new URLSearchParams(location.search).get('state') ?? 'measured'
if (state === 'missing-cost') p.debt[0].borrowApr = null
if (state === 'missing-income') p.collateral[0].supplyApr = null
if (state === 'mixed-rate') p.debt[0].borrowRateBasis = 'mixed'
if (state === 'assumed-peg') p.usdValuationBasis = 'assumed-peg'
if (state === 'same-asset') p.debt[0] = { ...p.debt[0], address: USDC, symbol: 'USDC' }
if (state === 'no-debt') p.debt = []
if (state === 'no-income') p.collateral = []
if (state === 'eth-ratio' || state === 'mixed-comet') {
  p.protocol = 'compound-v3'
  p.marketId = '0xa17581a9e3356d9a858b789d68b4d866e593ae94'
  p.collateral[0] = {
    ...p.collateral[0],
    symbol: 'wstETH',
    address: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
    supplyApr: 0,
  }
  p.debt[0] = {
    ...p.debt[0],
    symbol: 'WETH',
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  }
  if (state === 'mixed-comet')
    p.collateral.push({ ...p.collateral[0], symbol: 'USDC', address: USDC })
}
const model = buildCostReward(p, RATE_HISTORY, {
  nowMs: Date.now(),
  observedAtMs: Date.now() - (state === 'stale' ? 16 * 60_000 : 12_000),
  anchorState: state === 'loading' ? 'loading' : state === 'clock-error' ? 'error' : 'ready',
})
const root = document.getElementById('root')
if (!root) throw new Error('Missing browser harness root')
createRoot(root).render(
  <ChakraProvider>
    <Box className="news-edition" maxW="960px" mx="auto" px={{ base: 4, md: 6 }} py={6}>
      <p style={{ fontFamily: 'monospace', fontSize: 12 }}>
        Test harness · synthetic position/rates. Historical aggregate is sourced data. No product
        forecast.
      </p>
      <CostRewardContent model={model} position={p} />
    </Box>
  </ChakraProvider>,
)

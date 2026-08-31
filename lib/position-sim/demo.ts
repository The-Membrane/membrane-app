/**
 * The worked example the page opens with.
 *
 * DEMO-FIRST (CLAUDE.md V20): the simulator is populated before anyone types an
 * address. There is no empty state and no connect gate.
 *
 * HONESTY: this position is INVENTED — it is a worked example, not a real wallet, and
 * every block driven by it is stamped 'mock'. What is NOT invented is the risk
 * parameters attached to it: the liquidation threshold, max LTV and liquidation bonus
 * below are the real Aave V3 mainnet values read on-chain at block 23,543,615 and
 * committed to public/data/oct10-2025/protocols.json. So the demo shows a made-up
 * borrower running into a real engine over a real price path.
 */

import { stamp, type ProtocolPosition } from './types'

/** Aave V3 mainnet, block 23,543,615 — see public/data/oct10-2025/protocols.json. */
const AAVE_WETH = { liquidationThreshold: 0.83, maxLtv: 0.805, liquidationBonus: 0.05 }
const AAVE_WBTC = { liquidationThreshold: 0.78, maxLtv: 0.73, liquidationBonus: 0.05 }

/** Prices at the window's opening minute (2025-10-10 00:00 UTC), measured. */
const OPEN_ETH = 4370.37
const OPEN_BTC = 121566.15

export const DEMO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function demoPosition(): ProtocolPosition {
  const ethAmount = 40
  const btcAmount = 1.5
  const debtAmount = 210_000

  const collateral = [
    {
      symbol: 'WETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      decimals: 18,
      amount: ethAmount,
      priceUsd: OPEN_ETH,
      valueUsd: ethAmount * OPEN_ETH,
      ...AAVE_WETH,
    },
    {
      symbol: 'WBTC',
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      decimals: 8,
      amount: btcAmount,
      priceUsd: OPEN_BTC,
      valueUsd: btcAmount * OPEN_BTC,
      ...AAVE_WBTC,
    },
  ]
  const debt = [
    {
      symbol: 'USDC',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      amount: debtAmount,
      priceUsd: 1,
      valueUsd: debtAmount,
      borrowApr: null,
    },
  ]

  const totalCollateralUsd = collateral.reduce((a, c) => a + c.valueUsd, 0)
  const totalDebtUsd = debt.reduce((a, d) => a + d.valueUsd, 0)
  const liquidationLtv =
    collateral.reduce((a, c) => a + c.liquidationThreshold * c.valueUsd, 0) / totalCollateralUsd

  return {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral,
    debt,
    totalCollateralUsd,
    totalDebtUsd,
    ltv: totalDebtUsd / totalCollateralUsd,
    liquidationLtv,
    healthFactor: (totalCollateralUsd * liquidationLtv) / totalDebtUsd,
    provenance: stamp(
      'mock',
      'worked example · not a real wallet',
      'The balances are invented. The Aave V3 risk parameters attached to them (83%/78% liquidation thresholds, 5% bonus) are real mainnet values read at block 23,543,615.',
    ),
  }
}

/** A one-line description of the demo used in copy, so the number never drifts. */
export function demoSummary(): string {
  const p = demoPosition()
  return `40 WETH + 1.5 WBTC backing ${Math.round(p.totalDebtUsd / 1000)}k USDC on Aave V3 — ${(p.ltv * 100).toFixed(1)}% LTV against an ${(p.liquidationLtv * 100).toFixed(1)}% line.`
}

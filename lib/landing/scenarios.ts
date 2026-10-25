/**
 * THE SCENARIO PICKER'S REGISTRY (framework: "Oct 10 2025 default + 2–3 other stress
 * windows").
 *
 * Only a window with a committed, measured price path is runnable. Today that is one:
 * public/data/oct10-2025 (Chainlink oracle rounds + Binance 1m klines + the Curve USDe
 * quote, built by scripts/build-oct10-dataset.ts). The others are listed as "coming"
 * with the data pull each one needs, and carry no numbers of any kind.
 */

export type ScenarioStatus = 'live' | 'coming'

export interface Scenario {
  id: string
  label: string
  status: ScenarioStatus
  /** Live: where the measured path lives. */
  dataPath?: string
  /** Coming: what has to be pulled before it can run. Shown to the reader. */
  needs?: string
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'oct10-2025',
    label: '10 Oct 2025',
    status: 'live',
    dataPath: '/data/oct10-2025',
  },
  {
    id: 'aug05-2024',
    label: '5 Aug 2024',
    status: 'coming',
    needs:
      'Chainlink ETH/USD, BTC/USD and stETH/ETH rounds plus Binance 1m klines for 4–6 Aug 2024, the Aave V3 and Morpho risk parameters at that block, and that window’s liquidation events for the measured repay sizes.',
  },
  {
    id: 'mar12-2020',
    label: '12 Mar 2020',
    status: 'coming',
    needs:
      'Chainlink/Maker oracle rounds and 1m spot for 11–13 Mar 2020. Aave V3 and Morpho did not exist; it needs a venue mapping (Compound V2, Maker) before a replay means anything.',
  },
  {
    id: 'jun2022-steth',
    label: 'Jun 2022 stETH discount',
    status: 'coming',
    needs:
      'stETH/ETH oracle rounds and Curve stETH/ETH depth for 9–18 Jun 2022, and the Aave V2 parameters then in force.',
  },
]

export const DEFAULT_SCENARIO_ID = 'oct10-2025'

export function scenarioById(id: string | null | undefined): Scenario {
  const s = SCENARIOS.find((x) => x.id === id && x.status === 'live')
  return s ?? (SCENARIOS.find((x) => x.id === DEFAULT_SCENARIO_ID) as Scenario)
}

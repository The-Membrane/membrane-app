import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'

const BAND_PCT = Math.round(MAX_THRESHOLD_TO_DELAY * 100)

/** 100–300 words of static prose for the crawler and the careful reader (SEO R10). */
export const PROSE = [
  `Paste the address of a wallet with an open borrow on Aave V3, Spark, Morpho Blue or Compound V3. The page reads the position from Ethereum mainnet, read-only, with no signature and no deposit. It then replays that exact collateral and debt through the measured minute-by-minute oracle prices of the 10 Oct 2025 crash, twice: once under your venue’s own liquidation rules, and once under Membrane’s.`,
  `On your venue, a position over its liquidation line is liquidated in the same block, with the venue’s bonus paid to the liquidator. On Membrane, within ${BAND_PCT}% of the line, liquidation waits ${CURE_WINDOW_HOURS} hours. A return under the line ends the wait with nothing sold. Past the ${BAND_PCT}% band, or still over the line when the ${CURE_WINDOW_HOURS} hours run out, the position is partially liquidated back to its borrowable LTV, not closed.`,
  `The chart shows the value of the position through the replay on both engines, with every liquidation, trim and armed window marked. It is a replay of one day, not a promise about the next one. Membrane is pre-launch, so its per-asset line in the replay is a modelled assumption. The cards below answer the usual objections from data, and link to it.`,
]


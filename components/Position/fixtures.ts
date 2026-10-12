// Encounter copy ported verbatim from public/proto/dash.html. Rendered by
// components/Portfolio/PortPage/YourRecord.tsx under the DemoBanner until real
// position events are wired. The rest of the proto's mock data (deliveries,
// intents with hardcoded breach odds, seats, points) left with the /position
// page on 2026-10-12 — see docs/CUTS-2026-10-12.md to restore it.

import { Encounter } from './types'

/** Named market encounters, scored after the fact. */
export const ENCOUNTERS: Encounter[] = [
  {
    when: 'Aug 12, 2026',
    bad: false,
    title: 'Survived the Aug 12 wick',
    body: 'Bitcoin fell 14.2% in 90 minutes. Your headroom bottomed at **3.1 hours** before recovering, and no venue was ever asked for capital. You were drawn at 40% when the same position at 52% would have been recalled — **your sizing is why**.',
    stamp: 'price data measured 2026-08-12 · block 21,904,118',
  },
  {
    when: 'Jul 29, 2026',
    bad: false,
    title: 'sUSDe cooldown coincided with a 9% slide',
    body: 'The one venue that could not have answered was locked for four days. It never mattered, because **Aave and Morpho Vault V2 covered the whole requirement** on their own. Two liquid venues did the work of three.',
    stamp: 'price data measured 2026-07-29 · block 21,712,455',
  },
  {
    when: 'Jun 04, 2026',
    bad: true,
    title: 'You paid for a lesson here',
    body: 'A 6% drift crossed the line because the position was drawn at 57% that week. **{neg}$418 of bitcoin was sold{/neg}** to bring it back to the cap. You reduced the draw four days later and it has not happened since.',
    stamp: 'price data measured 2026-06-04 · block 21,204,901',
  },
]

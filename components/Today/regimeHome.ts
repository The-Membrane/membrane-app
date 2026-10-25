// THE HOME SWITCH: which body owns the Today screen. Pure: the weather query's state in,
// the owner, its kicker and the one-line jump to the other body out. No React, so the
// unit tests run it in node.
//
// One state owns the screen (membrane-board design/DESIGN_RULES.md §2; owner rule for
// Q27 item 3). M0 drives it:
//   calm                     → Opportunities (carry and venue scan)
//   choppy, trigger or hold  → Safety (positions, venue alarms, curator exits)
//   stale (regime withheld)  → Safety: with no regime to go by, lean toward risk
//   weather API error        → Safety, the same way
//   loading                  → no owner yet: the page reserves the body's space and
//                              renders neither body, so nothing flashes or shifts.
// The other body is collapsed to one jump line below the owner, never side by side.
//
// The state is read through weatherView, the strip's own view model, so the strip and
// the body it switches can never disagree (same response, same staleness rule).

import type { WeatherResponse } from '@/lib/weather/handler'
import { weatherView } from '@/components/Weather/weatherView'

export type HomeBody = 'opportunities' | 'safety'

export type HomeState = 'loading' | 'calm' | 'choppyActive' | 'choppyHold' | 'stale' | 'error'

export const HOME_COPY = {
  name: { opportunities: 'Opportunities', safety: 'Safety' },
  /** Suffix on the owner's kicker when Safety leads only because no regime is known.
   *  The strip above already says why (withheld or unavailable); this says what follows. */
  byDefault: 'by default',
  jump: {
    opportunities: 'Opportunities continue below →',
    safety: 'Safety continues below →',
  },
} as const

/** The section id of each body: the jump line's anchor and the deep link `#safety`. */
export const BODY_ID: Record<HomeBody, string> = {
  opportunities: 'opportunities',
  safety: 'safety',
}

export interface HomeJump {
  body: HomeBody
  text: string
  href: string
}

export interface RegimeHome {
  state: HomeState
  /** The body that owns the screen. Null while the weather loads. */
  owner: HomeBody | null
  /** The owner's kicker: "Opportunities", "Safety", or "Safety, by default". */
  kicker: string | null
  /** True when Safety leads without a regime (withheld or unavailable). */
  byDefault: boolean
  /** The other body, collapsed to this one line. Null while loading. */
  jump: HomeJump | null
}

const other = (b: HomeBody): HomeBody => (b === 'safety' ? 'opportunities' : 'safety')

export function jumpTo(body: HomeBody): HomeJump {
  return { body, text: HOME_COPY.jump[body], href: `#${BODY_ID[body]}` }
}

export function regimeHome(input: {
  status: 'pending' | 'error' | 'success'
  data: WeatherResponse | undefined
  nowMs: number
}): RegimeHome {
  const v = weatherView(input)
  if (v.kind === 'loading') {
    return { state: 'loading', owner: null, kicker: null, byDefault: false, jump: null }
  }
  const state: HomeState =
    v.kind === 'choppy' ? (v.reason ? 'choppyActive' : 'choppyHold') : v.kind
  const owner: HomeBody = state === 'calm' ? 'opportunities' : 'safety'
  const byDefault = state === 'stale' || state === 'error'
  const name = HOME_COPY.name[owner]
  return {
    state,
    owner,
    kicker: byDefault ? `${name}, ${HOME_COPY.byDefault}` : name,
    byDefault,
    jump: jumpTo(other(owner)),
  }
}

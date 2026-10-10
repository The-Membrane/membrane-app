import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import routeCapital from '@/components/Carry/route-capital.json'
import {
  DAILY_GHO_ROUTE_KEY,
  DAILY_USDE_ROUTE_KEY,
  dailySpreadForRoute,
} from '@/lib/carry/dailyRouteRows'

const now = Date.parse('2026-09-28T12:00:00Z')
const gho = {
  borrowApy: 0.04,
  yieldApy: 0.046,
  spread: 0.006,
  observedAt: '2026-09-28T06:00:00Z',
}
const usde = {
  borrowApy: 0.035,
  yieldApy: 0.041,
  spread: 0.006,
  observedAt: '2026-09-26T06:00:00Z',
}
const pilots = { exactAaveSpread: gho, latestUsdeExactSpread: usde }

describe('daily rate legs inside the August route rack', () => {
  it('maps only the two exact priced route keys, not similar destinations or assets', () => {
    const mapped = ROUTES.map((route) => route.routeKey).filter(
      (key) => dailySpreadForRoute(key, pilots, now) !== null,
    )
    expect(mapped).toEqual([DAILY_USDE_ROUTE_KEY, DAILY_GHO_ROUTE_KEY])
    expect(dailySpreadForRoute('GHO → UmbrellaStakeToken [GHO]', pilots, now)).toBeNull()
    expect(
      dailySpreadForRoute('USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]', pilots, now),
    ).toBeNull()
    expect(dailySpreadForRoute(undefined, pilots, now)).toBeNull()
    expect(dailySpreadForRoute(DAILY_GHO_ROUTE_KEY, pilots, now)?.reading).toEqual(gho)
    expect(dailySpreadForRoute(DAILY_USDE_ROUTE_KEY, pilots, now)?.reading).toEqual(usde)
  })

  it('keeps missing and stale readings visible as distinct states', () => {
    expect(dailySpreadForRoute(DAILY_GHO_ROUTE_KEY, null, now)).toEqual({
      kind: 'gho',
      reading: null,
      stale: null,
    })
    expect(dailySpreadForRoute(DAILY_GHO_ROUTE_KEY, pilots, now)?.stale).toBe(false)
    expect(dailySpreadForRoute(DAILY_USDE_ROUTE_KEY, pilots, now)?.stale).toBe(true)
    expect(
      dailySpreadForRoute(
        DAILY_USDE_ROUTE_KEY,
        { latestUsdeExactSpread: { ...usde, observedAt: 'not a time' } },
        now,
      )?.reading,
    ).toBeNull()
    expect(
      dailySpreadForRoute(DAILY_USDE_ROUTE_KEY, { usdePilot: { exactSpread: usde } } as never, now)
        ?.reading,
    ).toBeNull()
    expect(
      dailySpreadForRoute(
        DAILY_USDE_ROUTE_KEY,
        { latestUsdeExactSpread: { ...usde, observedAt: '2026-09-29T12:00:00Z' } },
        now,
      )?.reading,
    ).toBeNull()
  })

  it('does not change frozen August spreads or capped capital into daily route TVL', () => {
    const august = ROUTES.find((route) => route.routeKey === DAILY_GHO_ROUTE_KEY)!
    const frozenCapital = routeCapital.routes.find((row) => row.route === DAILY_GHO_ROUTE_KEY)!
    const daily = dailySpreadForRoute(august.routeKey, pilots, now)!
    expect(august.net).toBe(0.52)
    expect(daily.reading!.spread * 100).toBeCloseTo(0.6)
    expect(daily).not.toHaveProperty('cohortHeldCapitalUsdApprox')
    expect(daily).not.toHaveProperty('totalAssetsGho')
    expect(frozenCapital.cohortHeldCapitalUsdApprox).toBeGreaterThanOrEqual(0)
  })
})

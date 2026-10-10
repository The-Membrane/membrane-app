import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import routeCapital from '@/components/Carry/route-capital.json'
import { dailyCapitalForRoute } from '@/lib/carry/dailyRouteCapital'
import { DAILY_GHO_ROUTE_KEY, DAILY_USDE_ROUTE_KEY } from '@/lib/carry/dailyRouteRows'

const now = Date.parse('2026-09-28T12:00:00Z')
const gho = {
  matchedGho: 1234.125,
  completeWalletCount: 20,
  observedAt: '2026-09-28T06:00:00Z',
}
const usde = {
  matchedUsde: '25000.375',
  completeWalletCount: 25,
  observedAt: '2026-09-26T06:00:00Z',
}
const pilots = { matchedCapital: gho, latestUsdeMatchedCapital: usde }

describe('fixed August-wallet daily debt/holding overlap', () => {
  it('maps only the exact two route keys, never an asset or destination substring', () => {
    expect(
      ROUTES.map((route) => route.routeKey).filter(
        (key) => dailyCapitalForRoute(key, pilots, now) !== null,
      ),
    ).toEqual([DAILY_USDE_ROUTE_KEY, DAILY_GHO_ROUTE_KEY])
    expect(dailyCapitalForRoute('GHO → UmbrellaStakeToken [GHO]', pilots, now)).toBeNull()
    expect(
      dailyCapitalForRoute('USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]', pilots, now),
    ).toBeNull()
    expect(dailyCapitalForRoute(undefined, pilots, now)).toBeNull()
    expect(dailyCapitalForRoute(DAILY_GHO_ROUTE_KEY, pilots, now)).toMatchObject({
      amount: '1,234.125 GHO',
      walletCount: 20,
      stale: false,
    })
    expect(dailyCapitalForRoute(DAILY_USDE_ROUTE_KEY, pilots, now)).toMatchObject({
      amount: '25,000.375 USDe',
      walletCount: 25,
      stale: true,
    })
  })

  it('retains a valid measured zero, including a stale zero', () => {
    expect(
      dailyCapitalForRoute(DAILY_GHO_ROUTE_KEY, { matchedCapital: { ...gho, matchedGho: 0 } }, now),
    ).toMatchObject({ amount: '0 GHO', walletCount: 20, stale: false })
    expect(
      dailyCapitalForRoute(
        DAILY_USDE_ROUTE_KEY,
        { latestUsdeMatchedCapital: { ...usde, matchedUsde: '0.000000' } },
        now,
      ),
    ).toMatchObject({ amount: '0 USDe', walletCount: 25, stale: true })
  })

  it('keeps a large uint256-compatible USDe token balance as a decimal string', () => {
    const whole = '9'.repeat(60)
    expect(
      dailyCapitalForRoute(
        DAILY_USDE_ROUTE_KEY,
        { latestUsdeMatchedCapital: { ...usde, matchedUsde: `${whole}.25` } },
        now,
      )?.amount,
    ).toBe(`${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.25 USDe`)
    expect(
      dailyCapitalForRoute(
        DAILY_USDE_ROUTE_KEY,
        { latestUsdeMatchedCapital: { ...usde, matchedUsde: '9'.repeat(61) } },
        now,
      )?.reading,
    ).toBeNull()
  })

  it('does not treat absent, incomplete or malformed data as a zero', () => {
    expect(dailyCapitalForRoute(DAILY_GHO_ROUTE_KEY, null, now)).toEqual({
      kind: 'gho',
      amount: null,
      reading: null,
      walletCount: 20,
      stale: null,
    })
    for (const invalid of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        dailyCapitalForRoute(
          DAILY_GHO_ROUTE_KEY,
          { matchedCapital: { ...gho, matchedGho: invalid } },
          now,
        )?.reading,
      ).toBeNull()
    }
    for (const invalid of ['-1', 'Infinity', '1e9', '1,000', '', '01', '1.1234567890123456789']) {
      expect(
        dailyCapitalForRoute(
          DAILY_USDE_ROUTE_KEY,
          { latestUsdeMatchedCapital: { ...usde, matchedUsde: invalid } },
          now,
        )?.reading,
      ).toBeNull()
    }
    expect(
      dailyCapitalForRoute(
        DAILY_USDE_ROUTE_KEY,
        { latestUsdeMatchedCapital: { ...usde, completeWalletCount: 24 } },
        now,
      )?.reading,
    ).toBeNull()
    expect(
      dailyCapitalForRoute(
        DAILY_GHO_ROUTE_KEY,
        { matchedCapital: { ...gho, observedAt: '2026-09-29T12:00:00Z' } },
        now,
      )?.reading,
    ).toBeNull()
  })

  it('keeps the frozen August dollar proxy separate from token-unit overlap', () => {
    const frozen = routeCapital.routes.find((row) => row.route === DAILY_GHO_ROUTE_KEY)!
    const daily = dailyCapitalForRoute(DAILY_GHO_ROUTE_KEY, pilots, now)!
    expect(frozen.cohortHeldCapitalUsdApprox).toBeGreaterThanOrEqual(0)
    expect(daily.amount).toBe('1,234.125 GHO')
    expect(daily).not.toHaveProperty('cohortHeldCapitalUsdApprox')
    expect(daily).not.toHaveProperty('totalAssetsGho')
  })
})

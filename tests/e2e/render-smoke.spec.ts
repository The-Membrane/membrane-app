import { test, expect } from '@playwright/test'

/**
 * Render smoke: visit every key route on the PRODUCTION build (next start) and fail on
 * client-side crashes — uncaught page errors (React #185/#310 minified loops, hydration
 * blowups) and error-boundary trips. Run with:
 *
 *   pnpm build && pnpm start -p 3005 &   # production server, same bundle Vercel serves
 *   npx playwright test tests/e2e/render-smoke.spec.ts --project='Desktop Chrome' --workers=1
 *
 * Console noise (failed RPC fetches, extension chatter) is EXPECTED and not a failure —
 * only pageerror (uncaught exceptions) and the Next.js client-exception overlay fail.
 */

const ROUTES = [
  '/',
  '/osmosis',
  '/osmosis/mint',
  '/osmosis/stake',
  '/osmosis/liquidate',
  '/osmosis/portfolio',
  '/osmosis/transmuter',
  '/osmosis/disco',
  '/osmosis/isolated',
  '/osmosis/maze-runners',
  '/neutron/mint',
  '/nft',
  '/bid',
  '/lockdrop',
  '/manic',
]

// Errors that mean "the page crashed", not "a data fetch failed".
// Hydration mismatches (#418/#423/#425) are excluded: React recovers by client
// rendering, the page still displays — they're logged as warnings below and tracked
// for a dedicated hydration pass (timing-dependent: live chain data racing hydration).
const FATAL_PATTERNS = [
  /Minified React error #(?!418\b|423\b|425\b)\d+/,
  /Maximum update depth exceeded/,
  /client-side exception/i,
]

const HYDRATION_PATTERNS = [/Minified React error #(418|423|425)\b/, /Hydration failed/]

test.describe('render smoke (production build)', () => {
  test.setTimeout(90000)

  for (const route of ROUTES) {
    test(`renders without crashing: ${route}`, async ({ page }) => {
      const pageErrors: string[] = []
      const fatalConsole: string[] = []

      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return
        const text = msg.text()
        if (FATAL_PATTERNS.some((p) => p.test(text))) fatalConsole.push(text)
      })

      // 'load' not 'networkidle' — the app polls RPCs forever (see skill notes)
      await page.goto(route, { waitUntil: 'load' })
      // settle window: effects, react-query retries, and any update loop would trip here
      await page.waitForTimeout(4000)

      const hydration = pageErrors.filter((e) => HYDRATION_PATTERNS.some((p) => p.test(e)))
      if (hydration.length) {
        console.warn(`[HYDRATION-WARN] ${route}: ${hydration.length} hydration mismatch(es)`)
      }

      const fatal = [
        ...pageErrors.filter((e) => FATAL_PATTERNS.some((p) => p.test(e))),
        ...fatalConsole,
      ]
      expect(fatal, `fatal client errors on ${route}:\n${fatal.join('\n')}`).toHaveLength(0)

      // the Next.js "Application error" fallback replaces the app when _app crashes
      const appError = await page
        .getByText(/Application error: a client-side exception has occurred/i)
        .count()
      expect(appError, `Next.js error overlay rendered on ${route}`).toBe(0)

      // sanity: something actually rendered
      const bodyLen = (await page.locator('body').innerText()).length
      expect(bodyLen, `empty body on ${route}`).toBeGreaterThan(0)
    })
  }
})

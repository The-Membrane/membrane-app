import { test, expect, type Locator } from '@playwright/test'

/**
 * Navigation Tests
 *
 * Tests navigation functionality across devices:
 * - Desktop horizontal nav
 * - Mobile hamburger menu
 * - Breadcrumb navigation
 * - Chain switching
 *
 * NOTE ON ROUTES: these tests previously targeted `/neutron`, which is no longer
 * a supported chain — `config/chains.ts` lists `ethereum` only, so `/neutron`
 * server-redirects to `/ethereum` (pages/[chain]/index.tsx). They now use the
 * supported chain directly.
 *
 * NOTE ON NAV ITEMS: `components/HorizontalNav.tsx` renders About / Home / Mint /
 * The Disco / Liquidate. Portfolio, Manic and Transmuter are commented out of
 * `navItems`, so tests assert only against links that actually render.
 */

// The only chain in `supportedChains` (config/chains.ts).
const CHAIN = 'ethereum'

/**
 * Click a control and wait for its effect, retrying the whole interaction.
 *
 * In dev the page can finish loading before React has hydrated, and a click that
 * lands first is silently dropped — the DOM node exists but has no handler yet.
 * Retrying the click until the expected result appears removes that race, which
 * otherwise makes the mobile-drawer tests intermittently fail.
 */
async function clickUntil(trigger: Locator, expected: Locator) {
  await expect(async () => {
    await trigger.click({ timeout: 2000 })
    await expect(expected).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 20000 })
}

/**
 * Open a Chakra <Menu>. Its <MenuList> stays mounted while closed, so asserting
 * on visibility is unreliable — `aria-expanded` on the trigger is the real
 * signal. Retried for the same pre-hydration reason as `clickUntil`.
 */
async function openMenu(trigger: Locator) {
  await expect(async () => {
    await trigger.click({ timeout: 2000 })
    await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 1500 })
  }).toPass({ timeout: 20000 })
}

// The dev server compiles routes on demand, so a first client-side navigation
// can take several seconds — well past Playwright's 5s assertion default.
const NAV_TIMEOUT = 30000

test.describe('Navigation', () => {
  test.describe('Desktop Navigation', () => {
    test.use({ viewport: { width: 1920, height: 1080 } })

    test('should display horizontal navigation on desktop', async ({ page }) => {
      await page.goto(`/${CHAIN}`)

      // The nav is a single `<Box as="nav">` (HorizontalNav.tsx) — there is no
      // nested [role="navigation"] child, so target the nav element itself.
      const horizontalNav = page.locator('nav').first()
      await expect(horizontalNav).toBeVisible()

      // Hamburger should be hidden
      const hamburger = page.locator('button[aria-label="Open menu"]')
      await expect(hamburger).toBeHidden()
    })

    test('should navigate between pages using horizontal nav', async ({ page }) => {
      await page.goto(`/${CHAIN}`)

      // Nav items render as <Button as={NextLink}>, i.e. anchors with hrefs.
      await page.getByRole('link', { name: 'Mint', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/${CHAIN}/mint`), { timeout: NAV_TIMEOUT })

      await page.getByRole('link', { name: 'The Disco', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/${CHAIN}/disco`), { timeout: NAV_TIMEOUT })

      await page.getByRole('link', { name: 'Liquidate', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/${CHAIN}/liquidate`), { timeout: NAV_TIMEOUT })
    })

    test('should highlight active page in navigation', async ({ page }) => {
      await page.goto(`/${CHAIN}/mint`)

      // The active item gets bg `whiteAlpha.200` (rgba(255,255,255,0.08)) while
      // every other nav link stays transparent. This must be an auto-retrying
      // assertion: `router.asPath` only resolves to the real path after
      // hydration, so a one-shot read of the computed style sees the
      // pre-hydration state where nothing is marked active yet.
      const activeLink = page.locator(`a[href="/${CHAIN}/mint"]`).first()
      await expect(activeLink).toBeVisible()
      await expect(activeLink).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.08)')

      // A sibling link stays transparent, proving the highlight is selective.
      const inactiveLink = page.locator(`a[href="/${CHAIN}/liquidate"]`).first()
      await expect(inactiveLink).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    })
  })

  test.describe('Mobile Navigation', () => {
    test.use({ viewport: { width: 375, height: 667 } })

    test('should display hamburger menu on mobile', async ({ page }) => {
      await page.goto(`/${CHAIN}`)

      // Hamburger should be visible
      const hamburger = page.locator('button[aria-label="Open menu"]')
      await expect(hamburger).toBeVisible()

      // The desktop nav row is display:none below `lg`.
      const desktopNavLink = page.locator(`a[href="/${CHAIN}/mint"]`).first()
      await expect(desktopNavLink).toBeHidden()
    })

    test('should open mobile menu drawer', async ({ page }) => {
      await page.goto(`/${CHAIN}`)

      const drawer = page.locator('[role="dialog"]')
      await clickUntil(page.locator('button[aria-label="Open menu"]'), drawer)

      // Nav items should be visible in the drawer
      await expect(drawer.getByRole('link', { name: 'Mint', exact: true })).toBeVisible()
      await expect(drawer.getByRole('link', { name: 'The Disco', exact: true })).toBeVisible()
    })

    test('should navigate from mobile menu', async ({ page }) => {
      await page.goto(`/${CHAIN}`)

      const drawer = page.locator('[role="dialog"]')
      await clickUntil(page.locator('button[aria-label="Open menu"]'), drawer)

      await drawer.getByRole('link', { name: 'Mint', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/${CHAIN}/mint`))

      // Drawer should close
      await expect(drawer).toBeHidden()
    })
  })

  test.describe('Breadcrumb Navigation', () => {
    // `components/ui/Breadcrumb.tsx` is fully implemented but is not imported or
    // rendered by any page or layout, so there are no breadcrumbs to assert on.
    // These stay skipped (rather than deleted) so the unfinished wiring stays
    // visible; unskip once <Breadcrumb /> is rendered in components/Layout.tsx.
    test.skip('should display breadcrumbs on nested pages', async ({ page }) => {
      await page.goto(`/${CHAIN}/portfolio`)

      const breadcrumb = page.locator('nav[aria-label="breadcrumb"]')
      await expect(breadcrumb).toBeVisible()
    })

    test('should not display breadcrumbs on home page', async ({ page }) => {
      await page.goto(`/${CHAIN}`)

      // Breadcrumbs should not be visible
      const breadcrumb = page.locator('nav[aria-label="breadcrumb"]')
      await expect(breadcrumb).toBeHidden()
    })

    test.skip('should navigate using breadcrumb links', async ({ page }) => {
      await page.goto(`/${CHAIN}/portfolio`)

      await page.click('nav[aria-label="breadcrumb"] >> text=Home')
      await expect(page).toHaveURL(new RegExp(`/${CHAIN}$`))
    })
  })

  test.describe('Chain Switching', () => {
    test('should open the chain selector', async ({ page }) => {
      // Runs on /portfolio on purpose. That route used to fail hydration
      // ("<button> cannot appear as a descendant of <button>"), which made React
      // throw away the server tree and re-render the whole page on the client,
      // leaving this header button unclickable. Keeping the test here means a
      // regression of that bug shows up as a failure again.
      await page.goto(`/${CHAIN}/portfolio`)

      // The selector is an icon-only MenuButton, identified by the aria-label.
      await openMenu(page.locator('button[aria-label="Select chain"]'))

      // Other Chakra menus (e.g. Dashboards, per-asset menus) are mounted on the
      // same page, so scope to the menu listing chains rather than [role="menu"].
      const chainMenu = page.locator('[role="menu"]').filter({ hasText: 'Ethereum' })

      // Only `ethereum` is currently supported, so exactly one option renders.
      await expect(chainMenu.getByRole('menuitem')).toHaveCount(1)
      await expect(chainMenu.getByRole('menuitem').first()).toContainText('Ethereum')
    })

    test('should preserve current page when switching chains', async ({ page }) => {
      await page.goto(`/${CHAIN}/disco`)

      await openMenu(page.locator('button[aria-label="Select chain"]'))
      const chainMenu = page.locator('[role="menu"]').filter({ hasText: 'Ethereum' })
      await chainMenu.getByRole('menuitem').first().click()

      // Selecting a chain keeps the user on the same sub-page.
      await expect(page).toHaveURL(/\/disco/, { timeout: NAV_TIMEOUT })
    })
  })

  test.describe('Logo Navigation', () => {
    // The logo is rendered inside the mobile drawer and as a mobile-only centred
    // image (HorizontalNav.tsx); the desktop header logo is commented out. In
    // neither place is it wrapped in a link, so clicking it navigates nowhere.
    // Skipped until the logo is made a link to home — a product decision, not a
    // test fix.
    test.skip('should navigate to home when clicking logo', async ({ page }) => {
      await page.goto(`/${CHAIN}/portfolio`)

      await page.click('[data-testid="logo"]')
      await expect(page).toHaveURL(new RegExp(`/${CHAIN}$`))
    })
  })
})

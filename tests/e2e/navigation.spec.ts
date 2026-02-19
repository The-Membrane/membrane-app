import { test, expect } from '@playwright/test'

/**
 * Navigation Tests
 *
 * Tests navigation functionality across devices:
 * - Desktop horizontal nav
 * - Mobile hamburger menu
 * - Breadcrumb navigation
 * - Chain switching
 */

test.describe('Navigation', () => {
  test.describe('Desktop Navigation', () => {
    test.use({ viewport: { width: 1920, height: 1080 } })

    test('should display horizontal navigation on desktop', async ({ page }) => {
      await page.goto('/neutron')

      // Horizontal nav should be visible
      const horizontalNav = page.locator('nav [role="navigation"]').first()
      await expect(horizontalNav).toBeVisible()

      // Hamburger should be hidden
      const hamburger = page.locator('button[aria-label="Open menu"]')
      await expect(hamburger).toBeHidden()
    })

    test('should navigate between pages using horizontal nav', async ({ page }) => {
      await page.goto('/neutron')

      // Click on Portfolio link
      await page.click('text=Portfolio')
      await expect(page).toHaveURL(/.*\/portfolio/)

      // Click on Disco link
      await page.click('text=Disco')
      await expect(page).toHaveURL(/.*\/disco/)

      // Click on Manic link
      await page.click('text=Manic')
      await expect(page).toHaveURL(/.*\/manic/)
    })

    test('should highlight active page in navigation', async ({ page }) => {
      await page.goto('/neutron/portfolio')

      // Portfolio button should have active styling
      const portfolioButton = page.locator('a[href*="/portfolio"]')
      const bgColor = await portfolioButton.evaluate((el) =>
        window.getComputedStyle(el).backgroundColor
      )
      expect(bgColor).not.toBe('transparent')
    })
  })

  test.describe('Mobile Navigation', () => {
    test.use({ viewport: { width: 375, height: 667 } })

    test('should display hamburger menu on mobile', async ({ page }) => {
      await page.goto('/neutron')

      // Hamburger should be visible
      const hamburger = page.locator('button[aria-label="Open menu"]')
      await expect(hamburger).toBeVisible()

      // Horizontal nav should be hidden
      const navItems = page.locator('nav button:has-text("Portfolio")').first()
      await expect(navItems).toBeHidden()
    })

    test('should open mobile menu drawer', async ({ page }) => {
      await page.goto('/neutron')

      // Open hamburger menu
      await page.click('button[aria-label="Open menu"]')

      // Drawer should be visible
      const drawer = page.locator('[role="dialog"]')
      await expect(drawer).toBeVisible()

      // Nav items should be visible in drawer
      await expect(page.locator('text=Portfolio').nth(1)).toBeVisible()
      await expect(page.locator('text=Disco').nth(1)).toBeVisible()
    })

    test('should navigate from mobile menu', async ({ page }) => {
      await page.goto('/neutron')

      // Open menu and navigate
      await page.click('button[aria-label="Open menu"]')
      await page.click('[role="dialog"] >> text=Portfolio')

      // Should navigate to portfolio page
      await expect(page).toHaveURL(/.*\/portfolio/)

      // Drawer should close
      const drawer = page.locator('[role="dialog"]')
      await expect(drawer).toBeHidden()
    })
  })

  test.describe('Breadcrumb Navigation', () => {
    test('should display breadcrumbs on nested pages', async ({ page }) => {
      await page.goto('/neutron/portfolio')

      // Breadcrumbs should be visible
      const breadcrumb = page.locator('nav[aria-label="breadcrumb"]')
      await expect(breadcrumb).toBeVisible()

      // Should show Home > Portfolio
      await expect(page.locator('text=Home')).toBeVisible()
      await expect(page.locator('text=Portfolio')).toBeVisible()
    })

    test('should not display breadcrumbs on home page', async ({ page }) => {
      await page.goto('/neutron')

      // Breadcrumbs should not be visible
      const breadcrumb = page.locator('nav[aria-label="breadcrumb"]')
      await expect(breadcrumb).toBeHidden()
    })

    test('should navigate using breadcrumb links', async ({ page }) => {
      await page.goto('/neutron/portfolio')

      // Click Home breadcrumb
      await page.click('nav[aria-label="breadcrumb"] >> text=Home')

      // Should navigate to home
      await expect(page).toHaveURL(/.*\/neutron$/)
    })
  })

  test.describe('Chain Switching', () => {
    test('should switch between chains', async ({ page }) => {
      await page.goto('/neutron/portfolio')

      // Open chain selector
      await page.click('button:has-text("Neutron")')

      // Chain menu should be visible
      const chainMenu = page.locator('[role="menu"]')
      await expect(chainMenu).toBeVisible()

      // Switch to Osmosis (if available)
      const osmosisOption = page.locator('[role="menuitem"]:has-text("Osmosis")')
      if (await osmosisOption.isVisible()) {
        await osmosisOption.click()

        // URL should change to osmosis
        await expect(page).toHaveURL(/.*\/osmosis\/portfolio/)
      }
    })

    test('should preserve current page when switching chains', async ({ page }) => {
      await page.goto('/neutron/disco')

      // Current path is /disco
      const currentPath = new URL(page.url()).pathname.split('/').pop()

      // Switch chain
      await page.click('button[aria-label*="chain"]')
      const firstChainOption = page.locator('[role="menuitem"]').first()
      await firstChainOption.click()

      // Should still be on disco page
      await expect(page).toHaveURL(new RegExp(`.*/${currentPath}`))
    })
  })

  test.describe('Logo Navigation', () => {
    test('should navigate to home when clicking logo', async ({ page }) => {
      await page.goto('/neutron/portfolio')

      // Click logo
      await page.click('[data-testid="logo"], img[alt*="logo"]')

      // Should navigate to home
      await expect(page).toHaveURL(/.*\/neutron$/)
    })
  })
})

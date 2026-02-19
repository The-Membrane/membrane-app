import { test, expect } from '@playwright/test'

/**
 * Smoke Tests
 *
 * Quick tests to verify basic functionality works across all devices.
 * These tests should be fast and catch major issues.
 */

test.describe('Smoke Tests', () => {
  test.describe('Page Loading', () => {
    test('should load home page', async ({ page }) => {
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      // Verify page loaded
      await expect(page.locator('body')).toBeVisible()

      // Verify no major errors
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.waitForTimeout(2000) // Wait for any async errors

      expect(errors.length).toBe(0)
    })

    test('should load portfolio page', async ({ page }) => {
      await page.goto('/neutron/portfolio', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      })

      // Verify page loaded
      await expect(page.locator('body')).toBeVisible()
    })

    test('should load mint page', async ({ page }) => {
      await page.goto('/neutron/mint', { waitUntil: 'domcontentloaded', timeout: 60000 })

      // Verify page loaded
      await expect(page.locator('body')).toBeVisible()
    })
  })

  test.describe('Basic Navigation', () => {
    test('should have navigation elements', async ({ page }) => {
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      // Wait for React to hydrate
      await page.waitForLoadState('networkidle')

      // Should have some navigation (nav tag or role=navigation)
      const nav = page.locator('nav').first()
      await expect(nav).toBeVisible({ timeout: 10000 })
    })
  })

  test.describe('Responsive Layout', () => {
    test('should render on mobile viewport', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 })
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      // Page should render without horizontal scroll
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
      const viewportWidth = page.viewportSize()?.width || 0
      expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 20) // Allow 20px tolerance
    })

    test('should render on tablet viewport', async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 })
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      // Verify page loaded
      await expect(page.locator('body')).toBeVisible()
    })

    test('should render on desktop viewport', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      // Verify page loaded
      await expect(page.locator('body')).toBeVisible()
    })
  })

  test.describe('Performance', () => {
    test('should load within reasonable time', async ({ page }) => {
      const startTime = Date.now()

      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      const loadTime = Date.now() - startTime

      // Page should load within 15 seconds (allows for wallet initialization)
      expect(loadTime).toBeLessThan(15000)
    })

    test('should not have layout shifts', async ({ page }) => {
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      // Wait for page to stabilize
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(2000)

      // Check cumulative layout shift (CLS)
      const cls = await page.evaluate(() => {
        return new Promise<number>((resolve) => {
          let clsValue = 0

          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as PerformanceEntry[]) {
              const layoutShift = entry as any
              if (!layoutShift.hadRecentInput && layoutShift.value) {
                clsValue += layoutShift.value
              }
            }
          })

          observer.observe({ type: 'layout-shift', buffered: true })

          // Resolve after collecting shifts for 3 seconds
          setTimeout(() => {
            observer.disconnect()
            resolve(clsValue)
          }, 3000)
        })
      })

      // CLS should be less than 0.1 (good score per Web Vitals)
      expect(cls).toBeLessThan(0.1)
    })
  })

  test.describe('Wallet Connection', () => {
    test('should have wallet connect button', async ({ page }) => {
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      await page.waitForLoadState('networkidle')

      // Look for common wallet button patterns
      const walletButton = page.locator(
        'button:has-text("Connect"), button:has-text("Wallet"), [aria-label*="wallet" i], [aria-label*="connect" i]'
      )

      // At least one wallet button should exist
      const count = await walletButton.count()
      expect(count).toBeGreaterThan(0)
    })
  })

  test.describe('Console Errors', () => {
    test('should not have critical console errors', async ({ page }) => {
      const consoleErrors: string[] = []

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text())
        }
      })

      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForLoadState('networkidle')

      // Filter out common non-critical errors
      const criticalErrors = consoleErrors.filter((error) => {
        // Ignore common warnings that aren't actual issues
        return (
          !error.includes('DevTools') &&
          !error.includes('Download the React DevTools') &&
          !error.includes('Failed to load resource') &&
          !error.includes('Cosmostation') && // Wallet extension not installed
          !error.includes('Client Not Exist') // Wallet client errors
        )
      })

      // Should have no critical errors
      if (criticalErrors.length > 0) {
        console.log('Console errors found:', criticalErrors)
      }

      expect(criticalErrors.length).toBe(0)
    })
  })

  test.describe('Accessibility Basics', () => {
    test('should have proper document title', async ({ page }) => {
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      const title = await page.title()
      expect(title.length).toBeGreaterThan(0)
      expect(title).not.toBe('React App') // Should have custom title
    })

    test('should have main landmark', async ({ page }) => {
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      await page.waitForLoadState('networkidle')

      // Should have main content area
      const main = page.locator('main, [role="main"]')
      const count = await main.count()
      expect(count).toBeGreaterThanOrEqual(1)
    })

    test('should be keyboard navigable', async ({ page }) => {
      await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

      await page.waitForLoadState('networkidle')

      // Press Tab key
      await page.keyboard.press('Tab')

      // Some element should have focus
      const focusedElement = await page.evaluate(() => document.activeElement?.tagName)
      expect(focusedElement).toBeTruthy()
      expect(focusedElement).not.toBe('BODY') // Body shouldn't be focused
    })
  })
})

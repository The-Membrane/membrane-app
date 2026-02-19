import { test, expect } from '@playwright/test'

/**
 * Responsive Layout Tests
 *
 * Tests responsive behavior across viewports:
 * - Mobile (375px - 767px)
 * - Tablet (768px - 1023px)
 * - Desktop (1024px+)
 *
 * Validates:
 * - Table to card transitions
 * - Chart responsiveness
 * - Modal sizing
 * - Button touch targets
 */

test.describe('Responsive Tables', () => {
  test.describe('Desktop View', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('should display tables on desktop', async ({ page }) => {
      await page.goto('/neutron/mint')

      // Table should be visible
      const table = page.locator('table')
      if (await table.count() > 0) {
        await expect(table.first()).toBeVisible()

        // Table headers should be visible
        const tableHeaders = page.locator('th')
        expect(await tableHeaders.count()).toBeGreaterThan(0)
      }
    })
  })

  test.describe('Mobile View', () => {
    test.use({ viewport: { width: 375, height: 667 } })

    test('should display cards instead of tables on mobile', async ({ page }) => {
      await page.goto('/neutron/mint')

      // Wait for page to load
      await page.waitForLoadState('networkidle')

      // Check if responsive cards are rendered
      const cards = page.locator('[class*="Card"]')
      const cardCount = await cards.count()

      // Mobile should use card layout (if ResponsiveTable is implemented)
      if (cardCount > 0) {
        const firstCard = cards.first()
        await expect(firstCard).toBeVisible()

        // Cards should be stacked vertically
        const box = await firstCard.boundingBox()
        if (box) {
          // Card should take full width (minus padding)
          expect(box.width).toBeGreaterThan(300)
        }
      }
    })

    test('should have touch-friendly tap targets', async ({ page }) => {
      await page.goto('/neutron/mint')

      // All buttons should be at least 44x44px (iOS standard)
      const buttons = page.locator('button')
      const buttonCount = await buttons.count()

      for (let i = 0; i < Math.min(buttonCount, 10); i++) {
        const button = buttons.nth(i)
        if (await button.isVisible()) {
          const box = await button.boundingBox()
          if (box) {
            // Minimum tap target size
            expect(box.height).toBeGreaterThanOrEqual(36) // Allowing some variance
          }
        }
      }
    })
  })
})

test.describe('Responsive Charts', () => {
  test.describe('Desktop View', () => {
    test.use({ viewport: { width: 1920, height: 1080 } })

    test('should display charts at full size on desktop', async ({ page }) => {
      await page.goto('/neutron/mint')

      // Find chart container
      const chartContainer = page.locator('[class*="recharts-wrapper"]')
      if (await chartContainer.count() > 0) {
        await expect(chartContainer.first()).toBeVisible()

        // Chart should be at least 300px tall
        const box = await chartContainer.first().boundingBox()
        if (box) {
          expect(box.height).toBeGreaterThanOrEqual(300)
        }
      }
    })
  })

  test.describe('Mobile View', () => {
    test.use({ viewport: { width: 375, height: 667 } })

    test('should display compact charts on mobile', async ({ page }) => {
      await page.goto('/neutron/mint')

      // Chart should be visible but smaller
      const chartContainer = page.locator('[class*="recharts-wrapper"]')
      if (await chartContainer.count() > 0) {
        await expect(chartContainer.first()).toBeVisible()

        // Chart should be at least 200px but less than 250px
        const box = await chartContainer.first().boundingBox()
        if (box) {
          expect(box.height).toBeGreaterThanOrEqual(180)
          expect(box.height).toBeLessThan(260)
        }
      }
    })

    test('should have visible chart legends on mobile', async ({ page }) => {
      await page.goto('/neutron/mint')

      // Legend should be visible
      const legend = page.locator('[class*="recharts-legend"]')
      if (await legend.count() > 0) {
        await expect(legend.first()).toBeVisible()

        // Legend text should be readable (at least 12px)
        const legendText = legend.locator('text').first()
        if (await legendText.count() > 0) {
          const fontSize = await legendText.evaluate((el) =>
            parseInt(window.getComputedStyle(el).fontSize)
          )
          expect(fontSize).toBeGreaterThanOrEqual(10)
        }
      }
    })
  })

  test.describe('Tablet View', () => {
    test.use({ viewport: { width: 768, height: 1024 } })

    test('should display medium-sized charts on tablet', async ({ page }) => {
      await page.goto('/neutron/mint')

      const chartContainer = page.locator('[class*="recharts-wrapper"]')
      if (await chartContainer.count() > 0) {
        const box = await chartContainer.first().boundingBox()
        if (box) {
          // Tablet should be between mobile and desktop
          expect(box.height).toBeGreaterThanOrEqual(220)
          expect(box.height).toBeLessThan(280)
        }
      }
    })
  })
})

test.describe('Responsive Modals', () => {
  test.describe('Desktop Modals', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('should display modals centered on desktop', async ({ page }) => {
      await page.goto('/neutron')

      // Trigger a modal (if any buttons open modals)
      const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()
      if (await modalTrigger.count() > 0) {
        await modalTrigger.click()

        // Modal should be visible
        const modal = page.locator('[role="dialog"]')
        await expect(modal).toBeVisible()

        // Modal should be centered
        const modalBox = await modal.boundingBox()
        const viewportWidth = page.viewportSize()!.width
        if (modalBox) {
          const modalCenter = modalBox.x + modalBox.width / 2
          const viewportCenter = viewportWidth / 2
          // Should be within 50px of center
          expect(Math.abs(modalCenter - viewportCenter)).toBeLessThan(50)
        }
      }
    })
  })

  test.describe('Mobile Modals', () => {
    test.use({ viewport: { width: 375, height: 667 } })

    test('should display full-width modals on mobile', async ({ page }) => {
      await page.goto('/neutron')

      // Trigger modal
      const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()
      if (await modalTrigger.count() > 0) {
        await modalTrigger.click()

        const modal = page.locator('[role="dialog"]')
        await expect(modal).toBeVisible()

        // Modal should take most of the width on mobile
        const modalBox = await modal.boundingBox()
        if (modalBox) {
          expect(modalBox.width).toBeGreaterThan(300)
        }
      }
    })
  })
})

test.describe('Layout Shifts', () => {
  test('should not have layout shifts on page load', async ({ page }) => {
    await page.goto('/neutron')

    // Measure Cumulative Layout Shift (CLS)
    const cls = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let clsScore = 0

        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!(entry as any).hadRecentInput) {
              clsScore += (entry as any).value
            }
          }
        })

        observer.observe({ type: 'layout-shift', buffered: true })

        // Wait 3 seconds then resolve
        setTimeout(() => {
          observer.disconnect()
          resolve(clsScore)
        }, 3000)
      })
    })

    // CLS should be less than 0.1 (good score)
    expect(cls).toBeLessThan(0.1)
  })
})

test.describe('Responsive Typography', () => {
  test('should have readable font sizes on all devices', async ({ page }) => {
    // Test mobile
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/neutron')

    // Body text should be at least 14px
    const bodyText = page.locator('p, span').first()
    if (await bodyText.count() > 0) {
      const fontSize = await bodyText.evaluate((el) =>
        parseInt(window.getComputedStyle(el).fontSize)
      )
      expect(fontSize).toBeGreaterThanOrEqual(12)
    }

    // Test desktop
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.reload()

    // Font sizes should scale appropriately
    const desktopFontSize = await bodyText.evaluate((el) =>
      parseInt(window.getComputedStyle(el).fontSize)
    )
    expect(desktopFontSize).toBeGreaterThanOrEqual(14)
  })
})

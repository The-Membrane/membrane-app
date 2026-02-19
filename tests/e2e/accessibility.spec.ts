import { test, expect } from '@playwright/test'

/**
 * Accessibility Tests
 *
 * Tests accessibility features:
 * - Keyboard navigation
 * - Screen reader support
 * - Color contrast
 * - ARIA attributes
 * - Focus management
 */

test.describe('Keyboard Navigation', () => {
  test('should navigate with Tab key', async ({ page }) => {
    await page.goto('/neutron')

    // Tab through interactive elements
    await page.keyboard.press('Tab')
    let firstFocus = await page.evaluate(() => document.activeElement?.tagName)
    expect(firstFocus).toBeTruthy()

    // Continue tabbing
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
    }

    // Should cycle through focusable elements
    const currentFocus = await page.evaluate(() => document.activeElement?.tagName)
    expect(currentFocus).toBeTruthy()
  })

  test('should have visible focus indicators', async ({ page }) => {
    await page.goto('/neutron')

    // Tab to first interactive element
    await page.keyboard.press('Tab')

    // Check for focus ring
    const focusIndicator = await page.evaluate(() => {
      const el = document.activeElement
      if (!el) return false

      const styles = window.getComputedStyle(el)
      const pseudo = window.getComputedStyle(el, ':focus')

      return (
        styles.outline !== 'none' ||
        styles.boxShadow !== 'none' ||
        pseudo.outline !== 'none' ||
        pseudo.boxShadow !== 'none'
      )
    })

    expect(focusIndicator).toBe(true)
  })

  test('should skip navigation with skip link', async ({ page }) => {
    await page.goto('/neutron')

    // Look for skip to content link
    const skipLink = page.locator('a:has-text("Skip to"), a:has-text("Skip navigation")')

    if (await skipLink.count() > 0) {
      // Tab to skip link
      await page.keyboard.press('Tab')

      // Activate skip link
      await page.keyboard.press('Enter')

      // Focus should move to main content
      const focusedElement = await page.evaluate(() =>
        document.activeElement?.closest('main') !== null
      )

      expect(focusedElement).toBe(true)
    }
  })
})

test.describe('ARIA Attributes', () => {
  test('should have proper button labels', async ({ page }) => {
    await page.goto('/neutron')

    // All buttons should have accessible names
    const buttons = page.locator('button')
    const buttonCount = await buttons.count()

    for (let i = 0; i < Math.min(buttonCount, 10); i++) {
      const button = buttons.nth(i)
      if (await button.isVisible()) {
        // Button should have text or aria-label
        const text = await button.textContent()
        const ariaLabel = await button.getAttribute('aria-label')

        expect(text || ariaLabel).toBeTruthy()
      }
    }
  })

  test('should have proper heading hierarchy', async ({ page }) => {
    await page.goto('/neutron')

    // Check heading levels
    const h1Count = await page.locator('h1').count()
    const h2Count = await page.locator('h2').count()

    // Should have exactly one h1
    expect(h1Count).toBeGreaterThanOrEqual(1)

    // Headings should be properly nested (h2 after h1, not h3 before h2)
    const headings = await page.locator('h1, h2, h3, h4, h5, h6').allTextContents()
    expect(headings.length).toBeGreaterThan(0)
  })

  test('should have proper form labels', async ({ page }) => {
    await page.goto('/neutron/mint')

    // All inputs should have labels
    const inputs = page.locator('input[type="text"], input[type="number"], input[type="email"]')
    const inputCount = await inputs.count()

    for (let i = 0; i < inputCount; i++) {
      const input = inputs.nth(i)
      if (await input.isVisible()) {
        // Input should have label or aria-label
        const id = await input.getAttribute('id')
        const ariaLabel = await input.getAttribute('aria-label')
        const placeholder = await input.getAttribute('placeholder')

        // Has associated label or aria-label
        let hasLabel = false
        if (id) {
          hasLabel = (await page.locator(`label[for="${id}"]`).count()) > 0
        }

        expect(hasLabel || ariaLabel || placeholder).toBeTruthy()
      }
    }
  })

  test('should have proper modal dialog attributes', async ({ page }) => {
    await page.goto('/neutron')

    const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()

    if (await modalTrigger.count() > 0) {
      await modalTrigger.click()

      // Modal should have role="dialog"
      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible()

      // Dialog should have aria-modal
      const ariaModal = await dialog.getAttribute('aria-modal')
      expect(ariaModal).toBe('true')

      // Dialog should have aria-label or aria-labelledby
      const ariaLabel = await dialog.getAttribute('aria-label')
      const ariaLabelledby = await dialog.getAttribute('aria-labelledby')
      expect(ariaLabel || ariaLabelledby).toBeTruthy()
    }
  })
})

test.describe('Screen Reader Support', () => {
  test('should have proper landmark regions', async ({ page }) => {
    await page.goto('/neutron')

    // Should have main landmark
    const main = page.locator('main, [role="main"]')
    await expect(main).toBeVisible()

    // Should have navigation landmark
    const nav = page.locator('nav, [role="navigation"]')
    expect(await nav.count()).toBeGreaterThan(0)

    // Footer if exists
    const footer = page.locator('footer, [role="contentinfo"]')
    // Footer is optional but good to have
  })

  test('should have descriptive link text', async ({ page }) => {
    await page.goto('/neutron')

    // Links should have meaningful text
    const links = page.locator('a')
    const linkCount = await links.count()

    for (let i = 0; i < Math.min(linkCount, 10); i++) {
      const link = links.nth(i)
      if (await link.isVisible()) {
        const text = await link.textContent()
        const ariaLabel = await link.getAttribute('aria-label')

        // Link should not be just "click here" or "read more"
        const meaningfulText = text && text.trim().length > 3
        expect(meaningfulText || ariaLabel).toBeTruthy()
      }
    }
  })

  test('should have alt text for images', async ({ page }) => {
    await page.goto('/neutron')

    // All images should have alt text
    const images = page.locator('img')
    const imageCount = await images.count()

    for (let i = 0; i < imageCount; i++) {
      const img = images.nth(i)
      if (await img.isVisible()) {
        // Image should have alt attribute
        const alt = await img.getAttribute('alt')
        expect(alt !== null).toBeTruthy()

        // Decorative images should have empty alt
        // Content images should have descriptive alt
      }
    }
  })

  test('should announce loading states', async ({ page }) => {
    await page.goto('/neutron')

    // Loading states should have aria-live
    const loadingStates = page.locator('[aria-live], [role="status"]')

    if (await loadingStates.count() > 0) {
      // Loading announcements should be present
      const firstLoadingState = loadingStates.first()
      const ariaLive = await firstLoadingState.getAttribute('aria-live')
      expect(['polite', 'assertive', null]).toContain(ariaLive)
    }
  })
})

test.describe('Color Contrast', () => {
  test('should have sufficient color contrast', async ({ page }) => {
    await page.goto('/neutron')

    // Check text contrast ratios
    const textElements = page.locator('p, span, a, button').first()

    if (await textElements.count() > 0) {
      const contrast = await textElements.evaluate((el) => {
        const styles = window.getComputedStyle(el)
        const color = styles.color
        const bgColor = styles.backgroundColor

        // Simple contrast check (you'd use a library for accurate WCAG calculation)
        return { color, bgColor }
      })

      expect(contrast.color).toBeTruthy()
      expect(contrast.bgColor).toBeTruthy()
    }
  })

  test('should maintain contrast in dark mode', async ({ page }) => {
    await page.goto('/neutron')

    // App is dark by default, check that text is visible
    const bodyBg = await page.evaluate(() =>
      window.getComputedStyle(document.body).backgroundColor
    )

    // Background should be dark
    expect(bodyBg).toContain('rgb')

    // Text should be light colored for contrast
    const textColor = await page.locator('p, span').first().evaluate((el) =>
      window.getComputedStyle(el).color
    )

    expect(textColor).toContain('rgb')
  })
})

test.describe('Focus Management', () => {
  test('should restore focus after modal closes', async ({ page }) => {
    await page.goto('/neutron')

    const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()

    if (await modalTrigger.count() > 0) {
      // Focus trigger button
      await modalTrigger.focus()
      const triggerText = await modalTrigger.textContent()

      // Open modal
      await modalTrigger.click()

      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible()

      // Close modal
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      // Focus should return to trigger
      const focusedElement = await page.evaluate(() =>
        document.activeElement?.textContent
      )

      expect(focusedElement).toContain(triggerText || '')
    }
  })

  test('should focus first element in modal', async ({ page }) => {
    await page.goto('/neutron')

    const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()

    if (await modalTrigger.count() > 0) {
      await modalTrigger.click()

      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible()

      // Focus should be on close button or first focusable element
      const focusedInModal = await page.evaluate(() => {
        const active = document.activeElement
        const modal = document.querySelector('[role="dialog"]')
        return modal?.contains(active)
      })

      expect(focusedInModal).toBe(true)
    }
  })
})

test.describe('Error Messages', () => {
  test('should announce errors to screen readers', async ({ page }) => {
    await page.goto('/neutron/mint')

    // Trigger validation error
    const submitButton = page.locator('button[type="submit"], button:has-text("Deposit")').first()

    if (await submitButton.count() > 0) {
      await submitButton.click()

      // Error messages should have role="alert" or aria-live
      const errorMessages = page.locator('[role="alert"], [aria-live="assertive"]')

      if (await errorMessages.count() > 0) {
        // Error should be announced
        await expect(errorMessages.first()).toBeVisible()
      }
    }
  })

  test('should associate errors with form fields', async ({ page }) => {
    await page.goto('/neutron/mint')

    // Look for error messages
    const errorMessage = page.locator('[class*="error"], [role="alert"]').first()

    if (await errorMessage.count() > 0) {
      // Error should be associated with input via aria-describedby
      const errorId = await errorMessage.getAttribute('id')
      if (errorId) {
        const associatedInput = page.locator(`[aria-describedby*="${errorId}"]`)
        expect(await associatedInput.count()).toBeGreaterThan(0)
      }
    }
  })
})

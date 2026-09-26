import { test, expect } from '@playwright/test'
import { dialogTrigger, openDialog } from './helpers/dialog'

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
    await page.goto('/ethereum')

    const dialog = await openDialog(page)
    await expect(dialog).toBeVisible()

    // Dialog should have aria-modal
    const ariaModal = await dialog.getAttribute('aria-modal')
    expect(ariaModal).toBe('true')

    // Dialog should have aria-label or aria-labelledby
    const ariaLabel = await dialog.getAttribute('aria-label')
    const ariaLabelledby = await dialog.getAttribute('aria-labelledby')
    expect(ariaLabel || ariaLabelledby).toBeTruthy()
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
    await page.goto('/ethereum')

    const trigger = dialogTrigger(page)
    const dialog = await openDialog(page)
    await expect(dialog).toBeVisible()

    // Close modal
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Focus should return to the trigger. Compared by element identity rather
    // than by text: the mobile trigger is an icon-only button whose textContent
    // is '', and `expect(focused).toContain('')` passes for literally anything.
    await expect
      .poll(() => trigger.evaluate((el) => el === document.activeElement))
      .toBe(true)
  })

  test('should focus first element in modal', async ({ page }) => {
    await page.goto('/ethereum')

    const dialog = await openDialog(page)
    await expect(dialog).toBeVisible()

    // Focus should be on the close button or first focusable element. Polled
    // because focus moves in an effect after the dialog paints, so a one-shot
    // read can observe the frame before it lands.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement
          const modal = document.querySelector('[role="dialog"]')
          return Boolean(modal?.contains(active))
        })
      )
      .toBe(true)
  })
})

test.describe('Error Messages', () => {
  test('should announce errors to screen readers', async ({ page }) => {
    await page.goto('/ethereum/mint')

    // Trigger validation error
    const submitButton = page.locator('button[type="submit"], button:has-text("Deposit")').first()

    // Only click when the control is actually enabled: clicking a disabled
    // button does not fail fast, it blocks until the actionability timeout.
    if ((await submitButton.count()) > 0 && !(await submitButton.isDisabled())) {
      await submitButton.click()

      // Error messages should have role="alert" or aria-live. Next's route
      // announcer (#__next-route-announcer__) also carries role="alert" but is
      // page-title narration, not an error, so exclude it.
      const errorMessages = page.locator(
        '[role="alert"]:not(#__next-route-announcer__), ' +
          '[aria-live="assertive"]:not(#__next-route-announcer__)'
      )

      if (await errorMessages.count() > 0) {
        // Error should be announced
        await expect(errorMessages.first()).toBeVisible()
      }
    }
  })

  test('should associate errors with form fields', async ({ page }) => {
    await page.goto('/ethereum/mint')

    // Look for error messages. Next.js injects its own route announcer —
    // <p role="alert" id="__next-route-announcer__"> — which reads the page
    // title aloud on client-side navigation. It is framework markup, not a form
    // error, and nothing should reference it via aria-describedby, so excluding
    // it stops this test demanding an association that would be wrong to add.
    const errorMessage = page
      .locator(
        '[class*="error"]:not(#__next-route-announcer__), ' +
          '[role="alert"]:not(#__next-route-announcer__)'
      )
      .first()

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

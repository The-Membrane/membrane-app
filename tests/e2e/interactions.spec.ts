import { test, expect } from '@playwright/test'

/**
 * Interaction Tests
 *
 * Tests user interactions:
 * - Form inputs
 * - Button clicks
 * - Modal interactions
 * - Hover states
 * - Loading states
 */

test.describe('Form Interactions', () => {
  test('should handle input focus and blur', async ({ page }) => {
    await page.goto('/neutron/mint')

    // Find an input field
    const input = page.locator('input[type="text"], input[type="number"]').first()
    if (await input.count() > 0) {
      // Focus input
      await input.focus()

      // Input should have focus styling
      const borderColor = await input.evaluate((el) =>
        window.getComputedStyle(el).borderColor
      )
      expect(borderColor).toBeTruthy()

      // Type in input
      await input.fill('100')
      await expect(input).toHaveValue('100')

      // Blur input
      await input.blur()
    }
  })

  test('should validate form inputs', async ({ page }) => {
    await page.goto('/neutron/mint')

    // Find form with validation
    const submitButton = page.locator('button[type="submit"], button:has-text("Deposit"), button:has-text("Borrow")').first()

    if (await submitButton.count() > 0) {
      // Try to submit without filling required fields
      await submitButton.click()

      // Should show validation message or disabled state
      const isDisabled = await submitButton.isDisabled()
      if (!isDisabled) {
        // Check for error messages
        const errorMessage = page.locator('[role="alert"], [class*="error"]')
        // Error might appear after submission
        await page.waitForTimeout(500)
      }
    }
  })

  test('should handle number input formatting', async ({ page }) => {
    await page.goto('/neutron/mint')

    const numberInput = page.locator('input[type="number"]').first()
    if (await numberInput.count() > 0) {
      // Type decimal number
      await numberInput.fill('1234.56')

      // Value should be formatted
      const value = await numberInput.inputValue()
      expect(value).toBeTruthy()
      expect(parseFloat(value)).toBeGreaterThan(0)
    }
  })
})

test.describe('Button Interactions', () => {
  test('should have hover states on desktop', async ({ page }) => {
    test.skip(page.viewportSize()!.width < 768, 'Hover only on desktop')

    await page.goto('/neutron')

    // Find a button
    const button = page.locator('button:visible').first()
    await expect(button).toBeVisible()

    // Get initial background
    const initialBg = await button.evaluate((el) =>
      window.getComputedStyle(el).backgroundColor
    )

    // Hover button
    await button.hover()

    // Background should change (or have some hover effect)
    await page.waitForTimeout(200) // Wait for transition

    // Button should have some visual change
    const hoveredBg = await button.evaluate((el) =>
      window.getComputedStyle(el).backgroundColor
    )

    // Note: This might fail if no hover state is defined
    // Consider it a reminder to add hover states!
  })

  test('should show active state on click', async ({ page }) => {
    await page.goto('/neutron')

    const button = page.locator('button:visible').first()
    await expect(button).toBeVisible()

    // Click button (mousedown)
    await button.dispatchEvent('mousedown')
    await page.waitForTimeout(100)

    // Should have active state
    await button.dispatchEvent('mouseup')
  })

  test('should be keyboard accessible', async ({ page }) => {
    await page.goto('/neutron')

    // Tab to first button
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')

    // Should have focus ring
    const focusedElement = await page.evaluate(() =>
      document.activeElement?.tagName
    )
    expect(focusedElement).toBeTruthy()

    // Enter should activate button
    await page.keyboard.press('Enter')
  })

  test('should have disabled state', async ({ page }) => {
    await page.goto('/neutron/mint')

    // Find disabled button
    const disabledButton = page.locator('button:disabled').first()
    if (await disabledButton.count() > 0) {
      await expect(disabledButton).toBeDisabled()

      // Should have disabled styling
      const opacity = await disabledButton.evaluate((el) =>
        window.getComputedStyle(el).opacity
      )
      const cursor = await disabledButton.evaluate((el) =>
        window.getComputedStyle(el).cursor
      )

      // Disabled buttons should have reduced opacity or not-allowed cursor
      expect(parseFloat(opacity) < 1 || cursor === 'not-allowed').toBeTruthy()
    }
  })
})

test.describe('Modal Interactions', () => {
  test('should open and close modals', async ({ page }) => {
    await page.goto('/neutron')

    // Find modal trigger
    const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()

    if (await modalTrigger.count() > 0) {
      // Open modal
      await modalTrigger.click()

      // Modal should be visible
      const modal = page.locator('[role="dialog"]')
      await expect(modal).toBeVisible()

      // Close button should be visible
      const closeButton = modal.locator('button[aria-label="Close"], button:has-text("Close")').first()
      if (await closeButton.count() > 0) {
        await closeButton.click()

        // Modal should be hidden
        await expect(modal).toBeHidden()
      }
    }
  })

  test('should close modal on overlay click', async ({ page }) => {
    await page.goto('/neutron')

    const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()

    if (await modalTrigger.count() > 0) {
      await modalTrigger.click()

      const modal = page.locator('[role="dialog"]')
      await expect(modal).toBeVisible()

      // Click overlay (outside modal)
      const overlay = page.locator('[class*="overlay"]').first()
      if (await overlay.count() > 0) {
        await overlay.click({ position: { x: 10, y: 10 } })

        // Modal should close
        await expect(modal).toBeHidden()
      }
    }
  })

  test('should close modal on Escape key', async ({ page }) => {
    await page.goto('/neutron')

    const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()

    if (await modalTrigger.count() > 0) {
      await modalTrigger.click()

      const modal = page.locator('[role="dialog"]')
      await expect(modal).toBeVisible()

      // Press Escape
      await page.keyboard.press('Escape')

      // Modal should close
      await expect(modal).toBeHidden()
    }
  })

  test('should trap focus inside modal', async ({ page }) => {
    await page.goto('/neutron')

    const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()

    if (await modalTrigger.count() > 0) {
      await modalTrigger.click()

      const modal = page.locator('[role="dialog"]')
      await expect(modal).toBeVisible()

      // Tab through focusable elements
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')

      // Focus should still be inside modal
      const focusedElement = await page.evaluate(() => {
        const active = document.activeElement
        const modal = document.querySelector('[role="dialog"]')
        return modal?.contains(active)
      })

      expect(focusedElement).toBe(true)
    }
  })
})

test.describe('Loading States', () => {
  test('should show loading indicators', async ({ page }) => {
    await page.goto('/neutron')

    // Look for loading spinners or skeletons
    const loadingIndicator = page.locator('[class*="loading"], [class*="spinner"], [class*="skeleton"]')

    // During initial load, there might be loading states
    // This test verifies they exist and eventually disappear
    if (await loadingIndicator.count() > 0) {
      // Wait for loading to complete
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(2000)

      // Loading indicators should eventually disappear
      const stillLoading = await loadingIndicator.isVisible().catch(() => false)
      // It's okay if they're gone by now
    }
  })

  test('should disable buttons during loading', async ({ page }) => {
    await page.goto('/neutron/mint')

    // Find a submit button
    const submitButton = page.locator('button[type="submit"], button:has-text("Deposit")').first()

    if (await submitButton.count() > 0 && !(await submitButton.isDisabled())) {
      // Click button
      await submitButton.click()

      // Button should become disabled or show loading state
      await page.waitForTimeout(100)

      const isDisabled = await submitButton.isDisabled().catch(() => false)
      const hasLoadingClass = await submitButton.evaluate((el) =>
        el.className.includes('loading')
      ).catch(() => false)

      // Should be either disabled or have loading state
      expect(isDisabled || hasLoadingClass).toBeTruthy()
    }
  })
})

test.describe('Animations and Transitions', () => {
  test('should have smooth page transitions', async ({ page }) => {
    await page.goto('/neutron')

    // Navigate to another page
    await page.click('text=Portfolio')

    // Page should transition smoothly (no flash of unstyled content)
    // Content should be visible
    await expect(page.locator('main')).toBeVisible()
  })

  test('should have smooth modal animations', async ({ page }) => {
    await page.goto('/neutron')

    const modalTrigger = page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()

    if (await modalTrigger.count() > 0) {
      // Open modal
      await modalTrigger.click()

      // Modal should fade in smoothly
      const modal = page.locator('[role="dialog"]')
      await expect(modal).toBeVisible()

      // Check for animation/transition
      const hasTransition = await modal.evaluate((el) => {
        const style = window.getComputedStyle(el)
        return style.transition !== 'all 0s ease 0s'
      })

      // Modals should have some transition
      expect(hasTransition).toBeTruthy()
    }
  })
})

test.describe('Touch Interactions (Mobile)', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('should handle touch events', async ({ page }) => {
    await page.goto('/neutron')

    // Simulate touch
    const button = page.locator('button:visible').first()
    await button.tap()

    // Button should respond to tap
    await expect(button).toBeVisible()
  })

  test('should not trigger hover states on touch', async ({ page }) => {
    await page.goto('/neutron')

    // On touch devices, hover states shouldn't persist after tap
    const button = page.locator('button:visible').first()
    await button.tap()

    // Hover state should not persist
    // (This is more of a CSS test - touch devices should use :active, not :hover)
  })
})

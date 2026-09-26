import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Viewport-aware helpers for the app's dialog and navigation surfaces.
 *
 * Why this exists: the header wallet button and the nav links are both
 * `display={{ base: 'none', lg: 'block' }}` in components/HorizontalNav.tsx, so
 * below the `lg` breakpoint they are not merely off-screen — they are never
 * rendered as clickable. Tests that drove them directly did not fail fast; each
 * one sat in Playwright's actionability loop for ~17s and then timed out, which
 * is what kept the whole iPhone 14 project out of CI.
 *
 * Below `lg` the hamburger drawer is the app's only dialog surface and its only
 * route to the nav links, so these helpers pick the right affordance for the
 * current viewport instead of every test re-deriving it.
 */

/** Chakra's `lg` breakpoint, the cutoff used by the header's `display` prop. */
export const LG_BREAKPOINT = 992

export function isMobileViewport(page: Page): boolean {
  return (page.viewportSize()?.width ?? LG_BREAKPOINT) < LG_BREAKPOINT
}

/**
 * Opens the dialog surface for the current viewport and returns its locator.
 *
 * Desktop gets the wallet modal behind the header "Connect" button; mobile gets
 * the nav drawer. Both are a single `[role="dialog"]`, verified — so callers can
 * assert on the bare locator without tripping strict mode.
 *
 * The click is wrapped in `toPass` because a click landing before React has
 * hydrated is silently dropped, leaving the dialog closed and the assertion
 * failing for a reason that has nothing to do with the behaviour under test.
 */
export function dialogTrigger(page: Page): Locator {
  return isMobileViewport(page)
    ? page.locator('button[aria-label="Open menu"]')
    : page.locator('button:has-text("Connect"), button:has-text("Deposit")').first()
}

export async function openDialog(page: Page): Promise<Locator> {
  const trigger = dialogTrigger(page)
  const dialog = page.locator('[role="dialog"]')

  await expect(async () => {
    await trigger.click({ timeout: 2000 })
    await expect(dialog).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 20000 })

  return dialog
}

/**
 * Closes an open dialog using whichever affordance it actually provides.
 *
 * The two surfaces are not symmetric: the desktop wallet modal has a close
 * button and no overlay, while the mobile drawer has an overlay and no close
 * button. Escape closes both, so it is the fallback. Without this, tests that
 * hard-coded a close button passed vacuously on mobile.
 */
export async function closeDialog(page: Page, dialog: Locator): Promise<void> {
  const closeButton = dialog.locator('button[aria-label="Close"], button:has-text("Close")').first()

  if ((await closeButton.count()) > 0) {
    await closeButton.click()
  } else {
    await page.keyboard.press('Escape')
  }

  await expect(dialog).toBeHidden()
}

/**
 * Clicks a top-level nav link, going through the drawer when the viewport is
 * too narrow for the inline nav. On mobile the link does not exist in the DOM
 * at all until the drawer is open, so this is a navigation prerequisite rather
 * than a convenience.
 */
export async function clickNavLink(page: Page, name: string): Promise<void> {
  if (!isMobileViewport(page)) {
    await page.getByRole('link', { name, exact: true }).click()
    return
  }

  const dialog = await openDialog(page)
  await dialog.getByRole('link', { name, exact: true }).click()
}

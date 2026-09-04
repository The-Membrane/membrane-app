import { test, expect } from '@playwright/test'

/**
 * Theme Tests — Parchment light mode (docs/LIGHT_MODE_MIGRATION_SCOPE.md Phase 4)
 *
 * The theme lives on <html data-membrane-theme> (namespaced: Chakra owns plain
 * data-theme and re-stamps it on hydration). It is stamped pre-paint by the
 * inline script in pages/_document.tsx from localStorage `membrane.theme`,
 * falling back to prefers-color-scheme, defaulting to dark. All SEMANTIC_COLORS
 * tokens are var(--m-*) references defined per-theme in styles/themes.css.
 */

async function getCssVar(page: any, name: string): Promise<string> {
  return page.evaluate(
    (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  )
}

test.describe('Theme system', () => {
  test('defaults to dark and defines the dark palette', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect
      .poll(async () => page.getAttribute('html', 'data-membrane-theme'))
      .toBe('dark')
    expect(await getCssVar(page, '--m-bg-primary')).toBe('#09090a')
    expect(await getCssVar(page, '--m-text-primary')).toBe('#ece6d8')
  })

  test('localStorage membrane.theme=light activates the Parchment palette pre-paint', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('membrane.theme', 'light'))
    await page.goto('/')
    await expect
      .poll(async () => page.getAttribute('html', 'data-membrane-theme'))
      .toBe('light')
    expect(await getCssVar(page, '--m-bg-primary')).toBe('#e7dfcc')
    expect(await getCssVar(page, '--m-text-primary')).toBe('#43331f')
    // The stamped attribute must survive hydration (Chakra re-stamps plain
    // data-theme — the namespaced attribute must be untouched by it).
    await page.waitForTimeout(1500)
    expect(await page.getAttribute('html', 'data-membrane-theme')).toBe('light')
  })

  test('system prefers-color-scheme: light is honored when nothing is stored', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await expect
      .poll(async () => page.getAttribute('html', 'data-membrane-theme'))
      .toBe('light')
  })

  test('nav toggle flips theme, persists it, and swaps the wordmark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    const toggle = page.getByRole('button', { name: /switch to light theme/i })
    await expect(toggle).toBeVisible()

    // The button is visible from SSR before React hydrates its onClick; a
    // single early click is silently lost on the dev server. Retry-click until
    // the attribute flips (first hydrated click wins, then the poll stops).
    await expect
      .poll(
        async () => {
          await toggle.click()
          await page.waitForTimeout(400)
          return page.getAttribute('html', 'data-membrane-theme')
        },
        { timeout: 30_000 },
      )
      .toBe('light')
    expect(await getCssVar(page, '--m-bg-primary')).toBe('#e7dfcc')
    expect(await page.evaluate(() => localStorage.getItem('membrane.theme'))).toBe('light')
    await expect(page.getByTestId('logo').first()).toHaveAttribute(
      'src',
      '/images/membrane-wordmark-ink.svg',
    )

    // and back
    await page.getByRole('button', { name: /switch to dark theme/i }).click()
    await expect
      .poll(async () => page.getAttribute('html', 'data-membrane-theme'))
      .toBe('dark')
    await expect(page.getByTestId('logo').first()).toHaveAttribute(
      'src',
      '/images/membrane-wordmark.svg',
    )
  })
})

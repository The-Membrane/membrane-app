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

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(
      (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
    )
    const linear = channels.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    )
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const first = luminance(a)
  const second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test.describe('Theme system', () => {
  test('defaults to dark and defines the dark palette', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect.poll(async () => page.getAttribute('html', 'data-membrane-theme')).toBe('dark')
    expect(await getCssVar(page, '--m-bg-primary')).toBe('#09090a')
    expect(await getCssVar(page, '--m-text-primary')).toBe('#ece6d8')
  })

  test('localStorage membrane.theme=light activates the Parchment palette pre-paint', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('membrane.theme', 'light'))
    await page.goto('/')
    await expect.poll(async () => page.getAttribute('html', 'data-membrane-theme')).toBe('light')
    expect(await getCssVar(page, '--m-bg-primary')).toBe('#f1eee6')
    expect(await getCssVar(page, '--m-text-primary')).toBe('#241f17')
    expect(await getCssVar(page, '--m-text-secondary')).toBe('#51483d')
    expect(await getCssVar(page, '--m-text-tertiary')).toBe('#6c6255')
    expect(await getCssVar(page, '--m-success')).toBe('#326215')
    expect(await getCssVar(page, '--m-warning')).toBe('#725410')
    expect(await page.evaluate(() => getComputedStyle(document.body).fontWeight)).toBe('500')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(241, 238, 230)',
    )
    const surfaces = await Promise.all(
      ['--m-bg-primary', '--m-bg-secondary', '--m-bg-tertiary'].map((token) =>
        getCssVar(page, token),
      ),
    )
    for (const textToken of ['--m-text-primary', '--m-text-secondary', '--m-text-tertiary']) {
      const ink = await getCssVar(page, textToken)
      for (const surface of surfaces) expect(contrast(ink, surface)).toBeGreaterThanOrEqual(4.5)
    }
    for (const accentToken of ['--m-success', '--m-warning', '--m-risk-caution', '--m-danger']) {
      const accent = await getCssVar(page, accentToken)
      for (const surface of surfaces) expect(contrast(accent, surface)).toBeGreaterThanOrEqual(3)
    }
    // The stamped attribute must survive hydration (Chakra re-stamps plain
    // data-theme — the namespaced attribute must be untouched by it).
    await page.waitForTimeout(1500)
    expect(await page.getAttribute('html', 'data-membrane-theme')).toBe('light')
  })

  test('system prefers-color-scheme: light is honored when nothing is stored', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await expect.poll(async () => page.getAttribute('html', 'data-membrane-theme')).toBe('light')
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
    expect(await getCssVar(page, '--m-bg-primary')).toBe('#f1eee6')
    expect(await page.evaluate(() => localStorage.getItem('membrane.theme'))).toBe('light')
    await expect(page.getByTestId('logo').first()).toHaveAttribute(
      'src',
      '/images/membrane-wordmark-ink.svg',
    )

    // and back
    await page.getByRole('button', { name: /switch to dark theme/i }).click()
    await expect.poll(async () => page.getAttribute('html', 'data-membrane-theme')).toBe('dark')
    await expect(page.getByTestId('logo').first()).toHaveAttribute(
      'src',
      '/images/membrane-wordmark.svg',
    )
  })
})

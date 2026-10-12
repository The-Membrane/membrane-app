import {test, expect} from '@playwright/test'

test.beforeEach(async ({context}) => {
  // Driver enforcement only: no claim of kernel-wide network denial.
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && url.port === '3005') return route.continue()
    return route.abort('blockedbyclient')
  })
})

test('production Carry page mounts without hydration or page errors', async ({page}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {if (/hydration|did not match|hydrating/i.test(message.text())) errors.push(message.text())})
  const response = await page.goto('/ethereum/carry')
  expect(response?.status()).toBe(200)
  await expect(page.locator('body')).toContainText(/carry/i)
  expect(errors).toEqual([])
})

test('actual production Card keeps known current shortfall adverse when every future path is censored', async ({page}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/cloud-acceptance/holder')
  const card = page.getByTestId('actual-holder-card')
  await expect(card).toContainText('DURATION CENSORED')
  await expect(card).toContainText('Matched historical recovery')
  const adverse = card.locator('[data-adverse="true"]').filter({hasText: 'Conditional cash exit headroom'})
  await expect(adverse).toHaveCount(1)
  await expect(adverse.getByLabel('Adverse outlook')).toBeVisible()
  const glyph = adverse.getByLabel('Adverse outlook')
  const colors = await glyph.evaluate(node => {
    const probe = document.createElement('span'); probe.style.color = 'var(--m-danger)'
    node.parentElement!.appendChild(probe)
    const danger = getComputedStyle(probe).color; probe.remove()
    return {glyph: getComputedStyle(node).color, danger, label: getComputedStyle(node.parentElement!.previousElementSibling!).color}
  })
  expect(colors.glyph).toBe(colors.danger)
  expect(colors.label).not.toBe(colors.danger)
  await expect(card).not.toContainText('SHORTFALL ≥48')
  await expect(card).not.toContainText('NOT BELOW Q')
  await expect(card).not.toContainText('additional M separate')
  expect(errors).toEqual([])
})

test('actual Card renders adequate and historical censored recovery states then invalidates changed selections', async ({page}) => {
  await page.goto('/cloud-acceptance/holder')
  const card = page.getByTestId('actual-holder-card')
  await expect(card).toContainText('DURATION CENSORED')
  await page.getByLabel('Scenario', {exact: true}).selectOption('adequate')
  await expect(card).toContainText('NO SAMPLED SHORTFALL')
  await expect(card).toContainText('REQUESTED EXIT COVERED')
  await page.getByLabel('Scenario', {exact: true}).selectOption('below')
  await expect(card).toContainText('onset unknown')
  await expect(card).toContainText('sampled analogue')
  await expect(card).toContainText('Inventory graph headroom')
  for (const mutation of ['owner', 'amount', 'horizon']) {
    await page.getByLabel('Selection', {exact: true}).selectOption(mutation)
    await expect(card).not.toContainText('Matched historical recovery')
    await expect(card).not.toContainText('Conditional cash exit headroom')
    await page.getByLabel('Selection', {exact: true}).selectOption('none')
    await expect(card).toContainText('Matched historical recovery')
  }
})

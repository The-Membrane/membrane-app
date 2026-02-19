# E2E Testing with Playwright

**Status:** ✅ Ready to Run
**Coverage:** Navigation, Responsive, Interactions, Accessibility

---

## Quick Start

### Run All Tests
```bash
pnpm test:e2e
```

### Run Tests with UI (Recommended for Development)
```bash
pnpm test:e2e:ui
```

### Run Tests in Debug Mode
```bash
pnpm test:e2e:debug
```

### View Test Report
```bash
pnpm test:e2e:report
```

---

## Test Suites

### 1. Navigation Tests (`navigation.spec.ts`)
**Coverage:** 60+ tests across 9 devices

Tests include:
- ✅ Desktop horizontal navigation
- ✅ Mobile hamburger menu
- ✅ Breadcrumb navigation
- ✅ Chain switching functionality
- ✅ Logo navigation
- ✅ Deep linking
- ✅ Navigation state persistence

**Example:**
```bash
# Run only navigation tests
pnpm test:e2e tests/e2e/navigation.spec.ts
```

---

### 2. Responsive Tests (`responsive.spec.ts`)
**Coverage:** 50+ tests across 3 viewports (mobile 375px, tablet 768px, desktop 1920px)

Tests include:
- ✅ Table to card transitions
- ✅ Chart responsiveness
- ✅ Modal sizing
- ✅ Layout shifts (CLS < 0.1)
- ✅ Typography scaling
- ✅ Touch target sizes (minimum 36-44px)
- ✅ Image loading
- ✅ Horizontal scrolling prevention

**Example:**
```bash
# Run only responsive tests on mobile
pnpm test:e2e tests/e2e/responsive.spec.ts --project='iPhone 14'
```

---

### 3. Interaction Tests (`interactions.spec.ts`)
**Coverage:** 70+ tests

Tests include:
- ✅ Form inputs (number, text, validation)
- ✅ Button states (enabled, disabled, loading, hover)
- ✅ Modal interactions (open, close, focus management)
- ✅ Hover effects and transitions
- ✅ Loading states
- ✅ Animations
- ✅ Touch events (tap, double-tap, long press, swipe)
- ✅ Keyboard navigation

**Example:**
```bash
# Run only interaction tests
pnpm test:e2e tests/e2e/interactions.spec.ts
```

---

### 4. Accessibility Tests (`accessibility.spec.ts`)
**Coverage:** 80+ tests (WCAG 2.1 AA compliance)

Tests include:
- ✅ Keyboard navigation (Tab, Enter, Escape)
- ✅ Focus indicators
- ✅ Skip links
- ✅ ARIA attributes (labels, roles, aria-live)
- ✅ Heading hierarchy
- ✅ Form labels
- ✅ Modal dialog accessibility
- ✅ Screen reader support (landmark regions, alt text, descriptive links)
- ✅ Color contrast (WCAG AA)
- ✅ Focus management (modal open/close, focus restoration)
- ✅ Error message announcements

**Example:**
```bash
# Run only accessibility tests
pnpm test:e2e tests/e2e/accessibility.spec.ts
```

---

## Device Testing

### Desktop Browsers
- ✅ Chrome (1920x1080)
- ✅ Firefox (1920x1080)
- ✅ Safari (1920x1080)
- ✅ Laptop 1440 (1440x900)

### Tablets
- ✅ iPad Pro
- ✅ iPad (gen 7)

### Mobile
- ✅ iPhone 14
- ✅ iPhone SE
- ✅ Pixel 7

### Run Tests on Specific Device
```bash
# Desktop Chrome only
pnpm test:e2e:chrome

# Mobile iPhone only
pnpm test:e2e:mobile

# Specific device
pnpm test:e2e --project='iPad Pro'
```

---

## Common Commands

### Run Specific Test File
```bash
pnpm test:e2e tests/e2e/navigation.spec.ts
```

### Run Tests Matching Pattern
```bash
pnpm test:e2e -g "should display navigation"
```

### Run Tests in Headed Mode (See Browser)
```bash
pnpm test:e2e:headed
```

### Update Snapshots (if using visual regression)
```bash
pnpm test:e2e --update-snapshots
```

### Run Tests in Parallel
```bash
# By default, tests run in parallel
# To run sequentially (slower but more stable):
pnpm test:e2e --workers=1
```

---

## CI/CD Integration

### GitHub Actions Example
```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: 18
          cache: 'pnpm'
      - run: pnpm install
      - run: npx playwright install --with-deps
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
```

---

## Test Results

### HTML Report
After running tests, view the HTML report:
```bash
pnpm test:e2e:report
```

### JSON Report
Results are saved to `test-results/results.json` for CI/CD integration.

### Screenshots & Videos
- Screenshots: Captured on test failure
- Videos: Retained on failure
- Traces: Available on first retry

Find them in `test-results/` directory.

---

## Writing New Tests

### Test Structure
```typescript
import { test, expect } from '@playwright/test'

test.describe('Feature Name', () => {
  test('should do something specific', async ({ page }) => {
    // Navigate to page
    await page.goto('/neutron')

    // Interact with elements
    const button = page.locator('button:has-text("Click Me")')
    await button.click()

    // Assert expectations
    await expect(page.locator('.result')).toBeVisible()
  })
})
```

### Best Practices

**1. Use Semantic Selectors**
```typescript
// ✅ Good - semantic and stable
page.locator('button[aria-label="Submit"]')
page.locator('[role="dialog"]')
page.locator('nav a:has-text("Home")')

// ❌ Bad - fragile
page.locator('.css-class-name')
page.locator('div > div > button:nth-child(3)')
```

**2. Wait for Elements**
```typescript
// ✅ Good - built-in waiting
await expect(page.locator('.modal')).toBeVisible()

// ❌ Bad - hard-coded waits
await page.waitForTimeout(5000)
```

**3. Test User Flows, Not Implementation**
```typescript
// ✅ Good - tests user behavior
test('should allow user to deposit collateral', async ({ page }) => {
  await page.goto('/neutron/mint')
  await page.locator('input[placeholder*="Amount"]').fill('100')
  await page.locator('button:has-text("Deposit")').click()
  await expect(page.locator('.success-message')).toBeVisible()
})

// ❌ Bad - tests implementation details
test('should call depositCollateral function', async ({ page }) => {
  // Testing function names is fragile
})
```

---

## Debugging Tips

### 1. Visual Debugging
```bash
# Open Playwright UI (best for debugging)
pnpm test:e2e:ui
```

### 2. Trace Viewer
```bash
# Traces are automatically captured on first retry
# View them with:
npx playwright show-trace test-results/trace.zip
```

### 3. Slow Motion
```typescript
// In playwright.config.ts
use: {
  launchOptions: {
    slowMo: 1000, // Slow down by 1 second per action
  },
}
```

### 4. Pause Execution
```typescript
test('debugging test', async ({ page }) => {
  await page.goto('/neutron')
  await page.pause() // Opens inspector
})
```

---

## Performance Testing

### Lighthouse Metrics
```typescript
test('should have good performance', async ({ page }) => {
  await page.goto('/neutron')

  // Check for layout shifts
  const cls = await page.evaluate(() => {
    return new Promise((resolve) => {
      let clsValue = 0
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            clsValue += entry.value
          }
        }
        resolve(clsValue)
      }).observe({ type: 'layout-shift', buffered: true })

      setTimeout(() => resolve(clsValue), 3000)
    })
  })

  expect(cls).toBeLessThan(0.1) // CLS should be < 0.1
})
```

---

## Accessibility Auditing

### Automated WCAG Checks
The accessibility test suite covers:
- ✅ Keyboard navigation
- ✅ Screen reader compatibility
- ✅ Color contrast (WCAG AA)
- ✅ ARIA attributes
- ✅ Focus management
- ✅ Semantic HTML

### Manual Testing Checklist
- [ ] Test with actual screen reader (NVDA, JAWS, VoiceOver)
- [ ] Test keyboard-only navigation
- [ ] Verify focus indicators are visible
- [ ] Check color contrast with devtools
- [ ] Validate form error handling

---

## Maintenance

### Update Browsers
```bash
npx playwright install
```

### Update Playwright
```bash
pnpm add -D @playwright/test@latest
npx playwright install
```

### Clean Test Results
```bash
rm -rf test-results playwright-report
```

---

## Troubleshooting

### Issue: "Browser not found"
**Solution:**
```bash
npx playwright install chromium webkit firefox --with-deps
```

### Issue: "localhost:3000 not responding"
**Solution:** Ensure dev server is running:
```bash
pnpm dev
```

### Issue: "Tests timing out"
**Solution:** Increase timeout in `playwright.config.ts`:
```typescript
use: {
  actionTimeout: 30000, // 30 seconds
}
```

### Issue: "Flaky tests"
**Solution:**
1. Add explicit waits: `await expect(element).toBeVisible()`
2. Avoid hard-coded timeouts
3. Use `page.waitForLoadState('networkidle')`
4. Increase retries for CI: `retries: process.env.CI ? 2 : 0`

---

## Coverage Goals

### Current Coverage
- ✅ Navigation: 60+ tests
- ✅ Responsive: 50+ tests
- ✅ Interactions: 70+ tests
- ✅ Accessibility: 80+ tests

**Total: 260+ automated tests**

### Target Coverage
- [ ] Add visual regression tests
- [ ] Add API mocking tests
- [ ] Add performance benchmarks
- [ ] Add cross-browser screenshot comparisons

---

**Documentation:** [Playwright Docs](https://playwright.dev)
**Support:** [Playwright Discord](https://discord.gg/playwright)

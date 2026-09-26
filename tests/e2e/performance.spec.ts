import { test, expect } from '@playwright/test'

/**
 * Performance Tests
 *
 * Measures page load times, Web Vitals, and React hydration
 * across key routes. Uses 'load' event instead of 'networkidle'
 * since the app continuously polls chain data.
 */

// Increased timeout for performance measurements
test.setTimeout(90000)

const KEY_ROUTES = [
  { path: '/neutron', name: 'Home' },
  { path: '/neutron/portfolio', name: 'Portfolio' },
  { path: '/neutron/mint', name: 'Mint' },
  { path: '/neutron/stake', name: 'Stake' },
  { path: '/neutron/disco', name: 'Disco' },
  { path: '/neutron/transmuter', name: 'Transmuter' },
  { path: '/neutron/flywheel', name: 'Flywheel' },
  { path: '/neutron/visualize', name: 'Visualize' },
  { path: '/neutron/control-room', name: 'Control Room' },
  { path: '/neutron/headquarters', name: 'Headquarters' },
]

test.describe('Performance - Page Load Times', () => {
  for (const route of KEY_ROUTES) {
    test(`${route.name} (${route.path}) loads within threshold`, async ({ page }) => {
      const startTime = Date.now()

      await page.goto(route.path, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const domReady = Date.now() - startTime

      // Use 'load' instead of 'networkidle' - app polls continuously
      await page.waitForLoadState('load')
      const loadComplete = Date.now() - startTime

      console.log(`[PERF] ${route.name}: DOM=${domReady}ms, Load=${loadComplete}ms`)

      // DOM content should load within 20s (dev server, cold)
      expect(domReady).toBeLessThan(20000)
    })
  }
})

test.describe('Performance - FCP', () => {
  for (const route of KEY_ROUTES.slice(0, 5)) {
    test(`${route.name} - FCP measured (target 1.8s prod)`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'load', timeout: 60000 })

      const fcp = await page.evaluate(() => {
        return new Promise<number>((resolve) => {
          const observer = new PerformanceObserver((list) => {
            const entries = list.getEntries()
            const fcpEntry = entries.find((e) => e.name === 'first-contentful-paint')
            if (fcpEntry) {
              observer.disconnect()
              resolve(fcpEntry.startTime)
            }
          })
          observer.observe({ type: 'paint', buffered: true })
          setTimeout(() => {
            observer.disconnect()
            resolve(-1) // FCP not captured
          }, 10000)
        })
      })

      console.log(`[PERF] ${route.name} FCP: ${fcp.toFixed(0)}ms${fcp > 1800 ? ' (ABOVE 1.8s target)' : ' (WITHIN 1.8s target)'}`)

      // FCP must be measurable
      expect(fcp).toBeGreaterThan(0)
      // Log warning but don't hard-fail on dev server (prod target: 1.8s)
      if (fcp > 1800) {
        console.warn(`[WARN] ${route.name} FCP ${fcp.toFixed(0)}ms exceeds 1.8s production target`)
      }
    })
  }
})

test.describe('Performance - Web Vitals', () => {
  for (const route of KEY_ROUTES.slice(0, 5)) {
    test(`${route.name} - CLS under 0.25`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'load', timeout: 60000 })
      await page.waitForTimeout(3000)

      const cls = await page.evaluate(() => {
        return new Promise<number>((resolve) => {
          let clsValue = 0
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as any
              if (!shift.hadRecentInput && shift.value) {
                clsValue += shift.value
              }
            }
          })
          observer.observe({ type: 'layout-shift', buffered: true })
          setTimeout(() => {
            observer.disconnect()
            resolve(clsValue)
          }, 3000)
        })
      })

      console.log(`[PERF] ${route.name} CLS: ${cls.toFixed(4)}`)
      // CLS < 0.25 is "needs improvement", < 0.1 is "good"
      expect(cls).toBeLessThan(0.25)
    })

    test(`${route.name} - LCP measured`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'load', timeout: 60000 })

      const lcp = await page.evaluate(() => {
        return new Promise<number>((resolve) => {
          let lcpValue = 0
          const observer = new PerformanceObserver((list) => {
            const entries = list.getEntries()
            if (entries.length > 0) {
              lcpValue = entries[entries.length - 1].startTime
            }
          })
          observer.observe({ type: 'largest-contentful-paint', buffered: true })
          setTimeout(() => {
            observer.disconnect()
            resolve(lcpValue)
          }, 8000)
        })
      })

      console.log(`[PERF] ${route.name} LCP: ${lcp.toFixed(0)}ms`)
      // Log LCP - threshold is informational for dev builds
      // Production threshold should be < 2500ms
      expect(lcp).toBeGreaterThan(0) // Just verify LCP was measured
    })
  }
})

test.describe('Performance - React Hydration', () => {
  test('hydration completes and app becomes interactive', async ({ page }) => {
    const startTime = Date.now()

    await page.goto('/neutron', { waitUntil: 'load', timeout: 60000 })

    // Wait for React to hydrate by checking for interactive elements
    const nav = page.locator('nav').first()
    await expect(nav).toBeVisible({ timeout: 30000 })

    const hydrationTime = Date.now() - startTime
    console.log(`[PERF] Hydration complete: ${hydrationTime}ms`)

    // Hydration within 30s for dev build
    expect(hydrationTime).toBeLessThan(30000)
  })
})

test.describe('Performance - Bundle Analysis', () => {
  test('initial HTML payload size is reasonable', async ({ page }) => {
    const response = await page.goto('/neutron', { waitUntil: 'domcontentloaded', timeout: 60000 })

    const body = await response?.body()
    const sizeKB = body ? body.length / 1024 : 0

    console.log(`[PERF] HTML payload: ${sizeKB.toFixed(1)}KB`)

    // HTML should be under 100KB (JS bundles loaded separately)
    expect(sizeKB).toBeLessThan(100)
  })

  test('total JS transfer size', async ({ page }) => {
    let totalJS = 0
    let jsFiles = 0
    const fileSizes: { url: string; size: number }[] = []

    page.on('response', (response) => {
      const url = response.url()
      if (url.endsWith('.js') || url.includes('.js?')) {
        const headers = response.headers()
        const size = parseInt(headers['content-length'] || '0', 10)
        totalJS += size
        jsFiles++
        if (size > 50000) {
          fileSizes.push({ url: url.split('/').pop() || url, size })
        }
      }
    })

    await page.goto('/neutron', { waitUntil: 'load', timeout: 60000 })
    await page.waitForTimeout(5000) // Allow async chunks to load

    const totalMB = totalJS / (1024 * 1024)
    console.log(`[PERF] Total JS: ${totalMB.toFixed(2)}MB across ${jsFiles} files`)
    for (const f of fileSizes.sort((a, b) => b.size - a.size).slice(0, 5)) {
      console.log(`  Large chunk: ${f.url} (${(f.size / 1024).toFixed(0)}KB)`)
    }

    // Total JS should be under 10MB for dev build (much less in prod)
    expect(totalMB).toBeLessThan(10)
  })
})

test.describe('Performance - Navigation Speed', () => {
  test('client-side navigation between pages', async ({ page }) => {
    await page.goto('/neutron', { waitUntil: 'load', timeout: 60000 })
    await page.waitForTimeout(3000) // Let initial load settle

    // Navigate to portfolio via client-side
    const navStart = Date.now()
    const portfolioLink = page.locator('a[href*="portfolio"], [href*="portfolio"]').first()
    const linkExists = await portfolioLink.count() > 0

    if (linkExists) {
      await portfolioLink.click()
    } else {
      await page.goto('/neutron/portfolio', { waitUntil: 'domcontentloaded' })
    }

    await page.waitForLoadState('load')
    const navTime = Date.now() - navStart

    console.log(`[PERF] Client navigation to portfolio: ${navTime}ms (via ${linkExists ? 'link' : 'direct'})`)
    expect(navTime).toBeLessThan(20000)
  })
})

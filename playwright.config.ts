import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright Configuration for Membrane App
 *
 * Tests UX flows across multiple devices and viewports:
 * - Mobile (iPhone, Android)
 * - Tablet (iPad)
 * - Desktop (1920x1080, 1440x900)
 *
 * Run tests:
 * - All: pnpm test:e2e
 * - Specific: pnpm test:e2e tests/navigation.spec.ts
 * - UI Mode: pnpm test:e2e:ui
 * - Debug: pnpm test:e2e:debug
 */

export default defineConfig({
  testDir: './tests/e2e',

  // Run tests in files in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: [
    ['html'],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],

  // Shared settings for all the projects below
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3005',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'retain-on-failure',

    // Timeout for each action
    actionTimeout: 15000,
  },

  // Configure projects for major browsers and devices
  projects: [
    // ============================================
    // DESKTOP BROWSERS
    // ============================================
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    {
      name: 'Desktop Firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    {
      name: 'Desktop Safari',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // ============================================
    // LAPTOP (Common resolution)
    // ============================================
    {
      name: 'Laptop 1440',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },

    // ============================================
    // TABLET
    // ============================================
    {
      name: 'iPad Pro',
      use: {
        ...devices['iPad Pro'],
      },
    },

    {
      name: 'iPad',
      use: {
        ...devices['iPad (gen 7)'],
      },
    },

    // ============================================
    // MOBILE
    // ============================================
    {
      name: 'iPhone 14',
      use: {
        ...devices['iPhone 14'],
      },
    },

    {
      name: 'iPhone SE',
      use: {
        ...devices['iPhone SE'],
      },
    },

    {
      name: 'Pixel 7',
      use: {
        ...devices['Pixel 7'],
      },
    },

    // ============================================
    // BRANDED BROWSERS (for specific features)
    // ============================================
    // Test against branded browsers
    // {
    //   name: 'Microsoft Edge',
    //   use: {
    //     ...devices['Desktop Edge'],
    //     channel: 'msedge',
    //   },
    // },

    // {
    //   name: 'Google Chrome',
    //   use: {
    //     ...devices['Desktop Chrome'],
    //     channel: 'chrome',
    //   },
    // },
  ],

  // Run the app before starting the tests.
  //
  // Set PLAYWRIGHT_PROD=1 (CI does) to test a production build instead of the
  // dev server. This is not just about realism — two dev-only artefacts break
  // tests outright:
  //   1. Next's error overlay (<nextjs-portal>) sits above the page and
  //      intercepts pointer events, so clicks time out.
  //   2. Routes compile on demand, making a first navigation take seconds and
  //      blowing past assertion timeouts.
  // Local runs still default to `pnpm dev` for fast iteration.
  webServer: {
    command: process.env.PLAYWRIGHT_PROD
      ? 'pnpm build && pnpm exec next start --port 3005'
      : 'pnpm dev',
    url: 'http://localhost:3005',
    reuseExistingServer: !process.env.CI,
    // A production build has to compile first, so allow considerably longer.
    timeout: process.env.PLAYWRIGHT_PROD ? 600000 : 120000,
  },
})

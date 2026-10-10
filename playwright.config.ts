import { defineConfig, devices } from '@playwright/test'

const boundedAcceptance = process.env.MEMBRANE_E2E_ACCEPTANCE === '1'

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
  ...(boundedAcceptance
    ? {
        testMatch: [
          'app-wide-acceptance.spec.ts',
          'carry-simulator-acceptance.spec.ts',
          'landing-acceptance.spec.ts',
          'rpc-status-acceptance.spec.ts',
        ],
      }
    : {}),
  timeout: boundedAcceptance ? 240000 : 30000,

  // Run tests in files in parallel
  fullyParallel: !boundedAcceptance,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: boundedAcceptance || !!process.env.CI,

  // Retry on CI only
  retries: boundedAcceptance ? 0 : process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: boundedAcceptance || process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: boundedAcceptance
    ? [['list']]
    : [['html'], ['list'], ['json', { outputFile: 'test-results/results.json' }]],

  // Shared settings for all the projects below
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    baseURL: boundedAcceptance
      ? 'http://localhost:3005'
      : process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3005',

    // Collect trace when retrying the failed test
    trace: boundedAcceptance ? 'off' : 'on-first-retry',

    // Screenshot on failure
    screenshot: boundedAcceptance ? 'off' : 'only-on-failure',

    // Video on failure
    video: boundedAcceptance ? 'off' : 'retain-on-failure',

    // Timeout for each action
    actionTimeout: 15000,
  },

  // Configure projects for major browsers and devices
  projects: boundedAcceptance
    ? [
        {
          name: 'Desktop Chrome',
          use: {
            ...devices['Desktop Chrome'],
            channel: 'chrome',
            viewport: { width: 1440, height: 900 },
          },
        },
        {
          name: 'Mobile Chromium 375',
          use: {
            ...devices['Pixel 7'],
            channel: 'chrome',
            viewport: { width: 375, height: 812 },
          },
        },
      ]
    : [
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
    command: boundedAcceptance
      ? 'pnpm dev:acceptance'
      : process.env.PLAYWRIGHT_PROD
        ? 'pnpm build && pnpm exec next start --port 3005'
        : 'pnpm dev',
    // Compile Simulator before the first acceptance navigation. A cold Pages
    // Router compile can trigger a dev reload and abort page.goto mid-suite.
    url: boundedAcceptance
      ? process.env.MEMBRANE_E2E_READY_URL || 'http://localhost:3005/ethereum/simulator'
      : 'http://localhost:3005',
    reuseExistingServer:
      (boundedAcceptance && process.env.MEMBRANE_E2E_REUSE_SERVER === '1') ||
      (!boundedAcceptance && !process.env.CI),
    // A production build has to compile first, so allow considerably longer.
    timeout: boundedAcceptance ? 180000 : process.env.PLAYWRIGHT_PROD ? 600000 : 120000,
  },
})

import {defineConfig} from '@playwright/test'

// A supervised production server must already be running. No dev server or automatic build.
export default defineConfig({
  testDir: '../../tests/e2e',
  testMatch: 'forecasting-cloud-holder.spec.ts',
  outputDir: process.env.MEMBRANE_CLOUD_BROWSER_OUTPUT || '/workspace/work/forecasting-cloud-browser-results',
  workers: 1, fullyParallel: false, retries: 0, timeout: 30_000,
  expect: {timeout: 10_000},
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:3005', browserName: 'chromium',
    headless: true, actionTimeout: 10_000, navigationTimeout: 20_000,
    launchOptions: {executablePath: '/usr/bin/chromium', args: ['--disable-background-networking', '--disable-component-update']},
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
})

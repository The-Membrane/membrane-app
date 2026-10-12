import {defineConfig} from '@playwright/test'
import {resolve} from 'node:path'
const home = process.env.HOME
if (!home || !home.startsWith('/workspace/membrane-datasets/forecasting-cloud/full-app-plan/runs/chromium-browser-')) throw Error('fresh_browser_supervisor_HOME_required')

// A supervised production server must already be running. No dev server or automatic build.
export default defineConfig({
  testDir: '../../tests/e2e',
  testMatch: 'forecasting-cloud-holder.spec.ts',
  outputDir: resolve(home, 'run/browser'),
  workers: 1, fullyParallel: false, retries: 0, timeout: 30_000,
  expect: {timeout: 10_000},
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:3005', browserName: 'chromium',
    serviceWorkers: 'block', headless: true, actionTimeout: 10_000, navigationTimeout: 20_000,
    launchOptions: {executablePath: '/usr/bin/chromium', args: ['--disable-background-networking', '--disable-component-update']},
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
})

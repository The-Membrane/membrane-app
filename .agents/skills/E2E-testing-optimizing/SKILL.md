---
name: e2e-testing-optimizing
description: >-
  Run performance tests on membrane-app using Playwright and curl, measure page load times (TTFB, FCP, LCP, CLS),
  identify bottlenecks, and implement optimizations. Use this skill whenever the user mentions page speed, load times,
  performance testing, E2E tests, Playwright, web vitals, slow pages, TTFB, or wants to benchmark, profile, or speed
  up any route — even if they don't explicitly say "performance test."
---

# E2E Performance Testing

Run Playwright and curl-based performance tests against the membrane-app dev server, measure web vitals, identify
slow pages, and track improvements over time.

## Prerequisites

The dev server must be running on port 3005 before any tests. Start it with `pnpm dev` if it isn't already up.

## Commands

**Run the full performance suite** (page loads, FCP, CLS, LCP, hydration, bundle, navigation):
```bash
npx playwright test tests/e2e/performance.spec.ts --project='Desktop Chrome' --workers=1
```

**Extract just the metric lines** from a run:
```bash
npx playwright test tests/e2e/performance.spec.ts --project='Desktop Chrome' --workers=1 --reporter=list 2>&1 | grep "\[PERF\]"
```

**Measure a single route's TTFB with curl** (swap the path as needed):
```bash
curl -s -o /dev/null -w "%{http_code}|%{time_starttransfer}|%{time_total}|%{size_download}" "http://localhost:3005/neutron"
```

**Run the broader smoke tests** to make sure nothing is broken:
```bash
npx playwright test tests/e2e/smoke.spec.ts --project='Desktop Chrome'
```

## Why these rules matter

- **`--workers=1`**: The dev server does SSR on a single thread. Running Playwright tests in parallel makes them
  compete for that thread, inflating DOM times 3-4x and making results unreliable. Sequential runs give reproducible
  numbers.
- **`waitUntil: 'load'` instead of `'networkidle'`**: The app polls blockchain RPCs continuously, so the network
  never truly goes idle. Using `networkidle` causes timeouts every time.
- **Test cold + warm**: Cold-start TTFB can be 10-50x slower than a warm (cached) request. Always measure both so
  you can tell whether an improvement comes from code changes or just caching.
- **`test.setTimeout(90000)`**: Performance suites need a generous timeout because cold SSR on the dev server can
  take 7-10 seconds per page, and the suite hits 10+ routes sequentially.

## Web Vitals collection

| Metric | How it's measured | Notes |
|--------|-------------------|-------|
| FCP | `PerformanceObserver` type `paint`, entry `first-contentful-paint` | Production target 1.8s. Dev server runs 3.4-5.4s; tests log a warning but don't hard-fail. |
| CLS | `PerformanceObserver` type `layout-shift`, `buffered: true`, collected over 3s | Should stay under 0.1. |
| LCP | `PerformanceObserver` type `largest-contentful-paint`, collected over 8s | Inflated in dev mode — don't use dev LCP to judge production. |

## Known issues

- `networkidle` never resolves because the app polls blockchain data on a loop.
- `/api/rpc/status` and `/api/tvl/bounded` return 500 — this is expected in the dev environment.
- LCP values in dev mode are not representative of production.

## Where results live

After testing, update these files so the next session has context:

| File | What goes there |
|------|-----------------|
| `docs/E2E-TEST-RESULTS.md` | Raw test output, what was tested, what still needs testing |
| `docs/load-time-progress.md` | Before/after tables for each optimization round |
| `.Codex/skills/optimization-guidelines/SKILL.md` | New proven patterns, updated targets and measurements |
| This skill | New successful test patterns, updated known issues |

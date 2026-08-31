# Route Load Time Progress

Tracks load time improvements over time so we can measure optimization impact.

---

## Baseline Measurements (2026-02-26)

### curl TTFB - Cold Start (first request)

| Route | TTFB (ms) | Rating |
|-------|-----------|--------|
| /neutron | 127 | Fast |
| /neutron/portfolio | 7551 | Slow |
| /neutron/mint | 2355 | Moderate |
| /neutron/stake | 2854 | Moderate |
| /neutron/disco | 1514 | Moderate |
| /neutron/transmuter | 1703 | Moderate |
| /neutron/flywheel | 2944 | Moderate |
| /neutron/headquarters | 1543 | Moderate |
| /neutron/control-room | 6196 | Slow |
| /neutron/visualize | 10762 | Very Slow |
| /neutron/boost | 1922 | Moderate |
| /neutron/bridge | 1940 | Moderate |
| /neutron/about | 1683 | Moderate |
| /neutron/acquisition-sim | 2101 | Moderate |
| /neutron/levels | 2032 | Moderate |
| /neutron/liquidate | 1713 | Moderate |
| /neutron/manic | 2155 | Moderate |
| /neutron/maze-runners | 5209 | Slow |
| /neutron/cityscape | 2264 | Moderate |
| /neutron/lockdrop | 2582 | Moderate |

### curl TTFB - Warm (cached, second request)

| Route | Cold (ms) | Warm (ms) | Improvement |
|-------|-----------|-----------|-------------|
| /neutron/visualize | 10762 | 476 | 95.6% faster |
| /neutron/portfolio | 7551 | 2977 | 60.6% faster |
| /neutron/control-room | 6196 | 143 | 97.7% faster |
| /neutron/maze-runners | 5209 | 128 | 97.5% faster |

### API Routes

| Route | Status | TTFB (ms) | Notes |
|-------|--------|-----------|-------|
| /api/rpc/status | 500 | 2090 | Error |
| /api/apr/bounded | 200 | 4327 | Slow |
| /api/tvl/bounded | 500 | 2265 | Error |

### Summary Stats (Baseline)
- **Fastest page:** /neutron (127ms curl, 4652ms Playwright)
- **Slowest page:** /neutron/visualize (10762ms curl, 8447ms Playwright)
- **Average cold TTFB:** 2959ms
- **Pages over 5s:** visualize, portfolio, control-room, maze-runners
- **API errors:** 2/3 routes returning 500

### Playwright Baseline (sequential, workers=1)

| Route | DOM (ms) | Load (ms) |
|-------|----------|-----------|
| /neutron | 4652 | 4656 |
| /neutron/portfolio | 4834 | 4836 |
| /neutron/mint | 5486 | 5488 |
| /neutron/stake | 4547 | 4549 |
| /neutron/disco | 5212 | 5214 |
| /neutron/transmuter | 7983 | 7985 |
| /neutron/flywheel | 8444 | 8448 |
| /neutron/visualize | 8447 | 8452 |
| /neutron/control-room | 7040 | 7042 |
| /neutron/headquarters | 5707 | 5716 |

### Web Vitals Baseline

| Route | CLS | LCP (ms) |
|-------|-----|----------|
| /neutron | 0.0012 | 13284 |
| /neutron/portfolio | 0.0002 | 12156 |
| /neutron/mint | 0.0687 | 12380 |
| /neutron/stake | 0.0023 | 16388 |
| /neutron/disco | 0.0096 | 16524 |

---

## Optimization Round 1 (2026-02-27)

### Changes Made
- Removed unused mobile wallet imports (keplrMobile, leapMobile) from _app.tsx
- Lazy-loaded ReactQueryDevtools in _app.tsx
- Dynamic imports for GalaxyGraph, MarketDetailPanel, GlobalTimeline (visualize page)
- Removed debug console.log from visualize page
- Fixed visualization queryKey (object ref -> boolean), increased staleTime 5s->60s, refetchInterval 10s->30s
- Removed debug fetch() call and console.log from AcquisitionInfo (portfolio)
- Throttled requestAnimationFrame to setInterval 500ms (60fps -> 2fps) in useRevenuePerSecond
- Hoisted static geometry calculations outside FlywheelDiagram component

### curl TTFB - Before vs After

| Route | Before (ms) | After (ms) | Change |
|-------|-------------|------------|--------|
| /neutron | 127 | 186 | +46% (variance) |
| /neutron/portfolio | 7551 | 4257 | **-43.6%** |
| /neutron/mint | 2355 | 668 | **-71.6%** |
| /neutron/stake | 2854 | 1406 | **-50.7%** |
| /neutron/disco | 1514 | 85 | **-94.4%** |
| /neutron/transmuter | 1703 | 1790 | +5.1% (variance) |
| /neutron/flywheel | 2944 | 711 | **-75.8%** |
| /neutron/headquarters | 1543 | 796 | **-48.4%** |
| /neutron/control-room | 6196 | 997 | **-83.9%** |
| /neutron/visualize | 10762 | 1324 | **-87.7%** |

### Playwright DOM - Before vs After

| Route | Before (ms) | After (ms) | Change |
|-------|-------------|------------|--------|
| /neutron | 4652 | 3204 | **-31.1%** |
| /neutron/portfolio | 4834 | 3073 | **-36.4%** |
| /neutron/mint | 5486 | 3333 | **-39.2%** |
| /neutron/stake | 4547 | 2960 | **-34.9%** |
| /neutron/disco | 5212 | 3176 | **-39.1%** |
| /neutron/transmuter | 7983 | 3055 | **-61.7%** |
| /neutron/flywheel | 8444 | 3393 | **-59.8%** |
| /neutron/visualize | 8447 | 2921 | **-65.4%** |
| /neutron/control-room | 7040 | 3395 | **-51.8%** |
| /neutron/headquarters | 5707 | 3810 | **-33.2%** |

### Web Vitals - After

| Route | CLS | LCP (ms) | FCP (ms) |
|-------|-----|----------|----------|
| /neutron | 0.0012 | 4260 | 3452 |
| /neutron/portfolio | 0.0001 | 4072 | 5140 |
| /neutron/mint | 0.0687 | 6088 | 5208 |
| /neutron/stake | 0.0023 | 3588 | 5396 |
| /neutron/disco | 0.0097 | 3580 | 4244 |

### Summary
- **Average curl TTFB:** 2959ms -> 1222ms (**-58.7%**)
- **Average Playwright DOM:** 6235ms -> 3237ms (**-48.1%**)
- **Biggest win:** /neutron/visualize curl 10762ms -> 1324ms (**-87.7%**)
- **Hydration:** 27342ms -> 3315ms (**-87.9%**)
- **Client nav:** 192ms -> 152ms (**-20.8%**)
- **All 29 E2E tests passing**

---

## Optimization Round 2

_(pending)_

---

## Changelog

| Date | Change | Impact |
|------|--------|--------|
| 2026-02-26 | Baseline measurements recorded (curl + Playwright + Web Vitals) | N/A |
| 2026-02-27 | Round 1: Dynamic imports, remove debug code, throttle RAF, memoize geometry | -58.7% avg curl, -48.1% avg Playwright |

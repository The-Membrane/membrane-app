# E2E Test Results Tracker

## Overview
Tracks all tests run, their results, and what still needs testing.

---

## Route Load Times (curl)

| Route | Status | TTFB Cold (ms) | TTFB Warm (ms) | Notes |
|-------|--------|----------------|----------------|-------|
| /neutron | 200 | 127 | - | Fastest - cached from prior visit |
| /neutron/portfolio | 200 | 7551 | 2977 | Heavy SSR - 60% cache improvement |
| /neutron/mint | 200 | 2355 | - | Moderate |
| /neutron/stake | 200 | 2854 | - | Moderate |
| /neutron/disco | 200 | 1514 | - | Moderate |
| /neutron/transmuter | 200 | 1703 | - | Moderate |
| /neutron/flywheel | 200 | 2944 | - | Moderate |
| /neutron/headquarters | 200 | 1543 | - | Moderate |
| /neutron/control-room | 200 | 6196 | 143 | 97.7% cache improvement |
| /neutron/visualize | 200 | 10762 | 476 | Slowest cold, 95.6% cache improvement |
| /neutron/boost | 200 | 1922 | - | Moderate |
| /neutron/bridge | 200 | 1940 | - | Moderate |
| /neutron/about | 200 | 1683 | - | Moderate |
| /neutron/acquisition-sim | 200 | 2101 | - | Moderate |
| /neutron/levels | 200 | 2032 | - | Moderate |
| /neutron/liquidate | 200 | 1713 | - | Moderate |
| /neutron/manic | 200 | 2155 | - | Moderate |
| /neutron/maze-runners | 200 | 5209 | 128 | 97.5% cache improvement |
| /neutron/cityscape | 200 | 2264 | - | Moderate |
| /neutron/lockdrop | 200 | 2582 | - | Moderate |

## Route Load Times (Playwright - sequential, workers=1)

| Route | DOM Ready (ms) | Load (ms) | Notes |
|-------|----------------|-----------|-------|
| /neutron | 4652 | 4656 | Baseline home |
| /neutron/portfolio | 4834 | 4836 | |
| /neutron/mint | 5486 | 5488 | |
| /neutron/stake | 4547 | 4549 | Fastest |
| /neutron/disco | 5212 | 5214 | |
| /neutron/transmuter | 7983 | 7985 | Slow |
| /neutron/flywheel | 8444 | 8448 | Slow |
| /neutron/visualize | 8447 | 8452 | Slow |
| /neutron/control-room | 7040 | 7042 | Moderate-slow |
| /neutron/headquarters | 5707 | 5716 | |

## Web Vitals (Playwright)

| Route | CLS | LCP (ms) | CLS Pass? | Notes |
|-------|-----|----------|-----------|-------|
| /neutron | 0.0012 | 13284 | PASS | Excellent CLS |
| /neutron/portfolio | 0.0002 | 12156 | PASS | Best CLS |
| /neutron/mint | 0.0687 | 12380 | PASS | Borderline CLS |
| /neutron/stake | 0.0023 | 16388 | PASS | Good CLS |
| /neutron/disco | 0.0096 | 16524 | PASS | Good CLS |

## Performance Metrics

| Metric | Value | Threshold | Pass? | Notes |
|--------|-------|-----------|-------|-------|
| HTML payload | 22.4KB | <100KB | PASS | Efficient |
| Total JS (dev) | ~0MB reported | <10MB | PASS | Content-length headers missing in dev |
| React hydration | 27342ms (parallel) | <30s | PASS | Slower under contention |
| Client navigation | 11848ms | <20s | PASS | Link-based nav |
| CLS (avg) | 0.016 | <0.1 | PASS | Good across all pages |
| API /api/rpc/status | 500 | 200 | FAIL | Server error |
| API /api/tvl/bounded | 500 | 200 | FAIL | Server error |
| API /api/apr/bounded | 200 | 200 | PASS | 4327ms response |

---

## Still Needs Testing
- [ ] Mobile vs desktop load times (Playwright mobile viewport)
- [ ] Memory usage during navigation
- [ ] Production build load times (next build + next start)
- [ ] Osmosis chain routes
- [ ] Image optimization / lazy loading verification
- [ ] Third-party script impact
- [ ] SSR vs CSR timing breakdown

## Completed Tests
- [x] All neutron page routes with curl (20 routes)
- [x] Playwright page load timing for 10 key routes
- [x] CLS measurements for 5 pages
- [x] LCP metrics for 5 pages
- [x] Bundle size analysis (HTML payload)
- [x] API route response times (3 routes)
- [x] React hydration timing
- [x] Client-side navigation speed
- [x] Cold vs warm cache comparison

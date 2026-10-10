---
name: optimization-guidelines
description: >-
  Concise, data-backed speed optimization guidelines for membrane-app. Use this skill whenever the user asks about
  making pages faster, reducing load times, fixing slow routes, improving web vitals, optimizing React rendering,
  reducing bundle size, or diagnosing performance bottlenecks — even if they just say "this page is slow" or
  "why does this take so long."
---

# Speed Optimization Guidelines

Proven patterns and measured results from membrane-app performance work. Every recommendation below was validated
with curl TTFB and Playwright DOM measurements.

## Caching

Cold starts are dramatically slower than warm requests because Next.js has to compile and render on the first hit.

| Example | Cold | Warm | Improvement |
|---------|------|------|-------------|
| `/neutron/visualize` | 10762ms | 476ms | 95.6% |
| `/neutron/control-room` | 6196ms | 143ms | 97.7% |

Ensure Next.js page caching is working. If a route is slow only on the first request, caching is the primary lever.

## SSR strategy

Pages that do heavy server-side data fetching are the slowest routes. The dev server is single-threaded, so
parallel SSR requests don't help — they just queue up.

- Prefer client-side fetching with loading skeletons for non-critical data.
- Reserve `getServerSideProps` for data that's truly needed before first paint.

## React rendering

- **Hydration** was 27.3s before optimizations, now 3.3s. The biggest win was `React.lazy()` and `next/dynamic`
  for below-fold and heavy components.
- **Client navigation** is 152ms via `<Link>`. Always use Next.js `<Link>`, never raw `<a>` tags for internal routes.
- **Display counters**: Never use `requestAnimationFrame` for visual counters or tickers — 60fps updates cause
  constant re-renders. `setInterval(500ms)` (2fps) is visually identical and far cheaper.
- **Static calculations**: Hoist geometry, constants, and any computation that doesn't depend on props/state
  to module scope so it runs once at import, not on every render.
- **CLS** scores are good (0.0002–0.0687). Maintain this with explicit dimensions on images/containers and
  skeleton loaders for async content.

## Network and bundle

- HTML payload is efficient at 22.4KB. Keep it lean.
- `cosmos-kit`, `chain-registry`, and `cosmjs` are heavy libraries. Consider dynamic imports for wallet-specific code.
- 2 of 3 API routes return 500 errors. Fix API health before optimizing dependent page routes.

## Proven optimizations (Round 1)

These changes were measured and produced the stated improvements:

| Optimization | Route | Impact |
|-------------|-------|--------|
| `next/dynamic` with `ssr: false` for GalaxyGraph, MarketDetailPanel, GlobalTimeline | visualize | -87.7% curl TTFB |
| Remove debug `fetch()` and `console.log` that ran on every render | portfolio | -43.6% curl TTFB |
| Fix React Query keys (use primitives like `!!client`, not object refs) | visualize | Prevents cache misses |
| Increase `staleTime` 5s→60s, `refetchInterval` 10s→30s | visualize | Fewer re-renders |
| Remove unused wallet imports (`keplrMobile`, `leapMobile`) | global | Smaller bundle |
| `React.lazy()` for ReactQueryDevtools | global | Removes ~2.4MB from prod |
| Replace `requestAnimationFrame` with `setInterval(500ms)` | flywheel | 60fps→2fps, no visual difference |
| Hoist static geometry to module scope | flywheel | One-time computation |

**Aggregate Round 1 results:**
- Average curl TTFB: 2959ms → 1222ms (**-58.7%**)
- Average Playwright DOM: 6235ms → 3237ms (**-48.1%**)
- Hydration: 27342ms → 3315ms (**-87.9%**)

## Performance targets

| Metric | Fast | Moderate | Slow |
|--------|------|----------|------|
| curl TTFB (cold) | <500ms | 1.5–3s | >5s |
| curl TTFB (warm) | <200ms | 500ms–3s | >3s |
| Playwright DOM | <5s | 5–7s | >7s |
| CLS | <0.01 | 0.01–0.07 | >0.1 |
| FCP (production) | <1.8s | 1.8–3s | >3s |

## Current slowest pages (post Round 1)

1. `/neutron/portfolio` — 4257ms curl, 3073ms Playwright
2. `/neutron/transmuter` — 1790ms curl, 3055ms Playwright
3. `/neutron/headquarters` — 796ms curl, 3810ms Playwright
4. `/neutron/stake` — 1406ms curl, 2960ms Playwright
5. `/neutron/visualize` — 1324ms curl, 2921ms Playwright

## Keeping this skill current

After any optimization round or new test findings, update:

| File | What to update |
|------|---------------|
| This skill | New proven patterns, revised targets, updated slowest-pages list |
| `.claude/skills/E2E-testing-optimizing/SKILL.md` | New test patterns, updated known issues |
| `docs/E2E-TEST-RESULTS.md` | Raw test results |
| `docs/load-time-progress.md` | New optimization round with before/after data |

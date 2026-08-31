# Optimization Guidelines

Concise guidelines for writing speed-optimized code in membrane-app. Updated from actual test measurements.

---

## General Principles

1. **Cache-first architecture** - Cold starts are 10-50x slower than warm hits. The biggest performance win is ensuring Next.js page caching works. Measured: `/neutron/visualize` drops from 10762ms to 476ms (95.6%) on second hit.

2. **Avoid blocking SSR with data fetches** - Pages doing heavy server-side data fetching (visualize, portfolio, control-room) are the slowest. Prefer client-side fetching with loading states for non-critical data.

3. **Sequential is faster than parallel under contention** - Playwright with 4 workers saw 14-34s DOM times. Sequential (workers=1) saw 4.5-8.5s. The dev server SSR is single-threaded; don't assume parallel requests improve UX.

## React Performance

1. **Minimize layout shifts** - Current CLS scores are good (0.0002-0.0687). Maintain by:
   - Setting explicit dimensions on images/containers
   - Using skeleton loaders that match final dimensions
   - Avoiding dynamic content insertion above the fold

2. **Hydration is the bottleneck** - Measured 27s under contention. Reduce hydration cost by:
   - Using `React.lazy()` for below-fold components
   - Deferring non-critical state initialization
   - Using `useMemo`/`useCallback` to prevent re-renders during hydration

3. **Client navigation is faster than full page loads** - 11.8s via link click vs 4-8s cold load. Keep SPA navigation working by using Next.js `<Link>` instead of `<a>` tags.

## Network & Loading

1. **HTML payload is efficient** - 22.4KB is well under the 100KB target. Keep it lean.

2. **API routes need attention** - 2 of 3 API routes return 500 errors. `/api/apr/bounded` takes 4.3s. Optimize API routes before page routes.

3. **Avoid `networkidle` in tests** - The app polls blockchain data continuously. Use `load` or `domcontentloaded` events instead.

## Bundle Size

1. **Monitor JS bundle size** - Dev build doesn't expose content-length headers. Run `next build --profile` to get accurate production bundle analysis.

2. **Large dependencies to watch** - cosmos-kit, chain-registry, and cosmjs are heavy. Consider dynamic imports for chain-specific code.

## Measured Baselines (2026-02-26, dev server)

| Metric | Fast | Moderate | Slow |
|--------|------|----------|------|
| curl TTFB (cold) | <500ms | 1.5-3s | >5s |
| curl TTFB (warm) | <200ms | 500ms-3s | >3s |
| Playwright DOM (sequential) | <5s | 5-7s | >7s |
| CLS | <0.01 | 0.01-0.07 | >0.1 |
| LCP (dev) | <10s | 10-15s | >15s |

### Slowest Pages (optimization targets)
1. `/neutron/visualize` - 10762ms cold curl, 8447ms Playwright
2. `/neutron/portfolio` - 7551ms cold curl, 4834ms Playwright
3. `/neutron/control-room` - 6196ms cold curl, 7040ms Playwright
4. `/neutron/maze-runners` - 5209ms cold curl
5. `/neutron/flywheel` - 2944ms cold curl, 8444ms Playwright

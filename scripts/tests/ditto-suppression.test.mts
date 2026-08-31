/**
 * Ditto route-suppression logic.
 *
 * Cannot be verified in the browser: DittoHologram is loaded with
 * `dynamic(..., { ssr: false })` (components/Layout.tsx:14), so it never appears in
 * server-rendered HTML, and the preview pane cannot hydrate (its tab is permanently
 * hidden, so requestAnimationFrame never fires and Next's displayContent() never
 * resolves). So the predicate is tested directly.
 *
 * The case that matters most: these are Next route PATTERNS, and the landing page's
 * pattern is `/[chain]`. A prefix/`includes` match — which is what the neighbouring
 * getThemeForRoute does — would suppress Ditto on EVERY page in the app.
 */
import assert from 'node:assert'

const { isDittoSuppressed, dittoSuppressedRoutes, getThemeForRoute } = await import(
  '@/config/dittoThemes'
)

let checks = 0
const ok = (cond: boolean, what: string) => {
  assert.ok(cond, what)
  checks++
}

// --- suppressed: the proof surfaces ---------------------------------------
ok(isDittoSuppressed('/[chain]'), 'landing page (/[chain]) suppresses Ditto')
ok(isDittoSuppressed('/[chain]/evidence'), 'legacy /evidence route suppresses Ditto')

// --- NOT suppressed: everything else --------------------------------------
for (const p of [
  '/[chain]/builder',
  '/[chain]/carry',
  '/[chain]/defend',
  '/[chain]/simulator',
  '/[chain]/home',
  '/[chain]/mint',
  '/[chain]/disco',
  '/[chain]/membrane-dashboard',
  '/[chain]/about',
  '/',
]) {
  ok(!isDittoSuppressed(p), `${p} keeps Ditto`)
}

// --- the regression this guards against -----------------------------------
// If matching ever becomes startsWith/includes instead of exact equality, every
// '/[chain]/*' page inherits the landing page's suppression and Ditto vanishes app-wide.
const everyChainRoute = ['/[chain]/builder', '/[chain]/carry', '/[chain]/mint']
ok(
  everyChainRoute.every((p) => p.startsWith('/[chain]') && !isDittoSuppressed(p)),
  'prefix-matching regression: /[chain]/* pages must NOT inherit landing suppression',
)

// --- suppression is independent of theming --------------------------------
// getThemeForRoute uses substring matching and returns a theme for anything; it must
// not be mistaken for a suppression signal.
ok(getThemeForRoute('/[chain]').id === 'default', 'suppressed route still resolves a theme')
ok(getThemeForRoute('/[chain]/mint').id === 'mint', 'substring theming still works')

// --- the list itself is sane ----------------------------------------------
ok(dittoSuppressedRoutes.length === 2, 'exactly two suppressed routes')
ok(
  dittoSuppressedRoutes.every((r) => r.startsWith('/[chain]')),
  'all suppressed routes are chain-scoped patterns, not URLs',
)
ok(
  !dittoSuppressedRoutes.includes('/ethereum'),
  'suppression list holds route PATTERNS, not resolved URLs',
)

console.log(`DITTO SUPPRESSION OK — ${checks} assertions passed`)
console.log(`  suppressed: ${dittoSuppressedRoutes.join(', ')}`)

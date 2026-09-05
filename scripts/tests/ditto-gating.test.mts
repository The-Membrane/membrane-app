/**
 * Ditto route gating.
 *
 * Replaces ditto-suppression.test.mts, which tested `isDittoSuppressed` — a denylist in
 * config/dittoThemes.ts that was superseded by the EXECUTABLE_ROUTES allowlist in
 * components/Layout.tsx and deleted. The allowlist subsumed it: neither the landing page
 * nor /evidence is executable, so Ditto never mounted there anyway.
 *
 * Cannot be verified in the preview pane: dynamic(ssr:false) plus visibilityState
 * "hidden" means rAF never fires and the component never mounts.
 */
import assert from 'node:assert'

/** Mirrors components/Layout.tsx. */
const EXECUTABLE_ROUTES = [
  '/mint', '/disco', '/transmuter', '/stake', '/manic', '/portfolio', '/earn',
  '/liquidate', '/lockdrop', '/borrow', '/position', '/boost', '/isolated',
]
const isExecutableRoute = (pathname: string) => EXECUTABLE_ROUTES.some((r) => pathname.includes(r))

let n = 0
const ok = (c: boolean, what: string) => { assert.ok(c, what); n++ }

// --- executable surfaces get him -------------------------------------------
for (const p of ['/[chain]/mint', '/[chain]/borrow', '/[chain]/position', '/[chain]/earn']) {
  ok(isExecutableRoute(p), `${p} is executable -> Ditto mounts`)
}

// --- proof and wallet-free surfaces do NOT ---------------------------------
// The landing page is the Evidence counterfactual. Ditto's four message types are all
// scoped to the user's own position; there is no position here, so anything he said
// would have to be invented.
for (const p of ['/[chain]', '/[chain]/evidence', '/[chain]/simulator', '/[chain]/builder',
                 '/[chain]/defend', '/[chain]/carry', '/[chain]/membrane-dashboard',
                 '/[chain]/radar', '/[chain]/landing', '/[chain]/about']) {
  ok(!isExecutableRoute(p), `${p} is not executable -> no Ditto`)
}

// --- the regression this guards against ------------------------------------
// Matching is substring, so a route whose name CONTAINS an executable one would mount
// him by accident. Guard the landing page specifically, since it is the proof surface.
ok(!isExecutableRoute('/[chain]'), 'landing page must never match an executable route')

console.log(`DITTO GATING OK — ${n} assertions passed`)

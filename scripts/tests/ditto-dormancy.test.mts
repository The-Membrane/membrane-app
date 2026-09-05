/**
 * Ditto dormancy logic.
 *
 * Cannot be verified in the preview pane: DittoHologram is dynamic(ssr:false) and the
 * pane reports visibilityState "hidden", so rAF never fires and it never mounts. The
 * predicate is therefore tested directly, the same approach used for route suppression.
 */
import assert from 'node:assert'

/** Mirrors the isAwake expression in components/DittoHologram.tsx. */
const isAwake = (s: {
  isPanelOpen: boolean
  hasAvailableActions: boolean
  dismissed: boolean
  isInteracting: boolean
}) => s.isPanelOpen || (s.hasAvailableActions && !s.dismissed && !s.isInteracting)

const base = {
  isPanelOpen: false,
  hasAvailableActions: false,
  dismissed: false,
  isInteracting: false,
}
let n = 0
const ok = (c: boolean, what: string) => {
  assert.ok(c, what)
  n++
}

// --- the whole point: silent by default ------------------------------------
ok(!isAwake(base), 'nothing to say -> dormant')
ok(
  !isAwake({ ...base, hasAvailableActions: false, isPanelOpen: false }),
  'no actions means no glowing object competing with the page',
)

// --- surfaces only with something to say -----------------------------------
ok(isAwake({ ...base, hasAvailableActions: true }), 'actions available -> awake')

// --- and goes away after ----------------------------------------------------
ok(!isAwake({ ...base, hasAvailableActions: true, dismissed: true }), 'dismissed -> dormant again')

// --- never interrupts mid-action (ditto-character.md:79) --------------------
ok(
  !isAwake({ ...base, hasAvailableActions: true, isInteracting: true }),
  'typing an amount suppresses him even when he has something to say',
)

// --- an open panel always wins ----------------------------------------------
ok(isAwake({ ...base, isPanelOpen: true }), 'open panel stays visible with no actions')
ok(
  isAwake({ ...base, isPanelOpen: true, dismissed: true, isInteracting: true }),
  'open panel outranks both dismissal and interaction: never yank an open panel away',
)

console.log(`DITTO DORMANCY OK — ${n} assertions passed`)

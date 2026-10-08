// Bridge (LayerZero route) rules: compare two evaluated RouteStates of one (chain, oapp, eid,
// direction) and decide severity / floor / rule IDs, plus the head-state breaches of a route.
//
// Diffs run on the EFFECTIVE config (Kelp finding 2026-10-05): an override that replaces an
// inherited 2-of-2 default with 1-of-1 is a downgrade even though no explicit value dropped,
// and a route CREATED under the floor is red even though nothing was downgraded.

import type { ChangeTag, RouteState, StateItem } from './types'
import { down, neutral, tag, up, type Verdict } from './rules'
import { FLOOR_E, isZeroPeer, routeVerifies } from './uln'

const notIn = (xs: string[], ys: string[] | undefined) => xs.filter((x) => !(ys ?? []).includes(x))

/**
 * Everything about one library's security a curator would see. The grace library's config is
 * compared too (review round 5): a weaker config written to the old library while it is still
 * in its receive grace period — it verifies packets until expiry — was invisible.
 */
const securitySig = (s: RouteState['security']) =>
  [
    s.E,
    s.blocked,
    s.confirmations,
    s.zeroConfirmations,
    s.required,
    s.optional,
    s.threshold,
    s.operators.join(),
    s.unknown.join(),
    s.noCode.join(),
    s.duplicateOperator.join(),
  ].join('|')

/** True when two route states differ in anything a curator would see. */
export function routeDiffers(a: RouteState | undefined, b: RouteState | undefined): boolean {
  if (!a || !b) return a !== b
  return (
    a.lib !== b.lib ||
    a.peer !== b.peer ||
    a.live !== b.live ||
    a.Eeff !== b.Eeff ||
    a.security.blocked !== b.security.blocked ||
    a.config.confirmations !== b.config.confirmations ||
    a.config.optionalThreshold !== b.config.optionalThreshold ||
    a.config.required.join() !== b.config.required.join() ||
    a.config.optional.join() !== b.config.optional.join() ||
    (a.grace?.lib ?? '') !== (b.grace?.lib ?? '') ||
    (a.grace?.expiry ?? 0) !== (b.grace?.expiry ?? 0) ||
    (a.grace ? securitySig(a.grace.security) : '') !==
      (b.grace ? securitySig(b.grace.security) : '')
  )
}

/** Security of the library that verifies: the current one, else the old one in its grace period. */
const verifyingSecurity = (r: RouteState) =>
  r.security.blocked && r.grace && !r.grace.security.blocked ? r.grace.security : r.security
const viaGrace = (r: RouteState) => verifyingSecurity(r) !== r.security
/**
 * Confirmations a forged packet must wait for: the FEWEST over every library that can verify
 * right now — the current one and the old one in its grace period (review round 5).
 */
const verifyingConfirmations = (r: RouteState): bigint => {
  const libs = [r.security, r.grace?.security].filter(
    (s): s is RouteState['security'] => !!s && !s.blocked,
  )
  const xs = (libs.length ? libs : [verifyingSecurity(r)]).map((s) => BigInt(s.confirmations))
  return xs.reduce((m, x) => (x < m ? x : m))
}

/**
 * `lastVerifying` is the route's last state that could verify a packet (the replay keeps it
 * across a closed spell): a route reopened at a lower E than it last ran at is a BR-1, even
 * when the downgrade was written while it was closed.
 */
export function compareRoute(
  before: RouteState | undefined,
  after: RouteState,
  lastVerifying?: RouteState,
  /**
   * The route's last NON-ZERO peer (the replay / the previous runs keep it): a peer zeroed and
   * later set to a different address (A → 0 → B) is the same re-point as A → B (review round 5).
   */
  lastPeer?: string,
): Verdict {
  const v = neutral()
  if (after.direction === 'send') tag(v, 'send_side')
  if (after.grace) tag(v, 'grace_period')
  if (after.security.deprecated.length) tag(v, 'deprecated_dvn')

  // Peer moves (owner ruling 2026-10-06, #3: STRICT). Every re-point from one non-zero peer to
  // another is red — also on a route that is closed right now: the new counterparty is trusted
  // the moment the route reopens.
  if (before && !isZeroPeer(before.peer) && !isZeroPeer(after.peer) && before.peer !== after.peer)
    down(
      v,
      'BR-6',
      `peer ${before.peer} → ${after.peer}${before.live ? '' : ' (while the route was closed)'}`,
    )
  if (before && !isZeroPeer(before.peer) && isZeroPeer(after.peer)) tag(v, 'route_removed')
  if (
    (!before || isZeroPeer(before.peer)) &&
    !isZeroPeer(after.peer) &&
    lastPeer &&
    !isZeroPeer(lastPeer) &&
    lastPeer.toLowerCase() !== after.peer.toLowerCase()
  )
    down(
      v,
      'BR-6',
      `peer ${lastPeer} → 0 → ${after.peer} (re-pointed through a zeroed peer${after.live ? '' : ', while the route is closed'})`,
    )

  // Closing a route (BlockedMessageLib, dead DVN) is a liveness event, not a security one. A
  // DVN without code or an unknown DVN parked in a closed route's config is still flagged: it
  // becomes live the moment the blocking part (often an inherited default) changes. A route
  // whose old library is still in its grace period is NOT closed (routeVerifies).
  if (!routeVerifies(after)) {
    if (before && routeVerifies(before)) tag(v, 'blocked')
    latentDvnRules(v, before, after)
    return v
  }

  const created = !before || isZeroPeer(before.peer) ? !isZeroPeer(after.peer) : false
  const unblocked = !!before && !routeVerifies(before)
  if (created) tag(v, 'route_created')
  if (unblocked) tag(v, 'unblocked')
  if (!after.live) tag(v, 'inactive_route')

  // FLOOR (BR-2): a live route under 2 distinct known operators — red at creation, after any
  // change, whatever the direction of the change.
  if (after.live && after.Eeff < FLOOR_E) {
    v.floorBreach = true
    v.ruleIds.push('BR-2')
    v.notes.push(`live route at E=${after.Eeff} (< ${FLOOR_E})`)
  }

  // Compare against the state just before, or — when that state could not verify — against
  // the last state that could (a downgrade written behind BlockedMessageLib is still one).
  const base =
    before && routeVerifies(before)
      ? before
      : lastVerifying && routeVerifies(lastVerifying)
        ? lastVerifying
        : undefined
  if (base) {
    const via = base === before ? '' : ' (vs the last config the route ran with)'
    if (after.Eeff < base.Eeff) down(v, 'BR-1', `E ${base.Eeff} → ${after.Eeff}${via}`)
    else if (after.Eeff > base.Eeff) up(v, `E ${base.Eeff} → ${after.Eeff}${via}`)
    // BR-3: fewer confirmations is red when it goes to ZERO (incl. the uint64-max NIL) or below
    // LayerZero's own default for the pathway (its finality guidance) as it stood before or
    // after the change. Above that guidance it is noted, not red (a 1,000,000 → 30,000 move on a
    // pathway whose default is 30,000 is not a reorg-safety loss).
    const nb = verifyingConfirmations(after)
    const ob = verifyingConfirmations(base)
    if (nb < ob) {
      const guide = [base.defaultConfirmations, after.defaultConfirmations]
        .filter((x): x is string => x !== undefined)
        .map((x) => BigInt(x))
      const floor = guide.length ? guide.reduce((m, x) => (x > m ? x : m), 0n) : null
      const msg = `confirmations ${ob} → ${nb === 0n ? 'ZERO' : nb}${via}`
      // owner ruling 2026-10-06 (#1): red only at ZERO or below LZ's default for the pathway.
      // A default that was not read cannot clear the drop (fail closed) — the note says so.
      if (nb === 0n || nb < (floor ?? 0n)) down(v, 'BR-3', msg)
      else if (floor === null)
        down(v, 'BR-3', `${msg} (LayerZero's default for this pathway not read: fail closed)`)
      else v.notes.push(`${msg} (still ≥ the pathway default ${floor})`)
    }
    // A WIDER DVN set at the SAME effective threshold (owner ruling 2026-10-06, round 2 #6):
    // e.g. 4-of-4 → 2 required + 2-of-3 optional, or one more optional DVN at an unchanged
    // optional threshold. More DVNs for an attacker to pick from, but no fewer signatures
    // needed: AMBER, not red. An UNKNOWN added DVN stays red under BR-7 (latentDvnRules).
    // (DVN lists are kept for the current library only: not judged through a grace library.)
    const dvns = (r: RouteState) => new Set([...r.config.required, ...r.config.optional])
    const was = dvns(base)
    const now = dvns(after)
    const added = [...now].filter((x) => !was.has(x))
    if (
      !viaGrace(after) &&
      !viaGrace(base) &&
      after.Eeff === base.Eeff &&
      added.length > 0 &&
      now.size > was.size
    ) {
      tag(v, 'wider_dvn_set')
      v.notes.push(
        `wider DVN set at the same threshold (E=${after.Eeff}): ${was.size} → ${now.size} DVNs${via} (amber, BR-8)`,
      )
    }
  }

  // BR-3 FLOOR (review round 6): a live route at ZERO confirmations (incl. the NIL sentinel) —
  // red at creation and after any change, like BR-2. A drop to zero was caught above; a route
  // CREATED at NIL (configured first, peer set later) was two neutral rows.
  if (after.live && verifyingConfirmations(after) === 0n && !v.ruleIds.includes('BR-3')) {
    v.floorBreach = true
    v.ruleIds.push('BR-3')
    v.notes.push('live route at ZERO confirmations (a forged packet needs no block to pass)')
  }

  latentDvnRules(v, before, after)
  if (!after.libAllowed && (!before || before.libAllowed))
    down(v, 'BR-5', `library ${after.lib} not in the LZ allowlist`)
  return v
}

/**
 * BR-4 / BR-7 for DVNs that are NEW in `after` (a closed route's config included), over EVERY
 * library that verifies: the current one and the old one in its receive grace period (review
 * round 6: an unknown DVN added to the grace library at the same E was neutral).
 */
function latentDvnRules(v: Verdict, before: RouteState | undefined, after: RouteState) {
  const libs = (r: RouteState | undefined) =>
    r ? [r.security, ...(r.grace ? [r.grace.security] : [])] : []
  const all = (r: RouteState | undefined, f: (s: RouteState['security']) => string[]) => [
    ...new Set(libs(r).flatMap(f)),
  ]
  const noCode = notIn(
    all(after, (s) => s.noCode),
    all(before, (s) => s.noCode),
  )
  if (noCode.length) down(v, 'BR-4', `DVN without code: ${noCode.join(', ')}`)
  const prevUnknown = all(before, (s) => [...s.unknown, ...s.duplicateOperator])
  const unknown = notIn(
    all(after, (s) => [...s.unknown, ...s.duplicateOperator]),
    prevUnknown,
  )
  if (unknown.length) down(v, 'BR-7', `unknown or same-operator DVN: ${unknown.join(', ')}`)
}

/** Head-state breaches of one route (persist as a red banner without any new change). */
export function routeBreaches(r: RouteState): { ruleId: string; message: string }[] {
  const out: { ruleId: string; message: string }[] = []
  if (r.live && r.Eeff < FLOOR_E)
    out.push({
      ruleId: 'BR-2',
      message: `live route at E=${r.Eeff}: fewer than ${FLOOR_E} distinct known DVN operators`,
    })
  // BR-3 floor at head (review round 6): no history row is needed for a route sitting at zero
  if (r.live && verifyingConfirmations(r) === 0n)
    out.push({ ruleId: 'BR-3', message: 'live route at ZERO confirmations' })
  if (r.security.noCode.length)
    out.push({ ruleId: 'BR-4', message: `DVN without code: ${r.security.noCode.join(', ')}` })
  if (r.security.unknown.length)
    out.push({ ruleId: 'BR-7', message: `unknown DVN: ${r.security.unknown.join(', ')}` })
  if (r.security.duplicateOperator.length)
    out.push({
      ruleId: 'BR-7',
      message: `two DVNs of one operator: ${r.security.duplicateOperator.join(', ')}`,
    })
  if (!r.libAllowed)
    out.push({ ruleId: 'BR-5', message: `library ${r.lib} not in the LZ allowlist` })
  return out
}

export function routeTags(r: RouteState): ChangeTag[] {
  const t: ChangeTag[] = []
  if (r.security.deprecated.length) t.push('deprecated_dvn')
  if (r.grace) t.push('grace_period')
  if (r.security.blocked) t.push('blocked')
  if (r.direction === 'send') t.push('send_side')
  return t
}

/**
 * Routes with a floor breach (BR-2) now, counted once per ROUTE (Ethereum OApp × eid) whichever
 * of its four sides breach (review round 7: the headline counted sides — the Kelp route, under
 * the floor on both send and receive, read "2 floor breaches" next to "1 under floor").
 */
export function floorBreachRoutes(
  items: readonly Pick<StateItem, 'key' | 'display' | 'value' | 'breaches'>[],
): string[] {
  const out = new Set<string>()
  for (const i of items) {
    if (!(i.breaches ?? []).some((b) => b.ruleId === 'BR-2')) continue
    const named = (i.value as { localOApp?: unknown } | undefined)?.localOApp
    const oapp = typeof named === 'string' ? named.toLowerCase() : (i.key.split('/')[3] ?? i.key)
    const eid = i.display.match(/^eid (\d+)/)?.[1] ?? i.key.split('/')[4] ?? ''
    out.add(`${oapp}|${eid}`)
  }
  return [...out]
}

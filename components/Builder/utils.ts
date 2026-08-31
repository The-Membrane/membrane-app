// Pure math ported from public/proto/builder.html. Every function is side-effect free:
// the proto read/mutated globals (st, run, SCENARIOS); here the same state is passed in.

import {
  BASE_SCENARIOS,
  BORROW,
  BTC_PX,
  CAL_MIN,
  DIVEST_LOSS,
  DOCTRINE_DEFS,
  MAX_BORROW,
  MAX_LTV,
  SHORT_NAMES,
  TEMPLATES,
  TILES,
} from './fixtures'
import {
  AuditResult,
  AuditRow,
  Calc,
  CoreState,
  Forecast,
  GhostRow,
  Intent,
  Resolution,
  RunResult,
  Scenario,
  Tile,
} from './types'

// ---------- formatters ----------

// The sign belongs in front of the currency symbol, not after it (proto :685).
export function usd(n: number): string {
  const v = Math.round(n)
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US')
}
export function pct(n: number): string {
  return (n * 100).toFixed(0) + '%'
}

export function byId(id: string | null): Tile | undefined {
  return TILES.find((t) => t.id === id)
}
export function placed(slots: (string | null)[]): Tile[] {
  return slots.filter(Boolean).map((id) => byId(id)!).filter(Boolean)
}

// ---------- liquidation math ----------

// Two lines, not one. You may borrow up to MAX_BORROW; you are liquidated past MAX_LTV.
// A partial liquidation repays you all the way back down to the borrow cap. Port of
// LiquidationEngine._getRepayQuantities (proto :619).
export function repayNeeded(debt: number, collAfter: number, ltvAfter: number): number {
  if (collAfter <= 0) return debt
  if (ltvAfter >= 1) return collAfter // repay against ALL collateral
  return Math.max(0, (debt * (ltvAfter - MAX_BORROW)) / ltvAfter)
}

// The line moves with a voted Disco cut; the debt moves with compounded interest. Both
// are run state (proto :629).
export function liqLine(runActive: boolean, ltvCut: number): number {
  return runActive ? Math.max(0.2, MAX_LTV - ltvCut) : MAX_LTV
}
export function debtMul(runActive: boolean, debtX: number): number {
  return runActive ? debtX : 1
}

export function calc(p: Tile[], btc: number, ltv: number, intent: Intent, dm: number): Calc {
  const coll = btc * BTC_PX
  const debt = coll * ltv * dm
  const apr = p.length ? p.reduce((a, t) => a + t.apr, 0) / p.length : 0
  const liq = p.length ? p.reduce((a, t) => a + t.liq, 0) / p.length : 0
  const earn = intent === 'distribute' || intent === 'repay' || intent === 'compound' ? debt * apr : 0
  const cost = debt * BORROW
  return { coll, debt, p, apr, liq, earn, cost, net: earn - cost, ltv }
}

// Bitcoin sold if the price falls by `drop`, on this board (proto :703).
export function stressBtc(c: Calc, btc: number, line: number, drop: number): number {
  if (!c.p.length) return 0
  const px = BTC_PX * (1 - drop)
  const collAfter = btc * px
  if (collAfter <= 0) return btc
  const lv = c.debt / collAfter
  if (lv <= line) return 0
  const needed = repayNeeded(c.debt, collAfter, lv)
  return Math.min(btc, Math.max(0, needed - c.debt * c.liq) / px)
}

// How far bitcoin must fall before the venues stop covering you (proto :696).
export function breakPoint(c: Calc, btc: number, line: number): number | null {
  if (!c.p.length) return null
  for (let d = 0.05; d <= 0.90001; d += 0.01) {
    if (stressBtc(c, btc, line, d) > 1e-9) return d
  }
  return null
}

// ---------- daily seed ----------

export function mulberry32(a: number): () => number {
  a = a >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function fnv(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}
export function hex4(n: number): string {
  return ('0000' + (n & 0xffff).toString(16).toUpperCase()).slice(-4)
}
export function utcDayStr(d: Date): string {
  const p2 = (x: number) => (x < 10 ? '0' : '') + x
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
}
export function fmtUTC(d: Date): string {
  const DY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return DY[d.getUTCDay()] + ' ' + MO[d.getUTCMonth()] + ' ' + d.getUTCDate()
}
// The seed id IS the seed: 16 bits shown as 4 hex chars (proto :1165).
export function dailySeedId(): string {
  const h = fnv('membrane-gauntlet-' + utcDayStr(new Date()))
  return hex4((h >>> 16) ^ h)
}
// Any text becomes a seed id: 1-4 hex chars pass through, anything else hashes (proto :1170).
export function seedIdFrom(s: string | null | undefined): string | null {
  s = String(s == null ? '' : s).trim()
  if (!s) return null
  const m = s.match(/^#?([0-9a-fA-F]{1,4})$/)
  if (m) return hex4(parseInt(m[1], 16))
  const h = fnv(s.toLowerCase())
  return hex4((h >>> 16) ^ h)
}
// Jitter one lever. Zero stays zero; the clamp keeps the draw inside the floor's own
// described range (proto :1180).
function jit(rnd: () => number, v: number, frac: number, lo: number, hi: number): number {
  if (!v) return v
  const x = v * (1 + (rnd() * 2 - 1) * frac)
  return Math.round(Math.min(hi, Math.max(lo, x)) * 1000) / 1000
}
export function buildScenarios(id: string): Scenario[] {
  const rnd = mulberry32(parseInt(id, 16) ^ 0x9e3779b9)
  return BASE_SCENARIOS.map((b) => {
    const sc: Scenario = { ...b, hair: {}, freeze: (b.freeze || []).slice() }
    for (const k in b.hair || {}) {
      const key = k as keyof typeof sc.hair
      sc.hair[key] = jit(rnd, b.hair[key]!, 0.4, 0.005, 0.12)
    }
    if (b.bleed) {
      sc.bleed = {}
      for (const k in b.bleed) {
        const key = k as keyof typeof sc.bleed
        sc.bleed[key] = jit(rnd, b.bleed[key]!, 0.3, 0.03, 0.15)
      }
    }
    sc.coll = jit(rnd, b.coll, 0.2, 0.02, 0.65)
    if (b.rate) sc.rate = jit(rnd, b.rate, 0.25, 0.05, 0.35)
    if (b.ltvCut) sc.ltvCut = jit(rnd, b.ltvCut, 0.3, 0.06, 0.2)
    if (b.stale) sc.stale = jit(rnd, b.stale, 0.3, 0.15, 0.6)
    if (b.days > 3) sc.days = Math.max(2, Math.round(b.days * (1 + (rnd() * 2 - 1) * 0.25)))
    return sc
  })
}

// ---------- per-floor audit ----------

const FREEZE_WHY_L: Record<string, string> = {
  lst: 'the unstaking queue is shut — your money is fine, it just cannot come out until the queue clears',
  synth: 'in its cooldown — this venue pays the most precisely because it makes you wait to leave',
  stable: 'the lending pool is empty — everyone withdrew at once and there is nothing left to hand you',
}
const LIQ_WHY_L: Record<string, string> = {
  aave: 'you can only take out what other people have not already borrowed',
  fluid: 'you can only take out what other people have not already borrowed',
  yearn: 'most of the money is out working in strategies and has to be unwound first',
  susde: 'only the part not sitting in a cooldown can leave today',
  ptoken: 'it cannot be redeemed until it matures, so the only way out is selling it to someone',
  wsteth: 'staked ETH has to be unwrapped and queued before it is cash again',
  reth: 'staked ETH has to be unwrapped and queued before it is cash again',
  usd3: 'you can only take out what has not already been lent on to someone else',
}

// Full per-venue accounting for one floor. Returns the receipt, not a verdict (proto :1244).
export function auditFloor(
  sc: Scenario,
  c: Calc,
  p: Tile[],
  runActive: boolean,
  banned: Record<string, number>,
  sick: Record<string, number>,
): AuditResult {
  const n = p.length || 1
  const share = c.debt / n
  const rows: AuditRow[] = p.map((t) => {
    const hair = (sc.hair && (sc.hair as Record<string, number>)[t.cls]) || 0
    const bleed = (sc.bleed && (sc.bleed as Record<string, number>)[t.cls]) || 0
    const frozen = sc.freeze.indexOf(t.cls as never) >= 0
    const ban = !!(runActive && banned[t.id] > 0)
    const divest = !!(sc.divest && runActive && sick[t.id])
    const crys = divest ? DIVEST_LOSS : 0
    const value = share * Math.max(0, 1 - hair - bleed - crys)
    const live = !frozen && !ban
    return {
      t, share, hair, bleed: bleed + crys, value, frozen, ban, divest,
      liq: live ? t.liq : 0, ret: live ? value * t.liq : 0, failed: false, shown: 0, why: '',
    }
  })
  // A counterparty failure takes the slot that would have returned the most.
  for (let i = 0; i < sc.fail && i < rows.length; i++) {
    let best = -1
    let bv = -1
    rows.forEach((r, ix) => {
      if (!r.failed && r.ret > bv) {
        bv = r.ret
        best = ix
      }
    })
    if (best >= 0) {
      rows[best].failed = true
      rows[best].ret = 0
      rows[best].liq = 0
    }
  }
  rows.forEach((r) => {
    r.why = r.failed
      ? 'the venue itself is gone — nothing comes back from it, ever'
      : r.ban
        ? 'benched — it failed to deliver on an earlier floor, so it is skipped now even though it recovered'
        : r.frozen
          ? FREEZE_WHY_L[r.t.cls]
          : r.divest
            ? 'force-closed — it stayed unreachable long enough that anyone could pull the plug, and this is what was left'
            : LIQ_WHY_L[r.t.id] || 'only part of what it holds can be handed back on demand'
  })
  const over = sc.stale || 0
  rows.forEach((r) => {
    r.shown = r.ret * (1 + over)
  })
  return {
    rows,
    stale: over,
    fast: rows.reduce((a, r) => a + r.ret * (r.t.spd === undefined ? 1 : r.t.spd), 0),
    shown: rows.reduce((a, r) => a + r.shown, 0),
    recalled: rows.reduce((a, r) => a + r.ret, 0),
    haircut: rows.reduce((a, r) => a + r.share * r.hair, 0),
    bleed: rows.reduce((a, r) => a + r.share * r.bleed, 0),
    debt: c.debt,
  }
}

// ---------- one floor against one state, no side effects (proto resolveCore :1674) ----------

// `baseBtc` is the ORIGINAL stack (the proto's global st.btc): the debt was drawn
// against it at open, and the quarter-of-the-stack death rule measures against it —
// while `S.btc` (the run's remaining bitcoin) is what backs the position when the
// shock lands.
export function resolveCore(sc: Scenario, S: CoreState, intent: Intent, baseBtc: number): Resolution {
  const debtXAfter = S.debtX * (sc.rate ? 1 + Math.max(0, sc.rate - BORROW) * (sc.days / 365) : 1)
  const ltvCutAfter = S.ltvCut + (sc.ltvCut || 0)
  const line = Math.max(0.2, MAX_LTV - ltvCutAfter)
  const p = placed(S.slots)
  const c = calc(p, baseBtc, S.ltv, intent, debtXAfter)
  const a = auditFloor(sc, c, p, true, S.banned, S.sick)
  const px = BTC_PX * (1 - sc.coll)
  const collAfter = S.btc * px
  const ltvAfter = collAfter > 0 ? c.debt / collAfter : 99
  const breached = ltvAfter > line
  const needed = breached ? repayNeeded(c.debt, collAfter, ltvAfter) : 0
  const recalled = Math.min(a.recalled, needed)
  const shortfall = Math.max(0, needed - recalled)
  const cured = !!(breached && sc.timer && a.fast >= needed)
  const frozenOut = !!(breached && sc.closed)
  const sold = breached && !cured && !frozenOut ? Math.min(S.btc, shortfall / px) : 0
  const btcAfter = Math.max(0, S.btc - sold)
  const wiped = btcAfter <= baseBtc * 0.75
  const R: Resolution = {
    c, a, px, ltvAfter, line, breached, needed, recalled, shortfall, cured, frozenOut,
    sold, btcAfter, wiped, debtXAfter, ltvCutAfter, survived: !wiped, bind: { k: '', why: '' },
  }
  R.bind = bindingConstraint(sc, S, R)
  return R
}

// Which lever actually decided the outcome, in plain language (proto :1712).
function bindingConstraint(sc: Scenario, S: CoreState, R: Resolution): { k: string; why: string } {
  let frozen = 0
  let benched = 0
  let gone = 0
  let crys = 0
  R.a.rows.forEach((r) => {
    if (r.failed) gone += r.value * r.t.liq
    else if (r.ban) benched += r.value * r.t.liq
    else if (r.frozen) frozen += r.value * r.t.liq
    if (r.divest) crys += r.share * DIVEST_LOSS
  })
  const grow = R.debtXAfter > 0 ? R.c.debt * (1 - S.debtX / R.debtXAfter) : 0
  const ltvNoRate = R.ltvAfter * (R.debtXAfter > 0 ? S.debtX / R.debtXAfter : 1)
  const lineOld = Math.max(0.2, MAX_LTV - S.ltvCut)
  const lp = (v: number) => (v * 100).toFixed(0) + '%'

  if (R.wiped) {
    if (R.ltvAfter >= 1)
      return { k: 'total', why: 'at ' + lp(R.ltvAfter) + ' LTV the call was the whole stack; the recall answered ' + usd(R.recalled) + ' and the last ' + usd(R.shortfall) + ' came out of bitcoin' }
    if (sc.timer && R.a.fast < R.needed)
      return { k: 'timer', why: 'only ' + usd(R.a.fast) + ' could move inside the cure window; the call was ' + usd(R.needed) }
    if (sc.rate && ltvNoRate <= R.line)
      return { k: 'rate', why: lp(sc.rate) + ' interest compounded ' + usd(grow) + ' onto the debt — the price move alone would have stayed under the line' }
    if (sc.ltvCut && R.ltvAfter <= lineOld)
      return { k: 'cut', why: 'the vote moved the line from ' + lp(lineOld) + ' to ' + lp(R.line) + ' under a position that never moved' }
    if (frozen > 0 && frozen >= R.shortfall)
      return { k: 'freeze', why: 'the freeze locked ' + usd(frozen) + ' of its exit; the call wanted ' + usd(R.shortfall) + ' more' }
    if (benched > 0 && benched >= R.shortfall)
      return { k: 'ban', why: 'the earlier ban held out ' + usd(benched) + ' from venues that were healthy again' }
    if (gone > 0 && gone >= R.shortfall)
      return { k: 'fail', why: 'the dead venue took ' + usd(gone) + ' of recall with it; the gap was ' + usd(R.shortfall) }
    if (crys > 0 && crys >= R.shortfall)
      return { k: 'divest', why: 'the force-close crystallised ' + usd(crys) + ' out of a venue that had gone quiet' }
    return { k: 'depth', why: 'repay-to-cap sold ' + lp(S.btc > 0 ? R.sold / S.btc : 1) + ' of the stack — venues sent ' + usd(R.recalled) + ' of the ' + usd(R.needed) + ' call' }
  }
  if (R.cured)
    return { k: 'cured', why: usd(R.a.fast) + ' arrived inside the window against the ' + usd(R.needed) + ' call — cured, nothing sold' }
  if (R.frozenOut)
    return { k: 'breaker', why: 'the breaker blocked the sale at ' + lp(R.ltvAfter) + ' LTV — the breach rides into the next floor' }
  if (R.breached && R.ltvAfter >= 1)
    return {
      k: 'recall-total',
      why: (R.sold <= 0
        ? 'at ' + lp(R.ltvAfter) + ' LTV the call was the whole stack, and the recall answered all ' + usd(R.needed) + ' of it'
        : 'at ' + lp(R.ltvAfter) + ' LTV the call was the whole stack; the recall answered ' + usd(R.recalled) + ', so only ' + R.sold.toFixed(3) + ' BTC went') + ' — without the recall, everything goes',
    }
  if (R.breached && R.sold <= 0)
    return { k: 'covered', why: 'recall covered the whole ' + usd(R.needed) + ' call — ' + usd(R.a.recalled) + ' was on tap' }
  if (R.sold > 0)
    return { k: 'depth', why: 'held, minus ' + R.sold.toFixed(3) + ' BTC — venues sent ' + usd(R.recalled) + ' of the ' + usd(R.needed) + ' call' }
  if (R.a.bleed > 0)
    return { k: 'bleed', why: 'no breach, but the funding bleed took ' + usd(R.a.bleed) + ' of principal for good' }
  if (sc.rate)
    return { k: 'rate-held', why: 'interest grew the debt ' + usd(grow) + '; it topped out at ' + lp(R.ltvAfter) + ' against the ' + lp(R.line) + ' line' }
  if (sc.ltvCut)
    return { k: 'cut-held', why: 'the line fell to ' + lp(R.line) + ' and it still cleared by ' + ((R.line - R.ltvAfter) * 100).toFixed(1) + ' points' }
  if (!sc.coll && frozen > 0)
    return { k: 'unasked', why: 'bitcoin never moved, so the ' + usd(frozen) + ' locked behind the freeze was never called for' }
  if (sc.coll > 0)
    return { k: 'room', why: 'the ' + lp(sc.coll) + ' fall used ' + Math.round((R.ltvAfter / R.line) * 100) + '% of its room' }
  return { k: 'calm', why: 'nothing moved and nothing was called for' }
}

// ---------- the roads not taken (proto ghostRows :1796) ----------

export interface GhostCtx {
  snap: { btc: number; debtX: number; ltvCut: number; banned: Record<string, number>; sick: Record<string, number> }
  slots: (string | null)[]
  ltv: number
  intent: Intent
  lastTmpl: number
  /** Original stack (proto st.btc) — sizes the debt and the wipe rule. */
  baseBtc: number
}

export function ghostRows(sc: Scenario, playerR: Resolution, ctx: GhostCtx): GhostRow[] {
  const snap = ctx.snap
  const mySlots = ctx.slots.slice()
  const myLtv = ctx.ltv
  const S = (slots: (string | null)[], ltv: number): CoreState => ({
    slots, ltv, btc: snap.btc, debtX: snap.debtX, ltvCut: snap.ltvCut,
    banned: JSON.parse(JSON.stringify(snap.banned || {})),
    sick: JSON.parse(JSON.stringify(snap.sick || {})),
  })
  const out: GhostRow[] = []

  // (a) same venues, twice the draw. The borrow cap still applies.
  const lev = Math.min(MAX_BORROW, myLtv * 2)
  out.push({
    label: '2× the draw · same venues · ' + (lev * 100).toFixed(0) + '%' + (myLtv * 2 > MAX_BORROW ? ' (the cap)' : ''),
    R: resolveCore(sc, S(mySlots.slice(), lev), ctx.intent, ctx.baseBtc),
  })

  // (b) the template not picked — prefer the one whose outcome differs from the player's.
  let pick: { t: (typeof TEMPLATES)[number]; R: Resolution } | null = null
  for (let i = 0; i < TEMPLATES.length; i++) {
    if (i === ctx.lastTmpl) continue
    const t = TEMPLATES[i]
    const same =
      t.ltv === myLtv &&
      t.slots.length === mySlots.filter(Boolean).length &&
      t.slots.every((id) => mySlots.indexOf(id) >= 0)
    if (same) continue
    const slots: (string | null)[] = [null, null, null]
    t.slots.forEach((id, j) => {
      slots[j] = id
    })
    const Rg = resolveCore(sc, S(slots, t.ltv), ctx.intent, ctx.baseBtc)
    if (!pick || (Rg.survived !== playerR.survived && pick.R.survived === playerR.survived)) pick = { t, R: Rg }
    if (pick.R.survived !== playerR.survived) break
  }
  if (pick) out.push({ label: 'the ' + pick.t.nm + ' template · ' + (pick.t.ltv * 100).toFixed(0) + '%', R: pick.R })

  // (c) one venue swapped — the swap that changes the outcome, else shallowest→deepest.
  const idx: number[] = []
  mySlots.forEach((id, i2) => {
    if (id) idx.push(i2)
  })
  let swap: { from: Tile; to: Tile; R: Resolution } | null = null
  for (let s2 = 0; s2 < idx.length && !swap; s2++) {
    for (let t2 = 0; t2 < TILES.length; t2++) {
      if (mySlots.indexOf(TILES[t2].id) >= 0) continue
      const sl = mySlots.slice()
      sl[idx[s2]] = TILES[t2].id
      const R2 = resolveCore(sc, S(sl, myLtv), ctx.intent, ctx.baseBtc)
      if (R2.survived !== playerR.survived) {
        swap = { from: byId(mySlots[idx[s2]])!, to: TILES[t2], R: R2 }
        break
      }
    }
  }
  if (!swap && idx.length) {
    const low = idx.slice().sort((x, y) => byId(mySlots[x])!.liq - byId(mySlots[y])!.liq)[0]
    const hi = TILES.filter((t3) => mySlots.indexOf(t3.id) < 0).sort((x, y) => y.liq - x.liq)[0]
    if (hi) {
      const sl2 = mySlots.slice()
      sl2[low] = hi.id
      swap = { from: byId(mySlots[low])!, to: hi, R: resolveCore(sc, S(sl2, myLtv), ctx.intent, ctx.baseBtc) }
    }
  }
  if (swap) out.push({ label: swap.from.nm + ' → ' + swap.to.nm + ' · same draw', R: swap.R })
  return out
}

// ---------- reference doctrines (proto simReference :2260) ----------

export function simReference(
  slots: string[],
  ltv: number,
  stBtc: number,
  intent: Intent,
  scenarios: Scenario[],
): { floors: number; btc: number; banked: number; lost: number; net: number } {
  const S: CoreState = { slots: slots.slice(), ltv, btc: stBtc, debtX: 1, ltvCut: 0, banned: {}, sick: {} }
  let banked = 0
  let lost = 0
  let dead = 0
  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i]
    const R = resolveCore(sc, S, intent, stBtc)
    if (R.wiped) {
      dead++
    } else {
      const debtPre = R.debtXAfter > 0 ? R.c.debt * (S.debtX / R.debtXAfter) : R.c.debt
      banked += debtPre * (R.c.apr - (sc.rate || BORROW)) * (sc.days / 365)
      lost += R.a.bleed + R.sold * R.px + (R.sold > 0 ? R.a.haircut : 0)
      if (R.breached && !R.frozenOut) {
        R.a.rows.forEach((r) => {
          if (r.ret <= 0) {
            S.banned[r.t.id] = 2
            S.sick[r.t.id] = 1
          }
        })
      }
      S.btc = R.btcAfter
      S.debtX = R.debtXAfter
      S.ltvCut = R.ltvCutAfter
    }
    Object.keys(S.banned).forEach((k) => {
      S.banned[k]--
      if (S.banned[k] <= 0) delete S.banned[k]
    })
  }
  return { floors: scenarios.length - dead, btc: stBtc > 0 ? S.btc / stBtc : 0, banked, lost, net: banked - lost }
}

export function doctrineRows(seedId: string, stBtc: number, intent: Intent, scenarios: Scenario[]): RunResult[] {
  return DOCTRINE_DEFS.map((d) => {
    const r = simReference(d.slots, d.ltv, stBtc, intent, scenarios)
    return { who: d.who, floors: r.floors, btc: r.btc, banked: r.banked, lost: r.lost, net: r.net, build: d.build + ' · seed #' + seedId }
  })
}

// ---------- calibration ----------

export function brier(forecasts: Forecast[]): number | null {
  if (!forecasts.length) return null
  return forecasts.reduce((a, f) => a + (f.p - f.o) * (f.p - f.o), 0) / forecasts.length
}

// ---------- seed experience (proto seedExperience :2346) ----------

export function seedExperience(scenarios: Scenario[]): { tier: string; standout: string; label: string } {
  let num = 0
  let den = 0
  const worst = { r: 0, txt: '' }
  scenarios.forEach((sc, i) => {
    const b = BASE_SCENARIOS[i]
    const nm = SHORT_NAMES[i] || b.n
    if (b.coll > 0) {
      num += sc.coll / b.coll
      den++
      if (b.coll >= 0.2 && sc.coll / b.coll > worst.r) {
        worst.r = sc.coll / b.coll
        worst.txt = (sc.coll * 100).toFixed(0) + '% ' + nm
      }
    }
    if (b.rate && sc.rate) {
      num += sc.rate / b.rate
      den++
      if (sc.rate / b.rate > worst.r) {
        worst.r = sc.rate / b.rate
        worst.txt = (sc.rate * 100).toFixed(0) + '% ' + nm
      }
    }
    if (b.stale && sc.stale) {
      num += sc.stale / b.stale
      den++
      if (sc.stale / b.stale > worst.r) {
        worst.r = sc.stale / b.stale
        worst.txt = '+' + (sc.stale * 100).toFixed(0) + '% ' + nm
      }
    }
  })
  const sev = den ? num / den : 1
  const tier = sev < 0.97 ? 'gentle' : sev <= 1.03 ? 'standard' : 'harsh'
  return { tier, standout: worst.txt, label: tier + (worst.txt ? ' · ' + worst.txt : '') }
}

export { CAL_MIN }

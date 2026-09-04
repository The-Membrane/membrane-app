// The Carry Builder engine. The proto (public/proto/builder.html) was one big IIFE
// mutating module globals and repainting the DOM imperatively. Porting a 15-floor state
// machine + game loop 1:1 into idiomatic useState risks subtle async-batching bugs, so the
// engine keeps its mutable state in a single ref `E` and forces a React re-render via a
// version counter after every mutation — an imperative engine behind a thin React view.
// All heavy math lives in ../utils.ts as pure functions; this file only orchestrates state.

import { useCallback, useEffect, useReducer, useRef } from 'react'

import { resolveColor } from '@/helpers/resolveToken'

import {
  BORROW,
  BTC_PX,
  CAL_MIN,
  EQUIV,
  MAX_BORROW,
  TEMPLATES,
} from '../fixtures'
import {
  AuditResult,
  Forecast,
  GhostRow,
  Intent,
  Resolution,
  RunResult,
  RunState,
  Scenario,
  SeedInfo,
  St,
} from '../types'
import {
  auditFloor,
  brier,
  buildScenarios,
  calc as calcFn,
  dailySeedId,
  ghostRows,
  hex4,
  fnv,
  liqLine as liqLineFn,
  placed,
  repayNeeded,
  resolveCore,
  seedExperience,
  seedIdFrom,
  usd,
  utcDayStr,
} from '../utils'
import {
  loadCalls,
  loadSeedBook,
  loadView,
  saveCalls,
  saveSeedBook,
  saveView,
} from './useBuilderStorage'

export interface FcRes {
  p: number
  held: boolean
  off: number
  verdict: string
}

export interface Stage {
  scNm: string
  scEra: string
  mechVisible: boolean
  mechBody: string
  scYours: string
  forecastVisible: boolean
  fcQ: string
  fcSub: string
  fcResVisible: boolean
  fcRes: FcRes | null
  tickText: string
  tickHurt: boolean
  tickGold: boolean
  tickNText: string
  pxWidth: number
  auditVisible: boolean
  audit: AuditResult | null
  auditSc: Scenario | null
  auditNeeded: number
  auditSold: number
  howtoVisible: boolean
  ghostsVisible: boolean
  ghosts: GhostRow[] | null
  ghostPlayerR: Resolution | null
  nextVisible: boolean
  retryVisible: boolean
  runHint: string
}

export interface VerdictLedger {
  k: string
  v: string
  n: string
  cls: string
}
export interface VerdictView {
  visible: boolean
  cls: 'pass' | 'fail' | ''
  tag: string
  title: string
  why: string
  ledger: VerdictLedger[]
}

interface Engine {
  st: St
  run: RunState
  seed: SeedInfo
  scenarios: Scenario[]
  history: RunResult[]
  forecasts: Forecast[]
  pending: number | null
  skipped: number
  maxReached: number
  practice: number
  lastTmpl: number
  fcastP: number // forecast slider, 0..100
  lastRes: RunResult | null
  vet: boolean
  cfxOpen: boolean
  stage: Stage
  verdict: VerdictView
}

const emptyStage = (): Stage => ({
  scNm: 'The gauntlet',
  scEra: 'not started',
  mechVisible: false,
  mechBody: '',
  scYours:
    'Fifteen floors, one sweep. A floor you survive pays and carries forward; a floor that would have killed you is voided and marked red — the run walks on either way.',
  forecastVisible: false,
  fcQ: '',
  fcSub: '',
  fcResVisible: false,
  fcRes: null,
  tickText: '$0',
  tickHurt: false,
  tickGold: false,
  tickNText: 'nothing running',
  pxWidth: 0,
  auditVisible: false,
  audit: null,
  auditSc: null,
  auditNeeded: 0,
  auditSold: 0,
  howtoVisible: false,
  ghostsVisible: false,
  ghosts: null,
  ghostPlayerR: null,
  nextVisible: false,
  retryVisible: false,
  runHint: 'Build a board, then take it through the gauntlet. Each floor is a real episode or a constructed one.',
})

const emptyVerdict = (): VerdictView => ({
  visible: false,
  cls: '',
  tag: 'Idle',
  title: 'Nothing built yet.',
  why: 'Drop at least one venue on a slot, then run the gauntlet.',
  ledger: [],
})

const freshRun = (): RunState => ({
  active: false, floor: 0, btc: 1, banked: 0, lost: 0, dead: false, phase: 'idle',
  t: 0, target: 0, shown: 0, ltvCut: 0, debtX: 1, banned: {}, sick: {}, closed: false, marks: [],
})

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o))

export interface BuilderScroll {
  toFloor: () => void
  toBoard: () => void
}

export function useBuilderEngine(scroll?: BuilderScroll) {
  const [, bump] = useReducer((x: number) => x + 1, 0)

  // One-time deterministic seed init — dailySeedId() uses getUTC*, so server and client
  // agree on the same UTC day and produce the same id (no hydration mismatch).
  const engineRef = useRef<Engine | null>(null)
  if (engineRef.current === null) {
    const daily = dailySeedId()
    const seed: SeedInfo = { id: daily, isDaily: true, dateStr: utcDayStr(new Date()) }
    engineRef.current = {
      st: { btc: 1, ltv: 0.4, slots: [null, null, null], intent: 'repay', tested: false },
      run: freshRun(),
      seed,
      scenarios: buildScenarios(seed.id),
      history: [],
      forecasts: [],
      pending: null,
      skipped: 0,
      maxReached: 0,
      practice: -1,
      lastTmpl: -1,
      fcastP: 50,
      lastRes: null,
      vet: false,
      cfxOpen: true,
      stage: emptyStage(),
      verdict: emptyVerdict(),
    }
  }
  const E = engineRef.current

  // ---------- derived helpers bound to current engine state ----------
  const curPlaced = () => placed(E.st.slots)
  const curLiqLine = () => liqLineFn(E.run.active, E.run.ltvCut)
  const curCalc = () =>
    calcFn(curPlaced(), E.st.btc, E.st.ltv, E.st.intent, E.run.active ? E.run.debtX : 1)

  // ---------- calibration ----------
  const paintCalNoop = () => {} // calibration re-renders with the engine; kept for parity

  const scoreForecast = (sold: number) => {
    if (E.pending === null) return
    const o: 0 | 1 = sold <= 1e-9 ? 1 : 0
    const p = E.pending
    const loss = (p - o) * (p - o)
    E.forecasts.push({ p, o, floor: E.run.floor, nm: 'Floor ' + (E.run.floor + 1) + ' — ' + E.scenarios[E.run.floor].n })
    E.pending = null
    saveCalls(E.forecasts, E.skipped)
    E.stage.fcResVisible = true
    E.stage.fcRes = {
      p, held: o === 1, off: Math.abs(p - o) * 100,
      verdict:
        loss < 0.06 ? 'You knew.'
          : loss < 0.25 ? 'Better than a coin flip.'
            : loss < 0.5 ? 'Worse than admitting you did not know.'
              : 'Confidently wrong, which is the expensive kind.',
    }
    paintCalNoop()
  }

  const askForecast = () => {
    const sc = E.scenarios[E.run.floor]
    const c = curCalc()
    const bp = breakPointCur(c)
    E.fcastP = 50
    E.stage.fcQ =
      'Before floor ' + (E.run.floor + 1) + ' runs — what are the odds your board gets through ' + sc.n + ' without selling any bitcoin?'
    E.stage.fcSub =
      sc.days + ' days of carry, then ' +
      (sc.coll > 0 ? 'a ' + (sc.coll * 100).toFixed(0) + '% collateral move' : 'no collateral move at all') +
      '. You are at ' + (c.ltv * 100).toFixed(0) + '% LTV against the 73% line, and bitcoin has to fall ' +
      (bp == null ? 'more than 90%' : 'about ' + (bp * 100).toFixed(0) + '%') + ' before your venues stop covering you.'
    E.stage.forecastVisible = true
    E.stage.fcResVisible = false
    E.stage.tickNText = 'waiting on your call…'
  }

  const breakPointCur = (c: ReturnType<typeof curCalc>): number | null => {
    if (!c.p.length) return null
    const line = curLiqLine()
    for (let d = 0.05; d <= 0.90001; d += 0.01) {
      const px = BTC_PX * (1 - d)
      const collAfter = E.st.btc * px
      if (collAfter <= 0) return d
      const lv = c.debt / collAfter
      if (lv <= line) continue
      const needed = repayNeeded(c.debt, collAfter, lv)
      if (Math.min(E.st.btc, Math.max(0, needed - c.debt * c.liq) / px) > 1e-9) return d
    }
    return null
  }

  // ---------- board editing ----------
  const render = () => {
    if (!E.st.tested) E.verdict.visible = false
    bump()
  }
  const invalidate = () => {
    E.st.tested = false
    render()
  }

  const setBtc = useCallback((v: number) => {
    E.st.btc = v
    invalidate()
  }, [])
  const setLtv = useCallback((v: number) => {
    E.st.ltv = v / 100
    invalidate()
  }, [])
  const setIntent = useCallback((i: Intent) => {
    E.st.intent = i
    invalidate()
  }, [])
  const placeTileAt = useCallback((i: number, id: string) => {
    const prev = E.st.slots.indexOf(id)
    if (prev >= 0 && prev !== i) E.st.slots[prev] = null
    E.st.slots[i] = id
    invalidate()
  }, [])
  const placeTileFree = useCallback((id: string) => {
    const free = E.st.slots.indexOf(null)
    if (free < 0) return
    E.st.slots[free] = id
    invalidate()
  }, [])
  const removeSlot = useCallback((i: number) => {
    E.st.slots[i] = null
    invalidate()
  }, [])
  const clearBoard = useCallback(() => {
    E.st.slots = [null, null, null]
    invalidate()
  }, [])

  const applyTemplate = useCallback((i: number) => {
    const t = TEMPLATES[i]
    E.lastTmpl = i
    E.st.slots = [null, null, null]
    t.slots.forEach((id: string, j: number) => {
      E.st.slots[j] = id
    })
    E.st.ltv = t.ltv
    E.st.tested = false
    E.verdict.visible = true
    E.verdict.cls = ''
    E.verdict.tag = 'Template'
    E.verdict.title = t.nm
    E.verdict.why = t.doc + ' Run the gauntlet to see where it bends.'
    E.verdict.ledger = []
    bump()
  }, [])

  // ---------- run lifecycle ----------
  const enterFloor = () => {
    E.run.snap = {
      floor: E.run.floor, btc: E.run.btc, banked: E.run.banked, lost: E.run.lost,
      debtX: E.run.debtX, ltvCut: E.run.ltvCut, pushed: false,
      banned: clone(E.run.banned), sick: clone(E.run.sick),
    }
    const sc = E.scenarios[E.run.floor]
    const c = curCalc()
    E.stage.scNm = 'Floor ' + (E.run.floor + 1) + ': ' + sc.n
    E.stage.scEra = sc.era
    const hits = curPlaced().filter((t) => (sc.hair[t.cls] || 0) > 0 || sc.freeze.indexOf(t.cls as never) >= 0)
    const pl = curPlaced()
    const ltvAfter = sc.coll < 1 ? c.ltv / (1 - sc.coll) : 9
    const yours = !pl.length
      ? 'Drop a venue on a slot first.'
      : (hits.length ? 'This floor freezes ' + hits.map((t) => t.nm).join(' and ') + '. ' : 'Nothing on your board is frozen by this floor. ') +
        'Either way your venues hand back about ' + (c.liq * 100).toFixed(0) + '% of what is deployed, and a ' +
        (sc.coll * 100).toFixed(0) + '% move takes you to ' + (ltvAfter * 100).toFixed(0) + '% LTV against a ' +
        (curLiqLine() * 100).toFixed(0) + '% line.'
    E.stage.mechVisible = true
    E.stage.mechBody = sc.mech
    E.stage.scYours = yours.trim() || 'Nothing on your board is in an affected class — only the collateral move reaches you.'
    E.stage.runHint =
      'Floor ' + (E.run.floor + 1) + ' of ' + E.scenarios.length + ' — ' + sc.days + ' days, then ' +
      (sc.coll > 0 ? 'a ' + (sc.coll * 100).toFixed(0) + '% collateral move' : 'no collateral move at all') + '.'
    E.run.target = c.debt * c.apr * (sc.days / 365) - c.debt * (sc.rate || BORROW) * (sc.days / 365)
    E.run.shown = 0
    E.run.t = 0
    E.run.phase = 'forecast'
    E.stage.tickHurt = false
    E.stage.tickGold = false
    askForecast()
    E.stage.auditVisible = false
    E.stage.howtoVisible = false
    E.stage.ghostsVisible = false
  }

  const startRun = () => {
    const c = curCalc()
    if (!c.p.length) return
    E.run = { ...freshRun(), active: true, phase: 'accrue', btc: E.st.btc }
    E.practice = -1
    recordSeedRun()
    E.stage.nextVisible = false
    E.stage.fcResVisible = false
    E.pending = null
    E.maxReached = Math.max(E.maxReached, 0)
    enterFloor()
    bump()
    scroll?.toFloor()
  }

  const lockForecast = () => {
    E.pending = E.fcastP / 100
    E.stage.forecastVisible = false
    const sc = E.scenarios[E.run.floor]
    E.stage.tickNText = 'accruing over ' + sc.days + ' days…'
    E.run.phase = 'accrue'
    E.run.t = 0
    E.run.shown = 0
    bump()
  }

  const skipForecast = () => {
    E.pending = null
    E.skipped++
    saveCalls(E.forecasts, E.skipped)
    E.stage.forecastVisible = false
    const sc = E.scenarios[E.run.floor]
    E.stage.tickNText = 'accruing over ' + sc.days + ' days…'
    E.run.phase = 'accrue'
    E.run.t = 0
    E.run.shown = 0
    bump()
  }

  const setForecastP = (v: number) => {
    E.fcastP = v
    bump()
  }

  const resolveFloor = () => {
    const sc = E.scenarios[E.run.floor]
    const R = resolveCore(
      sc,
      { slots: E.st.slots.slice(), ltv: E.st.ltv, btc: E.run.btc, debtX: E.run.debtX, ltvCut: E.run.ltvCut, banned: E.run.banned, sick: E.run.sick },
      E.st.intent,
      E.st.btc,
    )
    E.run.debtX = R.debtXAfter
    E.run.ltvCut = R.ltvCutAfter
    const c = R.c
    E.run.banked += E.run.target
    const a = R.a
    E.run.lost += a.bleed
    const px = R.px, ltvAfter = R.ltvAfter, breached = R.breached, needed = R.needed
    const recalled = R.recalled, cured = R.cured, frozenOut = R.frozenOut, sold = R.sold
    scoreForecast(sold)
    E.run.btc = Math.max(0, E.run.btc - sold)
    E.run.lost += sold * px
    if (sold > 0) E.run.lost += a.haircut

    if (breached && !frozenOut) {
      a.rows.forEach((r) => {
        if (r.ret <= 0) {
          E.run.banned[r.t.id] = 2
          E.run.sick[r.t.id] = 1
        }
      })
    }

    // audit render data
    E.stage.auditVisible = true
    E.stage.audit = a
    E.stage.auditSc = sc
    E.stage.auditNeeded = needed
    E.stage.auditSold = sold
    E.stage.howtoVisible = true

    const dead = a.rows.filter((r) => r.ret <= 0)
    const culprit = dead.length
      ? dead.map((r) => r.t.nm).join(' and ') + ' returned nothing'
      : 'every venue paid, but they only hand back ' + (c.liq * 100).toFixed(0) + '% of what they hold'

    const wiped = E.run.btc <= E.st.btc * 0.75
    E.run.marks[E.run.floor] = wiped ? 'dead' : sold > 0 ? 'hurt' : 'clean'

    if (wiped) {
      const s2 = E.run.snap
      if (s2) {
        E.run.btc = s2.btc
        E.run.banked = s2.banked
        E.run.lost = s2.lost
        E.run.debtX = s2.debtX
        E.run.ltvCut = s2.ltvCut
        E.run.banned = clone(s2.banned)
        E.run.sick = clone(s2.sick)
      }
      E.stage.tickHurt = true
      E.stage.tickGold = false
      E.stage.tickText = '−' + sold.toFixed(3) + ' BTC'
      E.stage.tickNText =
        sc.n + ' would have ended it. ' +
        (ltvAfter >= 1
          ? 'At ' + (ltvAfter * 100).toFixed(0) + '% LTV the engine stops sizing the repayment and comes for the whole ' + usd(needed) + ' of collateral. '
          : (ltvAfter * 100).toFixed(0) + '% LTV meant ' + usd(needed) + ' had to be retired to get back down to the ' + (MAX_BORROW * 100).toFixed(0) + '% borrow cap. ') +
        'Your venues returned ' + usd(recalled) + ' — ' + culprit + ' — so the remaining ' +
        usd(needed - recalled) + ' would have come out of bitcoin: ' + sold.toFixed(3) + ' BTC. ' +
        'The floor is marked red, the damage is voided, and the sweep continues — nothing banked here.'
      E.run.phase = 'shocked'
      E.stage.retryVisible = true
      if (E.run.floor >= E.scenarios.length - 1) {
        E.run.active = false
        endRun()
      } else {
        E.stage.nextVisible = true
      }
    } else {
      const head = (curLiqLine() - ltvAfter) * 100
      E.stage.tickHurt = sold > 0
      E.stage.tickGold = sold <= 0 && head < 8
      E.stage.tickText =
        sold > 0
          ? '−' + sold.toFixed(3) + ' BTC'
          : a.bleed > 0
            ? usd(-a.bleed) + ' bled'
            : E.run.target >= 0
              ? '+' + usd(E.run.target) + ' banked'
              : usd(E.run.target) + ' — the loan cost more than the venues paid'
      E.stage.tickNText =
        sold > 0
          ? (ltvAfter >= 1
              ? 'Past 100% LTV the engine stops sizing the repayment and comes for all of it. '
              : 'A breach does not stop at the line — it repays you back down to the ' + (MAX_BORROW * 100).toFixed(0) + '% borrow cap. ') +
            'That meant ' + usd(needed) + ' had to be retired. Your venues could return ' + usd(recalled) +
            ' (' + culprit + '), so the ' + usd(needed - recalled) + ' left over was covered by selling ' + sold.toFixed(3) + ' BTC.'
          : cured
            ? 'SavedByDelay — breached at ' + (ltvAfter * 100).toFixed(0) + '% LTV, but ' + usd(a.fast) + ' could arrive inside the window against ' + usd(c.debt) + ' owed. The timer cleared and nothing was sold.'
            : frozenOut
              ? 'breached at ' + (ltvAfter * 100).toFixed(0) + '% LTV and nothing happened — the breaker blocked liquidate(). You are carrying that breach into the next floor, and you could not have repaid it either.'
              : breached
                ? 'breached at ' + (ltvAfter * 100).toFixed(0) + '% LTV but recall covered it in full'
                : 'cleared with ' + ((curLiqLine() - ltvAfter) * 100).toFixed(0) + ' points of headroom — ' + (ltvAfter * 100).toFixed(0) + '% LTV against the ' + (curLiqLine() * 100).toFixed(0) + '% liquidation line' +
                  (a.bleed > 0 ? ', though funding still bled ' + usd(a.bleed) : a.haircut > 0 ? '. The dislocation cost nothing because you never had to sell into it' : '')
      E.run.phase = 'shocked'
      E.stage.retryVisible = true
      if (E.run.floor >= E.scenarios.length - 1) {
        E.run.active = false
        endRun()
      } else {
        E.stage.nextVisible = true
      }
    }

    // The roads not taken — rendered unprompted, alive or dead.
    try {
      const ctx = {
        snap: E.run.snap
          ? { btc: E.run.snap.btc, debtX: E.run.snap.debtX, ltvCut: E.run.snap.ltvCut, banned: E.run.snap.banned, sick: E.run.snap.sick }
          : { btc: E.st.btc, debtX: 1, ltvCut: 0, banned: {}, sick: {} },
        slots: E.st.slots,
        ltv: E.st.ltv,
        intent: E.st.intent,
        lastTmpl: E.lastTmpl,
        baseBtc: E.st.btc,
      }
      E.stage.ghosts = ghostRows(sc, R, ctx)
      E.stage.ghostPlayerR = R
      E.stage.ghostsVisible = true
    } catch {
      /* a failure in the lesson table must never take the run down */
    }
    bump()
  }

  const nextFloor = () => {
    E.stage.nextVisible = false
    E.stage.retryVisible = false
    Object.keys(E.run.banned).forEach((k) => {
      E.run.banned[k]--
      if (E.run.banned[k] <= 0) delete E.run.banned[k]
    })
    E.run.floor++
    E.maxReached = Math.max(E.maxReached, E.run.floor)
    enterFloor()
    bump()
    scroll?.toFloor()
  }

  const retryFloor = () => {
    const s2 = E.run.snap
    if (!s2) return
    if (s2.pushed) E.history.pop()
    E.run.active = true
    E.run.dead = false
    E.run.floor = s2.floor
    E.run.btc = s2.btc
    E.run.banked = s2.banked
    E.run.lost = s2.lost
    E.run.debtX = s2.debtX
    E.run.ltvCut = s2.ltvCut
    E.run.banned = clone(s2.banned)
    E.run.sick = clone(s2.sick)
    E.st.tested = false
    E.stage.nextVisible = false
    E.stage.retryVisible = false
    E.verdict.visible = false
    E.stage.auditVisible = false
    E.stage.howtoVisible = false
    enterFloor()
    bump()
    scroll?.toBoard()
  }

  const endRun = () => {
    const deadFloors: number[] = []
    for (let i = 0; i < E.scenarios.length; i++) if (E.run.marks[i] === 'dead') deadFloors.push(i)
    const survived = E.scenarios.length - deadFloors.length
    const res: RunResult = {
      who: 'Your run ' + (E.history.length + 1),
      floors: survived,
      deadFloors,
      marks: E.run.marks.slice(),
      btc: E.run.btc / E.st.btc,
      banked: E.run.banked,
      lost: E.run.lost,
      net: E.run.banked - E.run.lost,
      mine: true,
      seed: E.seed.id,
      unranked: !E.seed.isDaily,
      build:
        (curPlaced().map((t) => t.nm).join(' + ') || 'empty') + ' · seed #' + E.seed.id + (E.seed.isDaily ? '' : ' · practice'),
    }
    E.history.push(res)
    if (E.run.snap) E.run.snap.pushed = true
    recordSeedResult(survived, res.net)
    runVerdict(res)
    E.stage.runHint = deadFloors.length
      ? deadFloors.length + ' of ' + E.scenarios.length + ' floors ran red — each would have ended this board. Re-tune and sweep again.'
      : 'Cleared all ' + E.scenarios.length + '. Re-tune and try to keep more bitcoin.'
  }

  const runVerdict = (res: RunResult) => {
    const reds = res.deadFloors || []
    const cleared = !reds.length
    const sold = Math.max(0, 1 - res.btc)
    const grade = !cleared ? 'dead' : sold <= 0.001 ? 'held' : sold < 0.15 ? 'bruised' : 'costly'
    E.verdict.visible = true
    E.verdict.cls = grade === 'held' ? 'pass' : grade === 'bruised' ? '' : 'fail'
    E.verdict.tag =
      grade === 'dead' ? 'Red on ' + reds.length + ' floor' + (reds.length > 1 ? 's' : '')
        : grade === 'held' ? 'Cleared'
          : grade === 'bruised' ? 'Bruised'
            : 'Sold your stack'
    let title = ''
    let why = ''
    if (grade === 'dead') {
      const nms = reds.map((fi) => fi + 1 + ' · ' + E.scenarios[fi].n).join(', ')
      title = (reds.length > 1 ? reds.length + ' floors would have taken it: ' : 'One floor would have taken it: ') + nms + '.'
      why =
        'Each red floor ended the position in simulation; its damage was voided and the sweep walked on, so the score is the ' +
        res.floors + ' floors that held. The receipt above each red names the venue that did not return — read it before you re-tune, because the fix is usually size, not rate.'
    } else if (grade === 'held') {
      title = 'Cleared all ' + E.scenarios.length + ' floors with the stack intact.'
      why =
        'Every floor was absorbed by the venues and no bitcoin left. ' + usd(res.banked) + ' banked. Worth knowing what that cost you in throughput — the safest board is rarely the highest-paying one, and that trade is the decision, not an accident. This is the fluency the network runs on: capital retention first, optimization second. You are learning the root system.'
    } else if (grade === 'bruised') {
      title = 'Cleared all ' + E.scenarios.length + ', and it cost ' + (sold * 100).toFixed(0) + '% of the stack.'
      why =
        'The position finished, but ' + usd(res.lost) + ' of bitcoin went out the door to keep it there against ' + usd(res.banked) + ' banked — net ' + (res.net >= 0 ? '+' : '') + usd(res.net) + '.'
    } else {
      title = 'It finished, and you sold ' + (sold * 100).toFixed(0) + '% of your bitcoin to do it.'
      why =
        'Surviving every floor is not the goal if the stack pays for it. ' + usd(res.banked) + ' banked against ' + usd(res.lost) + ' of bitcoin sold is a ' + usd(Math.abs(res.net)) + ' loss wearing a yield number. Size down and run it again.'
    }
    E.verdict.title = title
    E.verdict.why = why
    E.verdict.ledger = [
      { k: 'Floors survived', v: res.floors + ' / ' + E.scenarios.length, n: cleared ? 'cleared' : 'red floors voided', cls: cleared ? 'pos' : 'neg' },
      { k: 'Bitcoin kept', v: (res.btc * 100).toFixed(0) + '%', n: (res.btc * E.st.btc).toFixed(3) + ' BTC', cls: sold > 0.001 ? 'neg' : 'pos' },
      { k: 'Yield banked', v: usd(res.banked), n: 'over the run', cls: 'warn' },
      { k: 'Net made', v: (res.net >= 0 ? '+' : '') + usd(res.net), n: 'banked minus bitcoin sold', cls: res.net >= 0 ? 'pos' : 'neg' },
    ]
    E.lastRes = res
    E.st.tested = true
  }

  // ---------- drill one unlocked floor ----------
  const drillFloor = (i: number) => {
    if (i > E.maxReached || E.run.active) return
    E.practice = i
    E.pending = null
    scroll?.toFloor()
    E.stage.forecastVisible = false
    E.stage.fcResVisible = false
    const sc = E.scenarios[i]
    const c = curCalc()
    if (!c.p.length) return
    E.stage.scNm = 'Floor ' + (i + 1) + ': ' + sc.n
    E.stage.scEra = sc.era + ' · drill'
    const hits = curPlaced().filter((t) => (sc.hair[t.cls] || 0) > 0 || sc.freeze.indexOf(t.cls as never) >= 0)
    E.stage.mechVisible = true
    E.stage.mechBody = sc.mech
    const dLtv = sc.coll < 1 ? c.ltv / (1 - sc.coll) : 9
    E.stage.scYours =
      (hits.length ? 'This floor freezes ' + hits.map((t) => t.nm).join(' and ') + '. ' : 'Nothing on your board is frozen by this floor. ') +
      'Either way your venues hand back about ' + (c.liq * 100).toFixed(0) + '% of what is deployed, and a ' +
      (sc.coll * 100).toFixed(0) + '% move takes you to ' + (dLtv * 100).toFixed(0) + '% LTV against a ' + (curLiqLine() * 100).toFixed(0) + '% line.'

    const a = auditFloor(sc, c, curPlaced(), E.run.active, E.run.banned, E.run.sick)
    const px = BTC_PX * (1 - sc.coll)
    const collAfter = E.st.btc * px
    const ltvAfter = collAfter > 0 ? c.debt / collAfter : 99
    const breached = ltvAfter > curLiqLine()
    const needed = breached ? repayNeeded(c.debt, collAfter, ltvAfter) : 0
    const recalled = Math.min(a.recalled, needed)
    const sold = breached ? Math.min(E.st.btc, Math.max(0, needed - recalled) / px) : 0

    E.stage.auditVisible = true
    E.stage.audit = a
    E.stage.auditSc = sc
    E.stage.auditNeeded = needed
    E.stage.auditSold = sold
    E.stage.howtoVisible = true
    E.stage.tickHurt = sold > 0
    E.stage.tickGold = false
    E.stage.tickText = sold > 0 ? '−' + sold.toFixed(3) + ' BTC' : a.haircut > 0 ? '−' + usd(a.haircut) + ' to haircuts' : 'clean'
    E.stage.tickNText =
      'drill only — ' + (ltvAfter * 100).toFixed(0) + '% LTV after the move. ' +
      (breached
        ? usd(needed) + ' would have to be retired to get back to the ' + (MAX_BORROW * 100).toFixed(0) + '% borrow cap, and ' + usd(a.recalled) + ' is recallable.'
        : 'Under the line, so nothing is recalled. ' + usd(a.recalled) + ' was available.') +
      ' Nothing banked, nothing scored.'
    E.stage.pxWidth = 100
    E.stage.ghostsVisible = false
    E.stage.nextVisible = false
    E.stage.retryVisible = false
    E.stage.runHint = 'Drilling floor ' + (i + 1) + '. Re-tune and run it again as many times as you like.'
    bump()
  }

  // ---------- seed book ----------
  const recordSeedRun = () => {
    const bk = loadSeedBook()
    const e = bk[E.seed.id] || { id: E.seed.id, first: E.seed.dateStr, runs: 0, best: -1, bestNet: null }
    e.label = seedExperience(E.scenarios).label
    if (E.seed.isDaily) e.daily = E.seed.dateStr
    e.runs++
    e.last = utcDayStr(new Date())
    bk[E.seed.id] = e
    saveSeedBook(bk)
  }
  const recordSeedResult = (floors: number, net: number) => {
    const bk = loadSeedBook()
    const e = bk[E.seed.id]
    if (!e) return
    if (floors > e.best || (floors === e.best && (e.bestNet == null || net > e.bestNet))) {
      e.best = floors
      e.bestNet = net
    }
    bk[E.seed.id] = e
    saveSeedBook(bk)
  }

  const applySeed = useCallback((raw: string) => {
    const id = seedIdFrom(raw)
    if (!id) return
    const daily = dailySeedId()
    if (id === E.seed.id) {
      E.seed.isDaily = id === daily
      bump()
      return
    }
    E.seed = { id, isDaily: id === daily, dateStr: utcDayStr(new Date()) }
    E.scenarios = buildScenarios(id)
    E.run = freshRun()
    E.practice = -1
    E.pending = null
    E.stage = emptyStage()
    E.stage.scYours =
      'Fifteen floors, drawn from seed #' + E.seed.id + ', one sweep. A floor you survive pays; one that would have killed you is voided and marked red — the run walks on either way.'
    E.stage.runHint = E.seed.isDaily
      ? 'Back on today’s challenge. Build a board, then sweep it through the gauntlet.'
      : 'Practice seed #' + E.seed.id + ' loaded — ' + seedExperience(E.scenarios).label + ' — same machine, different draws, unranked.'
    E.verdict.visible = false
    bump()
  }, [])

  const randomizeSeed = useCallback(() => {
    let r = (fnv(String(Date.now())) ^ (Math.random() * 0xffff)) & 0xffff
    if (hex4(r) === dailySeedId()) r = (r + 1) & 0xffff
    applySeed(hex4(r))
  }, [applySeed])

  const backToDaily = useCallback(() => applySeed(dailySeedId()), [applySeed])

  const challengeUrl = useCallback(() => {
    let base = ''
    try {
      base = location.origin + location.pathname
    } catch {
      /* ignore */
    }
    return base + '?seed=' + E.seed.id
  }, [])

  // ---------- share card (proto drawResultCard :2129) ----------
  const saveResultCard = useCallback(() => {
    const res = E.lastRes
    if (!res || typeof document === 'undefined') return
    const W = 1080, H = 1350, M = 96
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const g = cv.getContext('2d')
    if (!g) return
    const MONO = 'Menlo,Consolas,monospace', SERIF = 'Georgia,serif'
    // Resolve at paint time (not module scope) so the card follows the active theme.
    const BONE = resolveColor('var(--m-text-primary)'), DIM = resolveColor('var(--m-text-secondary)'), FAINT = resolveColor('var(--m-text-tertiary)'), PHOS = resolveColor('var(--m-primary)'), GOLD = resolveColor('var(--m-warning)'), BLOOD = resolveColor('var(--m-danger)')
    // Bone hairline at a given alpha — BONE is already concrete, so compose rgba directly.
    const hair = (a: number): string => {
      if (BONE.startsWith('rgb')) { const [r, g2, b] = BONE.match(/[\d.]+/g) || []; return `rgba(${r},${g2},${b},${a})` }
      const h = BONE.replace('#', ''); return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
    }
    g.fillStyle = resolveColor('var(--m-bg-primary)')
    g.fillRect(0, 0, W, H)
    g.strokeStyle = hair(0.1)
    g.lineWidth = 2
    g.strokeRect(48, 48, W - 96, H - 96)
    const sd = { id: E.seed.id, isDaily: E.seed.isDaily, dateStr: E.seed.dateStr }
    try { g.letterSpacing = '6px' } catch { /* older browsers */ }
    g.font = '26px ' + MONO
    g.fillStyle = DIM
    g.fillText('MEMBRANE GAUNTLET', M, 172)
    const seedLine = sd.isDaily
      ? 'CHALLENGE · ' + sd.dateStr.toUpperCase() + (sd.id ? ' · SEED #' + sd.id.toUpperCase() : '')
      : 'PRACTICE · SEED #' + (sd.id || '?').toUpperCase() + ' · UNRANKED'
    g.fillStyle = sd.isDaily ? BONE : GOLD
    g.fillText(seedLine, M, 220)
    try { g.letterSpacing = '0px' } catch { /* ignore */ }
    const marks = res.marks || null
    const redN = marks ? marks.filter((m) => m === 'dead').length : res.floors >= E.scenarios.length ? 0 : 1
    const cleared = redN === 0
    g.font = '64px ' + SERIF
    g.fillStyle = BONE
    g.fillText(
      cleared ? 'Cleared all ' + E.scenarios.length + ' floors.' : marks ? redN + ' floor' + (redN > 1 ? 's' : '') + ' ran red.' : 'Dead on floor ' + (res.floors + 1) + '.',
      M, 340,
    )
    const n = E.scenarios.length, size = 48, gap = n > 1 ? (W - 2 * M - n * size) / (n - 1) : 0, y0 = 408
    for (let i = 0; i < n; i++) {
      const x = M + i * (size + gap)
      const mk = marks ? marks[i] : i < res.floors ? 'clean' : !cleared && i === res.floors ? 'dead' : null
      if (mk === 'dead') { g.fillStyle = BLOOD; g.fillRect(x, y0, size, size) }
      else if (mk === 'hurt') { g.fillStyle = GOLD; g.fillRect(x, y0, size, size) }
      else if (mk === 'clean') { g.fillStyle = PHOS; g.fillRect(x, y0, size, size) }
      else { g.strokeStyle = hair(0.28); g.lineWidth = 2; g.strokeRect(x + 1, y0 + 1, size - 2, size - 2) }
    }
    g.font = '24px ' + MONO
    g.fillStyle = DIM
    g.fillText(res.floors + ' / ' + n + ' floors', M, y0 + size + 46)
    g.font = '22px ' + MONO
    g.fillStyle = DIM
    try { g.letterSpacing = '4px' } catch { /* ignore */ }
    g.fillText('NET · ON EQUITY · SIMULATED', M, 650)
    try { g.letterSpacing = '0px' } catch { /* ignore */ }
    g.font = '120px ' + MONO
    g.fillStyle = res.net < 0 ? BLOOD : PHOS
    g.fillText((res.net >= 0 ? '+' : '') + usd(res.net), M, 780)
    let y = 880
    const nc = E.forecasts.length, b = brier(E.forecasts)
    if (nc >= CAL_MIN && b != null) {
      const skill = (0.25 - b) / 0.25
      g.font = '30px ' + MONO
      g.fillStyle = skill >= 0 ? PHOS : BLOOD
      g.fillText((skill >= 0 ? '+' : '−') + Math.abs(skill * 100).toFixed(0) + '% vs coin flip', M, y)
      g.font = '22px ' + MONO
      g.fillStyle = DIM
      g.fillText(nc + ' calls scored', M, y + 38)
      y += 118
    }
    if (res.net > 0) {
      let eq: (typeof EQUIV)[number] | null = null
      let months = 0
      for (let j = 0; j < EQUIV.length; j++) {
        const m = Math.floor(res.net / EQUIV[j].mo)
        if (m >= 3) { eq = EQUIV[j]; months = m; break }
      }
      if (!eq) {
        const lastEq = EQUIV[EQUIV.length - 1]
        months = Math.floor(res.net / lastEq.mo)
        if (months >= 1) eq = lastEq
      }
      if (eq) {
        g.font = '34px ' + SERIF
        g.fillStyle = BONE
        g.fillText('= ' + months + ' month' + (months === 1 ? '' : 's') + ' of ' + eq.nm, M, y)
        g.font = '22px ' + MONO
        g.fillStyle = DIM
        g.fillText('at list price · $' + eq.mo + '/mo', M, y + 40)
      }
    }
    g.font = '20px ' + MONO
    g.fillStyle = FAINT
    g.fillText('simulated on six years of measured 8-hour windows · membrane', M, H - 108)
    const url = cv.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = 'membrane-gauntlet-' + sd.dateStr.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() + '.png'
    document.body.appendChild(a)
    try { a.click() } catch { /* ignore */ }
    document.body.removeChild(a)
  }, [])

  // ---------- veteran mode ----------
  const toggleView = useCallback(() => {
    E.vet = !E.vet
    saveView(E.vet)
    bump()
  }, [])

  const runOrContinue = useCallback(() => {
    if (E.stage.nextVisible) nextFloor()
    else startRun()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleCfx = useCallback(() => {
    E.cfxOpen = !E.cfxOpen
    bump()
  }, [])

  const resetCalls = useCallback(() => {
    E.forecasts.length = 0
    E.skipped = 0
    saveCalls(E.forecasts, E.skipped)
    bump()
  }, [])

  // ---------- mount: hydrate persisted state, honour ?seed= ----------
  useEffect(() => {
    const stored = loadCalls()
    E.forecasts = stored.calls
    E.skipped = stored.skipped
    E.vet = loadView()
    // ?seed= from the current URL (proto seedFromUrl :2444)
    let seedParam: string | null = null
    try {
      const m = (location.search || '').match(/[?&]seed=([^&]+)/) || (location.hash || '').match(/[#&]seed=([^&#]+)/)
      if (m) seedParam = decodeURIComponent(m[1])
    } catch {
      /* ignore */
    }
    if (seedParam) applySeed(seedParam)
    else bump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- accrue-phase ticker loop (proto tickRun :1642) ----------
  useEffect(() => {
    let raf = 0
    let last = 0
    const frame = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      const run = E.run
      if (run.active && run.phase === 'accrue') {
        run.t += dt
        const k = Math.min(1, run.t / 1.5)
        run.shown = run.target * k
        E.stage.tickText = (run.shown >= 0 ? '+' : '') + usd(run.shown)
        E.stage.tickHurt = false
        E.stage.tickGold = false
        E.stage.pxWidth = k * 100
        if (k >= 1) {
          run.phase = 'shock'
          run.t = 0
          resolveFloor()
        } else {
          bump()
        }
      } else if (run.active && run.phase === 'shocked') {
        run.t += dt
        if (run.t > 0.6) run.phase = 'wait'
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- derived view snapshot ----------
  // Recomputed every render on purpose: the engine mutates `E` and bumps, so a
  // fresh snapshot each render is the correctness-preserving choice (no memo).
  const view = (() => {
    const c = curCalc()
    const line = curLiqLine()
    const bp = breakPointCur(c)
    const btcSweptLabel =
      E.run.marks && E.run.marks.length >= E.scenarios.length
        ? 'swept ' + E.scenarios.length
        : E.practice >= 0
          ? 'drill ' + (E.practice + 1)
          : '—'
    return {
      st: E.st,
      run: E.run,
      seed: E.seed,
      scenarios: E.scenarios,
      history: E.history,
      forecasts: E.forecasts,
      skipped: E.skipped,
      maxReached: E.maxReached,
      practice: E.practice,
      fcastP: E.fcastP,
      vet: E.vet,
      cfxOpen: E.cfxOpen,
      stage: E.stage,
      verdict: E.verdict,
      lastRes: E.lastRes,
      calc: c,
      liqLine: line,
      breakPoint: bp,
      placed: c.p,
      rFloorLabel: E.run.active ? E.run.floor + 1 + ' / ' + E.scenarios.length : btcSweptLabel,
      netMade: E.run.banked - E.run.lost,
      bTestMode: E.stage.nextVisible ? ('continue' as const) : ('run' as const),
    }
  })()

  return {
    view,
    actions: {
      setBtc, setLtv, setIntent, placeTileAt, placeTileFree, removeSlot, clearBoard,
      applyTemplate, startRun, runOrContinue, nextFloor, retryFloor, lockForecast,
      skipForecast, setForecastP, drillFloor, applySeed, randomizeSeed, backToDaily,
      challengeUrl, saveResultCard, toggleView, toggleCfx, resetCalls,
    },
  }
}

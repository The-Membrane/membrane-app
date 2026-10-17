// DESIGN CANDIDATES for the cost-vs-reward tracker (board Q34), for pages/dev/cost-reward.tsx.
// Spec: membrane-board design/COST_REWARD_TRACKER.md and its wireframe
// (design/assets/cost-reward-tracker-wireframe.html). Every figure comes from the captured
// archive reads (costRewardFixture.json, through lib/position/costReward.ts).
//
//   A  the spec's tracker   cost and income $/yr at today's size, one shared chart, window
//                           tabs, "At this read", sources and data table (faithful)
//   B  yield spread         S(t) = income − interest about $0: one line (needs ruling 1);
//                           incentives ‡ as a separate current-only figure
//   C  compact card         the yield spread first (one line about $0, now in $/yr and %),
//                           "Interest paid" and "Income earned" folded below it (round 5)
//
// Claim limits (spec §3, §4): annualized snapshots only, never integrated into earned or
// paid; a crossing is not a break-even date; incentives separate (‡) and CURRENT ONLY (no
// APR history behind a campaign, never back-filled from its start). The forward segment
// is drawn as its region and time extent only, hatched, "model pending" (owner, Q27 r3);
// the spec would end the plot at the last observation. Ink only: cost solid, income
// dashed, direct labels; no colour carries meaning alone.

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { fmtAmount, fmtInt, fmtUtc } from '@/lib/position/format'
import {
  FORECAST_EXTENT_D,
  WINDOWS,
  dayLabel,
  netValue,
  pct2,
  signedPct,
  signedUsd,
  spreadNow,
  spreadPct,
  usd2,
  windowed,
  type HistoryWindow,
  type RateFixture,
  type SpreadNow,
  type Track,
} from '@/lib/position/costReward'

import { Headline, Kicker, Mono, Small } from '../primitives'
import { TYPE, TYPE_PX } from '../typeScale'

import type { VariantKey } from './costRewardVariantMeta'

export { VARIANTS, type VariantKey } from './costRewardVariantMeta'

/** The SVG is drawn at its real pixel width so 11px labels stay 11px at 390px. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number | null] {
  const ref = useRef<T>(null)
  const [w, setW] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width
      if (cw && cw > 0) setW(Math.round(cw))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** A 1-2-5 step that gives about `n` ticks over [lo, hi]. */
function ticks(lo: number, hi: number, n = 3): number[] {
  const span = hi - lo || Math.abs(hi) || 1
  const raw = span / n
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)))
  return out
}

const LABEL = { fontFamily: NEWS_FONT.mono, fontSize: TYPE_PX.label, fill: NEWS.muted } as const
/** A paper halo under a direct label that sits on the plot. */
const HALO = { paintOrder: 'stroke' as const, stroke: NEWS.paper, strokeWidth: 3, strokeLinejoin: 'round' as const }
const CHAR_W = TYPE_PX.label * 0.6
const INCOME_DASH = '6 4'

const Defs: React.FC<{ uid: string }> = ({ uid }) => (
  <defs>
    <pattern id={`${uid}-dots`} width="4" height="4" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="0.8" fill={NEWS.ink} opacity={0.45} />
    </pattern>
    <pattern id={`${uid}-hatch`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="7" stroke={NEWS.ruleStrong} strokeWidth="1" />
    </pattern>
  </defs>
)

interface Frame {
  width: number
  height: number
  m: { left: number; right: number; top: number; bottom: number }
}

const xOf = (t: Track, f: Frame) => (ts: number) =>
  f.m.left + ((ts - t.from) / (t.forecastTo - t.from)) * (f.width - f.m.left - f.m.right)

const path = (pts: Array<[number, number]>) => pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('')

/** The forward segment: hatched, labelled, no value and no band. */
const Pending: React.FC<{ t: Track; f: Frame; uid: string; compact?: boolean }> = ({ t, f, uid, compact }) => {
  const x = xOf(t, f)
  const x0 = x(t.to)
  const x1 = x(t.forecastTo)
  const y0 = f.m.top
  const h = f.height - f.m.top - f.m.bottom
  const lines = compact ? ['model', 'pending'] : ['Forecast', 'model pending', 'Q33 · Q34']
  const fits = lines.every((l) => l.length * CHAR_W <= x1 - x0 - 8)
  return (
    <g data-testid="forecast-pending">
      <rect x={x0} y={y0} width={x1 - x0} height={h} fill={`url(#${uid}-hatch)`} />
      <line x1={x0} x2={x0} y1={y0} y2={y0 + h} stroke={NEWS.ink} strokeWidth={1} />
      {fits &&
        lines.map((l, i) => (
          <text key={l} x={x0 + 6} y={y0 + 12 + i * 13} {...LABEL} fill={i === 0 && !compact ? NEWS.ink : NEWS.muted}>
            {l}
          </text>
        ))}
    </g>
  )
}

/** First and last observation dates, and the end of the forward extent (right-anchored). */
const TimeAxis: React.FC<{ t: Track; f: Frame }> = ({ t, f }) => {
  const x = xOf(t, f)
  const y = f.height - f.m.bottom + 14
  return (
    <g>
      <text x={x(t.from)} y={y} {...LABEL}>
        {dayLabel(t.from)}
      </text>
      <text x={x(t.to) - 3} y={y} {...LABEL} textAnchor="end" fill={NEWS.ink}>
        {dayLabel(t.to)}
      </text>
      <text x={x(t.forecastTo)} y={y} {...LABEL} textAnchor="end">
        +{FORECAST_EXTENT_D}d
      </text>
    </g>
  )
}

const frameFor = (width: number): Frame => ({
  width,
  height: Math.round(Math.min(280, Math.max(220, width * 0.45))),
  m: { left: 48, right: 8, top: 14, bottom: 24 },
})

/** Keyboard and touch date selection over a chart (spec §4: no hover-only disclosure). */
function useScrub(n: number) {
  const [i, setI] = useState(n - 1)
  useEffect(() => setI(n - 1), [n])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setI((v) => Math.max(0, v - 1))
    else if (e.key === 'ArrowRight') setI((v) => Math.min(n - 1, v + 1))
    else if (e.key === 'Home') setI(0)
    else if (e.key === 'End') setI(n - 1)
    else return
    e.preventDefault()
  }
  return { i, setI, onKeyDown }
}

/** Picks the nearest observation under a pointer. */
const pick = (t: Track, f: Frame, e: React.PointerEvent<SVGSVGElement>, set: (i: number) => void) => {
  const box = e.currentTarget.getBoundingClientRect()
  const px = e.clientX - box.left
  const x = xOf(t, f)
  let best = 0
  t.points.forEach((p, k) => {
    if (Math.abs(x(p.ts) - px) < Math.abs(x(t.points[best].ts) - px)) best = k
  })
  set(best)
}

const SVG_FOCUS = { '& svg': { outline: 'none' }, '& svg:focus-visible': { outline: `1px solid ${NEWS.ink}`, outlineOffset: '2px' } }

// ------------------------------------------------------------------ A: the spec's tracker

const TwoLines: React.FC<{ t: Track; width: number; uid: string; sel: number; setSel: (i: number) => void; onKeyDown: (e: React.KeyboardEvent) => void }> = ({
  t,
  width,
  uid,
  sel,
  setSel,
  onKeyDown,
}) => {
  const f = frameFor(width)
  const x = xOf(t, f)
  const top = Math.max(...t.points.map((p) => Math.max(p.costRate, p.rewardRate)))
  const yt = ticks(0, top)
  const yMax = Math.max(top, yt[yt.length - 1]) * 1.06
  const y = (v: number) => f.m.top + (1 - v / yMax) * (f.height - f.m.top - f.m.bottom)
  const cost = t.points.map((p) => [x(p.ts), y(p.costRate)] as [number, number])
  const income = t.points.map((p) => [x(p.ts), y(p.rewardRate)] as [number, number])
  const last = t.points[t.points.length - 1]
  const s = t.points[sel]
  const lx = x(t.to) - 6
  return (
    <svg width={width} height={f.height} style={{ display: 'block' }} tabIndex={0} role="img"
      aria-label={`Cost and income, dollars per year at today's size and prices, ${dayLabel(t.from)} to ${dayLabel(t.to)}. Cost ${usd2(last.costRate)}, income ${usd2(last.rewardRate)} at the last observation. Left and right arrows step the selected date. Forward ${FORECAST_EXTENT_D} days: model pending.`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => pick(t, f, e, setSel)}
    >
      <Defs uid={uid} />
      {yt.map((v) => (
        <g key={v}>
          <line x1={f.m.left} x2={x(t.to)} y1={y(v)} y2={y(v)} stroke={v === 0 ? NEWS.ink : NEWS.rule} strokeDasharray={v === 0 ? undefined : '1 3'} />
          <text x={f.m.left - 4} y={y(v) + 4} {...LABEL} textAnchor="end">
            {usd2(v)}
          </text>
        </g>
      ))}
      <line x1={x(s.ts)} x2={x(s.ts)} y1={f.m.top} y2={y(0)} stroke={NEWS.ruleStrong} />
      <path d={path(cost)} fill="none" stroke={NEWS.ink} strokeWidth={2} />
      <path d={path(income)} fill="none" stroke={NEWS.ink} strokeWidth={2} strokeDasharray={INCOME_DASH} />
      <circle cx={x(s.ts)} cy={y(s.costRate)} r={3.5} fill={NEWS.ink} />
      <circle cx={x(s.ts)} cy={y(s.rewardRate)} r={3.5} fill={NEWS.paper} stroke={NEWS.ink} strokeWidth={1.5} />
      <text x={lx} y={y(last.costRate) - 7} {...LABEL} fill={NEWS.ink} textAnchor="end" fontWeight={700} style={HALO}>
        Cost —
      </text>
      <text x={lx} y={y(last.rewardRate) + (last.rewardRate < last.costRate ? 15 : -7)} {...LABEL} fill={NEWS.ink} textAnchor="end" fontWeight={700} style={HALO}>
        Income – –
      </text>
      <Pending t={t} f={f} uid={uid} />
      <TimeAxis t={t} f={f} />
    </svg>
  )
}

const TAB = {
  borderRadius: 0,
  minH: '44px',
  minW: '44px',
  px: SPACING.sm,
  fontFamily: NEWS_FONT.mono,
  fontSize: TYPE.label,
  fontWeight: 400,
  bg: 'transparent',
  color: NEWS.ink,
  border: `1px solid ${NEWS.rule}`,
  transition: TRANSITIONS.colors,
  _hover: { bg: NEWS.raised },
  _focusVisible: FOCUS_STYLES.ring,
  // The app's button theme sets caps and wide tracking; a window tab reads as data.
  textTransform: 'none',
  letterSpacing: 'normal',
} as const

const WINDOW_LABEL: Record<HistoryWindow, string> = { '7d': '7d', '30d': '30d', all: 'Available' }

const ReadRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <Box borderBottom={`1px solid ${NEWS.rule}`} py={SPACING.sm} minW={0}>
    <Small color={NEWS.ink2}>{label}</Small>
    <Mono overflowWrap="anywhere">{children}</Mono>
  </Box>
)

const TrackerA: React.FC<{ fx: RateFixture; track: Track; wide: boolean }> = ({ fx, track, wide }) => {
  const [win, setWin] = useState<HistoryWindow>('30d')
  const t = windowed(track, win)
  const { i, setI, onKeyDown } = useScrub(t.points.length)
  const sel = t.points[Math.min(i, t.points.length - 1)]
  const k = Math.min(i, t.points.length - 1)
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = `crA${useId().replace(/:/g, '')}`
  const debt = t.legs.filter((l) => l.side === 'cost')
  const income = t.legs.filter((l) => l.side === 'reward')
  const sum = (ls: typeof debt) => ls.reduce((a, l) => a + l.sizeUsd, 0)
  const lastRead = fmtUtc(track.to * 1000)
  return (
    <Box display="grid" gap={SPACING.sm} minW={0}>
      <Kicker tone="muted">Cost and income</Kicker>
      <Headline>What rates cost and pay</Headline>
      <Mono color={NEWS.ink2}>Measured rates · today&apos;s size and prices</Mono>
      <Box display="flex" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={SPACING.sm} borderBottom={`1px solid ${NEWS.ruleStrong}`} pb={SPACING.sm}>
        <Small>
          {dayLabel(t.from)} – {dayLabel(t.to)} · {t.points.length} daily reads
        </Small>
        <Box role="group" aria-label="History window" display="flex" gap={SPACING.xs}>
          {WINDOWS.map((w) => (
            <Button key={w} {...TAB} aria-pressed={w === win} borderColor={w === win ? NEWS.ink : NEWS.rule} borderBottomWidth={w === win ? '3px' : '1px'} onClick={() => setWin(w)}>
              {WINDOW_LABEL[w]}
            </Button>
          ))}
        </Box>
      </Box>
      <Box display="grid" gridTemplateColumns={wide ? { base: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 240px' } : 'minmax(0, 1fr)'} gap={SPACING.lg} minW={0}>
        <Box as="figure" m={0} display="grid" gap={SPACING.xs} minW={0}>
          <Small>$ / year at today&apos;s size and prices</Small>
          <Box ref={ref} w="100%" minW={0} minH={`${frameFor(width ?? 440).height}px`} sx={SVG_FOCUS}>
            {width !== null && <TwoLines t={t} width={width} uid={uid} sel={k} setSel={setI} onKeyDown={onKeyDown} />}
          </Box>
          <Mono aria-live="polite" fontSize={TYPE.label}>
            {fmtUtc(sel.ts * 1000)} · cost {usd2(sel.costRate)}/yr ({debt.map((l) => `${l.symbol} ${pct2(l.aprs[k])}`).join(', ')}) · income {usd2(sel.rewardRate)}/yr ({income.map((l) => `${l.symbol} ${pct2(l.aprs[k])}`).join(', ')})
          </Mono>
          <Text as="figcaption" fontFamily={NEWS_FONT.display} fontStyle="italic" fontSize={TYPE.body} color={NEWS.ink}>
            Annualized snapshots. A crossing is not a break-even date.
          </Text>
          <Small textAlign="right">Source: {fx.position.label} Pool getReserveData, one archive read a day</Small>
        </Box>
        <Box as="aside" aria-label="Position rate details" borderLeft={wide ? { base: 'none', md: `1px solid ${NEWS.rule}` } : 'none'} pl={wide ? { base: 0, md: SPACING.base } : 0} minW={0}>
          <Text fontFamily={NEWS_FONT.display} fontWeight={700} fontSize={TYPE.head} color={NEWS.ink}>
            At this read
          </Text>
          <ReadRow label="Debt size">
            {usd2(sum(debt))} · {debt.map((l) => `${fmtAmount(l.amount, 0)} ${l.symbol}`).join(', ')}
          </ReadRow>
          <ReadRow label="Income assets">
            {usd2(sum(income))} · {income.map((l) => `${fmtAmount(l.amount, 2)} ${l.symbol}`).join(', ')}
          </ReadRow>
          <ReadRow label="Covered debt / total">
            {usd2(sum(debt))} / {usd2(sum(debt))} · {debt.length} of {debt.length} legs
          </ReadRow>
          <ReadRow label="Incentives ‡">
            <IncentiveWords now={spreadNow(track, fx)} />
          </ReadRow>
          <ReadRow label="Observation age">Last read {lastRead} · block {fmtInt(fx.block)} · a captured fixture, not live</ReadRow>
        </Box>
      </Box>
      <Box as="details" borderTop={`1px solid ${NEWS.rule}`} sx={{ '& > summary': { cursor: 'pointer', minHeight: '44px', display: 'flex', alignItems: 'center' } }}>
        <Box as="summary" fontFamily={NEWS_FONT.mono} fontSize={TYPE.body} color={NEWS.ink} _focusVisible={FOCUS_STYLES.ring}>
          Sources and data
        </Box>
        <Box display="grid" gap={SPACING.xs} pb={SPACING.sm}>
          <Small>Chart values use fixed current quantities and prices. They do not reconstruct paid interest or realized profit.</Small>
          {sourceLines(fx).map((l) => (
            <Small key={l} overflowWrap="anywhere">
              {l}
            </Small>
          ))}
          <Box as="table" w="100%" sx={{ borderCollapse: 'collapse', '& td, & th': { fontFamily: NEWS_FONT.mono, fontSize: TYPE.label, textAlign: 'right', padding: '2px 4px', borderBottom: `1px solid ${NEWS.rule}` }, '& th:first-of-type, & td:first-of-type': { textAlign: 'left', paddingLeft: 0 } }}>
            <caption style={{ textAlign: 'left' }}>
              <Small as="span">Observations in this window, newest first</Small>
            </caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {t.legs.map((l) => (
                  <th key={l.symbol} scope="col">
                    {l.symbol} {l.side === 'cost' ? 'borrow' : 'supply'}
                  </th>
                ))}
                <th scope="col">Cost $/yr</th>
                <th scope="col">Income $/yr</th>
              </tr>
            </thead>
            <tbody>
              {t.points
                .map((p, j) => (
                  <tr key={p.ts}>
                    <td>{dayLabel(p.ts)}</td>
                    {t.legs.map((l) => (
                      <td key={l.symbol}>{pct2(l.aprs[j])}</td>
                    ))}
                    <td>{fmtInt(p.costRate)}</td>
                    <td>{fmtInt(p.rewardRate)}</td>
                  </tr>
                ))
                .reverse()}
            </tbody>
          </Box>
        </Box>
      </Box>
      <Small borderTop={`1px solid ${NEWS.rule}`} pt={SPACING.sm}>
        ‡ Incentives are reported separately; eligibility and end dates apply. Price changes and exit costs are outside these rate snapshots.
      </Small>
    </Box>
  )
}

// ------------------------------------------------------------------ B: income minus interest

const SpreadChart: React.FC<{
  t: Track
  width: number
  uid: string
  /** The spread now with incentives ‡: one marked point at the last read, never a line. */
  withInc?: number | null
  height?: number
  compact?: boolean
}> = ({ t, width, uid, withInc = null, height, compact = false }) => {
  const f0 = frameFor(width)
  const f: Frame = height ? { ...f0, height, m: { ...f0.m, left: compact ? 56 : f0.m.left } } : f0
  const x = xOf(t, f)
  const inc = withInc !== null && withInc !== t.points[t.points.length - 1].spread ? withInc : null
  const lo = Math.min(0, ...t.points.map((p) => p.spread), inc ?? 0)
  const hi = Math.max(0, ...t.points.map((p) => p.spread), inc ?? 0)
  const yt = ticks(lo, hi, compact ? 2 : 3)
  const pad = (hi - lo || 1) * 0.08
  const yLo = Math.min(lo, yt[0]) - pad
  const yHi = Math.max(hi, yt[yt.length - 1]) + pad
  const y = (v: number) => f.m.top + ((yHi - v) / (yHi - yLo)) * (f.height - f.m.top - f.m.bottom)
  const line = t.points.map((p) => [x(p.ts), y(p.spread)] as [number, number])
  const area = path([[x(t.from), y(0)], ...line, [x(t.to), y(0)]]) + 'Z'
  const last = t.points[t.points.length - 1]
  return (
    <svg width={width} height={f.height} role="img" aria-label={`Yield spread (income less interest), dollars per year at today's size and prices, ${dayLabel(t.from)} to ${dayLabel(t.to)}: ${signedUsd(last.spread)} at the last observation${withInc !== null && withInc !== last.spread ? `; ${signedUsd(withInc)} with current incentives` : ''}. Forward ${FORECAST_EXTENT_D} days: model pending.`}>
      <Defs uid={uid} />
      {yt.filter((v) => v !== 0).map((v) => (
        <g key={v}>
          <line x1={f.m.left} x2={x(t.to)} y1={y(v)} y2={y(v)} stroke={NEWS.rule} strokeDasharray="1 3" />
          <text x={f.m.left - 4} y={y(v) + 4} {...LABEL} textAnchor="end">
            {usd2(v)}
          </text>
        </g>
      ))}
      <path d={area} fill={`url(#${uid}-dots)`} />
      <path d={path(line)} fill="none" stroke={NEWS.ink} strokeWidth={2} />
      <line x1={f.m.left} x2={x(t.to)} y1={y(0)} y2={y(0)} stroke={NEWS.ink} strokeWidth={1} />
      <text x={f.m.left - 4} y={y(0) + 4} {...LABEL} textAnchor="end" fill={NEWS.ink}>
        $0
      </text>
      {/* Names the shaded side of $0 (owner: "negative spread"), inside the area it labels. */}
      <text x={f.m.left + 4} y={y(0) + (last.spread < 0 ? 14 : -6)} {...LABEL} fill={NEWS.ink}>
        {last.spread < 0 ? 'negative spread' : 'positive spread'}
      </text>
      <text x={x(t.to) - 6} y={y(last.spread) + (last.spread < 0 ? 15 : -7)} {...LABEL} textAnchor="end" fill={NEWS.ink} fontWeight={700} style={HALO}>
        {signedUsd(last.spread)}/yr
      </text>
      {inc !== null && (
        // Current only (Merkl has no APR history): one ‡ mark at the last read, no line back.
        <g data-testid="spread-incentive-point">
          <line x1={x(t.to)} x2={x(t.to)} y1={y(last.spread)} y2={y(inc)} stroke={NEWS.ink} strokeDasharray="2 2" />
          <circle cx={x(t.to)} cy={y(inc)} r={3.5} fill={NEWS.paper} stroke={NEWS.ink} strokeWidth={1.5} />
          <text x={x(t.to) - 6} y={y(inc) + (inc < last.spread ? 15 : -7)} {...LABEL} textAnchor="end" fill={NEWS.ink} style={HALO}>
            {signedUsd(inc)} with ‡
          </text>
        </g>
      )}
      <Pending t={t} f={f} uid={uid} />
      <TimeAxis t={t} f={f} />
    </svg>
  )
}

/** The incentives ‡ in words: each live campaign, or that the source has none for a leg. */
const IncentiveWords: React.FC<{ now: SpreadNow }> = ({ now }) => {
  if (!now.stamp) return <>Not read for this position · shown separately when read</>
  const live = now.legs.filter((l) => l.campaigns.length > 0)
  const none = now.legs.filter((l) => l.campaigns.length === 0)
  return (
    <>
      {live.map((l) => (
        <React.Fragment key={`${l.side}${l.symbol}`}>
          {l.symbol} {l.side} {pct2(l.apr)} · +{usd2(l.usdPerYear)}/yr to the spread ·{' '}
          {l.campaigns.map((c) => `${c.name}${c.end ? ` · ends ${dayLabel(c.end)}` : ''}`).join('; ')} · eligibility not checked
          <br />
        </React.Fragment>
      ))}
      {none.length > 0 && (
        <>
          No live campaign for {none.map((l) => `${l.symbol} ${l.side}`).join(' or ')}
          <br />
        </>
      )}
      {now.stamp} · current only: no APR history, never back-filled
    </>
  )
}

const VariantB: React.FC<{ fx: RateFixture; track: Track }> = ({ fx, track }) => {
  const t = windowed(track, '30d')
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = `crB${useId().replace(/:/g, '')}`
  const now = spreadNow(track, fx)
  const pct = spreadPct(now.base, track)
  return (
    <Box display="grid" gap={SPACING.xs} minW={0}>
      <Kicker tone="muted">Yield spread · proposed number †</Kicker>
      <Small>Income less interest · $ / year at today&apos;s size and prices · 30d · incentives ‡ beside it, not in the line</Small>
      <Box ref={ref} w="100%" minW={0} minH={`${frameFor(width ?? 440).height}px`}>
        {width !== null && <SpreadChart t={t} width={width} uid={uid} withInc={now.withIncentives} />}
      </Box>
      <Box display="grid" gridTemplateColumns="minmax(0, 1fr) auto" columnGap={SPACING.sm} borderTop={`1px solid ${NEWS.rule}`} pt={SPACING.xs} data-testid="spread-now">
        <Small color={NEWS.ink2}>Yield spread now</Small>
        <Mono fontWeight={700} textAlign="right">
          {signedUsd(now.base)}/yr{pct !== null ? ` · ${signedPct(pct)}` : ''}
        </Mono>
        <Small color={NEWS.ink2}>With incentives ‡, now</Small>
        <Mono textAlign="right" data-testid="spread-with-incentives">
          {now.withIncentives === null
            ? 'not read'
            : now.withIncentives === now.base
              ? `${signedUsd(now.withIncentives)}/yr · no live campaign`
              : `${signedUsd(now.withIncentives)}/yr${spreadPct(now.withIncentives, track) !== null ? ` · ${signedPct(spreadPct(now.withIncentives, track)!)}` : ''}`}
        </Mono>
      </Box>
      <Small overflowWrap="anywhere">
        ‡ <IncentiveWords now={now} />
      </Small>
      <Small>% of net value {usd2(netValue(track))} (collateral less debt, at today&apos;s size and prices).</Small>
      <Text fontFamily={NEWS_FONT.display} fontStyle="italic" fontSize={TYPE.body} color={NEWS.ink}>
        Annualized snapshots. Crossing $0 is not a break-even date, and a spread is not profit.
      </Text>
      <Small>† A new kind of number: awaits owner ruling 1 (Q34 spec §9).</Small>
    </Box>
  )
}

// ------------------------------------------------------------------ C: compact card

const Spark: React.FC<{ t: Track; values: number[]; width: number; dashed: boolean; uid: string; label: string }> = ({ t, values, width, dashed, uid, label }) => {
  const f: Frame = { width, height: 36, m: { left: 0, right: 0, top: 3, bottom: 3 } }
  const x = xOf(t, f)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const y = (v: number) => f.m.top + (1 - (v - lo) / (hi - lo || 1)) * (f.height - f.m.top - f.m.bottom)
  const pts = t.points.map((p, i) => [x(p.ts), y(values[i])] as [number, number])
  const end = pts[pts.length - 1]
  return (
    <svg width={width} height={f.height} role="img" aria-label={label}>
      <Defs uid={uid} />
      <path d={path(pts)} fill="none" stroke={NEWS.ink} strokeWidth={1.5} strokeDasharray={dashed ? INCOME_DASH : undefined} />
      <circle cx={end[0]} cy={end[1]} r={2.5} fill={NEWS.ink} />
      <Pending t={t} f={f} uid={uid} compact />
    </svg>
  )
}

/** One folded section of the compact card: a heading that opens its legs (aria-expanded). */
const Fold: React.FC<{ title: string; figure: string; id: string; children: React.ReactNode }> = ({ title, figure, id, children }) => {
  const [open, setOpen] = useState(false)
  return (
    <Box borderBottom={`1px solid ${NEWS.rule}`} minW={0}>
      <Button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        data-testid={`fold-${id}`}
        variant="unstyled"
        w="100%"
        h="auto"
        minH="44px"
        borderRadius={0}
        display="grid"
        gridTemplateColumns="1.5em minmax(0, 1fr) auto"
        alignItems="center"
        textAlign="left"
        fontFamily={NEWS_FONT.mono}
        fontSize={TYPE.body}
        fontWeight={400}
        color={NEWS.ink}
        whiteSpace="normal"
        textTransform="none"
        letterSpacing="normal"
        transition={TRANSITIONS.shadow}
        // Owner: no green on hover; the row lifts with the hard print shadow instead.
        _hover={{ boxShadow: NEWS.shadowRaised }}
        _focusVisible={FOCUS_STYLES.ring}
      >
        <Box as="span" aria-hidden>
          {open ? '▾' : '▸'}
        </Box>
        <Box as="span">{title}</Box>
        <Box as="span" fontWeight={700}>
          {figure}
        </Box>
      </Button>
      <Box id={id} hidden={!open} pb={SPACING.sm} display={open ? 'grid' : 'none'} gap={SPACING.sm}>
        {children}
      </Box>
    </Box>
  )
}

const VariantC: React.FC<{ fx: RateFixture; track: Track }> = ({ fx, track }) => {
  const t = windowed(track, '30d')
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = `crC${useId().replace(/:/g, '')}`
  const w = Math.min(width ?? 360, 420)
  const now = spreadNow(track, fx)
  const pct = spreadPct(now.base, track)
  const n = t.points.length
  const legRow = (l: Track['legs'][number], i: number) => (
    <Box key={l.symbol} display="grid" gap={SPACING.xs}>
      <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.sm} flexWrap="wrap">
        <Mono>
          {l.symbol} {l.side === 'cost' ? 'borrow' : 'supply'} {pct2(l.aprs[l.aprs.length - 1])} on {usd2(l.sizeUsd)}
        </Mono>
        <Mono fontWeight={700}>{usd2(l.rates[l.rates.length - 1])}/yr</Mono>
      </Box>
      {width !== null && (
        <Spark
          t={t}
          values={l.rates}
          width={w}
          dashed={l.side === 'reward'}
          uid={`${uid}-${i}`}
          label={`${l.symbol} ${l.side === 'cost' ? 'borrow' : 'supply'} at today's size, ${dayLabel(t.from)} to ${dayLabel(t.to)}, ${usd2(Math.min(...l.rates))} to ${usd2(Math.max(...l.rates))} a year; forward ${FORECAST_EXTENT_D} days model pending`}
        />
      )}
      <Small>
        {dayLabel(t.from)} – {dayLabel(t.to)} · low {pct2(Math.min(...l.aprs))} · high {pct2(Math.max(...l.aprs))}
      </Small>
    </Box>
  )
  const cost = t.legs.filter((l) => l.side === 'cost')
  const income = t.legs.filter((l) => l.side === 'reward')
  const sum = (ls: typeof cost) => ls.reduce((a, l) => a + l.rates[l.rates.length - 1], 0)
  const incSupply = now.legs.filter((l) => l.side === 'supply' && l.campaigns.length > 0)
  const incBorrow = now.legs.filter((l) => l.side === 'borrow' && l.campaigns.length > 0)
  return (
    <Box ref={ref} display="grid" gap={SPACING.sm} borderTop={`2px solid ${NEWS.ink}`} pt={SPACING.sm} maxW="420px" minW={0}>
      <Kicker tone="muted">Yield spread · at today&apos;s size</Kicker>
      <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.sm} flexWrap="wrap" data-testid="compact-spread">
        <Mono>Income less interest, now</Mono>
        <Mono fontWeight={700}>
          {signedUsd(now.base)}/yr{pct !== null ? ` · ${signedPct(pct)}` : ''}
        </Mono>
      </Box>
      {width !== null && <SpreadChart t={t} width={w} uid={`${uid}-s`} withInc={now.withIncentives} height={120} compact />}
      <Small>
        {dayLabel(t.from)} – {dayLabel(t.to)} · {n} daily reads · % of net value {usd2(netValue(track))}
      </Small>
      <Box borderTop={`1px solid ${NEWS.rule}`}>
        <Fold title="Interest paid" figure={`${usd2(sum(cost))}/yr`} id={`${uid}-cost`}>
          {cost.map(legRow)}
          {incBorrow.map((l) => (
            <Small key={l.symbol}>
              ‡ {l.symbol} borrow incentive {pct2(l.apr)} takes {usd2(l.usdPerYear)}/yr off, current only
            </Small>
          ))}
        </Fold>
        <Fold title="Income earned" figure={`${usd2(sum(income))}/yr`} id={`${uid}-income`}>
          {income.map((l, i) => legRow(l, i + cost.length))}
          {incSupply.map((l) => (
            <Small key={l.symbol}>
              ‡ {l.symbol} supply incentive {pct2(l.apr)} adds {usd2(l.usdPerYear)}/yr, current only
            </Small>
          ))}
        </Fold>
      </Box>
      <Small overflowWrap="anywhere">
        ‡ <IncentiveWords now={now} />
      </Small>
      <Small>Rates at today&apos;s size, $/yr: not totals paid or earned · forward {FORECAST_EXTENT_D}d hatched: model pending (Q33, Q34)</Small>
    </Box>
  )
}

// ------------------------------------------------------------------ frame

export const CostRewardVariant: React.FC<{ variant: VariantKey; fx: RateFixture; track: Track; wide: boolean }> = ({ variant, fx, track, wide }) =>
  variant === 'A' ? <TrackerA fx={fx} track={track} wide={wide} /> : variant === 'B' ? <VariantB fx={fx} track={track} /> : <VariantC fx={fx} track={track} />

/** What was read, and what each leg is held at. */
export function sourceLines(fx: RateFixture): string[] {
  const legs = [...fx.position.collateral, ...fx.position.debt]
    .map((l) => `${fmtAmount(l.amount, 2)} ${l.symbol} at $${fmtAmount(l.priceUsd, l.priceUsd < 10 ? 4 : 2)}`)
    .join(', ')
  return [
    `Measured: ${fx.source}; ${fx.series[Object.keys(fx.series)[0]].length} reads to block ${fmtInt(fx.block)}, captured ${fmtUtc(Date.parse(fx.capturedAt))} (scripts/position/capture-slip-fixtures.ts --rates).`,
    `Rates as the venue quoted them (APR; the supply rate is already net of the reserve factor). Today's size and prices: ${legs}, from the capture read, for every date.`,
    fx.incentives
      ? `‡ Incentives: ${fx.incentives.source}, fetched ${fmtUtc(Date.parse(fx.incentives.fetchedAt))}; ${fx.incentives.searched} live opportunities listed, matched to a leg by token. Current only: Merkl serves no APR history, so no incentive is drawn over the history or back-filled from a campaign start. Not in either line.`
      : '‡ Incentives were not read for this position. They are never in either line: Merkl serves no APR history.',
    `Forward ${FORECAST_EXTENT_D} days (the longest Q33 horizon): a forecast, so it waits on Q33's rate model passing and Q34's preregistration. Nothing is drawn there until then.`,
  ]
}


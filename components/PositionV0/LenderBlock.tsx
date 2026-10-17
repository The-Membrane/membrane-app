// THE LENDING BLOCK: what a supply-only position has in place of a liquidation line. Owner,
// 2026-10-17: "I don't love the risk section — it's more like vault info. Show the data and
// forecasting aspects useful for this venue, like capacity and oracle health. The lending
// model is pending but we can still design it."
//
// Data blocks, each its measured history and a forecast region (hatched, labelled with the
// model it waits on, no numbers):
//   What it pays         base APR on-chain | rewards reported (‡)
//   Capacity / exit      free liquidity vs your supply, 30 days           → M4 exit-trap
//   Utilization & rate   utilization and supply / borrow APR, 30 days     → Q33
//                        (a vault: its market allocation, and its net APR)
//   Oracle health        a Morpho market's oracle vs the market price      → M7
//   Bad debt             pending write-off ≈ $ of yours
// Then the structure in one line (no curator · LLTV · oracle address) and the source's
// warnings in words. Sources by venue: lib/position/lender.ts.

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FIGURE, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { fmtAmount, fmtUsd, fmtUtc } from '@/lib/position/format'
import {
  APR_NOTE,
  FORECAST_DAYS,
  HISTORY_DAYS,
  PENDING_MODEL,
  REWARDS_MARK,
  ago,
  aprLine,
  lenderView,
  reportRequest,
  rewardNote,
  shareText,
  usdShort,
  type LenderReport,
  type LenderView,
  type SeriesPoint,
} from '@/lib/position/lender'
import { fmtGap, gapSummary, unobservedLine } from '@/lib/position/oracleGap'
import type { ProtocolPosition } from '@/lib/position-sim/types'

import { Kicker, Mono, Section, Small } from './primitives'
import { TYPE, TYPE_PX } from './typeScale'
import { useLenderReport } from './useLenderReport'
import { useOracleGap } from './useOracleGap'

type QState = 'reading' | 'ok' | 'error' | 'none'

/** Axis labels: whole dollars at a glance. */
const axisUsd = (x: number) =>
  x >= 1e9
    ? `$${(x / 1e9).toFixed(1)}B`
    : x >= 1e6
      ? `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M`
      : x >= 1e3
        ? `$${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k`
        : `$${x.toFixed(0)}`
const axisPct = (x: number) => `${(x * 100).toFixed(x >= 0.1 || x === 0 ? 0 : 1)}%`
const pct2 = (x: number) => `${(x * 100).toFixed(2)}%`

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number | null] {
  const ref = useRef<T>(null)
  const [w, setW] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((e) => {
      const cw = e[0]?.contentRect.width
      if (cw && cw > 0) setW(Math.round(cw))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

// ------------------------------------------------------------------ one chart for every block

interface Line {
  points: SeriesPoint[]
  tone: 'ink' | 'muted'
  /** The end-of-line label: "supply", "borrow". */
  name?: string
  area?: boolean
}

interface SeriesChartProps {
  label: string
  caption: string
  lines: Line[]
  /** The on-chain reading now, drawn as a solid square at "now". */
  now?: number | null
  /** A dashed reference across history and the forecast region (your supply). */
  refLine?: { v: number; text: string } | null
  yFmt: (v: number) => string
  /** 'zero': a symmetric axis around a dotted zero line (the oracle gap). */
  axis?: 'floor' | 'zero'
  /** A fixed axis top (utilization: 100%). */
  yMax?: number
  pending: string
  state: QState
  /** What the history region says when there is no history. */
  empty: string
  nowS: number
}

const TONE = { ink: NEWS.ink, muted: NEWS.muted } as const
const M = { left: 46, right: 10, top: 20, bottom: 28 }

const SeriesChart: React.FC<SeriesChartProps> = (props) => {
  const [boxRef, width] = useWidth<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')
  const height = width === null ? 170 : Math.round(Math.min(210, Math.max(170, width * 0.32)))
  return (
    <Box ref={boxRef} w="100%" minW={0} h={`${height}px`} data-series-chart={props.state}>
      {width !== null && <SeriesSvg {...props} width={width} height={height} uid={uid} />}
    </Box>
  )
}

const SeriesSvg: React.FC<SeriesChartProps & { width: number; height: number; uid: string }> = ({
  label,
  caption,
  lines,
  now = null,
  refLine = null,
  yFmt,
  axis = 'floor',
  yMax,
  pending,
  state,
  empty,
  nowS,
  width,
  height,
  uid,
}) => {
  const pw = width - M.left - M.right
  const ph = height - M.top - M.bottom
  const floorY = M.top + ph
  const span = HISTORY_DAYS + FORECAST_DAYS
  const nowX = M.left + (HISTORY_DAYS / span) * pw
  const t0 = nowS - HISTORY_DAYS * 86_400
  const shown = lines.map((l) => ({ ...l, points: l.points.filter((p) => p.t >= t0 - 3_600 && p.t <= nowS + 3_600) }))
  const vals = [...shown.flatMap((l) => l.points.map((p) => p.v)), ...(now !== null ? [now] : []), ...(refLine ? [refLine.v] : [])]
  const has = shown.some((l) => l.points.length > 0)
  let lo = 0
  let hi = yMax ?? (Math.max(...vals, 0) * 1.15 || 1)
  if (axis === 'zero') {
    const m = Math.max(0.005, ...vals.map((v) => Math.abs(v))) * 1.3
    lo = -m
    hi = m
  }
  const x = (t: number) => M.left + ((t - t0) / (span * 86_400)) * pw
  const y = (v: number) => M.top + ph * (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo))
  const font = { fontFamily: NEWS_FONT.mono, fontSize: TYPE_PX.label }
  const halo = { ...font, paintOrder: 'stroke' as const, stroke: NEWS.paper, strokeWidth: 3, strokeLinejoin: 'round' as const }
  const ticks = axis === 'zero' ? [lo, 0, hi] : [hi / 2, hi]
  const midHist = (M.left + nowX) / 2
  const midPend = (nowX + M.left + pw) / 2
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ display: 'block', overflow: 'visible' }}>
      <title>{label}</title>
      <defs>
        <pattern id={`mp-${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" x2="0" y1="0" y2="6" stroke={NEWS.rule} strokeWidth={1} />
        </pattern>
        <pattern id={`ar-${uid}`} width="3" height="3" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill={NEWS.muted} />
        </pattern>
      </defs>
      <text x={M.left} y={M.top - 8} fill={NEWS.muted} style={font}>
        {caption}
      </text>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={M.left} x2={M.left + pw} y1={y(v)} y2={y(v)} stroke={NEWS.rule} strokeDasharray={v === 0 && axis === 'zero' ? undefined : '1 3'} />
          <text x={M.left - 6} y={y(v) + 4} textAnchor="end" fill={NEWS.muted} style={font}>
            {yFmt(v)}
          </text>
        </g>
      ))}
      {/* the forecast region: hatched, labelled with the model it waits on, no numbers */}
      <rect x={nowX} y={M.top} width={M.left + pw - nowX} height={ph} fill={`url(#mp-${uid})`} />
      {pending.split('\n').map((ln, i) => (
        <text key={i} x={midPend} y={M.top + ph / 2 - 6 + i * 13} textAnchor="middle" fill={NEWS.ink2} style={halo}>
          {ln}
        </text>
      ))}
      {shown.map((l, k) => {
        if (l.points.length === 0) return null
        const pts = l.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
        const end = l.points[l.points.length - 1]
        return (
          <g key={k}>
            {l.area && (
              <polygon points={`${x(l.points[0].t).toFixed(1)},${floorY} ${pts.join(' ')} ${x(end.t).toFixed(1)},${floorY}`} fill={`url(#ar-${uid})`} />
            )}
            <polyline points={pts.join(' ')} fill="none" stroke={TONE[l.tone]} strokeWidth={l.tone === 'ink' ? 1.25 : 1} strokeDasharray={l.tone === 'muted' ? '3 2' : undefined} />
            {l.name && (
              <text x={Math.min(nowX - 4, x(end.t) - 2)} y={y(end.v) - 5} textAnchor="end" fill={TONE[l.tone]} style={halo}>
                {l.name}
              </text>
            )}
          </g>
        )
      })}
      {!has && (
        <text x={midHist} y={M.top + ph / 2} textAnchor="middle" fill={NEWS.ink2} style={halo}>
          {state === 'reading' ? 'history reading…' : state === 'error' ? 'history not read' : empty}
        </text>
      )}
      {refLine && (
        <g>
          <line x1={M.left} x2={M.left + pw} y1={y(refLine.v)} y2={y(refLine.v)} stroke={NEWS.danger} strokeDasharray="4 3" strokeWidth={1} />
          <text x={M.left + 2} y={y(refLine.v) - 4} fill={NEWS.danger} style={{ ...halo, fontWeight: 700 }}>
            {refLine.text}
          </text>
        </g>
      )}
      <line x1={nowX} x2={nowX} y1={M.top} y2={floorY} stroke={NEWS.muted} />
      {now !== null && <rect x={nowX - 3} y={y(now) - 3} width={6} height={6} fill={NEWS.ink} stroke={NEWS.paper} strokeWidth={1} />}
      <line x1={M.left} x2={M.left + pw} y1={floorY} y2={floorY} stroke={NEWS.muted} />
      <text x={M.left} y={floorY + 16} fill={NEWS.muted} style={font}>
        −{HISTORY_DAYS}d
      </text>
      <text x={nowX} y={floorY + 16} textAnchor="middle" fill={NEWS.muted} style={font}>
        now
      </text>
      <text x={M.left + pw} y={floorY + 16} textAnchor="end" fill={NEWS.muted} style={font}>
        +{FORECAST_DAYS}d
      </text>
    </svg>
  )
}

const pendingText = (model: string) => `model pending\n${model}`

// ------------------------------------------------------------------ pieces

/** Base | rewards as one bar, base in ink, rewards lighter with the ‡. */
const AprBar: React.FC<{ v: LenderView }> = ({ v }) => {
  const base = v.apr.base ?? 0
  const rew = v.apr.rewardsTotal ?? 0
  const sum = base + rew
  if (!(sum > 0)) return null
  const bw = (base / sum) * 100
  return (
    <svg width="100%" height="12" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <rect x={0} y={0} width={bw} height={12} fill={NEWS.ink} />
      {rew > 0 && <rect x={bw + 0.4} y={0} width={Math.max(0, 100 - bw - 0.4)} height={12} fill={NEWS.muted} />}
    </svg>
  )
}

const BigFigure: React.FC<{ children: React.ReactNode; danger?: boolean; small?: boolean }> = ({ children, danger, small }) => (
  <Text as="p" m={0} {...NEWS_FIGURE.display} fontSize={small ? TYPE.head : TYPE.hero} lineHeight={1} color={danger ? NEWS.danger : NEWS.ink}>
    {children}
  </Text>
)

/** ‡ set small and raised, as the page's † is. */
const Mark: React.FC = () => (
  <Text as="span" fontSize="0.45em" verticalAlign="super" lineHeight={0} ml="0.05em">
    {REWARDS_MARK}
  </Text>
)

/** A vault's withdraw-queue markets: each a bar of its supply, the part it could take out now solid. */
const Allocation: React.FC<{ v: LenderView }> = ({ v }) => {
  const uid = useId().replace(/:/g, '')
  const al = (v.market.vault?.allocation ?? []).filter((a) => a.assets > 0).sort((a, b) => b.assets - a.assets)
  if (al.length === 0) return <Small>No funded market in the withdraw queue.</Small>
  const top = al.slice(0, 8)
  const rest = al.slice(8)
  const max = top[0].assets
  const p = v.market.priceUsd
  return (
    <Box display="grid" gap={SPACING.xs} minW={0} data-allocation="">
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
        <defs>
          <pattern id={`al-${uid}`} width="3" height="3" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.6" fill={NEWS.muted} />
          </pattern>
        </defs>
      </svg>
      {top.map((a) => (
        <Box key={a.marketId} display="grid" gap="2px" minW={0}>
          <Box display="flex" justifyContent="space-between" columnGap={SPACING.sm} minW={0}>
            <Small color={NEWS.ink} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
              {a.label}
            </Small>
            <Small flex="none">
              {usdShort(a.available * p)} of {usdShort(a.assets * p)} · {(a.utilization * 100).toFixed(0)}% used
            </Small>
          </Box>
          <svg width="100%" height="8" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
            <rect x={0} y={0} width={(a.assets / max) * 100} height={8} fill={`url(#al-${uid})`} stroke={NEWS.rule} strokeWidth={0.3} vectorEffect="non-scaling-stroke" />
            <rect x={0} y={0} width={(a.available / max) * 100} height={8} fill={NEWS.ink} />
          </svg>
        </Box>
      ))}
      {rest.length > 0 && (
        <Small>
          + {rest.length} smaller market{rest.length > 1 ? 's' : ''}: {usdShort(rest.reduce((s, a) => s + a.assets, 0) * p)}
        </Small>
      )}
      <Small color={NEWS.ink2}>Solid: what the vault could take out of that market now. Dotted: lent there and borrowed.</Small>
    </Box>
  )
}

// ------------------------------------------------------------------ the block

export const LenderBlock: React.FC<{ position: ProtocolPosition }> = ({ position }) => {
  const req = reportRequest(position)
  const q = useLenderReport(req)
  const report: LenderReport | null = q.data ?? null
  const state: QState = req.kind === 'none' ? 'none' : q.isError ? 'error' : report ? 'ok' : 'reading'
  const mp = position.lendMarket?.morpho ?? null
  const gapQ = useOracleGap(position.lendMarket?.venue === 'morpho-market' ? mp : null)
  const v = lenderView(position, report)
  if (!v) return null
  const m = v.market
  // The charts' "now": when the report was fetched, else the read block's time.
  const nowAxis = report ? report.fetchedAt / 1000 : m.blockTs ?? Date.now() / 1000
  const share = shareText(v.withdrawableShare)
  const shareDanger = v.withdrawableShare !== null && v.withdrawableShare < 1
  const fetched = report ? `fetched ${fmtUtc(report.fetchedAt)}` : null
  const src = report?.source ?? (req.kind === 'llama' ? 'DefiLlama yields' : 'Morpho API')
  const histWord = state === 'ok' ? `${src}, reported, ${fetched}` : state === 'reading' ? `${src}, reading…` : state === 'none' ? `not read (${req.kind === 'none' ? req.reason : ''})` : `${src}, not read`
  const asOf = v.sinceUpdateS !== null ? ` · as of the last on-chain update, ${ago(v.sinceUpdateS)}` : ''
  const free = v.liquidityUsd >= 1 ? fmtUsd(v.liquidityUsd) : v.liquidityUsd > 0 ? '<$1' : '$0'
  const onPaper = v.pending ? ' on paper' : ''
  const isVault = v.venue === 'morpho-vault'
  const showsMark = state === 'ok' && v.apr.marked && !isVault

  // --- capacity / exit -------------------------------------------------------
  const exit = (
    <Section id="lending-exit" aria-live="polite" key="exit">
      <Kicker>{v.paper ? 'At risk: can you get out' : 'Capacity: can you get out'}</Kicker>
      <Box display="flex" flexWrap="wrap" alignItems="baseline" columnGap={SPACING.md} minW={0}>
        <BigFigure danger={shareDanger}>{share}</BigFigure>
        <Mono as="span">of your supply could leave now</Mono>
      </Box>
      <Mono>
        {free} free {isVault ? 'across the vault’s markets' : 'for all lenders'} · your {fmtAmount(v.supplied, v.supplied >= 100 ? 0 : 2)} {v.symbol} (
        {fmtUsd(v.suppliedUsd)}
        {onPaper}){isVault ? ` · maxWithdraw ${fmtAmount(m.vault?.maxWithdraw ?? 0, 0)} ${v.symbol}` : ` · utilization ${(m.utilization * 100).toFixed(1)}%`}
      </Mono>
      <SeriesChart
        label={`Liquidity free to withdraw: ${fmtUsd(v.liquidityUsd)} now against your ${fmtUsd(v.suppliedUsd)}; the next ${FORECAST_DAYS} days: model pending (${PENDING_MODEL.exit}).`}
        caption={isVault ? 'free to withdraw from the vault ($)' : 'free to withdraw, all lenders ($)'}
        lines={[{ points: report?.liquidityUsd ?? [], tone: 'ink', area: true }]}
        now={v.liquidityUsd}
        refLine={{ v: v.suppliedUsd, text: `your supply ${usdShort(v.suppliedUsd)}${onPaper}` }}
        yFmt={axisUsd}
        pending={pendingText(PENDING_MODEL.exit)}
        state={state}
        empty={isVault ? 'no history reported for vaults' : 'no history reported'}
        nowS={nowAxis}
      />
      <Small>
        Now: on-chain at block {m.block.toLocaleString('en-US')}
        {isVault ? ' (Σ over the withdraw queue of min(vault supply, market liquidity); your exit is the vault’s own maxWithdraw)' : ''}. History:{' '}
        {isVault ? 'not reported for vaults' : histWord}. Forecast: model pending ({PENDING_MODEL.exit}) — no number is shown.
      </Small>
    </Section>
  )

  // --- what it pays ------------------------------------------------------------
  const aprFigure =
    isVault && v.apr.reported !== null ? (
      pct2(v.apr.reported)
    ) : v.apr.total !== null && state === 'ok' ? (
      <>
        {pct2(v.apr.total)}
        {v.apr.marked && <Mark />}
      </>
    ) : v.apr.base !== null ? (
      pct2(v.apr.base)
    ) : (
      '—'
    )
  const pays = (
    <Section id="lending-apr" aria-live="polite" key="apr">
      <Kicker>{v.paper ? 'What it pays: a paper rate' : 'What it pays'}</Kicker>
      <Box display="flex" flexWrap="wrap" alignItems="baseline" columnGap={SPACING.md} minW={0}>
        <BigFigure small={Boolean(v.paper)}>{aprFigure}</BigFigure>
        <Mono as="span">
          {isVault ? 'net APR, reported' : 'supply APR'}
          {v.paper ? ', on paper' : ''}
        </Mono>
      </Box>
      {v.paper ? <Mono color={NEWS.ink2}>{v.paper}</Mono> : !isVault && <AprBar v={v} />}
      <Mono>
        {aprLine(v, state === 'none' ? 'error' : state)}
        {asOf}
      </Mono>
      {!isVault && v.apr.rewards && v.apr.rewards.length > 0 && (
        <Small color={NEWS.ink2}>
          {v.apr.rewards.map((r) => `${r.symbol} ${pct2(r.apr)}${REWARDS_MARK}`).join(' · ')}: {rewardNote(v.apr.rewards.map((r) => r.symbol))}.
        </Small>
      )}
      <Small>
        Base: {m.aprBasis}
        {m.supplyApr !== null ? `, on-chain at block ${m.block.toLocaleString('en-US')}` : ''}. {APR_NOTE}
        {showsMark && fetched ? ` ${REWARDS_MARK} ${src}, reported, ${fetched}; not read on-chain.` : ''}
        {isVault && fetched ? ` Net APR: Morpho API, reported, ${fetched}, converted from its APY.` : ''}
      </Small>
    </Section>
  )

  // --- utilization & rate ---------------------------------------------------------
  const rateLines: Line[] = [
    { points: report?.supplyApr ?? [], tone: 'ink', name: isVault ? 'net' : 'supply' },
    { points: report?.borrowApr ?? [], tone: 'muted', name: 'borrow' },
  ]
  const util = (
    <Section id="lending-rate" key="rate">
      <Kicker>{isVault ? 'Allocation & rate' : 'Utilization & rate'}</Kicker>
      {isVault ? (
        <Allocation v={v} />
      ) : (
        <SeriesChart
          label={`Utilization: ${(m.utilization * 100).toFixed(1)}% now; the next ${FORECAST_DAYS} days: model pending (${PENDING_MODEL.rate}).`}
          caption="utilization (borrowed ÷ supplied)"
          lines={[{ points: report?.utilization ?? [], tone: 'ink' }]}
          now={m.utilization}
          yMax={1}
          yFmt={axisPct}
          pending={pendingText(PENDING_MODEL.rate)}
          state={state}
          empty={report?.source === 'DefiLlama yields' ? 'history not in the free API' : 'no history reported'}
          nowS={nowAxis}
        />
      )}
      <SeriesChart
        label={`${isVault ? 'Net' : 'Supply and borrow'} APR over ${HISTORY_DAYS} days; the next ${FORECAST_DAYS} days: model pending (${PENDING_MODEL.rate}).`}
        caption={isVault ? 'net APR (after the vault’s fee)' : 'APR: supply (solid) · borrow (dashed)'}
        lines={rateLines}
        now={isVault ? v.apr.reported : m.supplyApr}
        yFmt={axisPct}
        pending={pendingText(PENDING_MODEL.rate)}
        state={state}
        empty="no history reported"
        nowS={nowAxis}
      />
      <Small>
        {isVault
          ? `Allocation: on-chain at block ${m.block.toLocaleString('en-US')}, the withdraw queue's ${m.vault?.allocation.length ?? 0} markets.`
          : `Now: utilization ${(m.utilization * 100).toFixed(1)}%, supply ${m.supplyApr === null ? 'not read' : pct2(m.supplyApr)}, borrow ${m.borrowApr === null ? 'not read' : pct2(m.borrowApr)} APR, on-chain at block ${m.block.toLocaleString('en-US')}.`}{' '}
        History: {histWord}
        {report?.source === 'DefiLlama yields' ? ' (supply rate only: its utilization and borrow history are a paid API)' : ''}
        {state === 'ok' ? ', APRs converted from its APY' : ''}. Forecast: model pending ({PENDING_MODEL.rate}).
      </Small>
    </Section>
  )

  // --- oracle health ------------------------------------------------------------
  const gap = gapQ.data ?? null
  const gapState: QState = v.venue !== 'morpho-market' || !mp || mp.collateralToken === null ? 'none' : gapQ.isError ? 'error' : gap ? 'ok' : 'reading'
  const gapNow = gap?.points[gap.points.length - 1]?.gap ?? null
  const oracle = (
    <Section id="lending-oracle" key="oracle">
      <Kicker>Oracle health</Kicker>
      {v.venue === 'morpho-market' && mp && mp.collateralToken !== null ? (
        <>
          <Mono>
            {mp.collateralSymbol ?? 'collateral'} by this market’s oracle vs the market price:{' '}
            {gapNow !== null ? <b>{fmtGap(gapNow)} now</b> : gapState === 'reading' ? 'reading…' : 'not observed now'}
            {gap && gapSummary(gap.points) ? ` · ${gapSummary(gap.points)}` : ''}
          </Mono>
          <SeriesChart
            label={`Oracle price over market price, minus one, daily for ${HISTORY_DAYS} days; the next ${FORECAST_DAYS} days: model pending (${PENDING_MODEL.oracle}).`}
            caption="oracle ÷ market − 1"
            lines={[{ points: (gap?.points ?? []).filter((p) => p.gap !== null).map((p) => ({ t: p.ts, v: p.gap as number })), tone: 'ink' }]}
            now={gapNow}
            yFmt={(g) => (g === 0 ? '0' : fmtGap(g))}
            axis="zero"
            pending={pendingText(PENDING_MODEL.oracle)}
            state={gapState}
            empty="no point observed"
            nowS={gap ? gap.fetchedAt / 1000 : nowAxis}
          />
          <Small>
            Oracle {mp.oracle.slice(0, 6)}…{mp.oracle.slice(-4)} price() on-chain at one block a day (archive reads
            {gap && gap.failedReads > 0 ? `; ${gap.failedReads} failed, left unobserved` : ''}); market: DefiLlama prices of {mp.collateralSymbol ?? 'the collateral'} and{' '}
            {v.symbol}, reported. Above 0, the oracle prices the collateral higher than the market.{' '}
            {gap && unobservedLine(gap.points) ? `${unobservedLine(gap.points)}. ` : ''}A point more than 6 h from its price, or under 0.9 confidence, is unobserved, the curator-feed collector’s rules.
            {gap ? ` Fetched ${fmtUtc(gap.fetchedAt)}.` : ''} Forecast: model pending ({PENDING_MODEL.oracle}).
          </Small>
        </>
      ) : (
        <Small color={NEWS.ink2}>
          {v.venue === 'morpho-market'
            ? 'An idle market: no collateral, so no oracle prices a borrower here.'
            : v.venue === 'morpho-vault'
              ? `Not read for vaults yet: each of its ${m.vault?.allocation.filter((a) => a.assets > 0).length ?? 0} funded markets has its own oracle. Forecast: model pending (${PENDING_MODEL.oracle}).`
              : `Not read for pooled venues yet: every listed collateral has its own oracle feed. Forecast: model pending (${PENDING_MODEL.oracle}).`}
        </Small>
      )}
    </Section>
  )

  // --- bad debt -----------------------------------------------------------------
  const bad = (
    <Section id="lending-bad-debt" key="bad">
      <Kicker>Bad debt</Kicker>
      <Mono color={v.pending ? NEWS.danger : NEWS.ink}>
        {v.badDebt.line
          ? `${v.badDebt.line.charAt(0).toUpperCase()}${v.badDebt.line.slice(1)}.`
          : v.venue === 'morpho-market' && state === 'reading'
            ? 'Reading…'
            : 'Not read.'}
      </Mono>
      {v.badDebt.realized && <Small color={NEWS.ink2}>{v.badDebt.realized}.</Small>}
      <Small>
        Source: {v.badDebt.source}
        {v.venue === 'morpho-market' && fetched ? `, ${fetched}` : ''}.{' '}
        {v.venue === 'aave-reserve'
          ? 'Aave covers a deficit from its own backstop before lenders.'
          : v.venue === 'comet'
            ? 'Compound covers bad debt from its reserves; below zero, lenders carry it.'
            : 'Bad debt is written off against the market’s supply, so every lender loses pro rata.'}
      </Small>
    </Section>
  )

  return (
    <>
      {v.paper ? [exit, pays] : [pays, exit]}
      {util}
      {oracle}
      {bad}
      <Section id="lending-facts">
        <Small color={NEWS.ink2} data-facts-line="">
          {v.facts}
        </Small>
        {v.warnings.length > 0 && (
          <Small color={v.warnings.some((w) => w.flagged) ? NEWS.danger : NEWS.muted}>
            {src} flags: {v.warnings.map((w) => w.text).join(' · ')}
          </Small>
        )}
      </Section>
    </>
  )
}

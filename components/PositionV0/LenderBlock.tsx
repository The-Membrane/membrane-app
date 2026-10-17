// THE LENDING BLOCK: what a supply-only position has in place of a liquidation line (owner,
// 2026-10-17). Three parts, in the order a lender asks:
//   1. What it pays: base supply APR (on-chain) and rewards (Morpho API, reported, ‡), as
//      one bar split base | rewards.
//   2. Can you get out: the share of your supply the market could pay out now (on-chain
//      liquidity against your supply), and the liquidity's last 30 days (Morpho API) with
//      your supply as a line across it. The forecast region to the right is "model pending"
//      with no numbers: no capacity model exists yet (MODELS_PLAN M4).
//   3. What can go wrong: bad-debt sharing, the oracle, no curator, the utilization cap,
//      each with the API's facts and warnings under it when it answered.

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FIGURE, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { fmtAmount, fmtUsd, fmtUtc } from '@/lib/position/format'
import {
  FORECAST_DAYS,
  HISTORY_DAYS,
  REWARDS_MARK,
  aprLine,
  lenderView,
  type LenderReport,
  type LenderView,
} from '@/lib/position/lender'
import type { ProtocolPosition } from '@/lib/position-sim/types'

import { Kicker, Mono, Section, Small } from './primitives'
import { TYPE, TYPE_PX } from './typeScale'
import { useLenderReport } from './useLenderReport'

const usdShort = (x: number) =>
  x >= 1e6 ? `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k` : `$${x.toFixed(0)}`

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

/** Base | rewards as one bar, base in ink, rewards in halftone with the ‡. */
const AprBar: React.FC<{ v: LenderView }> = ({ v }) => {
  const base = v.apr.base ?? 0
  const rew = v.apr.rewardsTotal ?? 0
  const sum = base + rew
  if (!(sum > 0)) return null
  const bw = (base / sum) * 100
  return (
    <svg width="100%" height="12" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <rect x={0} y={0} width={bw} height={12} fill={NEWS.ink} />
      {/* rewards: lighter ink, a hairline gap from the base (reported, not read on-chain) */}
      {rew > 0 && <rect x={bw + 0.4} y={0} width={Math.max(0, 100 - bw - 0.4)} height={12} fill={NEWS.muted} />}
    </svg>
  )
}

/** Liquidity, 30 days back (reported) and now (on-chain), your supply across it; the next 7 days "model pending". */
const CapacityChart: React.FC<{ v: LenderView; report: LenderReport | null; state: 'reading' | 'ok' | 'error' }> = ({
  v,
  report,
  state,
}) => {
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')
  const height = width === null ? 180 : Math.round(Math.min(230, Math.max(180, width * 0.36)))
  const nowS = report ? report.fetchedAt / 1000 : null
  return (
    <Box ref={ref} w="100%" minW={0} h={`${height}px`} data-capacity-chart={state}>
      {width !== null && (
        <CapacitySvg v={v} report={report} state={state} width={width} height={height} uid={uid} nowS={nowS} />
      )}
    </Box>
  )
}

const M = { left: 44, right: 10, top: 20, bottom: 28 }

const CapacitySvg: React.FC<{
  v: LenderView
  report: LenderReport | null
  state: 'reading' | 'ok' | 'error'
  width: number
  height: number
  uid: string
  nowS: number | null
}> = ({ v, report, state, width, height, uid, nowS }) => {
  const pw = width - M.left - M.right
  const ph = height - M.top - M.bottom
  const floorY = M.top + ph
  const span = HISTORY_DAYS + FORECAST_DAYS
  const nowX = M.left + (HISTORY_DAYS / span) * pw
  const hist = report && nowS ? report.history.filter((p) => p.t >= nowS - HISTORY_DAYS * 86_400) : []
  const top = Math.max(v.liquidityUsd, v.suppliedUsd, ...hist.map((p) => p.usd)) * 1.15 || 1
  const x = (t: number) => M.left + ((t - ((nowS ?? 0) - HISTORY_DAYS * 86_400)) / (span * 86_400)) * pw
  const y = (u: number) => M.top + ph * (1 - Math.max(0, u) / top)
  const font = { fontFamily: NEWS_FONT.mono, fontSize: TYPE_PX.label }
  const halo = { ...font, paintOrder: 'stroke' as const, stroke: NEWS.paper, strokeWidth: 3, strokeLinejoin: 'round' as const }
  const line = [...hist.map((p) => `${x(p.t).toFixed(1)},${y(p.usd).toFixed(1)}`), `${nowX.toFixed(1)},${y(v.liquidityUsd).toFixed(1)}`].join(' ')
  const area = hist.length > 0 ? `${x(hist[0].t).toFixed(1)},${floorY} ${line} ${nowX.toFixed(1)},${floorY}` : ''
  const youY = y(v.suppliedUsd)
  const label =
    `Liquidity free to withdraw: ${fmtUsd(v.liquidityUsd)} now against your ${fmtUsd(v.suppliedUsd)}` +
    (hist.length ? `, ${HISTORY_DAYS} days of history` : '') +
    `; the next ${FORECAST_DAYS} days: model pending.`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ display: 'block', overflow: 'visible' }}>
      <title>{label}</title>
      <defs>
        <pattern id={`mp-${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" x2="0" y1="0" y2="6" stroke={NEWS.rule} strokeWidth={1} />
        </pattern>
        <pattern id={`lq-${uid}`} width="3" height="3" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill={NEWS.muted} />
        </pattern>
      </defs>
      <text x={M.left} y={M.top - 8} fill={NEWS.muted} style={font}>
        free to withdraw, all lenders ($)
      </text>
      {[top / 2, top].map((u) => (
        <g key={u}>
          <line x1={M.left} x2={M.left + pw} y1={y(u)} y2={y(u)} stroke={NEWS.rule} strokeDasharray="1 3" />
          <text x={M.left - 6} y={y(u) + 4} textAnchor="end" fill={NEWS.muted} style={font}>
            {usdShort(u)}
          </text>
        </g>
      ))}
      {/* the forecast region: hatched, no numbers */}
      <rect x={nowX} y={M.top} width={M.left + pw - nowX} height={ph} fill={`url(#mp-${uid})`} />
      <text x={(nowX + M.left + pw) / 2} y={M.top + ph / 2} textAnchor="middle" fill={NEWS.ink2} style={halo}>
        model
      </text>
      <text x={(nowX + M.left + pw) / 2} y={M.top + ph / 2 + 13} textAnchor="middle" fill={NEWS.ink2} style={halo}>
        pending
      </text>
      {area && <polygon points={area} fill={`url(#lq-${uid})`} />}
      {hist.length > 0 && <polyline points={line} fill="none" stroke={NEWS.ink} strokeWidth={1.25} strokeLinejoin="round" />}
      {state !== 'ok' && (
        <text x={(M.left + nowX) / 2} y={M.top + ph / 2} textAnchor="middle" fill={NEWS.ink2} style={halo}>
          {state === 'reading' ? 'history reading…' : 'history not read'}
        </text>
      )}
      {/* your supply: a dashed line across history and the pending region */}
      <line x1={M.left} x2={M.left + pw} y1={youY} y2={youY} stroke={NEWS.danger} strokeDasharray="4 3" strokeWidth={1} />
      <text x={M.left + 2} y={youY - 4} fill={NEWS.danger} style={{ ...halo, fontWeight: 700 }}>
        your supply {usdShort(v.suppliedUsd)}
      </text>
      {/* now: the on-chain reading */}
      <line x1={nowX} x2={nowX} y1={M.top} y2={floorY} stroke={NEWS.muted} />
      <rect x={nowX - 3} y={y(v.liquidityUsd) - 3} width={6} height={6} fill={NEWS.ink} stroke={NEWS.paper} strokeWidth={1} />
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

const Risk: React.FC<{ r: LenderView['risks'][number] }> = ({ r }) => (
  <Box borderTop={`1px solid ${NEWS.rule}`} pt={SPACING.sm} display="grid" gap={SPACING.xs} minW={0}>
    <Mono fontWeight={700} color={r.flagged ? NEWS.danger : NEWS.ink}>
      {r.flagged ? '■ ' : ''}
      {r.head}
    </Mono>
    <Small color={NEWS.ink2}>{r.body}</Small>
    {r.facts.length > 0 && <Small color={r.flagged ? NEWS.danger : NEWS.muted}>Morpho API: {r.facts.join(' · ')}</Small>}
  </Box>
)

export const LenderBlock: React.FC<{ position: ProtocolPosition }> = ({ position }) => {
  const q = useLenderReport(position.protocol === 'morpho-blue' ? position.marketId ?? null : null)
  const report = q.data ?? null
  const state: 'reading' | 'ok' | 'error' = q.isError ? 'error' : report ? 'ok' : 'reading'
  const v = lenderView(position, report)
  if (!v) return null
  const m = v.market
  const share = Math.floor(v.withdrawableShare * 100 + 1e-9)
  const stamp = report ? `Morpho API, reported, fetched ${fmtUtc(report.fetchedAt)}` : null
  return (
    <>
      <Section id="lending-apr" aria-live="polite">
        <Kicker>What it pays</Kicker>
        <Box display="flex" flexWrap="wrap" alignItems="baseline" columnGap={SPACING.md} minW={0}>
          <Text as="p" m={0} {...NEWS_FIGURE.display} fontSize={TYPE.hero} lineHeight={1} color={NEWS.ink}>
            {v.apr.total !== null && state === 'ok'
              ? `${(v.apr.total * 100).toFixed(2)}%`
              : v.apr.base !== null
                ? `${(v.apr.base * 100).toFixed(2)}%`
                : '—'}
            {v.apr.total !== null && state === 'ok' && v.apr.marked && (
              // Set small and raised, as the page's † is: it marks without shouting.
              <Text as="span" fontSize="0.45em" verticalAlign="super" lineHeight={0} ml="0.05em">
                {REWARDS_MARK}
              </Text>
            )}
          </Text>
          <Mono as="span">supply APR</Mono>
        </Box>
        <AprBar v={v} />
        <Mono>{aprLine(v, state)}</Mono>
        {v.apr.rewards && v.apr.rewards.length > 0 && (
          <Small color={NEWS.ink2}>
            {v.apr.rewards.map((r) => `${r.symbol} ${(r.apr * 100).toFixed(2)}%${REWARDS_MARK}`).join(' · ')}
          </Small>
        )}
        <Small>
          Base: borrow APR {m.borrowApr === null ? 'not read' : `${(m.borrowApr * 100).toFixed(2)}%`} × utilization{' '}
          {(m.utilization * 100).toFixed(1)}% × (1 − fee {(m.fee * 100).toFixed(0)}%), on-chain at block {m.block.toLocaleString('en-US')}.
          {stamp ? ` ${REWARDS_MARK} ${stamp}; not read on-chain.` : ''}
        </Small>
      </Section>

      <Section id="lending-exit" aria-live="polite">
        <Kicker>Can you get out</Kicker>
        <Box display="flex" flexWrap="wrap" alignItems="baseline" columnGap={SPACING.md} minW={0}>
          <Text as="p" m={0} {...NEWS_FIGURE.display} fontSize={TYPE.hero} lineHeight={1} color={share < 100 ? NEWS.danger : NEWS.ink}>
            {share}%
          </Text>
          <Mono as="span">of your supply could leave now</Mono>
        </Box>
        <Mono>
          {fmtUsd(v.liquidityUsd)} free for all lenders · your {fmtAmount(v.supplied, v.supplied >= 100 ? 0 : 2)} {v.symbol} (
          {fmtUsd(v.suppliedUsd)}) · utilization {(m.utilization * 100).toFixed(1)}%
        </Mono>
        <CapacityChart v={v} report={report} state={state} />
        <Small>
          Now: on-chain at block {m.block.toLocaleString('en-US')}. History: {stamp ?? (state === 'reading' ? 'Morpho API, reading…' : 'Morpho API, not read')}.
          Forecast of free liquidity: model pending — no capacity model is built yet, so no number is shown.
        </Small>
      </Section>

      <Section id="lending-risks">
        <Kicker>What can go wrong</Kicker>
        {v.risks.map((r) => (
          <Risk key={r.id} r={r} />
        ))}
      </Section>
    </>
  )
}

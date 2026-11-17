// Pure logic for PERSONAL POSITION ALERTS on the Radar Telegram bot (owner ruling
// 2026-10-30: "just add it to the radar bot"; supersedes the earlier non-reuse rule).
// JSX-free and I/O-free: one Aave V3 position read in, the next level and at most one
// message out. scripts/lib/telegramBot.mjs (sendPositionAlerts) owns the reads, the
// state table (position_alert_state) and the sends.
//
// Levels come from the shipped alert config: warn below HF 1.15, critical below 1.05
// (DEFAULT_ALERT_CONFIG), act-now within 3 % of the liquidation price (AT_RISK_RULE,
// R27). A message goes out when the level RISES, and once when a position that was
// at warn or worse recovers or closes. Leaving a level needs the hysteresis band
// (HF + 0.03, distance + 1 pt), so a position hovering on a line does not flap.

import { AT_RISK_RULE, DEFAULT_ALERT_CONFIG } from '@/lib/positionAlerts/config'

import { SITE, shortAddr } from './telegramLogic'

export type PositionLevel = 'ok' | 'warn' | 'critical' | 'act-now'

export const LEVEL_RANK: Record<PositionLevel, number> = {
  ok: 0,
  warn: 1,
  critical: 2,
  'act-now': 3,
}

const HF = DEFAULT_ALERT_CONFIG.healthFactor
const WARN_HF = HF.enter.warn ?? 1.15
const CRITICAL_HF = HF.enter.critical ?? 1.05
const HF_BAND = HF.band
const ACT_NOW_DISTANCE = AT_RISK_RULE.threshold
const DISTANCE_BAND = 0.01

export type PositionRead = {
  healthFactor: number | null // null = no debt
  distance: number | null // price drop to HF 1, fraction
  liquidationPrice: number | null
  mainCollateral: string
  riskType: 'price' | 'pair' | 'stable'
  debtUsd: number
}

/** The level a read sits in, ignoring history. */
export function rawLevel(r: PositionRead): PositionLevel {
  if (r.healthFactor === null || r.debtUsd <= 0) return 'ok'
  if (r.distance !== null && r.distance < ACT_NOW_DISTANCE) return 'act-now'
  if (r.healthFactor < CRITICAL_HF) return 'critical'
  if (r.healthFactor < WARN_HF) return 'warn'
  return 'ok'
}

/** True when the read is clear of `level` by the hysteresis band. */
function clearOf(level: PositionLevel, r: PositionRead): boolean {
  if (r.healthFactor === null || r.debtUsd <= 0) return true
  if (level === 'act-now')
    return r.distance === null || r.distance >= ACT_NOW_DISTANCE + DISTANCE_BAND
  if (level === 'critical') return r.healthFactor >= CRITICAL_HF + HF_BAND
  if (level === 'warn') return r.healthFactor >= WARN_HF + HF_BAND
  return true
}

/** Next level with hysteresis: rise at once, fall only one band clear of each level above. */
export function nextLevel(prev: PositionLevel, r: PositionRead): PositionLevel {
  const raw = rawLevel(r)
  if (LEVEL_RANK[raw] >= LEVEL_RANK[prev]) return raw
  const order: PositionLevel[] = ['act-now', 'critical', 'warn', 'ok']
  for (const L of order.slice(order.indexOf(prev))) {
    if (L === 'ok' || !clearOf(L, r)) return LEVEL_RANK[L] < LEVEL_RANK[raw] ? raw : L
  }
  return raw
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const price = (v: number) => `$${Number(v.toPrecision(5)).toLocaleString('en-US')}`

export const positionLink = (address: string) => `${SITE}/ethereum/liquidations?address=${address}`

const HEAD: Record<Exclude<PositionLevel, 'ok'>, string> = {
  warn: 'WARN',
  critical: 'CRITICAL',
  'act-now': 'ACT NOW',
}

/** The message for a level change, or null when nothing should be sent. */
export function positionMessage(
  address: string,
  prev: PositionLevel,
  next: PositionLevel,
  r: PositionRead,
): string | null {
  if (LEVEL_RANK[next] > LEVEL_RANK[prev] && next !== 'ok') {
    const lines = [
      `${HEAD[next]} · Aave V3 Ethereum · ${shortAddr(address)}`,
      `Health factor ${r.healthFactor!.toFixed(3)}` +
        (r.distance !== null
          ? ` · ${pct(r.distance)} ${r.riskType === 'price' ? 'price drop' : `${r.mainCollateral} move`} to liquidation`
          : ''),
      r.liquidationPrice !== null && r.riskType === 'price'
        ? `${r.mainCollateral} liquidation price about ${price(r.liquidationPrice)}`
        : null,
      next === 'act-now'
        ? 'Within 3% of liquidation. Repay debt or add collateral now.'
        : 'Repaying debt or adding collateral raises the health factor.',
      `X-ray: ${positionLink(address)}`,
      'Aave oracle prices, read hourly. Not financial advice · /stop to unsubscribe',
    ].filter(Boolean)
    return lines.join('\n')
  }
  if (next === 'ok' && LEVEL_RANK[prev] >= LEVEL_RANK.warn) {
    return r.healthFactor === null || r.debtUsd <= 0
      ? `Clear · ${shortAddr(address)} has no Aave V3 Ethereum debt now.`
      : `Clear · ${shortAddr(address)} health factor back to ${r.healthFactor.toFixed(3)} (above ${WARN_HF + HF_BAND}).`
  }
  return null
}

/** One planned send per subscription whose level changed; the state update rides with it. */
export type PositionPlan = {
  subscriptionId: string
  chatId: string
  address: string
  prev: PositionLevel
  next: PositionLevel
  text: string | null
}

export function planPositionAlerts(args: {
  subscriptions: { id: string; chatId: string; address: string }[]
  levels: Record<string, PositionLevel> // subscriptionId -> stored level (missing = ok)
  reads: Record<string, PositionRead | null> // address -> read (null = read failed: skip)
}): PositionPlan[] {
  const out: PositionPlan[] = []
  for (const s of args.subscriptions) {
    const r = args.reads[s.address]
    if (!r) continue
    const prev = args.levels[s.id] ?? 'ok'
    const next = nextLevel(prev, r)
    if (next === prev) continue
    out.push({
      subscriptionId: s.id,
      chatId: s.chatId,
      address: s.address,
      prev,
      next,
      text: positionMessage(s.address, prev, next, r),
    })
  }
  return out
}

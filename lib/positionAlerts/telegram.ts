/**
 * Telegram wording for personal position alerts — DRY RUN ONLY.
 *
 * This module formats a message and returns it. It never sends: there is no HTTP call, no
 * bot token, no chat lookup. Per the board ruling, personal alerts must NOT reuse the radar
 * alarm sender (scripts/lib/notify.mjs, scripts/lib/telegramBot.mjs) or the radar wording
 * (components/Radar/telegramLogic.ts); a test asserts this file imports none of them.
 *
 * Plain text (no parse_mode), so symbols and underscores in numbers never break Markdown.
 */

import { fmtHf, fmtPrice, fmtUsd } from './format'
import { repayToReach, topUpToReach, type PositionMetrics } from './metrics'
import type { Alert, PositionSnapshot, Severity } from './types'
import { levelOf } from './types'

/** Telegram's hard limit for one message. */
export const TELEGRAM_MAX_CHARS = 4096

const TAG: Record<Severity, string> = { watch: 'WATCH', warn: 'WARN', critical: 'CRITICAL' }

const shortId = (id: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(id) ? `${id.slice(0, 6)}…${id.slice(-4)}` : id

const utc = (ts: number) =>
  new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

export interface FormatArgs {
  alerts: Alert[]
  snapshot: PositionSnapshot
  metrics: PositionMetrics
  /** Health factor the "what to do" line aims for. */
  targetHf: number
}

/** One message for every notifiable alert of one position at one moment, or null if none. */
export function formatPositionAlert({
  alerts,
  snapshot,
  metrics,
  targetHf,
}: FormatArgs): string | null {
  if (alerts.length === 0) return null
  const worsening = alerts.filter((a) => a.transition === 'fire' || a.transition === 'escalate')
  const top = (worsening.length ? worsening : alerts).reduce((m, a) =>
    levelOf(a.severity) > levelOf(m.severity) ? a : m,
  )
  const allClear = worsening.length === 0
  const head = allClear
    ? `[OK] ${snapshot.venue} · ${shortId(snapshot.id)}`
    : `[${TAG[top.severity]}] ${snapshot.venue} · ${shortId(snapshot.id)}`

  const lines: string[] = [head]
  for (const a of alerts) lines.push('', a.title, a.detail)

  // The HF alert's own title already states health factor; don't say it twice.
  const hfStated = alerts.some((a) => a.ruleId === 'health-factor')
  const hf = hfStated ? '' : `Health factor ${fmtHf(metrics.healthFactor)} · `
  lines.push(
    '',
    `${hf}Collateral ${fmtUsd(metrics.collateralUsd)} · debt ${fmtUsd(metrics.debtUsd)}`,
  )
  const d = metrics.dominant
  if (d && d.liquidationPriceUsd !== null)
    lines.push(
      `Liquidation if ${d.symbol} reaches ${fmtPrice(d.liquidationPriceUsd)} (now ${fmtPrice(d.priceUsd)}).`,
    )

  if (!allClear && metrics.healthFactor < targetHf) {
    const leg = snapshot.collateral.find((c) => c.symbol === d?.symbol)
    const repay = repayToReach(metrics, targetHf)
    const topUp = leg ? topUpToReach(metrics, targetHf, leg.liquidationThreshold) : 0
    const add = leg && topUp > 0 ? `, or add ${fmtUsd(topUp)} of ${leg.symbol}` : ''
    lines.push(`To get back to HF ${fmtHf(targetHf)}: repay ${fmtUsd(repay)}${add}.`)
  }

  lines.push('', `Dry run: formatted, not sent · ${utc(snapshot.ts)}`)
  const text = lines.join('\n')
  return text.length <= TELEGRAM_MAX_CHARS ? text : text.slice(0, TELEGRAM_MAX_CHARS - 1) + '…'
}

export interface DryRunDelivery {
  channel: 'telegram'
  dryRun: true
  sent: false
  /** A label for the would-be recipient. Never a real chat id from storage. */
  to: string
  text: string
  parseMode: null
  chars: number
}

/** The whole delivery path: wrap the text and return it. Nothing leaves the process. */
export function dryRunTelegram(to: string, text: string): DryRunDelivery {
  return {
    channel: 'telegram',
    dryRun: true,
    sent: false,
    to,
    text,
    parseMode: null,
    chars: text.length,
  }
}

// Pure math/formatters ported from public/proto/supply.html's inline <script> blocks.

import { CapacityBand, ExecRequest, VenueLiquidity } from './types'
import { CAPACITY_BANDS, LIST_STAKE_USD, YOUR_MAX_WITHDRAW_USD } from './fixtures'

/** Applies an alpha channel to a `#rrggbb` semantic token, e.g. for the waterfall's tinted segment fills. */
export const withAlpha = (hex: string, alpha: number): string => {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Compact USD formatter — proto's `usd(n)` (script :441). */
export const usd = (n: number): string => {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${Math.round(n / 1000)}k`
}

/** Full-precision USD formatter for the stake box row ("$5,000"). */
export const usdRounded = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`

/** Strips everything but digits/decimal and parses — proto's stake-amount parse (script :393). */
export const parseAmountInput = (raw: string): number => {
  const cleaned = raw.replace(/[^0-9.]/g, '')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

/** Percent share of a band's amount out of the CAPACITY_BANDS total, for the flex-width bar segments. */
export const bandSharePercent = (band: CapacityBand, bands: CapacityBand[] = CAPACITY_BANDS): number => {
  const total = bands.reduce((sum, b) => sum + b.amountUsd, 0)
  if (total <= 0) return 0
  return (band.amountUsd / total) * 100
}

/** Per-venue instant/cooling/stranded share of that venue's own deployed total (script :456-461). */
export const venueSharePercent = (venue: VenueLiquidity, part: 'instant' | 'cooling' | 'stranded'): number => {
  const total = venue.instantUsd + venue.coolingUsd + venue.strandedUsd
  if (total <= 0) return 0
  const amount = part === 'instant' ? venue.instantUsd : part === 'cooling' ? venue.coolingUsd : venue.strandedUsd
  return (amount / total) * 100
}

export const venueTotalUsd = (venue: VenueLiquidity): number => venue.instantUsd + venue.coolingUsd + venue.strandedUsd

/** "You: maxWithdraw(you) = …" summary sentence — proto script :449-452. */
export const buildCapacitySummary = (bands: CapacityBand[] = CAPACITY_BANDS): string => {
  const [instant, cooling, stranded] = bands
  return (
    `You: maxWithdraw(you) = ${usdRounded(YOUR_MAX_WITHDRAW_USD)} — your whole balance, instantly, today. ` +
    `The clamp binds only when instant liquidity falls below your balance. If every lender left at once: ` +
    `${usd(instant.amountUsd)} exits now, ${usd(cooling.amountUsd)} lands Aug 22, ${usd(stranded.amountUsd)} ` +
    `cannot leave until the operator cranks.`
  )
}

/** Sacrifice-ratio label pair — proto script :387-389 ("boost: give up X% of fees → Yx points"). */
export const sacrificeMultiplier = (sacrificeRatioPercent: number): string =>
  `${(1 + sacrificeRatioPercent / 100).toFixed(2)}×`

/**
 * Builds the stake confirm-sheet request, mirroring the proto's two-step
 * disclosure (script :391-410): the base stake rows, plus — only when the
 * sacrifice ratio is above 0 — a "step 2 of 2" PointsSystem signature that
 * boosts points weight in exchange for a share of fees.
 */
export const buildStakeRequest = (seatValue: string, amountRaw: string, sacrificeRatioPercent: number): ExecRequest => {
  const amount = parseAmountInput(amountRaw)
  const isJunior = /junior/.test(seatValue)

  const rows: ExecRequest['rows'] = [
    { label: 'You stake', value: usdRounded(amount) },
    { label: 'Seat', value: isJunior ? 'junior — first staked loss' : 'senior — behind disco + junior' },
    { label: 'Fee share', value: isJunior ? 'higher — priced for the seat' : 'standard' },
    { label: 'Withdraw', value: 'anytime — no lock on existing listings' },
  ]

  let note = 'Losses eat left to right. Your seat is drawn in the loss order below.'

  if (sacrificeRatioPercent > 0) {
    rows.push({ label: '— step 2 of 2 —', value: `setSacrifice(Lender, ${sacrificeRatioPercent}%)` })
    rows.push({
      label: 'Fees you keep',
      value: `${100 - sacrificeRatioPercent}% · the forgone ${sacrificeRatioPercent}% boosts your own tranche rate`,
    })
    rows.push({ label: 'Points weight', value: `${sacrificeMultiplier(sacrificeRatioPercent)} fee-value` })
    note +=
      ' The sacrifice is a second signature to PointsSystem — immediate, reversible, and the Transmuter ' +
      'syncs it at your next touch there.'
  }

  return {
    title: `Stake — ${isJunior ? 'junior' : 'senior'}${sacrificeRatioPercent > 0 ? ' · 2 signatures' : ''}`,
    rows,
    note,
    cta: sacrificeRatioPercent > 0 ? 'Sign both' : 'Sign & stake',
    done: 'Staked — seat live',
  }
}

/** Builds the "Stake to list" confirm-sheet request for a shop candidate — proto script :330-333. */
export const buildListRequest = (sym: string): ExecRequest => ({
  title: `List ${sym} — stake the junior tranche`,
  rows: [
    { label: 'You stake', value: usdRounded(LIST_STAKE_USD) },
    { label: 'Lock', value: '90 days, no early exit' },
    { label: 'Onboards at', value: '40% LTV' },
    { label: 'Borrow capacity', value: 'capped to your stake' },
    { label: 'Your seat', value: 'junior — first staked loss' },
  ],
  note: 'Listing is permissionless. Your capital is the underwriting.',
  cta: 'Sign & list',
  done: 'Listed — tranche live',
})

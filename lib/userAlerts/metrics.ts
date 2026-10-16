/**
 * USER THRESHOLD ALERTS ("Alert me at X") — the shared vocabulary. Pure and
 * client-safe: the API validates with these, the UI view-model prefills and
 * validates with the same constants, so the two can never disagree on a bound.
 *
 * Units (one per metric, everywhere — API, DB, feed, UI):
 *   price        USD per unit of the asset (Chainlink USD feed)
 *   utilization  percent, 0–100 (recorder venue_snapshots params.utilization_pct)
 *   apr          percent per year (venue supply APR now, lib/netApy at one block)
 */

import { venueByKey } from '@/lib/netApy/venues'

export const METRICS = ['price', 'utilization', 'apr'] as const
export type Metric = (typeof METRICS)[number]

export const DIRECTIONS = ['above', 'below'] as const
export type Direction = (typeof DIRECTIONS)[number]

/** 'telegram' is reserved for an owner created from a chat; the web creates 'address' owners only. */
export const OWNER_KINDS = ['address', 'telegram'] as const
export type OwnerKind = (typeof OWNER_KINDS)[number]

/** Active thresholds per owner (one feed). Same number as the bot's per-chat cap. */
export const MAX_ACTIVE_PER_OWNER = 25

/** Assets with a verified Chainlink USD feed (lib/userAlerts/values.ts CHAINLINK_FEEDS). */
export const PRICE_ASSETS = ['ETH', 'BTC'] as const
export type PriceAsset = (typeof PRICE_ASSETS)[number]
export const PRICE_SUBJECTS: readonly string[] = PRICE_ASSETS.map((a) => `asset:${a}`)

/**
 * Sane bounds per metric (inclusive unless minExclusive). Price: a positive USD
 * price below $10M. Utilization: a percentage. APR: 0–500% — a supply APR at full
 * utilization can pass 100% on a steep slope2, never 500%.
 */
export const BOUNDS: Record<Metric, { min: number; max: number; minExclusive: boolean }> = {
  price: { min: 0, max: 10_000_000, minExclusive: true },
  utilization: { min: 0, max: 100, minExclusive: false },
  apr: { min: 0, max: 500, minExclusive: false },
}

/**
 * HYSTERESIS: a crossed threshold clears only once the value is back past the line
 * by more than this band, so a value hovering at the line cannot flap.
 *  - price: 0.5% of the threshold. Both Chainlink feeds update on a 0.5% deviation
 *    (or the 1h heartbeat), so a clear needs at least one full deviation-sized move
 *    back — oracle noise alone cannot clear and re-fire.
 *  - utilization / apr: 0.5 percentage points. Hour-to-hour recorder utilization and
 *    block-to-block supply APR move by tenths of a point in calm markets; half a
 *    point is above that noise and well below a move anyone would set an alert for.
 */
export const PRICE_BAND_FRACTION = 0.005
export const PP_BAND = 0.5

export const hysteresisBand = (metric: Metric, threshold: number): number =>
  metric === 'price' ? Math.abs(threshold) * PRICE_BAND_FRACTION : PP_BAND

/** The risk side of each metric: what a holder most wants to hear about first. */
export const DEFAULT_DIRECTION: Record<Metric, Direction> = {
  price: 'below', // collateral falling
  utilization: 'above', // exits getting gated
  apr: 'below', // carry compressing
}

export const isMetric = (v: unknown): v is Metric => typeof v === 'string' && (METRICS as readonly string[]).includes(v)
export const isDirection = (v: unknown): v is Direction =>
  typeof v === 'string' && (DIRECTIONS as readonly string[]).includes(v)

/** 32 random bytes as lower-case hex — the feed capability. */
export const FEED_TOKEN_RE = /^[0-9a-f]{64}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Stored precision: six decimals (the smallest step is 0.000001). */
export const THRESHOLD_SCALE = 1e6

/** Threshold validation shared by the API and the form. */
export const checkThreshold = (
  metric: Metric,
  n: unknown,
): { ok: true; value: number } | { ok: false; message: string } => {
  const b = BOUNDS[metric]
  // Round FIRST, then bound the number that will be stored: six decimals is finer than
  // any feed this compares against, and checking before rounding let a price like
  // 0.0000004 pass "> 0" and be stored as 0.
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n * THRESHOLD_SCALE) / THRESHOLD_SCALE : NaN
  const low = b.minExclusive ? v > b.min : v >= b.min
  if (!Number.isFinite(v) || !low || v > b.max) {
    const range =
      metric === 'price'
        ? `a USD price up to ${fmtNumber(b.max, 0)}`
        : `a % from ${b.min} to ${b.max}`
    return { ok: false, message: `Enter ${range}.` }
  }
  // Never a negative zero (a "-0.0000001" utilization rounds to 0).
  return { ok: true, value: v === 0 ? 0 : v }
}

/** A string threshold the API accepts: a plain decimal. Number('') is 0 and Number('0x10') is 16. */
export const PLAIN_DECIMAL_RE = /^-?\d+(\.\d+)?$/

/** The message for a STRING threshold that is not a plain decimal; null otherwise (metric not needed). */
export const thresholdShapeError = (raw: unknown): string | null =>
  typeof raw === 'string' && !PLAIN_DECIMAL_RE.test(raw.trim()) ? 'Enter a plain number, like 4.5.' : null

/**
 * The API's ONE threshold rule, for creating (POST /api/alerts) and editing
 * (PATCH /api/alerts/feed/[token]): a string must be a plain decimal, then the
 * metric's bounds (anything that is not a finite number fails those).
 */
export const apiThreshold = (metric: Metric, raw: unknown): ReturnType<typeof checkThreshold> => {
  const shape = thresholdShapeError(raw)
  if (shape) return { ok: false, message: shape }
  return checkThreshold(metric, typeof raw === 'string' ? Number(raw.trim()) : raw)
}

// --- subjects --------------------------------------------------------------

export type Subject = { kind: 'asset'; asset: string } | { kind: 'venue'; venue: string }

export const parseSubject = (s: string): Subject | null => {
  const m = /^(asset|venue):([A-Za-z0-9._-]{1,64})$/.exec(s)
  if (!m) return null
  return m[1] === 'asset' ? { kind: 'asset', asset: m[2] } : { kind: 'venue', venue: m[2] }
}

export const venueSubject = (venue: string): string => `venue:${venue}`
export const assetSubject = (asset: string): string => `asset:${asset}`

/** "ETH", "Aave v3 USDe", or the bare venue key. */
export const subjectLabel = (subject: string): string => {
  const s = parseSubject(subject)
  if (!s) return subject
  if (s.kind === 'asset') return s.asset
  return venueByKey(s.venue)?.label ?? s.venue
}

export const METRIC_LABEL: Record<Metric, string> = {
  price: 'price',
  utilization: 'utilization',
  apr: 'supply APR',
}

// --- formatting (fixed en-US so server and client render the same string) ---

const fmtNumber = (v: number, dp: number): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })

/** Decimals per metric: price to the cent, utilization as the venue page shows it, APR to 2. */
export const METRIC_DP: Record<Metric, number> = { price: 2, utilization: 1, apr: 2 }

export const formatValue = (metric: Metric, v: number): string =>
  metric === 'price' ? `$${fmtNumber(v, METRIC_DP.price)}` : `${fmtNumber(v, METRIC_DP[metric])}%`

/** "ETH price below $2,500.00" */
export const describeThreshold = (t: { metric: Metric; subject: string; direction: Direction; threshold: number }): string =>
  `${subjectLabel(t.subject)} ${METRIC_LABEL[t.metric]} ${t.direction} ${formatValue(t.metric, t.threshold)}`

// --- token encoding --------------------------------------------------------
// Telegram caps a /start payload at 64 chars of [A-Za-z0-9_-]. "th_" + 64 hex is 67,
// so the deep link carries the SAME 32 bytes as base64url (43 chars → 46 total).
// Pure (no Buffer) so this module stays client-safe.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export const hexToBase64url = (hex: string): string => {
  const bytes = hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    if (b !== undefined) out += B64[(n >> 6) & 63]
    if (c !== undefined) out += B64[n & 63]
  }
  return out
}

export const base64urlToHex = (s: string): string | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  let bits = 0
  let acc = 0
  let hex = ''
  for (const ch of s) {
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      hex += ((acc >> bits) & 0xff).toString(16).padStart(2, '0')
    }
  }
  return hex
}

export const TELEGRAM_LINK_PREFIX = 'th_'

/** t.me deep link that opens the bot with `/start th_<token>`. */
export const thresholdDeepLink = (botUsername: string, feedToken: string): string =>
  `https://t.me/${botUsername.replace(/^@/, '')}?start=${TELEGRAM_LINK_PREFIX}${hexToBase64url(feedToken)}`

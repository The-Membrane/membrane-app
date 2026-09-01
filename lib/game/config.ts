// Server-authoritative economy + energy constants for the offchain Q-Racing game.
// See docs/OFFCHAIN_QRACING_PLAN.md (Phase 2 + Phase 3).
//
// Trust rule: BYTE becomes on-chain money at mint, so every value credited to a player is
// decided here on the server, never posted by the client.

export const GAME = {
  // --- Energy ---------------------------------------------------------------
  // Keeper-free continuous refill: energy accrues linearly from `energy.updated_at`,
  // reaching ENERGY_MAX after ENERGY_REFILL_MS. Mirrors the 5-per-session cost the old
  // in-memory racing UI used (ENERGY_CONSUMED_PER_TRAINING_SESSION).
  ENERGY_MAX: 100,
  ENERGY_PER_RACE: 5,
  ENERGY_REFILL_MS: 4 * 60 * 60 * 1000, // full 0 -> 100 refill in 4 hours

  // --- BYTE (6 decimals, mirrors the byteMinter mint_amount base-unit convention) -------
  BYTE_DECIMALS: 6,
  // Awarded per server-verified race win. 5_000_000n base units = 5.000000 BYTE.
  BYTE_PER_WIN: 5_000_000n,
  // Phase 3 faucet cap: max BYTE creditable to one player per rolling 24h. Unused in
  // Phase 2 (race/submit does not yet enforce it) — defined here so Phase 3 wires it in.
  DAILY_BYTE_CAP: 200_000_000n, // 200 BYTE / day

  // --- Points (Phase 5 engagement ledger, app_points_ledger) -----------------------
  // A SEPARATE namespace from the on-chain PointsSystem.sol / MBRN-claim points
  // (services/chain/points.ts, rendered in components/Nav/PointsLevel.tsx) — plain
  // integer counts, no decimal scaling. 10 mirrors the app's existing convention of
  // small whole-number point displays (see PointsProgressCompactCard's `.toFixed(0)`).
  POINTS_PER_RACE_WIN: 10n,

  // --- Race lifecycle -------------------------------------------------------
  // A started race must be submitted within this window or it is marked 'expired'.
  RACE_SUBMIT_WINDOW_MS: 10 * 60 * 1000, // 10 minutes
  // Hard bound on the moves array a client may submit (anti-abuse; the tick cap in
  // replay.ts is the real limiter, this just bounds payload size).
  MAX_SUBMITTED_MOVES: 2048,

  // --- Session tracking (Phase 5, app_sessions) -------------------------------
  // A heartbeat within this window of the last one extends the current session row;
  // past it, the next heartbeat opens a new session.
  SESSION_IDLE_WINDOW_MS: 30 * 60 * 1000, // 30 minutes
  // Client-side throttle: hooks/useSessionHeartbeat.ts fires at most this often.
  SESSION_HEARTBEAT_MIN_INTERVAL_MS: 60 * 1000, // 60 seconds
} as const

/**
 * Continuous energy refill. Given the last-written value + timestamp, returns the current
 * energy (capped at max) and the ISO time at which it will next reach `max` (null if full).
 */
export function computeEnergy(
  storedValue: number,
  updatedAt: Date,
  now: Date = new Date(),
): { value: number; max: number; refillAt: string | null } {
  const max = GAME.ENERGY_MAX
  const clampedStored = Math.max(0, Math.min(max, Math.floor(storedValue)))
  const elapsedMs = Math.max(0, now.getTime() - updatedAt.getTime())
  const gained = Math.floor((elapsedMs * max) / GAME.ENERGY_REFILL_MS)
  const value = Math.min(max, clampedStored + gained)

  if (value >= max) return { value: max, max, refillAt: null }

  // ms until energy reaches `max` from the stored anchor.
  const msToFull = Math.ceil(((max - clampedStored) * GAME.ENERGY_REFILL_MS) / max)
  const refillAt = new Date(updatedAt.getTime() + msToFull).toISOString()
  return { value, max, refillAt }
}

/**
 * ISO time at which energy reaches `target` (used for the 402 insufficient-energy response
 * so the client can show a precise "playable again at" countdown). Null if already at/above.
 */
export function refillAtForTarget(
  storedValue: number,
  updatedAt: Date,
  target: number,
): string | null {
  const max = GAME.ENERGY_MAX
  const clampedStored = Math.max(0, Math.min(max, Math.floor(storedValue)))
  if (clampedStored >= target) return null
  const msToTarget = Math.ceil(((target - clampedStored) * GAME.ENERGY_REFILL_MS) / max)
  return new Date(updatedAt.getTime() + msToTarget).toISOString()
}

/**
 * Phase 3 faucet-cap arithmetic, pure so it's testable without a DB (tests/unit/limits.test.ts).
 * `earnedToday` is the sum of today's (UTC day) byte_ledger deltas with reason IN
 * ('race_win', 'rps_win') for the player, computed by the caller. Returns the BYTE to credit
 * for one more win: the full per-win amount, a partial amount if the cap is close, or 0n once
 * the cap is reached. Never negative.
 */
export function computeByteAward(
  earnedToday: bigint,
  perWin: bigint = GAME.BYTE_PER_WIN,
  dailyCap: bigint = GAME.DAILY_BYTE_CAP,
): bigint {
  const remaining = dailyCap - earnedToday
  if (remaining <= 0n) return 0n
  return remaining < perWin ? remaining : perWin
}

/** UTC-day window [start, end) that "today" means for the daily BYTE cap. */
export function utcDayRange(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  )
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

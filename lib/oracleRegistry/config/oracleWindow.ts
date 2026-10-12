/**
 * The oracle governance window's read-gap threshold, shared by the engine and the card (R5,
 * 2026-10-12: the engine listed an oracle-window read gap 300 blocks below the head while the
 * Oracles heading said "last 180 d" up to a day — 7,200 blocks — below it, so a window 1,000
 * blocks short read "last" beside its own read-gap line). No imports: the client card reads it
 * without pulling the engine into its bundle.
 */

/** A window ending more than this many blocks below the head is a read gap (PO-07 / MISSED-1). */
export const ORACLE_WINDOW_GAP_BLOCKS = 300

/** The engine lists "oracle governance changes: last … not read" exactly when this holds. */
export const oracleWindowGap = (endBlock: number, headBlock: number): boolean =>
  endBlock < headBlock - ORACLE_WINDOW_GAP_BLOCKS

/**
 * "Oct 5 UTC"; "Oct 5, 2025 UTC" when the year is not the head's, or the head is unknown. The
 * Oracles heading ("180 d to Oct 5 UTC") and the engine's read-gap line name the window's end in
 * these same words (S4, 2026-10-12).
 */
export function utcDay(ts: number, headTs: number): string {
  const d = new Date(ts * 1000)
  const day = `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`
  return headTs && new Date(headTs * 1000).getUTCFullYear() === d.getUTCFullYear()
    ? `${day} UTC`
    : `${day}, ${d.getUTCFullYear()} UTC`
}

const DAY_SEC = 86_400
const HOUR_SEC = 3_600
const n = (x: number) => x.toLocaleString('en-US')
const unit = (k: number, one: string) => `${n(k)} ${one}${k === 1 ? '' : 's'}`

/** The read-gap line of an oracle window whose end is not a finite block number. */
export const ORACLE_WINDOW_END_UNREAD = 'oracle governance changes: window end not read'

/**
 * The oracle-window read gap the engine lists and counts, or null when the window reaches the
 * head (S4, 2026-10-12: the line read "oracle governance events after block 26,129,366 not read
 * (the oracle collector's window ends 44,158 blocks below head)" — collector words, the block
 * twice; and an end that was not a finite number — NaN, null, a string, no window — failed the
 * threshold compare, so the engine listed nothing while the card hedged "180 d" over it).
 *   - end not a finite number, or no window: ORACLE_WINDOW_END_UNREAD (fail closed);
 *   - else the hole, floored (never claims more unread than there is): "last 6 days" / "last 3
 *     hours" when both times are known and the hole is at least an hour, else "last 44,158
 *     blocks" (never an invented time) — then where it starts: "(after Oct 5 UTC, block …)".
 */
export function oracleWindowGapLine(
  w: { endBlock?: unknown; endTs?: unknown } | null | undefined,
  head: { block: number; ts: number },
): string | null {
  const end = w?.endBlock
  if (typeof end !== 'number' || !Number.isFinite(end)) return ORACLE_WINDOW_END_UNREAD
  if (!oracleWindowGap(end, head.block)) return null
  const endTs = typeof w?.endTs === 'number' && Number.isFinite(w.endTs) ? w.endTs : null
  const sec = endTs !== null && Number.isFinite(head.ts) ? head.ts - endTs : NaN
  const hole =
    sec >= DAY_SEC
      ? unit(Math.floor(sec / DAY_SEC), 'day')
      : sec >= HOUR_SEC
        ? unit(Math.floor(sec / HOUR_SEC), 'hour')
        : unit(head.block - end, 'block')
  const from = endTs !== null && sec >= HOUR_SEC ? `${utcDay(endTs, head.ts)}, ` : ''
  return `oracle governance changes: last ${hole} not read (after ${from}block ${n(end)})`
}

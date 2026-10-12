/**
 * The oracle governance window's read-gap threshold, shared by the engine and the card (R5,
 * 2026-10-12: the engine listed an oracle-window read gap 300 blocks below the head while the
 * Oracles heading said "last 180 d" up to a day — 7,200 blocks — below it, so a window 1,000
 * blocks short read "last" beside its own read-gap line). No imports: the client card reads it
 * without pulling the engine into its bundle.
 */

/** A window ending more than this many blocks below the head is a read gap (PO-07 / MISSED-1). */
export const ORACLE_WINDOW_GAP_BLOCKS = 300

/** The engine lists "oracle governance events after block … not read" exactly when this holds. */
export const oracleWindowGap = (endBlock: number, headBlock: number): boolean =>
  endBlock < headBlock - ORACLE_WINDOW_GAP_BLOCKS

/**
 * oracleRounds — the pure Chainlink round handling behind
 * scripts/position-sim/build-price-history.mjs: phase windows, log decoding, the phase
 * HANDOVER round, and the per-hour aggregate. No I/O, so the price-history build is testable
 * (tests/unit/oracleRounds.test.ts).
 *
 * A ROUND ROW is `[block, logIndex, ts, price]`, sorted by (block, logIndex) — the order the
 * proxy saw the answers in. `ts` places the row on the hourly grid.
 *
 * PHASE WINDOWS. A Chainlink proxy's old phase aggregators can keep emitting after the proxy
 * moves on, so a log counts only inside its own phase's window [fromBlock, toBlock]
 * (`decodeRounds`). That alone drops one value the proxy DID serve:
 *
 * PHASE HANDOVER (refuter finding 2026-10-06). At the switch block the proxy starts serving
 * the NEW aggregator's latest round — a round it posted BEFORE the switch, which the window
 * rule drops as out of phase. Without it the hourly columns carried the OLD phase's last
 * value until the new aggregator's first in-phase round (ETH/USD phase 3, block 11008985:
 * 341.72 held ~3 h while the proxy served 341.1598; stETH/ETH phase 2, block 20435611:
 * 0.999895 held while it served 1.0000472). So each switch gets ONE synthetic row
 * (`handoverRow`): the new phase's `latestRoundData()` read at the block BEFORE the switch
 * (archive eth_call, so a round posted inside the switch block itself stays an ordinary log),
 * placed at the switch block with logIndex −1 (ahead of every log in that block) and stamped
 * with the switch block's TIMESTAMP — not the round's `updatedAt`, which is older and would
 * put the value into hours when the proxy still served the old phase.
 */

const H = 3600

/** A round row: [block, logIndex, ts (unix s), price]. */
export type RoundRow = [number, number, number, number]

/** One phase of a proxy, as the build's phase table stores it (blocks as decimal strings). */
export interface PhaseWindow {
  phase: number
  /** The aggregator the proxy calls in this phase. */
  address: string
  /** Where its AnswerUpdated logs come from (a facade's wrapped aggregator). */
  logSource: string
  fromBlock: string
  /** Null for the current phase. */
  toBlock: string | null
}

/** The AnswerUpdated fields `decodeRounds` reads off a viem log. */
export interface AnswerLog {
  address: string
  blockNumber: bigint
  logIndex: number | bigint
  args?: { current?: bigint; updatedAt?: bigint }
}

export const inPhase = (p: PhaseWindow, b: bigint): boolean =>
  BigInt(p.fromBlock) <= b && (p.toBlock === null || b <= BigInt(p.toBlock))

/**
 * Decoded rounds, each kept only inside its own phase window. A log of an aggregator before
 * its phase began is counted in `outOfPhase` — the one such round the proxy served (the new
 * phase's latest at the switch) comes back as a `handoverRow`.
 */
export function decodeRounds(
  logs: readonly AnswerLog[],
  phases: readonly PhaseWindow[],
  decimals: number,
): { rows: RoundRow[]; outOfPhase: number } {
  const rows: RoundRow[] = []
  let outOfPhase = 0
  for (const l of logs) {
    const addr = String(l.address).toLowerCase()
    const ph = phases.find((p) => p.logSource.toLowerCase() === addr && inPhase(p, l.blockNumber))
    if (!ph) {
      outOfPhase++
      continue
    }
    const cur = l.args?.current
    const upd = l.args?.updatedAt
    if (cur === undefined || upd === undefined || cur <= 0n) continue
    rows.push([
      Number(l.blockNumber),
      Number(l.logIndex),
      Number(upd),
      Number(cur) / 10 ** decimals,
    ])
  }
  rows.sort(byBlockLog)
  return { rows, outOfPhase }
}

/** One phase switch's handover read, as the build caches it. */
export interface PhaseHandover {
  /** The phase the proxy switched TO. */
  phase: number
  /** Its first block (the switch block). */
  fromBlock: string
  /** Timestamp of the switch block, unix s. */
  switchTs: number
  /**
   * The new phase's `latestRoundData()` at fromBlock − 1: what the proxy served from the
   * switch on. Null when it had no round yet (nothing carries over).
   */
  answer: string | null
  updatedAt: number | null
}

/** The synthetic round a handover contributes, or null when nothing carried over. */
export function handoverRow(h: PhaseHandover, decimals: number): RoundRow | null {
  if (h.answer === null) return null
  const a = BigInt(h.answer)
  if (a <= 0n || !(h.updatedAt! > 0)) return null
  return [Number(h.fromBlock), -1, h.switchTs, Number(a) / 10 ** decimals]
}

/**
 * Logged rounds plus every phase's handover row, in proxy order. Throws when a switch in
 * `phases` has no handover entry — a cache built before the fix must be re-read
 * (`--phase=handover`), never silently rebuilt with the old-phase carry-over.
 */
export function withHandovers(
  rows: readonly RoundRow[],
  phases: readonly PhaseWindow[],
  handovers: readonly PhaseHandover[],
  decimals: number,
): { rows: RoundRow[]; added: number } {
  const out = rows.slice()
  let added = 0
  for (const p of phases) {
    if (p.phase <= 1) continue // the first phase has no predecessor
    const h = handovers.find((x) => x.phase === p.phase)
    if (!h || h.fromBlock !== p.fromBlock)
      throw new Error(
        `phase ${p.phase} (switch block ${p.fromBlock}) has no handover read — run --phase=handover`,
      )
    const r = handoverRow(h, decimals)
    if (r) {
      out.push(r)
      added++
    }
  }
  out.sort(byBlockLog)
  return { rows: out, added }
}

/**
 * Per-hour aggregate of rows sorted by (block, logIndex): Map hourTs → [hourTs, last, low,
 * high, n, lastBlock]. `last` is the value in force at the hour's end.
 */
export function aggregateHours(
  rows: readonly RoundRow[],
): Map<number, [number, number, number, number, number, number]> {
  const out = new Map<number, [number, number, number, number, number, number]>()
  for (const [block, , ts, price] of rows) {
    const h = Math.floor(ts / H) * H
    const cur = out.get(h)
    if (!cur) out.set(h, [h, price, price, price, 1, block])
    else {
      cur[1] = price
      if (price < cur[2]) cur[2] = price
      if (price > cur[3]) cur[3] = price
      cur[4]++
      cur[5] = block
    }
  }
  return out
}

function byBlockLog(a: RoundRow, b: RoundRow): number {
  return a[0] - b[0] || a[1] - b[1]
}

import type { MigrateSource } from '@/lib/migrate/types'

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The ≤ 8-word stamp (`Anvil · block 68`, `Replay · 2025-10-10`) and the full provenance line
 *  for Details. */
export function sourceStamp(
  position: MigrateSource,
  onChain: { block: bigint; chainLabel: string } | null,
): { stamp: string; provenance: string } {
  if (onChain) {
    return {
      stamp: `${onChain.chainLabel.split(' ')[0]} · block ${onChain.block.toString()}`,
      provenance: `Rows read on ${onChain.chainLabel} at block ${onChain.block.toString()}, valued at Membrane’s oracle price.`,
    }
  }
  const p = position.provenance
  return {
    stamp: `Replay · ${day(p.at)}`,
    provenance: `Rows from the replayed position: ${p.label}, fetched ${hhmm(p.at)} UTC.`,
  }
}

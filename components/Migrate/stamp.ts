import type { MigrateSource } from '@/lib/migrate/types'

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

/** `source · fetched HH:MM` (UTC) for the replayed position, or the block the rows were read at. */
export function sourceStamp(position: MigrateSource, onChain: { block: bigint; chainLabel: string } | null): string {
  if (onChain) return `read on ${onChain.chainLabel} · block ${onChain.block.toString()} · Membrane oracle price`
  const p = position.provenance
  return `${p.label} · fetched ${hhmm(p.at)} UTC · rows from the replayed position`
}

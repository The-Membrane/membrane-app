// The simulator's one line when a read leaves nothing to simulate. Pure, so it is tested.
//
// Two reads are not "nothing found": a LENDER holds a position with no liquidation line (and
// is not beyond loss: Morpho writes bad debt off against lenders' supply), and a venue whose
// market discovery fell back checked only the markets it knows.

import { discoveryNote } from '@/lib/position-sim/adapters/types'
import type { AdapterResult, MarketDiscovery } from '@/lib/position-sim/types'

export function emptyReadLine(results: readonly AdapterResult[]): string {
  const partial = results.filter((r) => r.discovery && !r.discovery.complete)
  const lending = results.flatMap((r) => r.positions.filter((p) => p.status === 'supply-only'))
  const parts: string[] = []
  if (lending.length > 0) {
    parts.push(
      `Lending only (${lending.map((p) => p.label).join(', ')}): no liquidation line to simulate. Bad debt in a market is shared by its lenders.`,
    )
  }
  if (partial.length > 0) {
    parts.push(
      `No borrow position in the markets checked; ${partial
        .map((r) => `${r.label}: ${discoveryNote(r.discovery as MarketDiscovery)}`)
        .join('; ')}.`,
    )
  }
  return parts.length > 0 ? parts.join(' ') : 'No open position found for this address.'
}

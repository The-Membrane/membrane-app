import React from 'react'

import type { MigrateSheetProps } from '@/lib/migrate/types'

import { SlipView } from './SlipView'
import { sourceStamp } from './stamp'
import { useMigrateFlow } from './useMigrateFlow'

/**
 * "Migrate this position" (Q41 seam, stable name and props). Repays the old venue, moves the
 * collateral and reopens on Membrane in one Bundler3 transaction backed by a Morpho flash loan.
 * Pass a memoized `position`: the sheet re-reads the chain when it changes.
 */
export const MigrateSheet: React.FC<MigrateSheetProps & { inline?: boolean }> = ({ position, onClose, inline }) => {
  const flow = useMigrateFlow('migrate', position)
  return (
    <SlipView
      kind="migrate"
      inline={inline}
      plan={flow.plan}
      phase={flow.phase}
      sourceStamp={sourceStamp(position, flow.readOnChain)}
      promptIds={flow.promptIds}
      addresses={flow.addresses}
      onStart={flow.start}
      onClose={onClose}
    />
  )
}

export default MigrateSheet

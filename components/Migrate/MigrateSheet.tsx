import React from 'react'

import type { MigrateSheetProps } from '@/lib/migrate/types'

/** Interface stub (Q41 seam). The full sheet replaces this body; the export name and
 *  props stay. */
export const MigrateSheet: React.FC<MigrateSheetProps> = ({ position, onClose }) => (
  <div role="dialog" aria-label="Migrate this position" data-testid="migrate-sheet">
    <p>Migrate {position.label} — plan pending</p>
    <button type="button" onClick={onClose}>
      Close
    </button>
  </div>
)

export default MigrateSheet

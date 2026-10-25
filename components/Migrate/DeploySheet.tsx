import React from 'react'

import type { DeploySheetProps } from '@/lib/migrate/types'

/** Interface stub (Q41 seam). The full sheet replaces this body; the export name and
 *  props stay. */
export const DeploySheet: React.FC<DeploySheetProps> = ({ position, onClose }) => (
  <div role="dialog" aria-label="Deploy fresh on Membrane" data-testid="deploy-sheet">
    <p>Deploy fresh from {position.label} — plan pending</p>
    <button type="button" onClick={onClose}>
      Close
    </button>
  </div>
)

export default DeploySheet

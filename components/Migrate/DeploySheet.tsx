import React from 'react'

import type { DeploySheetProps } from '@/lib/migrate/types'

import { SlipView } from './SlipView'
import { sourceStamp } from './stamp'
import { useMigrateFlow } from './useMigrateFlow'

/**
 * "Deploy fresh" (Q41 seam, stable name and props). Opens a new Membrane position from the
 * wallet, prefilled from the replayed position: the same collateral (capped at what the wallet
 * holds) at the replay's LTV, capped at Membrane's borrow LTV.
 */
export const DeploySheet: React.FC<DeploySheetProps & { inline?: boolean }> = ({ position, onClose, inline }) => {
  const flow = useMigrateFlow('deploy', position)
  const replayed = position.collateral[0]
  const moved = flow.plan.move[0]
  const notes =
    flow.readOnChain && replayed && moved && moved.amount < replayed.amount
      ? [`Capped at your wallet: it holds ${moved.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${moved.symbol}; the replay held ${replayed.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}.`]
      : undefined
  return (
    <SlipView
      kind="deploy"
      inline={inline}
      plan={flow.plan}
      phase={flow.phase}
      sourceStamp={sourceStamp(position, flow.readOnChain)}
      promptIds={flow.promptIds}
      addresses={flow.addresses}
      notes={notes}
      onStart={flow.start}
      onClose={onClose}
    />
  )
}

export default DeploySheet

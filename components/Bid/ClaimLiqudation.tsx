import ConfirmModal from '@/components/ConfirmModal'
import { num } from '@/helpers/num'
import { ClaimSummary } from './ClaimSummary'
import useCheckClaims from './hooks/useCheckClaims'
import useClaimLiquidation from './hooks/useClaimLiquidation'

const ClaimLiqudation = () => {
  const { data: claims } = useCheckClaims()
  const claimLiqudation = useClaimLiquidation(claims)

  const isClaimDisabled = claims?.filter((claim) => num(claim.pending_liquidated_collateral).gt(0))

  return (
    <ConfirmModal
      label="Claim Liquidation"
      buttonProps={{
        borderRadius: '24px',
        justifySelf: 'end',
        w: '220px',
        px: '4',
        size: 'sm',
        fontWeight: 'normal',
        mr: '1',
      }}
      action={claimLiqudation}
      isDisabled={!isClaimDisabled?.length}
    >
      <ClaimSummary claims={claims} />
    </ConfirmModal>
  )
}

export default ClaimLiqudation

import ConfirmModal from '@/components/ConfirmModal'
import TxError from '@/components/TxError'
import { ClaimSummary } from './ClaimSummary'
import useCheckClaims from './hooks/useCheckClaims'
import useClaimLiquidation from './hooks/useClaimLiquidation'

const ClaimLiqudation = () => {
  const { data: claims } = useCheckClaims()
  const claimLiqudation = useClaimLiquidation(claims)

  return (
    <ConfirmModal
      label="Claim Liqudation"
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
    >
      <ClaimSummary claims={claims} />
      <TxError action={claimLiqudation} />
    </ConfirmModal>
  )
}

export default ClaimLiqudation

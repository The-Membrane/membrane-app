import ConfirmModal from '@/components/ConfirmModal'
import { num } from '@/helpers/num'
import { ClaimSummary } from './ClaimSummary'
import useCheckClaims from './hooks/useCheckClaims'
import useClaimLiquidation from './hooks/useClaimLiquidation'
import useCheckSPClaims from './hooks/useCheckSPClaims'
import { claimstoCoins } from '@/services/liquidation'
import { Coin } from '@cosmjs/stargate'

const ClaimLiqudation = () => {
  const { data: claims } = useCheckClaims()
  const { data: SP_claims } = useCheckSPClaims()
  const claimLiqudation = useClaimLiquidation(claims, SP_claims)

  var claim_coins: Coin[] = claimstoCoins(claims)
  if (SP_claims) {
    claim_coins = claim_coins.concat(SP_claims.claims)
  }

  const isClaimDisabled = claim_coins?.filter((claim) => num(claim.amount).gt(0))
  
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
      <ClaimSummary claims={claim_coins} />
    </ConfirmModal>
  )
}

export default ClaimLiqudation

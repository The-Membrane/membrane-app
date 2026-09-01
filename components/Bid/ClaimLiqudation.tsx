import ConfirmModal from '@/components/ConfirmModal'
import { num } from '@/helpers/num'
import { ClaimSummary } from './ClaimSummary'
import useClaimLiquidation from './hooks/useClaimLiquidation'
import { claimstoCoins } from '@/services/liquidation'
import { Coin } from '@cosmjs/stargate'
import { useCheckClaims, useCheckSPClaims } from '@/hooks/useLiquidations'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

const ClaimLiqudation = () => {
  const { data: claims } = useCheckClaims(true)
  const { data: SP_claims } = useCheckSPClaims(true)
  const claimLiqudation = useClaimLiquidation(claims, SP_claims, true).action

  var claim_coins: Coin[] = claimstoCoins(claims)
  if (SP_claims) {
    claim_coins = claim_coins.concat(SP_claims.claims)
  }

  const isClaimDisabled = claim_coins?.filter((claim) => num(claim.amount).gt(0))

  return (
    <ConfirmModal
      label="Claim"
      buttonProps={{
        borderRadius: '8px',
        justifySelf: 'end',
        w: '90px',
        px: SPACING.base,
        size: 'sm',
        fontWeight: TYPOGRAPHY.normal,
        mr: SPACING.xs,
      }}
      action={claimLiqudation}
      isDisabled={!isClaimDisabled?.length}
    >
      <ClaimSummary claims={claim_coins} />
    </ConfirmModal>
  )
}

export default ClaimLiqudation

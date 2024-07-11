import { Stack } from '@chakra-ui/react'
import React, { useState } from 'react'
import ConfirmModal from '../ConfirmModal'
import { ClaimSummary } from '../Bid/ClaimSummary'
import { LiqSummary } from './LiqSummary'
import useProtocolClaims from './hooks/useClaims'
import useProtocolLiquidations from './hooks/useLiquidations'

function UniversalButtons(){
    const { action: claim, claims_summary } = useProtocolClaims()
    const { action: liquidate, liquidating_positions: liq_summ } = useProtocolLiquidations()

    return (
        <Stack as="uniButtons" gap="1">
            {/* Claim Button */}
            <ConfirmModal
            label={ 'Claim' }
            action={claim}
            isDisabled={claims_summary.length === 0}
            // isLoading={false}
            >
            <ClaimSummary claims={claims_summary}/>
            </ConfirmModal>
            {/* Liquidate Button */}
            <ConfirmModal
            label={ 'Liquidate' }
            action={liquidate}
            isDisabled={liq_summ.length === 0}
            // isLoading={false}
            >
            <LiqSummary liquidations={liq_summ}/>
            </ConfirmModal>  
        </Stack>
    )
}

export default UniversalButtons
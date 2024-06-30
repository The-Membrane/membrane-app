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

    //Disable claims for a time period to allow simulates to run
    const [enable_msgs, setEnableMsgs] = useState(false)
    setTimeout(() => setEnableMsgs(true), 2222);

    if ((claim?.simulate.isError || !claim?.simulate.data || !enable_msgs || claims_summary.length === 0) && (liquidate?.simulate.isError || !liquidate?.simulate.data || !enable_msgs || liq_summ.length === 0)) return null

    return (
        <Stack as="uniButtons" gap="1">
            {/* Claim Button */}
            <ConfirmModal
            label={ 'Claim' }
            action={claim}
            isDisabled={claim?.simulate.isError || !claim?.simulate.data || !enable_msgs || claims_summary.length === 0}
            >
            <ClaimSummary claims={claims_summary}/>
            </ConfirmModal>
            {/* Liquidate Button */}
            <ConfirmModal
            label={ 'Liquidate' }
            action={liquidate}
            isDisabled={liquidate?.simulate.isError || !liquidate?.simulate.data || !enable_msgs || liq_summ.length === 0}
            >
            <LiqSummary liquidations={liq_summ}/>
            </ConfirmModal>  
        </Stack>
    )
}

export default UniversalButtons
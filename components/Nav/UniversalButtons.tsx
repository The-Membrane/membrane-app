import { Stack } from '@chakra-ui/react'
import React, { useMemo, useState } from 'react'
import ConfirmModal from '../ConfirmModal'
import { ClaimSummary } from '../Bid/ClaimSummary'
import useProtocolClaims from './hooks/useClaims'
import useProtocolLiquidations from './hooks/useLiquidations'
import { LiqSummary } from './LiqSummary'

function UniversalButtons({ enabled, setEnabled }: { enabled: boolean, setEnabled: any }) {
    const { action: claim, claims_summary } = useProtocolClaims({ run: enabled })
    const { action: liquidate, liquidating_positions: liq_summ } = useProtocolLiquidations({ run: enabled })

    const claimsDisabled = claims_summary.length === 0 || !enabled
    const liquidateDisabled = liq_summ.length === 0 || !enabled


    console.log('uni buttns disabled', liquidateDisabled, claimsDisabled)

    useMemo(() => {
        if (claimsDisabled && liquidateDisabled) {
            console.log("both disabled")
            setEnabled(false)
        }
    }, [claimsDisabled, liquidateDisabled])

    return (
        <Stack as="uniButtons" gap="1">
            {/* Claim Button */}
            <ConfirmModal
                label={'Claim'}
                action={claim}
                isDisabled={claimsDisabled}
            // isLoading={false}
            >
                <ClaimSummary claims={claims_summary} />
            </ConfirmModal>
            {/* Liquidate Button */}
            <ConfirmModal
                label={'Liquidate'}
                action={liquidate}
                isDisabled={liquidateDisabled}
            >
                <LiqSummary liquidations={liq_summ} />
            </ConfirmModal>
        </Stack>
    )
}

export default UniversalButtons
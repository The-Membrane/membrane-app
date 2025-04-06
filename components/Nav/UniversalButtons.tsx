import { Stack } from '@chakra-ui/react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import ConfirmModal from '../ConfirmModal'
import { ClaimSummary } from '../Bid/ClaimSummary'
import useProtocolClaims from './hooks/useClaims'
import useProtocolLiquidations from './hooks/useLiquidations'
import { LiqSummary } from './LiqSummary'

function UniversalButtons({ enabled, setEnabled }: { enabled: boolean, setEnabled: any }) {
    const { action: claim, claims_summary } = useProtocolClaims({ run: enabled })
    const { action: liquidate, liquidating_positions: liq_summ } = useProtocolLiquidations({ run: enabled })

    const claimsDisabled = claims_summary.length === 0
    const liquidateDisabled = liq_summ.length === 0
    const claimsLoading = (claim?.simulate.isLoading || claim?.tx.isPending)
    const liquidateLoading = (liquidate?.simulate.isLoading || liquidate?.tx.isPending)


    const claimsDisabledRef = useRef(claimsDisabled);
    const liquidateDisabledRef = useRef(liquidateDisabled);
    const enabledRef = useRef(enabled);
    const claimsLoadingRef = useRef(claimsLoading);
    const liquidateLoadingRef = useRef(liquidateLoading);

    // console.log('uni buttns disabled', liquidateDisabled, claimsDisabled)
    useEffect(() => {
        claimsDisabledRef.current = claimsDisabled;
        liquidateDisabledRef.current = liquidateDisabled;
        enabledRef.current = enabled;
        claimsLoadingRef.current = claimsLoading;
        liquidateLoadingRef.current = liquidateLoading;
    }, [claimsDisabled, liquidateDisabled, enabled, claimsLoading, liquidateLoading]);


    useMemo(() => {
        if (claimsDisabled && liquidateDisabled && enabled) {
            console.log("both disabled")
            setTimeout(() => {
                if (
                    claimsDisabledRef.current &&
                    liquidateDisabledRef.current &&
                    enabledRef.current &&
                    !claimsLoadingRef.current &&
                    !liquidateLoadingRef.current
                ) {
                    setEnabled(false);
                }
            }, 7000);
        }
    }, [claimsDisabled, liquidateDisabled, enabled])

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
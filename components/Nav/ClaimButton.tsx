import { Stack } from '@chakra-ui/react'
import React, { useEffect, useMemo, useRef } from 'react'
import ConfirmModal from '../ConfirmModal'
import { ClaimSummary } from '../Bid/ClaimSummary'
import useProtocolClaims from './hooks/useClaims'

function ClaimButton({ enabled, setEnabled }: { enabled: boolean, setEnabled: any }) {
    const { action: claim, claims_summary } = useProtocolClaims({ run: enabled })
    const claimsDisabled = claims_summary.length === 0
    const claimsLoading = (claim?.simulate.isLoading || claim?.tx.isPending)
    const claimsDisabledRef = useRef(claimsDisabled);
    const enabledRef = useRef(enabled);
    const claimsLoadingRef = useRef(claimsLoading);

    useEffect(() => {
        claimsDisabledRef.current = claimsDisabled;
        enabledRef.current = enabled;
        claimsLoadingRef.current = claimsLoading;
    }, [claimsDisabled, enabled, claimsLoading]);

    useMemo(() => {
        if (claimsDisabled && enabled) {
            setTimeout(() => {
                if (
                    claimsDisabledRef.current &&
                    enabledRef.current &&
                    !claimsLoadingRef.current
                ) {
                    setEnabled(false);
                }
            }, 7000);
        }
    }, [claimsDisabled, enabled]);

    return (
        <Stack gap="1">
            <ConfirmModal
                label={'Claim'}
                action={claim}
                isDisabled={claimsDisabled}
            >
                <ClaimSummary claims={claims_summary} />
            </ConfirmModal>
        </Stack>
    )
}

export default ClaimButton 
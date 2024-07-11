import { Stack } from '@chakra-ui/react'
import React, { useState } from 'react'
import ConfirmModal from '../ConfirmModal'
import { ClaimSummary } from '../Bid/ClaimSummary'
import useProtocolClaims from './hooks/useClaims'

function UniversalButtons(){
    const { action: claim, claims_summary } = useProtocolClaims()

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
        </Stack>
    )
}

export default UniversalButtons
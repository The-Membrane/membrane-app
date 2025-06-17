import { Stack } from '@chakra-ui/react'
import React, { useEffect, useMemo, useRef } from 'react'
import ConfirmModal from '../ConfirmModal'
import useProtocolLiquidations from './hooks/useLiquidations'
import { LiqSummary } from './LiqSummary'

function LiquidateButton({ enabled, setEnabled }: { enabled: boolean, setEnabled: any }) {
    const { action: liquidate, liquidating_positions: liq_summ } = useProtocolLiquidations({ run: enabled })
    const liquidateDisabled = liq_summ.length === 0
    const liquidateLoading = (liquidate?.simulate.isLoading || liquidate?.tx.isPending)
    const liquidateDisabledRef = useRef(liquidateDisabled);
    const enabledRef = useRef(enabled);
    const liquidateLoadingRef = useRef(liquidateLoading);

    useEffect(() => {
        liquidateDisabledRef.current = liquidateDisabled;
        enabledRef.current = enabled;
        liquidateLoadingRef.current = liquidateLoading;
    }, [liquidateDisabled, enabled, liquidateLoading]);

    useMemo(() => {
        if (liquidateDisabled && enabled) {
            setTimeout(() => {
                if (
                    liquidateDisabledRef.current &&
                    enabledRef.current &&
                    !liquidateLoadingRef.current
                ) {
                    setEnabled(false);
                }
            }, 7000);
        }
    }, [liquidateDisabled, enabled]);

    return (
        <Stack gap="1">
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

export default LiquidateButton 
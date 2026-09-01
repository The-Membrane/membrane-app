import React from 'react';
import { Box } from '@chakra-ui/react';
import ConfirmModal from '../ConfirmModal';
import { Asset } from '@/helpers/chain';
import TransformExposureSummary from '@/components/ManagedMarkets/TransformExposureSummary';
import { ManagedActionState } from '@/components/ManagedMarkets/hooks/useManagedMarketState';
import { Action } from '@/types/tx';

interface MyceliumDeployActionProps {
    amount: string;
    managedActionState: ManagedActionState;
    transformExposure: Action;
    mode: 'multiply' | 'de-risk';
    selectedAsset?: Asset;
    asset?: Asset;
    borrowAmount: string;
    collateralValue: number;
    resolvedMaxBorrowLTV: number;
}

const MyceliumDeployAction: React.FC<MyceliumDeployActionProps> = ({
    amount,
    managedActionState,
    transformExposure,
    mode,
    selectedAsset,
    asset,
    borrowAmount,
    collateralValue,
    resolvedMaxBorrowLTV,
}) => {
    return (
        <Box w={"98%"} maxW={"420px"} mt={4}>
            <ConfirmModal
                buttonProps={{ bg: '#10b981', _hover: { bg: '#059669' }, w: '100%', textShadow: '0 0 20px rgba(0, 0, 0, 1)' }}
                label={"Deploy"}
                isDisabled={amount === '0' || Number(managedActionState.collateralAmount) <= 0}
                action={transformExposure}
            >
                <TransformExposureSummary
                    mode={mode}
                    asset={(selectedAsset ?? asset) as Asset}
                    collateralAmount={managedActionState.collateralAmount}
                    multiplier={managedActionState.multiplier}
                    borrowAmount={borrowAmount}
                    collateralValue={collateralValue}
                    maxBorrowLTV={resolvedMaxBorrowLTV ?? 0}
                />
            </ConfirmModal>
            {/* <Text color="gray.400" fontSize="xs" mt={2} alignSelf="flex-end">(liq price ${liqPrice})</Text> */}
        </Box>
    );
};

export default MyceliumDeployAction;

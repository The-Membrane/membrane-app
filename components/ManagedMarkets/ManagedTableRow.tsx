import React from 'react';
import {
    HStack,
    Tr,
    Td,
    Image,
} from '@chakra-ui/react';
import { formatTvl } from './utils';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions';

// Numeric cells: machine-readable mono + tabular figures so columns align.
const NUM_STYLE = {
    color: SEMANTIC_COLORS.textPrimary,
    fontSize: TYPOGRAPHY.small,
    fontFamily: 'mono',
    sx: { fontVariantNumeric: 'tabular-nums' },
};

function formatMultiplier(val: number | string): string {
    let n = typeof val === 'number' ? val : parseFloat(val as string);
    if (isNaN(n)) return '0x';
    return `${n.toFixed(2)}x`;
}
function formatCost(val: number | string): string {
    let n = typeof val === 'number' ? val : parseFloat(val as string);
    if (isNaN(n)) return '0%';
    return `${(n * 100).toFixed(2)}%`;
}
function formatSupplyApr(val: number | string): string {
    let n = typeof val === 'number' ? val : parseFloat(val as string);
    if (isNaN(n)) return '0%';
    return `${(n * 100).toFixed(2)}%`;
}

// Add types for MarketRow props
export interface MarketRowProps {
    market: any;
    assetSymbol: string;
    assetLogo: string;
    tvl: number;
    tvlDisplay: string;
    vaultName: string;
    multiplier: number | string;
    cost: number | string;
    debtSupplied?: number;
    supplyApr?: number;
    selectedAction: 'multiply' | 'lend';
    onClick: () => void;
}

function MarketRow({ assetSymbol, assetLogo, tvlDisplay, vaultName, multiplier, cost, debtSupplied = 0, supplyApr = 0, selectedAction, onClick }: MarketRowProps) {
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
        }
    };

    return (
        <Tr
            onClick={onClick}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            role="button"
            cursor="pointer"
            transition={TRANSITIONS.colors}
            _hover={{ bg: SEMANTIC_COLORS.bgTertiary }}
            _focus={FOCUS_STYLES.ring}
        >
            <Td color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.medium} fontSize={TYPOGRAPHY.small}>
                <HStack spacing={SPACING.sm}>
                    {assetLogo && <Image src={assetLogo} alt={assetSymbol} boxSize="20px" borderRadius="full" bg={SEMANTIC_COLORS.bgTertiary} />}
                    <span>{assetSymbol}</span>
                </HStack>
            </Td>
            {selectedAction === 'lend' ? (
                <Td display={{ base: 'none', md: 'table-cell' }} {...NUM_STYLE}>{formatTvl(debtSupplied)}</Td>
            ) : (
                <Td display={{ base: 'none', md: 'table-cell' }} {...NUM_STYLE}>{tvlDisplay}</Td>
            )}
            <Td display={{ base: 'none', md: 'table-cell' }} color={SEMANTIC_COLORS.textPrimary} fontSize={TYPOGRAPHY.small}>{vaultName}</Td>
            {selectedAction === 'lend' ? (
                <Td {...NUM_STYLE}>{formatSupplyApr(supplyApr)}</Td>
            ) : (
                <Td {...NUM_STYLE}>{formatMultiplier(multiplier)}</Td>
            )}
            {/* No 5th column for lend */}
            {selectedAction === 'multiply' && (
                <Td display={{ base: 'none', md: 'table-cell' }} {...NUM_STYLE}>{formatCost(cost)}</Td>
            )}
        </Tr>
    );
}

export default MarketRow;

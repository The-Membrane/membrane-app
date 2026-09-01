import React from 'react';
import {
    Box,
    Table,
    Thead,
    Tbody,
    Tr,
    Th,
    Td,
    Icon,
    Tooltip,
} from '@chakra-ui/react';
import { TriangleDownIcon, TriangleUpIcon } from '@chakra-ui/icons';
import type { NextRouter } from 'next/router';
import type { useManagedTableData } from './hooks/useManagedTableData';
import MarketRow from './ManagedTableRow';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

// Living Typeface table-header convention: mono, uppercase, letterspaced, dim bone.
const HEADER_STYLE = {
    fontFamily: 'mono',
    fontSize: TYPOGRAPHY.label,
    fontWeight: TYPOGRAPHY.normal,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.28em',
    color: SEMANTIC_COLORS.textSecondary,
};

type TableData = ReturnType<typeof useManagedTableData>;

interface ManagedTableContentProps {
    selectedAction: TableData['selectedAction'];
    sortCol: TableData['sortCol'];
    sortDir: TableData['sortDir'];
    handleSort: TableData['handleSort'];
    sortedRows: TableData['sortedRows'];
    chainName: TableData['chainName'];
    router: NextRouter;
}

type SortableCol = 'tvl' | 'multiplier' | 'cost';

const ManagedTableContent = ({ selectedAction, sortCol, sortDir, handleSort, sortedRows, chainName, router }: ManagedTableContentProps) => {
    // Arrow icon for sort direction
    const sortArrow = (col: SortableCol) => {
        if (sortCol !== col) return null;
        return sortDir === 'asc' ? (
            <Icon as={TriangleUpIcon} ml={1} boxSize={3} />
        ) : (
            <Icon as={TriangleDownIcon} ml={1} boxSize={3} />
        );
    };

    // The <th> stays a columnheader (so `aria-sort` is announced); the inner
    // span is the actual control — focusable, keyboard-operable, focus-ringed.
    const sortAriaProps = (col: SortableCol) => ({
        'aria-sort': (sortCol === col
            ? sortDir === 'asc' ? 'ascending' : 'descending'
            : 'none') as 'ascending' | 'descending' | 'none',
    });

    const sortButtonProps = (col: SortableCol) => ({
        role: 'button',
        tabIndex: 0,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        transition: TRANSITIONS.colors,
        onClick: () => handleSort(col),
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            handleSort(col);
        },
        _hover: HOVER_EFFECTS.brighten,
        _focus: FOCUS_STYLES.ring,
        _focusVisible: FOCUS_STYLES.ring,
    });

    return (
        <Box
            w={{ base: '100%', md: '85%' }}
            mx="auto"
            bg={SEMANTIC_COLORS.bgSecondary}
            borderRadius={0}
            p={SPACING.base}
            flex="1"
            overflowY="auto"
            overflowX="hidden"
            sx={{
                '&::-webkit-scrollbar': { width: '8px' },
                '&::-webkit-scrollbar-thumb': { background: SEMANTIC_COLORS.borderStrong, borderRadius: 0 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
            }}
        >
            <Table variant="unstyled" colorScheme="gray" fontSize={TYPOGRAPHY.small} sx={{ tableLayout: 'fixed', width: '100%' }}>
                <Thead>
                    <Tr>
                        <Th {...HEADER_STYLE}>Asset</Th>
                        <Th display={{ base: 'none', md: 'table-cell' }} {...HEADER_STYLE} {...sortAriaProps('tvl')}>
                            <Tooltip
                                label={selectedAction === 'lend' ? 'Total Value Supplied' : 'Total Value Locked'}
                                placement="top"
                                hasArrow
                                bg={SEMANTIC_COLORS.bgSecondary}
                                color={SEMANTIC_COLORS.textPrimary}
                                borderRadius={0}
                                border="1px solid"
                                borderColor={SEMANTIC_COLORS.borderSubtle}
                                p={SPACING.md}
                                fontSize={TYPOGRAPHY.xs}
                            >
                                <Box as="span" {...sortButtonProps('tvl')}>
                                    {selectedAction === 'lend' ? 'TVS' : 'TVL'} {sortArrow('tvl')}
                                </Box>
                            </Tooltip>
                        </Th>
                        <Th display={{ base: 'none', md: 'table-cell' }} {...HEADER_STYLE}>Vault Name</Th>
                        <Th {...HEADER_STYLE} {...sortAriaProps('multiplier')}>
                            <Box as="span" {...sortButtonProps('multiplier')}>
                                {selectedAction === 'lend' ? 'Supply APR' : 'Multiplier'} {sortArrow('multiplier')}
                            </Box>
                        </Th>
                        {selectedAction === 'multiply' && (
                            <Th display={{ base: 'none', md: 'table-cell' }} {...HEADER_STYLE} {...sortAriaProps('cost')}>
                                <Box as="span" {...sortButtonProps('cost')}>
                                    Cost {sortArrow('cost')}
                                </Box>
                            </Th>
                        )}
                    </Tr>
                </Thead>
                <Tbody>
                    {sortedRows.length === 0 ? (
                        <Tr>
                            <Td
                                colSpan={selectedAction === 'lend' ? 4 : 5}
                                textAlign="center"
                                color={SEMANTIC_COLORS.textSecondary}
                                py={SPACING.xl}
                                fontFamily={TYPOGRAPHY.fontMono}
                                fontSize={TYPOGRAPHY.label}
                                textTransform="uppercase"
                                letterSpacing="0.28em"
                            >
                                No markets match this filter
                            </Td>
                        </Tr>
                    ) : (
                        sortedRows.map((row, idx) => (
                            <MarketRow
                                key={row.market.address || idx}
                                {...row}
                                selectedAction={selectedAction}
                                onClick={() => router.push({
                                    pathname: `/${chainName}/isolated/${row.market.address}/${row.assetSymbol}`,
                                    query: { tab: selectedAction },
                                }, undefined, { shallow: true })}
                            />
                        ))
                    )}
                </Tbody>
            </Table>
        </Box>
    );
};

export default ManagedTableContent;

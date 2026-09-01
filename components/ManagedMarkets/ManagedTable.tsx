import React from 'react';
import {
    Box,
    Button,
    Spinner,
    useDisclosure,
} from '@chakra-ui/react';
import { useRouter } from 'next/router';
import { useManagedTableData } from './hooks/useManagedTableData';
import { useCreateMarketForm } from './hooks/useCreateMarketForm';
import CreateMarketModal from './CreateMarketModal';
import ManagedTableFilters from './ManagedTableFilters';
import ManagedTableContent from './ManagedTableContent';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

// Re-exported for consumers that import the type from this module (e.g. hooks/useMarketCreation)
export type { MarketCreateState } from './types';

/**
 * Resolved-but-zero state. Distinct from the loading spinner: the registry answered,
 * it just has no markets in it. Living Typeface — mono eyebrow, serif headline,
 * sharp corners, a single hairline rule.
 */
const EmptyMarkets = () => (
    <Box
        flex="1"
        w="100%"
        display="flex"
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        textAlign="center"
        px={SPACING.base}
        py={SPACING['2xl']}
    >
        <Box
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            textTransform="uppercase"
            letterSpacing="0.28em"
            color={SEMANTIC_COLORS.textTertiary}
        >
            Isolated Markets
        </Box>
        <Box
            w="72px"
            h="1px"
            bg={SEMANTIC_COLORS.borderSubtle}
            my={SPACING.base}
        />
        <Box
            as="h2"
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h3}
            color={SEMANTIC_COLORS.textPrimary}
            mb={SPACING.sm}
        >
            No isolated markets yet
        </Box>
        <Box
            as="p"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
            maxW="42ch"
            lineHeight="1.7"
        >
            No market has been created on this chain. Use Create Market to open the first
            one, and it will appear here.
        </Box>
    </Box>
);

const ManagedTable = () => {
    const {
        allMarkets,
        chainName,
        selectedDeposits,
        setSelectedDeposits,
        search,
        setSearch,
        filterDisclosure,
        sortCol,
        sortDir,
        handleSort,
        selectedAction,
        setSelectedAction,
        filteredOptions,
        selectedDisplay,
        sortedRows,
    } = useManagedTableData();

    // Modal state
    const { isOpen: isCreateOpen, onOpen: onCreateOpen, onClose: onCreateClose } = useDisclosure();
    const form = useCreateMarketForm(isCreateOpen);

    const router = useRouter();

    // `allMarkets` is `null` only while the registry query is genuinely in flight;
    // a resolved zero-market registry comes back as `[]` and falls through to the
    // empty state below. Never gate the spinner on emptiness — that spins forever.
    if (!allMarkets) {
        return <Box display="flex" justifyContent="center" alignItems="center"><Spinner size="xl" color={SEMANTIC_COLORS.primary} /></Box>;
    }

    const hasMarkets = allMarkets.length > 0;

    return (
        <Box display="flex" flexDirection="column" alignItems="center" py={{ base: SPACING.lg, md: SPACING['2xl'] }}>
            {/* Top bar with Create Market button */}
            <Box w="100%" display="flex" justifyContent={{ base: 'center', md: 'flex-end' }} alignItems="center" mb={SPACING.base} pr={{ base: 0, md: SPACING['3xl'] }}>
                <Button
                    colorScheme="teal"
                    size="md"
                    fontWeight={TYPOGRAPHY.bold}
                    onClick={onCreateOpen}
                    w={{ base: '60%', md: '20%' }}
                    alignSelf="flex-end"
                    borderRadius={0}
                    transition={TRANSITIONS.colors}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                >
                    Create Market
                </Button>
            </Box>
            {/* Create Market Modal */}
            <CreateMarketModal isOpen={isCreateOpen} onClose={onCreateClose} form={form} />
            {/* Outer border effect container */}
            <Box
                w={{ base: '98vw' }}
                borderRadius={0}
                p={{ base: SPACING.xs, md: SPACING.sm }}
                bg={SEMANTIC_COLORS.bgTertiary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                display="flex"
                justifyContent="center"
                alignItems="center"
            >
                {/* Main content box – no scroll here (scroll only on table area) */}
                <Box
                    w="100%"
                    bg={SEMANTIC_COLORS.bgSecondary}
                    borderRadius={0}
                    p={{ base: SPACING.base, md: SPACING.xl }}
                    minH="70vh"
                    maxH="80vh"
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                >
                    {hasMarkets ? (
                        <>
                            {/* Deposit Selector stacked on top */}
                            <ManagedTableFilters
                                selectedAction={selectedAction}
                                setSelectedAction={setSelectedAction}
                                filterDisclosure={filterDisclosure}
                                selectedDisplay={selectedDisplay}
                                search={search}
                                setSearch={setSearch}
                                filteredOptions={filteredOptions}
                                selectedDeposits={selectedDeposits}
                                setSelectedDeposits={setSelectedDeposits}
                            />
                            {/* Scrollable table container */}
                            <ManagedTableContent
                                selectedAction={selectedAction}
                                sortCol={sortCol}
                                sortDir={sortDir}
                                handleSort={handleSort}
                                sortedRows={sortedRows}
                                chainName={chainName}
                                router={router}
                            />
                        </>
                    ) : (
                        <EmptyMarkets />
                    )}
                </Box>
            </Box>
        </Box>
    );
};

export default ManagedTable;

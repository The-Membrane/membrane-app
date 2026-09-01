import React from 'react';
import {
    Box,
    HStack,
    Input,
    Button,
    VStack,
    Checkbox,
    Popover,
    PopoverTrigger,
    PopoverContent,
    PopoverBody,
    PopoverArrow,
    PopoverCloseButton,
    PopoverHeader,
    Portal,
    Select,
} from '@chakra-ui/react';
import { ChevronDownIcon } from '@chakra-ui/icons';
import type { useManagedTableData } from './hooks/useManagedTableData';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

type TableData = ReturnType<typeof useManagedTableData>;

interface ManagedTableFiltersProps {
    selectedAction: TableData['selectedAction'];
    setSelectedAction: TableData['setSelectedAction'];
    filterDisclosure: TableData['filterDisclosure'];
    selectedDisplay: TableData['selectedDisplay'];
    search: TableData['search'];
    setSearch: TableData['setSearch'];
    filteredOptions: TableData['filteredOptions'];
    selectedDeposits: TableData['selectedDeposits'];
    setSelectedDeposits: TableData['setSelectedDeposits'];
}

const ManagedTableFilters = ({
    selectedAction,
    setSelectedAction,
    filterDisclosure,
    selectedDisplay,
    search,
    setSearch,
    filteredOptions,
    selectedDeposits,
    setSelectedDeposits,
}: ManagedTableFiltersProps) => {
    const { isOpen, onOpen, onClose } = filterDisclosure;
    const selectedDepositsSet = new Set(selectedDeposits);

    return (
        <Box w={{ base: '100%', md: '25%' }} mb={SPACING.lg} alignSelf={"start"} ml={"10%"}>
            <HStack justifyContent="flex-start" alignItems="center" w="100%" alignSelf={"flex-end"} marginLeft={"1%"}>
                {/* Action Selector */}
                <Select
                    value={selectedAction}
                    onChange={e => setSelectedAction(e.target.value as 'multiply' | 'lend')}
                    bg={SEMANTIC_COLORS.bgSecondary}
                    color={SEMANTIC_COLORS.textPrimary}
                    borderRadius={0}
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    minW="fit-content"
                    w="fit-content"
                    fontWeight={TYPOGRAPHY.bold}
                    transition={TRANSITIONS.colors}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _focus={FOCUS_STYLES.ring}
                    size="sm"
                >
                    <option value="multiply">Multiply</option>
                    <option value="lend">Lend</option>
                </Select>
                <Popover isOpen={isOpen} onOpen={onOpen} onClose={onClose} placement="bottom-start" closeOnBlur>
                    <PopoverTrigger>
                        <Button
                            rightIcon={<ChevronDownIcon />}
                            bg={SEMANTIC_COLORS.bgSecondary}
                            color={SEMANTIC_COLORS.textPrimary}
                            borderRadius={0}
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.borderSubtle}
                            minW="120px"
                            w="50%"
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.borderHighlight}
                            _focus={FOCUS_STYLES.ring}
                            onClick={onOpen}
                        >
                            {selectedDisplay}
                        </Button>
                    </PopoverTrigger>
                    <Portal>
                        <PopoverContent bg={SEMANTIC_COLORS.bgSecondary} color={SEMANTIC_COLORS.textPrimary} minW="220px" borderRadius={0} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} boxShadow="none">
                            <PopoverArrow bg={SEMANTIC_COLORS.bgSecondary} />
                            <PopoverCloseButton _focus={FOCUS_STYLES.ring} />
                            <PopoverHeader borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pb={SPACING.sm}>
                                <Input
                                    placeholder="Search for deposit asset"
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    bg={SEMANTIC_COLORS.bgSecondary}
                                    color={SEMANTIC_COLORS.textPrimary}
                                    borderRadius={0}
                                    borderColor={SEMANTIC_COLORS.borderSubtle}
                                    _placeholder={{ color: SEMANTIC_COLORS.textSecondary }}
                                    transition={TRANSITIONS.colors}
                                    _focus={FOCUS_STYLES.ring}
                                    size="sm"
                                    mb={SPACING.sm}
                                    autoFocus
                                />
                            </PopoverHeader>
                            <PopoverBody maxH="300px" overflowY="auto" px={0}>
                                <VStack align="stretch" spacing={0}>
                                    <Checkbox
                                        isChecked={selectedDeposits.includes('All')}
                                        onChange={() => setSelectedDeposits(['All'])}
                                        px={4}
                                        py={2}
                                    >
                                        All
                                    </Checkbox>
                                    {filteredOptions.map(opt => (
                                        <Checkbox
                                            key={opt}
                                            isChecked={selectedDepositsSet.has(opt)}
                                            onChange={() => {
                                                let newSelected = selectedDeposits.filter(s => s !== 'All');
                                                if (newSelected.includes(opt)) {
                                                    newSelected = newSelected.filter(s => s !== opt);
                                                } else {
                                                    newSelected = [...newSelected, opt];
                                                }
                                                setSelectedDeposits(newSelected.length === 0 ? ['All'] : newSelected);
                                            }}
                                            px={4}
                                            py={2}
                                        >
                                            {opt}
                                        </Checkbox>
                                    ))}
                                </VStack>
                            </PopoverBody>
                        </PopoverContent>
                    </Portal>
                </Popover>
            </HStack>
        </Box>
    );
};

export default ManagedTableFilters;

import React from 'react';
import { VStack, Tabs, TabList, Tab, TabPanels, TabPanel } from '@chakra-ui/react';
import useManagedMarketActionData from './hooks/useManagedMarketActionData';
import LendMarketAction from './LendMarketAction';
import { MultiplyPanel, StrategizePanel } from './MarketActionPanels';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions';

// Props: action, marketAddress, collateralSymbol
const ManagedMarketAction = ({
    action = 'Multiply',
    marketAddress = "Loading...",
    collateralSymbol = "Loading...",
}) => {
    // Data fetching, effects, handlers and derived calculations live in the
    // hook so the render tree below stays focused on layout/composition.
    const data = useManagedMarketActionData(marketAddress, collateralSymbol);
    const { collateralAsset, selectedTab, actionLabels, handleTabChange } = data;

    return (
        <VStack w="fit-content" spacing={SPACING.lg} align="center" mt={SPACING.xl}>
            <Tabs
                index={selectedTab}
                onChange={handleTabChange}
                variant="unstyled"
                w="100%"
            >
                <TabList
                    bg="transparent"
                    borderRadius={0}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    px={SPACING.sm}
                    py={SPACING.xs}
                    paddingInlineEnd={"0"}
                    display="flex"
                    justifyContent="center"
                    gap={{ base: "13%", md: "20%" }}
                >
                    {actionLabels.map((label, idx) => (
                        <Tab
                            key={label}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            fontWeight={TYPOGRAPHY.medium}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                            color={selectedTab === idx ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
                            borderBottom={selectedTab === idx ? `2px solid ${SEMANTIC_COLORS.primary}` : '2px solid transparent'}
                            _selected={{ color: SEMANTIC_COLORS.textPrimary, borderBottom: `2px solid ${SEMANTIC_COLORS.primary}`, bg: 'transparent' }}
                            _focus={FOCUS_STYLES.ring}
                            px={SPACING.xl}
                            py={SPACING.sm}
                            borderRadius={0}
                            transition={TRANSITIONS.colors}
                        >
                            {label}
                        </Tab>
                    ))}
                </TabList>
                <TabPanels>
                    <TabPanel px={0} py={0}>
                        <MultiplyPanel data={data} />
                    </TabPanel>
                    {/* Lend Tab */}
                    <TabPanel px={0} py={0}>
                        <LendMarketAction marketAddress={marketAddress} />
                    </TabPanel>
                    {/* Strategize Tab */}
                    <TabPanel px={0} py={0}>
                        <StrategizePanel collateralAsset={collateralAsset} />
                    </TabPanel>
                </TabPanels>
            </Tabs>
        </VStack>
    );
};

export default ManagedMarketAction;

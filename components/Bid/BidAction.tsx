import { Tabs, TabList, Tab, TabPanels, TabPanel, HStack } from '@chakra-ui/react'
import React, { PropsWithChildren, useState } from 'react'
import PlaceBid from './PlaceBid'
import MyBid from './MyBid'
import ClaimLiqudation from './ClaimLiqudation'
import StabilityPool from './StabilityPool'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

type TabProps = PropsWithChildren & {
  onClick: any
}

const CustomTab = ({ onClick, children }: TabProps) => (
  <Tab
    color={SEMANTIC_COLORS.textSecondary}
    fontWeight={TYPOGRAPHY.normal}
    fontSize={TYPOGRAPHY.small}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderMedium}
    borderRadius="8px"
    width="40%"
    transition={TRANSITIONS.all}
    _hover={{
      borderColor: SEMANTIC_COLORS.borderStrong,
      color: SEMANTIC_COLORS.textPrimary,
    }}
    _focus={FOCUS_STYLES.ring}
    onClick={onClick}
    _selected={{
      fontWeight: TYPOGRAPHY.medium,
      color: SEMANTIC_COLORS.textPrimary,
      bg: SEMANTIC_COLORS.primary,
      border: 'none',
    }}
  >
    {children}
  </Tab>
)

const BidAction = () => {
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  const handleTabClick = (index: number) => {
    setActiveTabIndex(index);
  };

  return (
    <Tabs variant="soft-rounded" size="sm" colorScheme="primary" index={activeTabIndex}>
      <HStack w="full">
        <TabList gap={SPACING.sm} w="full">
          <CustomTab onClick={() => handleTabClick(0)}>Place Bid</CustomTab>
          <CustomTab onClick={() => handleTabClick(1)}>Single-Asset Bids</CustomTab>
          <CustomTab onClick={() => handleTabClick(2)}>Omni-Bids</CustomTab>
        </TabList>
        <ClaimLiqudation />
      </HStack>
      <TabPanels>
        <TabPanel px={SPACING.none}>
          <PlaceBid />
        </TabPanel>
        <TabPanel px={SPACING.none}>
          <MyBid />
        </TabPanel>
        <TabPanel px={SPACING.none}>
          <StabilityPool setActiveTabIndex={setActiveTabIndex} />
        </TabPanel>
      </TabPanels>
    </Tabs>
  )
}

export default BidAction

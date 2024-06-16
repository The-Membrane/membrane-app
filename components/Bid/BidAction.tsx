import { Tabs, TabList, Tab, TabPanels, TabPanel, HStack } from '@chakra-ui/react'
import React, { PropsWithChildren, useState } from 'react'
import PlaceBid from './PlaceBid'
import MyBid from './MyBid'
import ClaimLiqudation from './ClaimLiqudation'
import StabilityPool from './StabilityPool'

type TabProps = PropsWithChildren & {
  onClick: any
}

const CustomTab = ({ onClick, children }: TabProps) => (
  <Tab
    color="white"
    fontWeight="normal"
    border="1px solid white"
    width={"40%"}
    onClick={onClick}
    _selected={{ fontWeight: 'normal', color: 'white', bg: 'primary.200', border: 'none' }}
  >
    {children}
  </Tab>
)

const BidAction = () => {
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  const handleTabClick = (index: number) => {
    setActiveTabIndex(index);
    console.log("tab log", activeTabIndex)
  };
  
  return (
    <Tabs variant="soft-rounded" size="sm" colorScheme="primary" index={activeTabIndex}>
      <HStack w="full">
        <TabList gap="2" w="full">
          <CustomTab onClick={() => handleTabClick(0)}>Place Bid</CustomTab>
          <CustomTab onClick={() => handleTabClick(1)}>Single-Asset Bids</CustomTab>
          <CustomTab onClick={() => handleTabClick(2)}>Omni-Bids</CustomTab>
        </TabList>
        <ClaimLiqudation />
      </HStack>
      <TabPanels>
        <TabPanel px="0">
          <PlaceBid />
        </TabPanel>
        <TabPanel px="0">
          <MyBid />
        </TabPanel>
        <TabPanel px="0">
          <StabilityPool setActiveTabIndex={setActiveTabIndex}/>
        </TabPanel>
      </TabPanels>
    </Tabs>
  )
}

export default BidAction

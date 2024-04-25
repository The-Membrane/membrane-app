import { Tabs, TabList, Tab, TabPanels, TabPanel, HStack } from '@chakra-ui/react'
import React, { PropsWithChildren } from 'react'
import PlaceBid from './PlaceBid'
import MyBid from './MyBid'
import ClaimLiqudation from './ClaimLiqudation'
import StabilityPool from './StabilityPool'

const CustomTab = ({ children }: PropsWithChildren) => (
  <Tab
    color="white"
    fontWeight="normal"
    border="1px solid white"
    width={"40%"}
    _selected={{ fontWeight: 'normal', color: 'white', bg: 'primary.200', border: 'none' }}
  >
    {children}
  </Tab>
)

const BidAction = () => {
  return (
    <Tabs variant="soft-rounded" size="sm" colorScheme="primary">
      <HStack w="full">
        <TabList gap="2" w="full">
          <CustomTab>Place Bid</CustomTab>
          <CustomTab>Single-Asset Bids</CustomTab>
          <CustomTab>Omni-Bids</CustomTab>
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
          <StabilityPool />
        </TabPanel>
      </TabPanels>
    </Tabs>
  )
}

export default BidAction

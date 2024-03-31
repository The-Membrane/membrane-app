import { Tabs, TabList, Tab, TabPanels, TabPanel, HStack } from '@chakra-ui/react'
import React, { PropsWithChildren } from 'react'
import PlaceBid from './PlaceBid'
import MyBid from './MyBid'
import ClaimLiqudation from './ClaimLiqudation'

type Props = {}

const CustomTab = ({ children }: PropsWithChildren) => (
  <Tab
    color="white"
    fontWeight="normal"
    border="1px solid white"
    _selected={{ fontWeight: 'normal', color: 'white', bg: 'primary.200', border: 'none' }}
  >
    {children}
  </Tab>
)

const BidAction = (props: Props) => {
  return (
    <Tabs variant="soft-rounded" size="sm" colorScheme="primary">
      <HStack w="full">
        <TabList gap="2" w="full">
          <CustomTab>Place Bid</CustomTab>
          <CustomTab>My Bid</CustomTab>
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
      </TabPanels>
    </Tabs>
  )
}

export default BidAction

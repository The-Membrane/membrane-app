import {
  Card,
  HStack,
  Tab,
  TabIndicator,
  TabList,
  TabPanels,
  Tabs,
  Text,
  VStack,
} from '@chakra-ui/react'
import Beaker from './Beaker'
import CurrentPositions from './CurrentPositions'
import TakeAction from './TakeAction'
import useMintState from './hooks/useMintState'
import LPTab from './LPTab'
import { useState } from 'react'

type TabProps = {
  onClick: any
  label: string
}

const CustomTab = ({ onClick, label }: TabProps) => (
  <Tab zIndex={1} onClick={onClick} _selected={{ color: 'white' }}>
    {label}
  </Tab>
)

const MintTabsCard = () => {
  const { setMintState } = useMintState()

  const onTabChange = (index: number) => {
    setMintState({ isTakeAction: index === 1 })
  }  
  const [activeTabIndex, setActiveTabIndex] = useState(1);

  const handleTabClick = (index: number) => {
    setActiveTabIndex(index);
  };

  return (
    <Card minW="400px" gap="12" h="max-content" px="2">
      <VStack w="full" gap="5">
        <Text variant="title" fontSize="24px">
          Mint
        </Text>

        <Tabs position="relative" variant="unstyled" align="center" w="full" onChange={onTabChange} index={activeTabIndex}>
          <TabList bg="white" borderRadius="28px" color="black" w="fit-content">
            <CustomTab onClick={() => handleTabClick(0)} label="Position info" />
            <CustomTab onClick={() => handleTabClick(1)} label="Manage Vault" />
            <CustomTab onClick={() => handleTabClick(2)} label="LP" />
          </TabList>

          <TabIndicator
            top="0"
            position="absolute"
            height="40px"
            bg="#C445F0"
            borderRadius="28px"
          />
          <TabPanels paddingBottom={activeTabIndex === 2 ? 0 : 4}>
            <CurrentPositions />
            <TakeAction />
            <LPTab />
          </TabPanels>
        </Tabs>
      </VStack>
    </Card>
  )
}

const Mint = () => {
  return (
    <HStack alignItems="flex-start">
      <MintTabsCard />
      <Beaker />
      {/* <BeakerScale /> */}
    </HStack>
  )
}

export default Mint

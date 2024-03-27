import {
  Card,
  Stack,
  Tab,
  TabIndicator,
  TabList,
  TabPanels,
  Tabs,
  Text,
  VStack,
} from '@chakra-ui/react'
import BeakerScale from './BeakerScale'
import CurrentPositions from './CurrentPositions'
import TakeAction from './TakeAction'
import useMintState from './hooks/useMintState'

const CustomeTab = ({ label }: { label: string }) => (
  <Tab zIndex={1} _selected={{ color: 'white' }}>
    {label}
  </Tab>
)

const MintTabsCard = () => {
  const { setMintState } = useMintState()

  const onTabChange = (index: number) => {
    setMintState({ isTakeAction: index === 1 })
  }
  return (
    <Card w="380px" gap="12" h="max-content" px="2">
      <VStack w="full" gap="5">
        <Text variant="title" fontSize="24px">
          Mint
        </Text>

        <Tabs position="relative" variant="unstyled" align="center" w="full" onChange={onTabChange}>
          <TabList bg="white" borderRadius="28px" color="black" w="fit-content">
            <CustomeTab label="Position info" />
            <CustomeTab label="Take Action" />
          </TabList>

          <TabIndicator
            top="0"
            position="absolute"
            height="40px"
            bg="#C445F0"
            borderRadius="28px"
          />
          <TabPanels mt="5">
            <CurrentPositions />
            <TakeAction />
          </TabPanels>
        </Tabs>
      </VStack>
    </Card>
  )
}

const Mint = () => {
  return (
    <Stack w="full" h="full" justifyContent="center">
      <MintTabsCard />
      <BeakerScale />
    </Stack>
  )
}

export default Mint

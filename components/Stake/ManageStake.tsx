import { Card, Tab, TabIndicator, TabList, TabPanel, TabPanels, Tabs, Box, useColorModeValue } from '@chakra-ui/react'
import Staking from './Staking'
import ClaimAndRestake from './ClaimAndRestake'
import Unstaking from './Unstaking'

const ManageStake = () => {
  const cardBg = useColorModeValue('#181F2A', '#232B3E')
  const tabActiveColor = useColorModeValue('blue.400', 'blue.300')
  const tabInactiveColor = useColorModeValue('gray.400', 'gray.500')
  return (
    <Card
      w="full"
      p={{ base: 4, md: 8 }}
      alignItems="center"
      gap={6}
      h="full"
      justifyContent="space-between"
      bg={cardBg}
      borderRadius="2xl"
      boxShadow="lg"
    >
      <Tabs position="relative" variant="unstyled" w="full" isFitted colorScheme="blue">
        <TabList mb={4}>
          <Tab
            _selected={{ color: tabActiveColor, fontWeight: 'bold' }}
            color={tabInactiveColor}
            fontSize="lg"
            py={2}
          >
            Manage
          </Tab>
          <Tab
            _selected={{ color: tabActiveColor, fontWeight: 'bold' }}
            color={tabInactiveColor}
            fontSize="lg"
            py={2}
          >
            Claim
          </Tab>
          <Tab
            _selected={{ color: tabActiveColor, fontWeight: 'bold' }}
            color={tabInactiveColor}
            fontSize="lg"
            py={2}
          >
            Unstaking
          </Tab>
        </TabList>
        <TabIndicator mt="-1.5px" height="2px" bg={tabActiveColor} borderRadius="1px" />
        <TabPanels>
          <TabPanel px={0}>
            <Staking />
          </TabPanel>
          <TabPanel px={0}>
            <ClaimAndRestake />
          </TabPanel>
          <TabPanel px={0}>
            <Unstaking />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Card>
  )
}

export default ManageStake

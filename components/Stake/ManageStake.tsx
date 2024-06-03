import { Card, Tab, TabIndicator, TabList, TabPanel, TabPanels, Tabs } from '@chakra-ui/react'
import Staking from './Staking'
import ClaimAndRestake from './ClaimAndRestake'
import Unstaking from './Unstaking'

const ManageStake = () => {
  return (
    <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
      <Tabs position="relative" variant="unstyled" w="full" isFitted>
        <TabList>
          <Tab>Manage</Tab>
          <Tab>Claim</Tab>
          <Tab>Unstaking</Tab>
        </TabList>

        <TabIndicator mt="-1.5px" height="2px" bg="blue.500" borderRadius="1px" />

        <TabPanels>
          <TabPanel>
            <Staking />
          </TabPanel>
          <TabPanel>
            <ClaimAndRestake />
          </TabPanel>
          <TabPanel>
            <Unstaking />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Card>
  )
}

export default ManageStake

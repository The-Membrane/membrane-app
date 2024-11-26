import {
  Card,
  HStack,
  Stack,
  SliderFilledTrack,
  SliderTrack,
  Slider,
  SliderThumb,
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
import { use, useMemo, useState } from 'react'
import React from "react"
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { Pagination } from '../Governance/Pagination'
import { useUserPositions } from '@/hooks/useCDP'
import { MAX_CDP_POSITIONS } from '@/config/defaults'
import useVaultSummary from './hooks/useVaultSummary'
import { num } from '@/helpers/num'

type TabProps = {
  onClick: any
  label: string
}

const CustomTab = ({ onClick, label }: TabProps) => (
  <Tab zIndex={1} onClick={onClick} _selected={{ color: 'white' }}>
    {label}
  </Tab>
)

type PaginationProps = {
  pagination: {
    totalPages: number
    currentPage: number
    nextPage: any
    previousPage: any
    isFirst: boolean
    isLast: boolean
    setPage: any
  }
}

const nextPage = (setMintState: any, currentPage: number, totalPages: number) => {
  if (currentPage < totalPages) {
    setMintState({ positionNumber: currentPage + 1 })
  }
}
const previousPage = (setMintState: any, currentPage: number) => {
  if (currentPage > 1) {
    setMintState({ positionNumber: currentPage - 1 })
  }
}

const PaginationBar = ({ pagination }: PaginationProps) => {
  if (pagination.totalPages <= 1) return null
  return (
    <HStack w="100%" justifyContent="flex-end">
      <Pagination {...pagination} />
    </HStack>
  )
}

const HealthSlider = () => {
  const { data } = useVaultSummary()
  const summary = data || {
    debtAmount: 0,
    cost: 0,
    discountedCost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  }  
  
  const health = useMemo(() => {
    if (summary.ltv === 0) return 100
    return num(1).minus(num(summary.ltv).dividedBy(summary.liqudationLTV)).times(100).dp(0).toNumber()
  }, [summary.ltv, summary.liqudationLTV])

  var color = 'blue'
  if (health <= (1 - summary.borrowLTV / summary.liqudationLTV) * 100 && health > 10 && health < 100)
    color = 'sewage'
  if (health <= 10) color = 'red'
  return(
    <Slider
        defaultValue={health}
        isReadOnly
        cursor="default"
        min={0}
        max={100}
        value={health}
      >
        <SliderTrack h="1.5">
          <SliderFilledTrack bg={'#20d6ff'} />
        </SliderTrack>
        <SliderThumb boxSize={10}>
          <Text fontSize="sm" color="white" fontWeight="bold">
            Health: {health}%
          </Text>
        </SliderThumb>
      </Slider>
  )
  
}

const MintTabsCard = React.memo(() => {
  const { mintState, setMintState } = useMintState()
  const { data: basketPositions } = useUserPositions()

  const totalPages = useMemo(() => {
    if (!basketPositions) return 1
    return Math.min(basketPositions[0].positions.length + 1, MAX_CDP_POSITIONS)
  }, [basketPositions])

  const onTabChange = (index: number) => {
    setMintState({ isTakeAction: index === 1 })
  }  
  const [activeTabIndex, setActiveTabIndex] = useState(1);

  const handleTabClick = (index: number) => {
    setActiveTabIndex(index);
  };

  return (
    <Card minW="363px" gap="12" h="max-content" px="2">
      <VStack w="full" gap="5">
        <Text variant="title" fontSize="24px">
          Mint
        </Text>

        <Tabs position="relative" variant="unstyled" align="center" w="full" onChange={onTabChange} index={activeTabIndex}>
          <TabList bg="white" borderRadius="28px" color="black" w="fit-content">
            <CustomTab onClick={() => handleTabClick(0)} label="Manage Vault" />
            <CustomTab onClick={() => handleTabClick(1)} label="LP" />
          </TabList>

          <TabIndicator
            top="0"
            position="absolute"
            height="40px"
            bg="#C445F0"
            borderRadius="28px"
          />
          <TabPanels paddingBottom={activeTabIndex === 1 ? 0 : 4}>
            <TakeAction />
            <LPTab />
          </TabPanels>
        </Tabs>
        {/* For position pagination */}
        <PaginationBar pagination={{
          totalPages: totalPages,
          currentPage: mintState.positionNumber,
          nextPage: () => nextPage(setMintState, mintState.positionNumber, totalPages),
          previousPage: () => previousPage(setMintState, mintState.positionNumber),
          isFirst: mintState.positionNumber === 1,
          isLast: mintState.positionNumber === totalPages,
          setPage: undefined
        }}/>
      </VStack>
    </Card>
  )
})

const Mint = React.memo(() => {
  return (
    <Stack>
      <HStack alignItems="flex-start">
        <MintTabsCard />
        <CurrentPositions />
      </HStack>
      <HealthSlider />
    </Stack>
  )
})

export default Mint

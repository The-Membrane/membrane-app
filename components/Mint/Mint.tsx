import {
  Card,
  HStack,
  Stack,
  SliderFilledTrack,
  SliderTrack,
  Slider,
  Box,
  Tab,
  TabIndicator,
  TabList,
  TabPanels,
  Tabs,
  Text,
  VStack,
  Checkbox,
  Button,
  useDisclosure,
  Modal,
  ModalOverlay,
  useBreakpointValue
} from '@chakra-ui/react'
import Beaker from './Beaker'
import CurrentPositions from './CurrentPositions'
import TakeAction from './TakeAction'
import useMintState from './hooks/useMintState'
import { use, useEffect, useMemo, useState } from 'react'
import React from "react"
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { Pagination } from '../Governance/Pagination'
import { useUserPositions } from '@/hooks/useCDP'
import { colors, denoms, MAX_CDP_POSITIONS } from '@/config/defaults'
import useVaultSummary from './hooks/useVaultSummary'
import { num } from '@/helpers/num'
import RedemptionCard from './RedemptionCard'
import { USDCMintCard } from './USDCMintCard'
import useCombinBalance from './hooks/useCombinBalance'
import { setInitialMintState } from '@/helpers/mint'
import { GrPowerReset } from 'react-icons/gr'
import { NeuroCloseModal } from '../Home/NeuroModals'
import { useOraclePrice } from '@/hooks/useOracle'

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
    <HStack w="100%" justifyContent="flex-end" mb="2%">
      <Pagination {...pagination} />
    </HStack>
  )
}

const HealthSlider = ({ summary }: { summary: any }) => {

  const health = useMemo(() => {
    if (summary.ltv === 0) return 100
    return num(1).minus(num(summary.ltv).dividedBy(summary.liqudationLTV)).times(100).dp(0).toNumber()
  }, [summary.ltv, summary.liqudationLTV])

  var color = 'blue.400'
  if (health <= (1 - summary.borrowLTV / summary.liqudationLTV) * 100 && health > 10 && health < 100)
    color = '#5e4220'
  if (health <= 10) color = 'red.400'
  return (
    <Slider
      defaultValue={health}
      isReadOnly
      cursor="default"
      min={0}
      max={100}
      value={health}
      width={"100%"}
    >
      <SliderTrack h="9" display={"flex"} borderRadius={"xl"}>
        <SliderFilledTrack bg={color} />
        <Box width={"100%"} justifyContent="center" display="flex" zIndex="999">
          <Text fontSize="large" color={"white"} zIndex="999" fontWeight="bold" alignSelf="center">
            Health: {Math.min(Math.max(0, health), 100)}%
          </Text>
        </Box>
      </SliderTrack>
    </Slider>
  )

}

const MintTabsCard = React.memo(({ summary }: { summary: any }) => {
  const isMobile = useBreakpointValue({ base: true, md: true, lg: false })
  const { mintState, setMintState } = useMintState()
  const { data: basketPositions } = useUserPositions()

  const totalPages = useMemo(() => {
    if (!basketPositions) return 1
    return Math.min(basketPositions[0].positions.length + 1, MAX_CDP_POSITIONS)
  }, [basketPositions])


  const combinBalance = useCombinBalance(mintState.positionNumber - 1)
  const { data } = useVaultSummary()
  const { ltv, borrowLTV, initialBorrowLTV, initialLTV, debtAmount } = data || {
    debtAmount: 0,
    cost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  }

  useEffect(() => {
    const overdraft = ltv > borrowLTV
    setMintState({ overdraft })
  }, [ltv, borrowLTV])

  const onRest = () => {
    // console.log("onRest LTVS:", initialBorrowLTV, initialLTV)
    setInitialMintState({
      combinBalance,
      ltv: initialLTV,
      borrowLTV: initialBorrowLTV,
      setMintState,
      reset: mintState.reset
      //newDebtAmount: 0,
    });
    //Requery basket to get updated current_position_id
    // reset();
    // queryClient.invalidateQueries({ queryKey: ['basket'] });
    //
  }


  const { data: prices } = useOraclePrice()
  const positionNumber = mintState.positionNumber
  const cdp = basketPositions?.[0].positions[positionNumber - 1] as PositionResponse
  const cdtMarketPrice = useMemo(() => prices?.find((price) => price.denom === denoms.CDT[0])?.price || "1", [prices])


  const { isOpen, onOpen, onClose } = useDisclosure()


  return (
    <>
      <Stack width="425px">
        {isMobile && <HealthSlider summary={summary} />}

        <Card boxShadow={"0 0 25px rgba(90, 90, 90, 0.5)"} minW="363px" gap="12" h="100%" width="100%" paddingBottom={0}>
          <VStack w="full" gap="5" h="full" alignItems="stretch">
            <HStack>
              <Text variant="title" fontSize="24px" alignSelf={"center"} textAlign="center" w="100%" marginLeft="7%">
                Manage Vault
              </Text>
              <div style={{ width: "6%", display: "flex", justifyContent: "flex-end", marginBottom: "1%" }}><Button variant="ghost" width={"5%"} padding={0} leftIcon={<GrPowerReset size={32} />} marginLeft={"auto"} onClick={onRest} /></div>
            </HStack>

            <TakeAction />


            {/* For position pagination */}
            <PaginationBar pagination={{
              totalPages: totalPages,
              currentPage: mintState.positionNumber,
              nextPage: () => nextPage(setMintState, mintState.positionNumber, totalPages),
              previousPage: () => previousPage(setMintState, mintState.positionNumber),
              isFirst: mintState.positionNumber === 1,
              isLast: mintState.positionNumber === totalPages,
              setPage: undefined
            }} />
          </VStack>
        </Card>
        <Button
          width="15%"
          display="flex"
          padding="0"
          alignSelf="center"
          margin="0"
          marginTop="2%"
          onClick={onOpen}
          isDisabled={positionNumber == 0 ? true : false}
        >
          Close
        </Button>
      </Stack>

      <Modal
        isOpen={isOpen}
        onClose={onClose}
        isCentered
        size="xl"
        closeOnOverlayClick={true}
      >
        <ModalOverlay />
        <NeuroCloseModal isOpen={isOpen} onClose={onClose} position={cdp} debtAmount={debtAmount} positionNumber={positionNumber} cdtMarketPrice={cdtMarketPrice} />
      </Modal>
    </>
  )
})

const Mint = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: true, lg: false })
  const { data } = useVaultSummary()
  const { data: basketPositions } = useUserPositions()
  const [useAdvanced, setAdvanced] = useState(false)
  const [summary, setSummary] = useState({
    newDebtAmount: 0,
    debtAmount: 0,
    cost: 0,
    discountedCost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  });

  useEffect(() => {
    if (data) {
      setSummary({ ...data }); // Only update if data is available
    }
  }, [data]); // Runs when `data` changes


  const zoomLevel = useBreakpointValue({ xxs: "70%", xs: "80%", sm: "90%", base: "100%" })
  console.log("zoomLevel", zoomLevel)

  return (
    <Stack gap="1rem" paddingTop="4%" height={"100%"} alignSelf={"center"} style={{ zoom: `${zoomLevel}` }} >
      {
        basketPositions === undefined && !useAdvanced
          ?
          <>
            <USDCMintCard />
            {basketPositions === undefined && <Button
              alignSelf="center"
              // checked={useAdvanced}
              onClick={() => { setAdvanced(!useAdvanced) }}
              width={"15%"}
              backgroundColor={"transparent"}
              fontFamily="Inter"
              fontWeight={"500"}
            >
              {useAdvanced ? "Use Simplifed Mode" : "Use Advanced Mode"}
            </Button>}
          </>
          :
          <>
            <Stack flexDirection={isMobile ? "column" : "row"} alignItems="flex-start" justifyContent={"center"} maxWidth={"870px"}>
              <Stack width="100%" alignItems={"center"}>
                <MintTabsCard summary={summary} />

                {basketPositions === undefined && <Button
                  alignSelf="center"
                  // checked={useAdvanced}
                  onClick={() => { setAdvanced(!useAdvanced) }}
                  width={"30%"}
                  backgroundColor={"transparent"}
                  fontFamily="Inter"
                  fontWeight={"500"}
                >
                  {useAdvanced ? "Use Simplifed Mode" : "Use Advanced Mode"}
                </Button>}
              </Stack>
              <CurrentPositions />
              {/* <RedemptionCard /> */}
            </Stack>
          </>
      }

    </Stack>
  )
})

export default Mint

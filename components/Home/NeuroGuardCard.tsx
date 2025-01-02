import React, { useEffect, useMemo, useState, useCallback, PropsWithChildren } from "react"
import { Card, Text, Stack, HStack, Button, List, ListItem, Image, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import { num } from "@/helpers/num"
import { shiftDigits } from "@/helpers/math"
import { colors, LPJoinDate } from "@/config/defaults"
import { FaArrowDown, FaArrowUp } from "react-icons/fa6"
import { AssetsWithBalanceMenu } from "../NFT/NFTSliderInput"
import { NeuroAssetSlider } from "./NeuroAssetSlider"
import { PositionResponse } from "@/contracts/codegen/positions/Positions.types"
import Divider from "../Divider"
import useNeuroClose from "./hooks/useNeuroClose"
import { useBasket, useUserPositions } from "@/hooks/useCDP"
import { useBoundedIntents, useBoundedTVL, useUserBoundedIntents } from "../Earn/hooks/useEarnQueries"
import { getBestCLRange } from "@/services/osmosis"
import { useOraclePrice } from "@/hooks/useOracle"
import useBidState from "../Bid/hooks/useBidState"
import useCollateralAssets from "../Bid/hooks/useCollateralAssets"
import useNeuroGuard from "./hooks/useNeuroGuard"
import useNeuroState from "./hooks/useNeuroState"
import useBalance from "@/hooks/useBalance"
import { Coin } from "@cosmjs/stargate"

// Extracted FAQ component to reduce main component complexity
const FAQ = React.memo(({ isExpanded }: { isExpanded: boolean }) => {
  if (!isExpanded) return null

  return (
    <List spacing={3} styleType="disc" padding="3%" paddingTop="0" paddingBottom="0">
      <Divider mt={2} />
      <Text variant="title" mb={1} letterSpacing={0} fontSize="md" color={colors.rangeBoundBox}>
        Can I get liquidated?
      </Text>
      <ListItem fontFamily="Inter" fontSize="md">
        Potentially. The product is built to use your loan to repay instead of having to sell collateral for it. If it malfunctions, your loan will go through a normal liquidation cycle, liquidating collateral to repay 25% of the loan. The LTV is set from 36-45% for most assets. The position can be seen in detail on the Mint page.
      </ListItem>
      <Text variant="title" mb={1} letterSpacing={0} fontSize="md" color={colors.rangeBoundBox}>
        Where does the yield come from?
      </Text>
      <ListItem fontFamily="Inter" fontSize="md">
        The Membrane vault right below this. Its a range bound concentrated liquidity position that is distributed 80% of protocol revenue, revenue sourced from loan interest rates.
      </ListItem>
      <Text variant="title" letterSpacing={0} fontSize="md" color={colors.rangeBoundBox}>
        Who automates this? Is it centralized?
      </Text>
      <ListItem fontFamily="Inter" fontSize="md">
        You pay for automation with 1% of the collected yield on compounds. Compounds can be initiated by anyone and opportunities to do so will be available to search for in the app.
      </ListItem>
    </List>
  )
})

// Extracted NeuroGuardCloseButton component
const NeuroGuardOpenEntry = React.memo(({
  asset,
  RBYield
}: {
  asset: any
  RBYield: string
}) => {
  // const { action: sheathe } = useNeuroClose({ position: guardedPosition.position })
  // const isDisabled = sheathe?.simulate.isError || !sheathe?.simulate.data
  // const isLoading = sheathe?.simulate.isLoading || sheathe?.tx.isPending
  const yieldValue = num(RBYield).times(asset.borrowLTV).times(0.8).toFixed(1)

  return (
    <Card width="100%" borderWidth={3} padding={4}>
      <HStack gap="9%">
        <HStack  width="20%"  justifyContent="left">
          <Image src={asset.logo} w="30px" h="30px" />
          <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {asset.symbol}
          </Text>        
        </HStack>
        <Text  width="20%"  justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px"  display="flex">
          ${asset.combinUsdValue}
        </Text>
        <Text width="20%"  justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" >
          {yieldValue}%
        </Text>    
        <TxButton
          width="20%"
          isLoading={false}
          isDisabled={true}
          // onClick={() => sheathe?.tx.mutate()}
          toggleConnectLabel={false}
          style={{ alignSelf: "center" }}
        >
          Deposit
        </TxButton>
      </HStack>
    </Card>
  )
})

const FAQModal = React.memo(({
  isOpen, onClose, children
}: PropsWithChildren<{isOpen: boolean, onClose: () => void}>) => {
  
    return (<>
    <Button onClick={()=>{}} variant="unstyled" fontWeight="normal" mb="3">
      {children}
    </Button>

    <Modal isOpen={isOpen} onClose={onClose} closeOnOverlayClick={true}>
      <ModalOverlay />
      <ModalContent maxW="800px">
        <ModalHeader>
          <Text variant="title">Neuro-Guard FAQ</Text>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody pb="5">
        <FAQ isExpanded={true} />
        </ModalBody>
        {/* {(
          <ModalFooter
            as={HStack}
            justifyContent="end"
            borderTop="1px solid"
            borderColor="whiteAlpha.200"
            pt="5"
            gap="5"
          >
            <ActionButtons
              proposal={proposal}
              isExecuteAllowed={isExecuteAllowed}
              isRemoveAllowed={isRemoveAllowed}
              isVoteAllowed={isVoteAllowed}
              isPending={isPending}
              vote={vote}
            />
          </ModalFooter>
        )} */}
      </ModalContent>
    </Modal>
  </>)
})

// Extracted NeuroGuardCloseButton component
const NeuroGuardCloseButton = React.memo(({
  guardedPosition,
  RBYield
}: {
  guardedPosition: {
    position: PositionResponse;
    symbol: string;
    image: string;
    LTV: string;
    value: string
  };
  RBYield: string
}) => {
  const { action: sheathe } = useNeuroClose({ position: guardedPosition.position })
  const isDisabled = sheathe?.simulate.isError || !sheathe?.simulate.data
  const isLoading = sheathe?.simulate.isLoading || sheathe?.tx.isPending
  const yieldValue = num(RBYield).times(guardedPosition.LTV).toFixed(1)

  return (
    <Card width="100%" borderWidth={3} padding={4}>
      <HStack gap="9%">
        <HStack  width="20%"  justifyContent="left">
          <Image src={guardedPosition.image} w="30px" h="30px" />
          <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {guardedPosition.symbol}
          </Text>        
        </HStack>
        <Text  width="20%"  justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px"  display="flex">
          ${guardedPosition.value}
        </Text>
        <Text width="20%"  justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" >
          {yieldValue}%
        </Text>        
        <Text width="20%"  justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          N/A
        </Text>
        <TxButton
          width="20%"
          isLoading={isLoading}
          isDisabled={isDisabled}
          onClick={() => sheathe?.tx.mutate()}
          toggleConnectLabel={false}
          style={{ alignSelf: "center" }}
        >
          Close
        </TxButton>
      </HStack>
    </Card>
  )
})

const NeuroGuardCard = () => {
  const [isExpanded, setIsExpanded] = useState(false)
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const { data: TVL } = useBoundedTVL()
  const { data: userIntents } = useUserBoundedIntents()
  console.log("userIntents", userIntents)
  const { neuroState, setNeuroState } = useNeuroState()
  const { action: neuro } = useNeuroGuard()
  const { data: walletBalances } = useBalance()
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  const { bidState } = useBidState()
  const { data: clRewardList } = getBestCLRange()

  // Define priority order for specific symbols
  const prioritySymbols = ['WBTC', 'stATOM', 'stOSMO', 'stTIA']

  // Calculate daysSinceDeposit once
  const daysSinceDeposit = useMemo(() =>
    num(Date.now() - LPJoinDate.getTime()).dividedBy(1000).dividedBy(86400).toNumber(),
    []
  )

  // Memoize rangeBoundAPR calculation
  const rangeBoundAPR = useMemo(() => {
    if (!clRewardList) return 0
    const totalrewards = (clRewardList[2].reward + clRewardList[3].reward +
      clRewardList[4].reward + clRewardList[10].reward +
      clRewardList[11].reward + clRewardList[12].reward) / 6
    return totalrewards / 1000000 / daysSinceDeposit * 365
  }, [clRewardList, daysSinceDeposit])

  // Memoize yield message calculation
  const yieldMsg = useMemo(() => {
    if (!neuroState?.selectedAsset || !bidState.cdpExpectedAnnualRevenue || !TVL || !rangeBoundAPR) {
      return (
        <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="35%" display="flex" justifyContent="center">
          Select an asset to see potential yield
        </Text>
      )
    }

    const yieldTotal = num(bidState.cdpExpectedAnnualRevenue)
      .times(0.80)
      .dividedBy(TVL)
      .plus(rangeBoundAPR)
      .multipliedBy(100)
      .toFixed(1)

    const finalYield = num(yieldTotal)
      .times(neuroState.selectedAsset.maxBorrowLTV ?? 0)
      .times(0.80)
      .toFixed(1)

    return (
      <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="35%" display="flex" justifyContent="center">
        {neuroState.selectedAsset.symbol} can earn {finalYield}%
      </Text>
    )
  }, [bidState.cdpExpectedAnnualRevenue, TVL, rangeBoundAPR, neuroState?.selectedAsset])

  ////Get all assets that have a wallet balance///////
  //List of all denoms in the wallet
  const walletDenoms = (walletBalances ?? []).map((coin: Coin) => {
    if (num(coin.amount).isGreaterThan(0)) return coin.denom
    else return ""
  }).filter((asset: string) => asset != "");

  //Create an object of assets that only holds assets that have a walletBalance
  useMemo(() => {
    if (prices && walletBalances && assets) {
      const assetsWithBalance = assets?.filter((asset) => {
        if (asset !== undefined) return walletDenoms.includes(asset.base)
        else return false
      }).map((asset) => {
        if (!asset) return

        return {
          ...asset,
          value: asset?.symbol,
          label: asset?.symbol,
          borrowLTV: asset?.maxBorrowLTV ?? 0,
          sliderValue: 0,
          balance: num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount ?? 0), -(asset?.decimal ?? 6))).toNumber(),
          price: Number(prices?.find((p: any) => p.denom === asset.base)?.price ?? "0"),
          combinUsdValue: num(num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount ?? 0), -(asset?.decimal ?? 6))).times(num(prices?.find((p: any) => p.denom === asset.base)?.price ?? "0"))).toNumber()
        }
      })
        //Filter out assets with zero balance
        .filter((asset) => asset?.combinUsdValue ?? 0 > 1)

      // Sort assets with priority symbols first, then alphabetically
      const sortedAssets = assetsWithBalance.sort((a, b) => { // @ts-ignore
        const aIndex = prioritySymbols.indexOf(a.symbol ?? "N/A") // @ts-ignore
        const bIndex = prioritySymbols.indexOf(b.symbol ?? "N/A")

        // If both assets are in priority list, sort by priority order
        if (aIndex !== -1 && bIndex !== -1) {
          return aIndex - bIndex
        }
        // If only first asset is in priority list, it comes first
        if (aIndex !== -1) {
          return -1
        }
        // If only second asset is in priority list, it comes first
        if (bIndex !== -1) {
          return 1
        }
        // For non-priority assets, sort alphabetically by symbol 
        // @ts-ignore
        return a.symbol.localeCompare(b.symbol)
      })


      setNeuroState({
        // @ts-ignore
        assets: (sortedAssets ?? []),
        // @ts-ignore
        selectedAsset: sortedAssets[0] ?? {}
      })
    }
  }, [assets, walletBalances, prices])

  // Memoize existing guards calculation
  const existingGuards = useMemo(() => {
    // console.log("userIntents close", userIntents, basket, prices, basketPositions, assets)
    if (userIntents && userIntents[0].intent.intents.purchase_intents && basket && prices && basketPositions && assets) {
      //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
      const neuroGuardIntents = userIntents[0].intent.intents.purchase_intents.filter((intent) => {
        return intent.position_id !== undefined
      })

      //If there are neuroGuardIntents, create an object that saves the ID, the compounding asset & the LTV
      return neuroGuardIntents.map((intent) => {
        // console.log("big checkers", neuroGuardIntents, intent, basketPositions)
        let position = basketPositions[0].positions.find((position) => position.position_id === (intent.position_id ?? 0).toString())
        // console.log("position", basketPositions[0].positions[0].position_id,(intent.position_id??0).toString(), basketPositions[0].positions[0].position_id === (intent.position_id??0).toString())
        console.log("position", position)
        if (position === undefined) return
        // if (position.credit_amount === "0") return
        let asset = position.collateral_assets[0] //@ts-ignore
        let assetPrice = Number(prices?.find((p: any) => p.denom === asset.asset.info.native_token.denom)?.price ?? "0") //@ts-ignore
        let fullAssetInfo = assets?.find((p: any) => p.base === asset.asset.info.native_token.denom)
        let assetDecimals = fullAssetInfo?.decimal ?? 0
        let assetValue = shiftDigits(asset.asset.amount, -(assetDecimals)).times(assetPrice)
        let creditPrice = basket.credit_price.price
        let creditValue = shiftDigits(position.credit_amount, -6).times(creditPrice)
        let LTV = creditValue.dividedBy(assetValue).toString()


        // console.log("guarded LTV in creation", LTV, creditValue, assetValue, position.credit_amount, asset.asset.amount, assetPrice, creditPrice)
        return {
          position: position,
          value: assetValue.toFixed(2),
          symbol: fullAssetInfo?.symbol ?? "N/A",
          image: fullAssetInfo?.logo,
          LTV
        }
      })

    } else return undefined
  }, [basketPositions, userIntents, assets, prices, basket])

  const onSliderChange = useCallback((value: number) => {
    const max = neuroState?.selectedAsset?.combinUsdValue ?? 0
    setNeuroState({
      selectedAsset: {
        ...neuroState?.selectedAsset,
        sliderValue: num(value).isGreaterThan(max) ? max : value
      }
    })
  }, [neuroState?.selectedAsset, setNeuroState])

  const onAssetMenuChange = useCallback((value: string) => {
    setNeuroState({ selectedAsset: value })
  }, [setNeuroState])

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])

  console.log("existingGuard", existingGuards)

  return (
    <Stack gap={1} marginBottom="3%">
      <HStack>
        <Text variant="title" fontFamily="Inter" fontSize="xl" letterSpacing="1px" marginBottom="1%" display="flex" color={colors.earnText}>
          Neuro-Guards
        </Text>        
        <FAQModal isOpen={isExpanded} onClose={toggleExpanded}>
          <Button
            variant="ghost"
            width="fit-content"
            padding="0"
            alignSelf="center"
            margin="0"
            rightIcon={!isExpanded ? <FaArrowDown /> : undefined}
            leftIcon={isExpanded ? <FaArrowUp /> : undefined}
            onClick={toggleExpanded}
          >
            {!isExpanded ? "Open" : "Close"} FAQ
          </Button>
        </FAQModal>
      </HStack>
      {neuroState.assets.length > 0 ?       
      <Stack>         
        <HStack gap="9%" p={4}>
          <Text width="25%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
            Asset
          </Text>
          <Text width="25%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
            TVL
          </Text>
          <Text width="25%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
           Potential APR
          </Text>       
          <Text width="25%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
            Actions
          </Text>
        </HStack>
        {neuroState.assets.map((asset) =>
          <HStack gap={"1%"} rowGap="5%" display={"grid"} gridTemplateColumns={"repeat(1, 1fr)"} gridTemplateRows={"repeat(1, 1fr)"}>
            {asset ? <NeuroGuardOpenEntry asset={asset} RBYield={bidState.cdpExpectedAnnualRevenue ? num(bidState.cdpExpectedAnnualRevenue).times(0.80).dividedBy(TVL || 1).plus(rangeBoundAPR).multipliedBy(100).toFixed(1) : "0"} /> : null}
          </HStack>
        )}
        </Stack>
      : null}
      <Card width="100%" borderWidth={3} padding={4}>
        <Stack>
          <HStack gap="4%">
            {yieldMsg}
            <AssetsWithBalanceMenu
              width="15%"
              value={neuroState?.selectedAsset}
              onChange={onAssetMenuChange}
              assets={neuroState.assets}
            />
            <NeuroAssetSlider
              key={neuroState?.selectedAsset?.base}
              asset={neuroState?.selectedAsset}
              label={neuroState?.selectedAsset?.symbol}
              onChangeExt={onSliderChange}
            />
            {neuroState.selectedAsset?.combinUsdValue &&
              neuroState.selectedAsset?.combinUsdValue < (21 / ((neuroState.selectedAsset?.maxBorrowLTV ?? 0) * 0.8)) && (
                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="18%">
                  Minimum for {neuroState.selectedAsset?.symbol ?? "N/A"}: $
                  {((21 / ((neuroState.selectedAsset?.maxBorrowLTV ?? 0) * 0.8)) + 1).toFixed(0)}
                </Text>
              )}
            <TxButton
              w="30%"
              isLoading={neuro?.simulate.isLoading || neuro?.tx.isPending}
              isDisabled={neuro?.simulate.isError || !neuro?.simulate.data}
              onClick={() => neuro?.tx.mutate()}
              toggleConnectLabel={false}
              style={{ alignSelf: "center" }}
            >
              Open Loan for Passive Yield
            </TxButton>
          </HStack>
        </Stack>
      </Card>
      
      {existingGuards ?       
      <Stack>         
        <HStack gap="9%" p={4}>
          <Text width="20%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
            Asset
          </Text>
          <Text width="20%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
            TVL
          </Text>
          <Text width="20%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
            APR
          </Text>        
          <Text width="20%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
            Historical Profit
          </Text>
          <Text width="20%"  justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
            Actions
          </Text>
        </HStack>
        {existingGuards.map((guard) =>
          <HStack gap={"1%"} rowGap="5%" display={"grid"} gridTemplateColumns={"repeat(1, 1fr)"} gridTemplateRows={"repeat(1, 1fr)"}>
            {guard ? <NeuroGuardCloseButton guardedPosition={guard} RBYield={bidState.cdpExpectedAnnualRevenue ? num(bidState.cdpExpectedAnnualRevenue).times(0.80).dividedBy(TVL || 1).plus(rangeBoundAPR).multipliedBy(100).toFixed(1) : "0"} /> : null}
          </HStack>
        )}
        </Stack>
      : null}
    </Stack>
  )
}

export default NeuroGuardCard
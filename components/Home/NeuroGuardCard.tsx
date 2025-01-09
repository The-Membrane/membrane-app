import React, { useEffect, useMemo, useState, useCallback, PropsWithChildren, ChangeEvent } from "react"
import { Card, Text, Stack, HStack, Button, List, ListItem, Image, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input } from "@chakra-ui/react"
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
import { useBasket, useCollateralInterest, useUserPositions } from "@/hooks/useCDP"
import { useBoundedIntents, useBoundedTVL, useUserBoundedIntents } from "../Earn/hooks/useEarnQueries"
import { getBestCLRange } from "@/services/osmosis"
import { useOraclePrice } from "@/hooks/useOracle"
import useBidState from "../Bid/hooks/useBidState"
import useCollateralAssets from "../Bid/hooks/useCollateralAssets"
import useNeuroGuard from "./hooks/useNeuroGuard"
import useNeuroState from "./hooks/useNeuroState"
import useBalance from "@/hooks/useBalance"
import { Coin } from "@cosmjs/stargate"
import TxError from "../TxError"
import { BasketAsset, getBasketAssets } from "@/services/cdp"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import { parseError } from "@/helpers/parseError"
import { NeuroCloseModal, NeuroDepositModal, NeuroOpenModal, NeuroWithdrawModal } from "./NeuroModals"
import useVaultSummary from "../Mint/hooks/useVaultSummary"
import { useRouter } from "next/router"
import NextLink from 'next/link'
import { MintIcon } from "../Icons"

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

const FAQModal = React.memo(({
  isOpen, onClose, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void }>) => {

  return (<>
    <Button onClick={() => { }} variant="unstyled" fontWeight="normal" mb="3">
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


// Extracted NeuroGuardOpenEntry component
const NeuroGuardOpenEntry = React.memo(({
  asset,
  RBYield,
  basketAssets
}: {
  asset: AssetWithBalance
  RBYield: string
  basketAssets: BasketAsset[]
}) => {
  const { setNeuroState } = useNeuroState()
  const [isOpen, setIsOpen] = useState(false)

  const toggleOpen = useCallback(() => {
    setIsOpen(prev => !prev)
  }, [])

  const minValue = ((21 / ((asset.maxBorrowLTV ?? 0) * 0.8)) + 1)
  const minAmount = num(minValue).dividedBy(asset.price ?? 0).toNumber()
  {/* @ts-ignore */ }
  const isDisabled = asset ? minAmount > asset.balance ?? 0 : false


  const cost = basketAssets.find((basketAsset) => basketAsset?.asset?.base === asset.base)?.interestRate || 0
  const yieldValue = Math.max(num(RBYield).times(asset?.maxBorrowLTV ?? 0).times(0.8).minus(cost).times(100).toNumber(), 0).toFixed(1)


  return (
    <Card width="100%" borderWidth={3} padding={4}>
      <HStack gap="9%">
        <HStack width="25%" justifyContent="left">
          {asset.logo ? <Image src={asset.logo} w="30px" h="30px" /> : null}
          <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
            {asset.symbol}
          </Text>
        </HStack>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {/* @ts-ignore */}
          {num((asset?.balance ?? 0)).toFixed(2)}
        </Text>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" >
          {yieldValue}%
        </Text>
        <NeuroOpenModal isOpen={isOpen} onClose={toggleOpen} asset={asset?.base} >
          <Button
            width="100%"
            display="flex"
            padding="0"
            alignSelf="center"
            margin="0"
            onClick={() => { setNeuroState({ selectedAsset: asset }); toggleOpen() }}
            isDisabled={isDisabled}
          >
            {/* @ts-ignore */}
            {isDisabled ? `Need ${(minAmount - asset?.balance).toFixed(2)} more to Deposit` : "Deposit"}
          </Button>
        </NeuroOpenModal>
        {/* <TxButton
          width="20%"
          isLoading={isLoading}
          isDisabled={isDisabled}
          onClick={() => neuro?.tx.mutate()}
          toggleConnectLabel={false}
          style={{ alignSelf: "center" }}
        >
          Deposit
        </TxButton> */}
      </HStack>
    </Card >
  )
})

// Extracted NeuroGuardExistingEntry component
const NeuroGuardExistingEntry = React.memo(({
  guardedPosition,
  RBYield
}: {
  guardedPosition: {
    position: PositionResponse;
    symbol: string;
    image: string;
    LTV: string;
    amount: string,
    cost: number
  };
  RBYield: string
}) => {
  const { neuroState, setNeuroState } = useNeuroState()
  //find the asset in the assets array
  //@ts-ignore
  const asset = neuroState.assets.find((asset) => asset.base === guardedPosition.position.collateral_assets[0].asset.info.native_token.denom)
  // console.log("FOUND IT", asset, neuroState.assets, guardedPosition.position.collateral_assets[0].asset.info.native_token.denom)

  const [isDepositOpen, setIsDepositOpen] = useState(false)
  const toggleDepositOpen = useCallback(() => {
    setIsDepositOpen(prev => !prev)
  }, [])


  const [isWithdrawOpen, setIsWithdrawOpenOpen] = useState(false)
  const toggleWithdrawOpen = useCallback(() => {
    setIsWithdrawOpenOpen(prev => !prev)
  }, [])

  {/* @ts-ignore */ }
  const isDisabled = (asset?.balance ?? 0) === 0
  // console.log("isDisabled", isDisabled, asset?.balance, asset)
  const yieldValue = Math.max(num(RBYield).times(guardedPosition.LTV).minus(guardedPosition.cost).times(100).toNumber(), 0).toFixed(1)

  return (
    <Card width="100%" borderWidth={3} padding={4}>
      <HStack gap="9%">
        <HStack width="20%" justifyContent="left">
          <Image src={guardedPosition.image} w="30px" h="30px" />
          <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
            {guardedPosition.symbol}
          </Text>
        </HStack>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {guardedPosition.amount}
        </Text>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" >
          {yieldValue}%
        </Text>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          N/A
        </Text>
        <HStack width={"36%"}>
          <NeuroDepositModal isOpen={isDepositOpen} onClose={toggleDepositOpen} asset={asset?.base ?? ""} position_id={guardedPosition.position.position_id} >
            <Button
              width="100%"
              display="flex"
              padding="0"
              alignSelf="center"
              margin="0"
              onClick={() => { setNeuroState({ selectedAsset: asset }); toggleDepositOpen() }}
              isDisabled={isDisabled}
            >
              Deposit
            </Button>
          </NeuroDepositModal>
          <NeuroWithdrawModal isOpen={isWithdrawOpen} onClose={toggleWithdrawOpen} guardedPosition={guardedPosition} >
            <Button
              width="100%"
              display="flex"
              padding="0"
              alignSelf="center"
              margin="0"
              onClick={() => { setNeuroState({ selectedAsset: asset }); toggleWithdrawOpen() }}
              isDisabled={false}
            >
              Withdraw
            </Button>
          </NeuroWithdrawModal>
        </HStack>
      </HStack>
    </Card>
  )
})

// Extracted NeuroGuardExistingEntry component
const VaultEntry = React.memo(({
  guardedPosition,
  cdp,
  positionNumber
}: {
  guardedPosition: {
    position: PositionResponse;
    symbol: string;
    image: string;
    LTV: string;
    amount: string,
    cost: number
  };
  cdp: PositionResponse;
  positionNumber: number
}) => {
  const { data } = useVaultSummary({ positionNumber })
  const { ltv, liqudationLTV, tvl, debtAmount } = data || {
    debtAmount: 0,
    cost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  }

  const health = useMemo(() => {
    if (ltv === 0) return 100
    return num(1).minus(num(ltv).dividedBy(liqudationLTV)).times(100).dp(0).toNumber()
  }, [ltv, liqudationLTV])


  const [isCloseOpen, setIsCloseOpen] = useState(false)
  const toggleCloseOpen = useCallback(() => {
    setIsCloseOpen(prev => !prev)
  }, [])

  {/* @ts-ignore */ }
  // const isDisabled = (asset?.balance ?? 0) === 0
  // console.log("isDisabled", isDisabled, asset?.balance, asset)

  return (
    <Card width="100%" borderWidth={3} padding={4}>
      <HStack gap="9%">
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          ${tvl.toFixed(2)}
        </Text>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {debtAmount.toFixed(0)} CDT
        </Text>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" >
          {Math.min(health, 100)}%
        </Text>
        <HStack width={"25%"}>
          <Button
            width={"50%"}
            as={NextLink}
            href={'/mint'}
            display="flex"
            padding="0"
            alignSelf="center"
            margin="0"
            isDisabled={false}
          >
            Edit
          </Button>
          <NeuroCloseModal isOpen={isCloseOpen} onClose={toggleCloseOpen} guardedPosition={guardedPosition} debtAmount={debtAmount} positionNumber={positionNumber} >
            <Button
              width="100%"
              display="flex"
              padding="0"
              alignSelf="center"
              margin="0"
              onClick={toggleCloseOpen}
              isDisabled={false}
            >
              Close
            </Button>
          </NeuroCloseModal>
        </HStack>
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
  // const { action: neuro } = useNeuroGuard()
  const { data: walletBalances } = useBalance()
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  const { bidState } = useBidState()
  const { data: clRewardList } = getBestCLRange()
  const { data: interest } = useCollateralInterest()

  const basketAssets = useMemo(() => {
    if (!basket || !interest) return []
    return getBasketAssets(basket, interest) ?? []
  }, [basket, interest])

  // Define priority order for specific symbols
  const prioritySymbols = ['WBTC.ETH.AXL', 'stATOM', 'stOSMO', 'stTIA']

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
          sliderValue: 0,
          balance: num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount ?? 0), -(asset?.decimal ?? 6))).toNumber(),
          price: Number(prices?.find((p: any) => p.denom === asset.base)?.price ?? "0"),
          combinUsdValue: num(num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount ?? 0), -(asset?.decimal ?? 6))).times(num(prices?.find((p: any) => p.denom === asset.base)?.price ?? "0"))).toNumber()
        }
      })
        //Filter out assets with zero value
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

  //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
  const neuroGuardIntents = useMemo(() => {
    if (userIntents && userIntents[0] && userIntents[0].intent.intents.purchase_intents) {
      return userIntents[0].intent.intents.purchase_intents.filter((intent) => {
        return intent.position_id !== undefined
      })
    } else return []

  }, [userIntents])

  //Iterate thru positions and find all positions that aren't for NeuroGuard (i.e. don't have a position ID)
  const nonNeuroGuardPositions = useMemo(() => {
    if (basketPositions) {
      return basketPositions[0].positions
        .map((position, index) => ({ position, positionNumber: index + 1 }))
        .filter(({ position }) =>
          neuroGuardIntents.find(
            (intent) => (intent.position_id ?? 0).toString() === position.position_id
          ) === undefined
        );
    } else return []
  }, [basketPositions, neuroGuardIntents])

  // Memoize existing guards calculation
  const existingGuards = useMemo(() => {
    // console.log("userIntents close", userIntents, basket, prices, basketPositions, assets)
    if (userIntents && userIntents[0] && userIntents[0].intent.intents.purchase_intents && basket && prices && basketPositions && assets) {
      //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
      // const neuroGuardIntents = userIntents[0].intent.intents.purchase_intents.filter((intent) => {
      //   return intent.position_id !== undefined
      // })

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


        // console.log("basketAssets", basketAssets.find((basketAsset) => basketAsset?.asset?.base === asset.asset.info.native_token.denom)?.interestRate , asset.asset.info.native_token.denom, basketAssets)
        return {
          position: position,
          amount: shiftDigits(asset.asset.amount, -(assetDecimals)).toFixed(2),
          symbol: fullAssetInfo?.symbol ?? "N/A", //@ts-ignore
          image: fullAssetInfo?.logo, //@ts-ignore
          cost: basketAssets.find((basketAsset) => basketAsset?.asset?.base === asset.asset.info.native_token.denom)?.interestRate || 0,
          LTV
        }
      })

    } else return undefined
  }, [basketPositions, userIntents, assets, prices, basket])


  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])

  console.log("existingGuard", existingGuards)

  return (
    <Stack gap={1} marginBottom="3%">
      <Stack alignItems={""}>
        <Text width="100%" variant="title" textTransform={"capitalize"} fontFamily="Inter" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
          <a style={{ fontWeight: "bold", color: colors.rangeBoundBox }}>Neuro-Guard: &nbsp;</a> Earn with Peace of Mind
        </Text>
        <FAQModal isOpen={isExpanded} onClose={toggleExpanded}>
          <Button
            display="flex"
            variant="ghost"
            width="fit-content"
            padding="0"
            alignSelf="center"
            margin="0"
            onClick={toggleExpanded}
            color={colors.noState}
          >
            Beta - FAQ
          </Button>
        </FAQModal>
      </Stack>
      {neuroState.assets.length > 1 || (neuroState.assets.length > 0 && num(neuroState.assets[0].combinUsdValue).isGreaterThan(0.01)) ?
        <Stack>
          <Text width="35%" variant="title" textTransform={"capitalize"} fontFamily="Inter" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
            Your Wallet
          </Text>
          <HStack gap="9%" p={4}>
            <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Asset
            </Text>
            <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Balance
            </Text>
            <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Potential APR
            </Text>
            <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Actions
            </Text>
          </HStack>
          {neuroState.assets.map((asset) =>
            <>
              {asset && num(asset.combinUsdValue).isGreaterThan(0.01) && existingGuards?.find(((guard) => guard?.symbol === asset.symbol)) == undefined ? <NeuroGuardOpenEntry asset={asset} basketAssets={basketAssets} RBYield={bidState.cdpExpectedAnnualRevenue ? num(bidState.cdpExpectedAnnualRevenue).times(0.80).dividedBy(TVL || 1).plus(rangeBoundAPR).toString() : "0"} /> : null}
            </>
          )}
        </Stack>
        : null}
      {existingGuards && existingGuards.length > 0 && existingGuards[0] ?
        <Stack>
          <Text marginTop="3%" width="35%" variant="title" textTransform={"capitalize"} fontFamily="Inter" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
            Your Guardians
          </Text>
          <HStack gap="0%" p={4}>
            <Text width="20%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Asset
            </Text>
            <Text width="20%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Balance
            </Text>
            <Text width="20%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Estimated APR
            </Text>
            <Text width="20%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Historical Profit
            </Text>
            <Text width="20%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Actions
            </Text>
          </HStack>
          {existingGuards.map((guard) =>
            <>{guard ? <NeuroGuardExistingEntry guardedPosition={guard} RBYield={bidState.cdpExpectedAnnualRevenue ? num(bidState.cdpExpectedAnnualRevenue).times(0.80).dividedBy(TVL || 1).plus(rangeBoundAPR).toString() : "0"} /> : null}</>
          )}
        </Stack>
        : null}

      {nonNeuroGuardPositions && nonNeuroGuardPositions.length > 0 && nonNeuroGuardPositions[0] ?
        <Stack>
          <Text marginTop="3%" width="35%" variant="title" textTransform={"capitalize"} fontFamily="Inter" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
            Your Vaults
          </Text>
          <HStack gap="9%" p={4}>
            <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              TVL
            </Text>
            <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Debt
            </Text>
            <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Health
            </Text>
            <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
              Actions
            </Text>
          </HStack>
          {nonNeuroGuardPositions.map((cdpInfo) =>
            <>{cdpInfo ? <VaultEntry cdp={cdpInfo.position} positionNumber={cdpInfo.positionNumber} /> : null}</>
          )}
        </Stack>
        : null}
    </Stack>
  )
}

export default NeuroGuardCard
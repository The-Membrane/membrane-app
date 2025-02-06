import React, { useEffect, useMemo, useState, useCallback, PropsWithChildren, ChangeEvent, memo, useRef } from "react"
import { Card, Text, Stack, HStack, Button, List, ListItem, Image, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input } from "@chakra-ui/react"
import { num } from "@/helpers/num"
import { shiftDigits } from "@/helpers/math"
import { colors, denoms } from "@/config/defaults"
import { PositionResponse } from "@/contracts/codegen/positions/Positions.types"
import Divider from "../Divider"
import { useBasket, useBasketAssets, useCollateralInterest, useUserPositions } from "@/hooks/useCDP"
import { simpleBoundedAPRCalc, useBoundedCDTVaultTokenUnderlying, useBoundedTVL, useEstimatedAnnualInterest, useUserBoundedIntents } from "../Earn/hooks/useEarnQueries"
import { useOraclePrice } from "@/hooks/useOracle"
import useBidState from "../Bid/hooks/useBidState"
import useCollateralAssets from "../Bid/hooks/useCollateralAssets"
import useNeuroState from "./hooks/useNeuroState"
import useBalance, { useBalanceByAsset } from "@/hooks/useBalance"
import { BasketAsset } from "@/services/cdp"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import { NeuroCloseModal, NeuroDepositModal, NeuroOpenModal, NeuroWithdrawModal, RBLPDepositModal, RBLPWithdrawModal } from "./NeuroModals"
import useVaultSummary from "../Mint/hooks/useVaultSummary"
import NextLink from 'next/link'
import useMintState from "../Mint/hooks/useMintState"
import { getCookie, setCookie } from "@/helpers/cookies"
import BigNumber from "bignumber.js"
import useQuickActionState from "./hooks/useQuickActionState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import useWallet from "@/hooks/useWallet"
import useAppState from "../../persisted-state/useAppState"
import { QueryInterchainAccountRequest } from "osmojs/ibc/applications/interchain_accounts/controller/v1/query"
import useNeuroIntentPolish from "./hooks/useNeuroIntentPolish"
import { TxButton } from "../TxButton"
import useToaster from "@/hooks/useToaster"
import RangeBoundVisual from "./RangeBoundVisual"
import RangeBoundInfoCard from "./RangeBoundInfoCard"
import { FaArrowDown } from "react-icons/fa6"

// Extracted RBLPDepositEntry component
const RBLPDepositEntry = React.memo(({
  asset,
  RBYield
}: {
  asset: AssetWithBalance
  RBYield: string
}) => {
  const [isOpen, setIsOpen] = useState(false)

  const toggleOpen = useCallback(() => {
    setIsOpen(prev => !prev)
  }, [])

  {/* @ts-ignore */ }
  const isDisabled = false

  const yieldValue = num(RBYield).times(100).toFixed(2)


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
        {isOpen && (<RBLPDepositModal isOpen={isOpen} onClose={toggleOpen} cdtAsset={asset} />)}
        <Button
          width="25%"
          minWidth={"262px"}
          display="flex"
          padding="0"
          alignSelf="center"
          margin="0"
          onClick={() => { toggleOpen() }}
          isDisabled={isDisabled}
        >
          Deposit
        </Button>
      </HStack>
    </Card >
  )
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
  // console.log("yieldValue test", RBYield, asset.maxBorrowLTV, cost)
  const yieldValue = num(RBYield).times(asset?.maxBorrowLTV ?? 0).times(0.8).minus(cost).times(100).toFixed(1)
  console.log(RBYield)
  // console.log("INFiNITY LOGS", (minAmount - asset?.balance).toFixed(2).toString() === "Infinity", (minAmount - asset?.balance) === Infinity)

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
          {/* @ts-ignore */}
          {asset?.default == true ? num(RBYield).times(100).toFixed(1) : yieldValue}%
        </Text>
        {isOpen && (<NeuroOpenModal isOpen={isOpen} onClose={toggleOpen} asset={asset?.base} />)}
        <Button
          width="25%"
          minWidth={"262px"}
          display="flex"
          padding="0"
          alignSelf="center"
          margin="0"
          onClick={() => { setNeuroState({ openSelectedAsset: asset }); toggleOpen(); console.log("isOpen?", isOpen) }}
          isDisabled={isDisabled}
        >
          {/* @ts-ignore */}
          {isDisabled ? `Need ${(minAmount - asset?.balance).toFixed(2).toString() === "Infinity" ? "___" : (minAmount - asset?.balance).toFixed(2)} more to Deposit` : "Deposit"}
        </Button>
      </HStack>
    </Card >
  )
})

// Extracted NeuroGuardExistingEntry component
const NeuroGuardExistingEntry = React.memo(({
  guardedPosition,
  RBYield,
  prices
}: {
  guardedPosition: {
    position: PositionResponse;
    symbol: string;
    image: string;
    LTV: string;
    amount: BigNumber,
    cost: number
  };
  RBYield: string
  prices: any
}) => {
  const { neuroState, setNeuroState } = useNeuroState()
  const { appState } = useAppState();

  //find the asset in the assets array
  //@ts-ignore
  const asset = guardedPosition.symbol === "N/A" ? undefined : neuroState.assets.find((asset) => asset.base === guardedPosition.position.collateral_assets[0].asset.info.native_token.denom)
  // console.log("FOUND IT", asset, neuroState.assets, guardedPosition.position.collateral_assets[0].asset.info.native_token.denom)

  //We need the cookie to be set even if these render before the user has checked the cookie box
  const [initialDepositAmount, setInitialDepositAmount] = useState(0);
  useEffect(() => {
    const cookieKey = "neuroGuard " + guardedPosition.position.position_id;
    let cookie = getCookie(cookieKey);
    console.log("cookie", cookie)

    if (cookie == null && appState.setCookie) {
      console.log("setting NG cookie", cookie)
      setCookie(cookieKey, guardedPosition.amount.toString(), 3650);
      cookie = guardedPosition.amount.toString();
    }

    setInitialDepositAmount(Number(cookie || 0));
  }, [appState.setCookie, guardedPosition.amount]);

  // console.log("initialDepositAmount", initialDepositAmount)

  const [isDepositOpen, setIsDepositOpen] = useState(false)
  const toggleDepositOpen = useCallback(() => {
    setIsDepositOpen(prev => !prev)
  }, [])


  const [isWithdrawOpen, setIsWithdrawOpenOpen] = useState(false)
  const toggleWithdrawOpen = useCallback(() => {
    setIsWithdrawOpenOpen(prev => !prev)
  }, [])

  {/* @ts-ignore */ }
  const isDisabled = (asset?.balance ?? 0) === 0 || guardedPosition.symbol === "N/A"
  // console.log("isDisabled", isDisabled, asset?.balance, asset)
  const yieldValue = num(RBYield).times(guardedPosition.LTV).minus(guardedPosition.cost).times(100).toFixed(1)

  return (
    <Card width="100%" borderWidth={3} padding={4}>
      <HStack gap="9%">
        <HStack width="20%" justifyContent="left">
          {guardedPosition.image ? <Image src={guardedPosition.image} w="30px" h="30px" /> : null}
          <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
            {guardedPosition.symbol}
          </Text>
        </HStack>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {guardedPosition.amount.toFixed(2)}
        </Text>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" >
          {yieldValue}%
        </Text>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {initialDepositAmount == 0 ? "0.00" : Math.max(0, num(guardedPosition.amount).dividedBy(initialDepositAmount).minus(1).times(100).toNumber()).toFixed(2)}%
        </Text>
        <HStack width={"36%"}>
          <Button
            width="50%"
            display="flex"
            padding="0"
            alignSelf="center"
            margin="0"
            onClick={() => {
              toggleDepositOpen();
              setNeuroState({ depositSelectedAsset: asset });
            }}
            isDisabled={isDisabled}
          >
            Deposit
          </Button>
          {isDepositOpen && (
            <NeuroDepositModal isOpen={isDepositOpen} onClose={toggleDepositOpen} asset={asset?.base ?? ""} position_id={guardedPosition.position.position_id} />
          )}

          {isWithdrawOpen && (<NeuroWithdrawModal isOpen={isWithdrawOpen} onClose={toggleWithdrawOpen} guardedPosition={guardedPosition} prices={prices} />)}
          <Button
            width="50%"
            display="flex"
            padding="0"
            alignSelf="center"
            margin="0"
            onClick={() => { toggleWithdrawOpen(); setNeuroState({ withdrawSelectedAsset: asset }); }}
            isDisabled={guardedPosition.symbol == "N/A" ? true : false}
          >
            Withdraw
          </Button>
        </HStack>
      </HStack>
    </Card>
  )
})

// Extracted RBLPExistingEntry component
const RBLPExistingEntry = React.memo(({
  rblpDeposit,
  RBYield,
  cdtMarketPrice,
  address
}: {
  rblpDeposit: number
  RBYield: string
  cdtMarketPrice: string
  address: string
}) => {

  const { neuroState } = useNeuroState()
  const { appState } = useAppState();
  const { setQuickActionState } = useQuickActionState()
  //find the asset in the assets array
  //@ts-ignore
  const asset = neuroState.assets.find((asset) => asset.base === denoms.CDT[0]) || { logo: "/images/cdt.svg", symbol: "CDT", balance: 0 }
  // console.log("cdtAsset", asset, neuroState.assets)

  //We need the cookie to be set even if these render before the user has checked the cookie box
  const [initialDepositAmount, setInitialDepositAmount] = useState(0);
  useEffect(() => {
    const cookieKey = "rblp " + address;
    let cookie = getCookie(cookieKey);
    console.log("rblp cookie", cookie)

    if (cookie == null && appState.setCookie) {
      console.log("setting RBLP cookie", cookie)
      setCookie(cookieKey, rblpDeposit.toString(), 3650);
      cookie = rblpDeposit.toString();
    }

    setInitialDepositAmount(Number(cookie || 0));
  }, [appState.setCookie, rblpDeposit]);

  // console.log("initialDepositAmount", initialDepositAmount)

  const [isDepositOpen, setIsDepositOpen] = useState(false)
  const toggleDepositOpen = useCallback(() => {
    setIsDepositOpen(prev => !prev)
  }, [])


  const [isWithdrawOpen, setIsWithdrawOpenOpen] = useState(false)
  const toggleWithdrawOpen = useCallback(() => {
    setIsWithdrawOpenOpen(prev => !prev)
  }, [])

  {/* @ts-ignore */ }
  const isDisabled = (asset?.symbol === "N/A") || false
  // console.log("isDisabled", isDisabled, asset?.balance, asset)
  const yieldValue = num(RBYield).times(100).toFixed(1)

  return (
    <Card width="100%" borderWidth={3} padding={4}>
      <HStack gap="9%">
        <HStack width="20%" justifyContent="left">
          <Image src={"/images/cdt.svg"} w="30px" h="30px" />
          <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
            CDT
          </Text>
        </HStack>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {rblpDeposit.toFixed(2)}
        </Text>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" >
          {yieldValue}%
        </Text>
        <Text width="20%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {initialDepositAmount == 0 ? "0.00" : Math.max(0, num(rblpDeposit).dividedBy(initialDepositAmount).minus(1).times(100).toNumber()).toFixed(2)}%
        </Text>
        <HStack width={"36%"}>
          {/* @ts-ignore */}
          {isDepositOpen && (<RBLPDepositModal isOpen={isDepositOpen} onClose={toggleDepositOpen} cdtAsset={asset} />)}
          <Button
            width="50%"
            display="flex"
            padding="0"
            alignSelf="center"
            margin="0"
            onClick={() => { toggleDepositOpen(); setQuickActionState({ rangeBoundLPwithdrawal: 0 }) }}
            //@ts-ignore
            isDisabled={isDisabled || (asset?.balance ?? 0) === 0}
          >
            Deposit
          </Button>

          {isWithdrawOpen && (<RBLPWithdrawModal isOpen={isWithdrawOpen} onClose={toggleWithdrawOpen} cdtMarketPrice={cdtMarketPrice} rblpDeposit={rblpDeposit} />)}
          <Button
            width="50%"
            display="flex"
            padding="0"
            alignSelf="center"
            margin="0"
            onClick={() => { toggleWithdrawOpen(); setQuickActionState({ rangeBoundLPdeposit: 0 }) }}
            isDisabled={isDisabled || rblpDeposit === 0}
          >
            Withdraw
          </Button>
        </HStack>
      </HStack>
    </Card>
  )
})


// Extracted VaultEntry component
const VaultEntry = React.memo(({
  cdp,
  positionNumber,
  cdtMarketPrice
}: {
  cdp: PositionResponse;
  positionNumber: number
  cdtMarketPrice: string
}) => {
  const { setMintState } = useMintState()
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


  return (
    <Card width="100%" borderWidth={3} padding={4}>
      <HStack gap="9%">
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {positionNumber == 0 ? "N/A" : `$${tvl.toFixed(2)}`}
        </Text>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
          {positionNumber == 0 ? "N/A" : `${debtAmount.toFixed(0)} CDT`}
        </Text>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" >
          {Math.min(health, 100) == -Infinity ? "N/A" : `${Math.min(health, 100)}%`}
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
            onClick={() => { setMintState({ positionNumber }) }}
          >
            {positionNumber == 0 ? "Create" : "Edit"}
          </Button>
          {isCloseOpen && (<NeuroCloseModal isOpen={isCloseOpen} onClose={toggleCloseOpen} position={cdp} debtAmount={debtAmount} positionNumber={positionNumber} cdtMarketPrice={cdtMarketPrice} />)}
          <Button
            width="50%"
            display="flex"
            padding="0"
            alignSelf="center"
            margin="0"
            onClick={toggleCloseOpen}
            isDisabled={positionNumber == 0 ? true : false}
          >
            Close
          </Button>
        </HStack>
      </HStack>
    </Card>
  )
})

// Memoize child components
const MemoizedNeuroGuardOpenEntry = memo(NeuroGuardOpenEntry);
// const MemoizedNeuroGuardExistingEntry = memo(NeuroGuardExistingEntry);
const MemoizedVaultEntry = memo(VaultEntry);
const MemoizedRBLPDepositEntry = memo(RBLPDepositEntry);
// const MemoizedRBLPExistingEntry = memo(RBLPExistingEntry);



//@ts-ignore
function ToastButton({ isLoading, isDisabled, onClick }) {
  return (
    <Button isDisabled={isDisabled} isLoading={isLoading} onClick={onClick}>
      Polish
    </Button>
  );
}

const NeuroGuardCard = () => {
  console.log("NG render")
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  // console.log("basketPositions", basketPositions)
  const { data: basket } = useBasket()
  // console.log("basketPositions", basketPositions)
  const { data: TVL } = useBoundedTVL()
  const { data: userIntents } = useUserBoundedIntents()
  const { neuroState, setNeuroState } = useNeuroState()
  // useEstimatedAnnualInterest(false)
  const { data: walletBalances } = useBalance()
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  // const { data: clRewardList } = getBestCLRange()
  const { data: interest } = useCollateralInterest()
  const { data: basketAssets } = useBasketAssets()
  const { action: polishIntents } = useNeuroIntentPolish()
  const toaster = useToaster();
  const [hasShownToast, setHasShownToast] = useState(false);


  const isDisabled = polishIntents?.simulate.isError || !polishIntents?.simulate.data
  const isLoading = polishIntents?.simulate.isLoading || polishIntents?.tx.isPending

  // Memoize the toggle handler to prevent recreating on each render
  const onClick = useCallback(() => {
    polishIntents?.tx.mutate()
  }, [polishIntents?.tx]);

  //Toast if a msg is ever ready to rock
  useEffect(() => {

    console.log("isDisabled polish", isDisabled, isLoading)

    if (!hasShownToast && !isDisabled && !isLoading) {
      toaster.message({
        title: 'Execute to Claim Guardian Dust & Re-Activate Intents',
        message: (
          <ToastButton
            isDisabled={isDisabled}
            isLoading={isLoading}
            onClick={onClick}
          />
        ),
        duration: null
      });
      setHasShownToast(true);
    } else if (hasShownToast && !isDisabled && isLoading) {
      toaster.dismiss();
      toaster.message({
        title: 'Execute to Claim Guardian Dust & Re-Activate Intents',
        message: (
          <ToastButton
            isDisabled={isDisabled}
            isLoading={isLoading}
            onClick={onClick}
          />
        ),
        duration: null
      });

    }
  }, [isDisabled, isLoading]);


  const calculatedRBYield = useMemo(() => {
    if (!basket || !interest || !TVL) return "0";
    return simpleBoundedAPRCalc(basket, interest, TVL)
  }, [basket, interest, TVL]);
  // console.log(calculatedRBYield, basket, interest, TVL)

  ////
  const boundCDTAsset = useAssetBySymbol('range-bound-CDT')
  const boundCDTBalance = useBalanceByAsset(boundCDTAsset) ?? "1"
  const { data: underlyingData } = useBoundedCDTVaultTokenUnderlying(
    num(shiftDigits(boundCDTBalance, 6)).toFixed(0)
  )
  const underlyingCDT = useMemo(() =>
    shiftDigits(underlyingData, -6).toString() ?? "0"
    , [underlyingData])
  ////


  const cdtMarketPrice = prices?.find((price) => price.denom === denoms.CDT[0])?.price || basket?.credit_price.price || "1"

  // Define priority order for specific symbols
  const prioritySymbols = ['WBTC.ETH.AXL', 'stATOM', 'stOSMO', 'stTIA']

  ////Get all assets that have a wallet balance///////
  //List of all denoms in the wallet
  const walletDenoms = useMemo(() => {
    return (walletBalances ?? [])
      //@ts-ignore
      .filter(coin => num(coin.amount).isGreaterThan(0))
      //@ts-ignore
      .map(coin => coin.denom);
  }, [walletBalances]);

  const sortedAssets = useMemo(() => {
    if (!prices || !walletBalances || !assets) return [];

    const assetsPlusCDT = [...assets, {
      base: denoms.CDT[0],
      symbol: "CDT",
      decimal: 6,
      logo: "/images/cdt.svg",
      combinedUsdValue: 1
    }];

    return assetsPlusCDT
      .filter(asset => asset && walletDenoms.includes(asset.base))
      .map(asset => ({
        ...asset,
        value: asset?.symbol,
        label: asset?.symbol,
        sliderValue: 0,
        balance: num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount ?? 0), -(asset?.decimal ?? 6))).toNumber(),
        price: Number(prices?.find((p: any) => p.denom === asset.base)?.price ?? "0"),
        combinUsdValue: num(num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount ?? 0), -(asset?.decimal ?? 6))).times(num(prices?.find((p: any) => p.denom === asset.base)?.price ?? "0"))).toNumber()
      }))
      .filter(asset => (asset?.combinUsdValue ?? 0) > 1)
      .sort((a, b) => { // @ts-ignore
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
      });
  }, [assets, walletBalances, prices, walletDenoms]);


  // Update state in a separate effect
  useEffect(() => {
    if (sortedAssets && sortedAssets.length > 0) {
      setNeuroState({
        //@ts-ignore
        assets: sortedAssets ?? [],
        selectedAsset: sortedAssets[0] ?? {}
      });
    }
  }, [sortedAssets]);
  //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
  const neuroGuardIntents = useMemo(() => {
    if (!userIntents?.[0]?.intent?.intents?.purchase_intents) return [];
    return userIntents[0].intent.intents.purchase_intents
      .filter(intent => intent.position_id !== undefined);
  }, [userIntents]);


  // Memoize existing guards calculation
  const existingGuards = useMemo(() => {
    // console.log(" top  guards")
    // console.log("userIntents close", userIntents, basket, prices, basketPositions, assets)
    if (userIntents && userIntents[0] && userIntents[0].intent.intents.purchase_intents && basket && prices && basketPositions && assets && basketAssets) {
      // console.log(" in guards")
      //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
      // const neuroGuardIntents = userIntents[0].intent.intents.purchase_intents.filter((intent) => {
      //   return intent.position_id !== undefined
      // })

      //If there are neuroGuardIntents, create an object that saves the ID, the compounding asset & the LTV
      return neuroGuardIntents.map((intent) => {
        // console.log("big checkers", neuroGuardIntents, intent, basketPositions)
        let position = basketPositions[0].positions.find((position) => position.position_id === (intent.position_id ?? 0).toString())
        // console.log("position", basketPositions[0].positions[0].position_id,(intent.position_id??0).toString(), basketPositions[0].positions[0].position_id === (intent.position_id??0).toString())
        // console.log("position", position)
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
          amount: shiftDigits(asset.asset.amount, -(assetDecimals)),
          symbol: fullAssetInfo?.symbol ?? "N/A", //@ts-ignore
          image: fullAssetInfo?.logo, //@ts-ignore
          cost: basketAssets.find((basketAsset) => basketAsset?.asset?.base === asset.asset.info.native_token.denom)?.interestRate || 0,
          LTV
        }
      })
        .filter(Boolean);

    } else return [{
      position: { position_id: "0", collateral_assets: [{ asset: { info: { native_token: { denom: "N/A" } } }, amount: "0" }] },
      amount: num("0"),
      symbol: "N/A",
      image: "",
      cost: 0,
      LTV: "0"
    }]
  }, [basketPositions, userIntents, assets, prices, basket, underlyingCDT, basketAssets])



  // Pre-calculate values used in render
  // const showWallet = useMemo(() => {
  //   return neuroState.assets.length > 1 ||
  //     (neuroState.assets.length > 0 &&
  //       num(neuroState.assets[0].combinUsdValue).isGreaterThan(0.01));
  // }, [neuroState.assets]);


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
    } else return [
      {
        position: {},
        positionNumber: 0
      }
    ]
  }, [basketPositions, neuroGuardIntents])
  // console.log("nonNeuroGuardPositions", nonNeuroGuardPositions, basketPositions, neuroGuardIntents)


  // Separate complex sections into components
  const WalletSection = memo(({ assets, existingGuards, RBYield, boundCDTBalance, basketAssets }: { assets: any[], existingGuards: any[], RBYield: string, boundCDTBalance: number, basketAssets: BasketAsset[] }) => {
    return (
      <Stack ref={sectionRef}>
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
        <Stack gap={"1rem"}>{true ?

          basketAssets.map((basketAsset) => {
            if (!basketAsset || basketAsset.asset?.symbol === "marsUSDC" || basketAsset.asset?.symbol === "OSMO/USDC.axl LP" || basketAsset.asset?.symbol === "ATOM/OSMO LP") {
              return null;
            }

            return (
              <MemoizedNeuroGuardOpenEntry
                key={basketAsset.asset?.symbol ?? basketAsset.asset?.base}
                asset={{
                  base: basketAsset.asset?.base,
                  symbol: basketAsset.asset?.symbol ?? "",
                  logo: basketAsset.asset?.logo ?? "",
                  maxBorrowLTV: basketAsset.maxBorrowLTV,
                  balance: 0,
                  combinUsdValue: num(basketAsset.interestRate).toNumber(),
                  default: true
                }}
                RBYield={RBYield}
                basketAssets={basketAssets}
              />
            );
          })

          : assets.map((asset) => {
            if (!asset || !num(asset.combinUsdValue).isGreaterThan(0.01) ||
              existingGuards?.find((guard) => guard?.symbol === asset.symbol)) {
              return null;
            }

            // console.log(!(boundCDTBalance > 0), boundCDTBalance)

            if (asset.base === denoms.CDT[0] && !(boundCDTBalance > 0)) {
              return (
                <MemoizedRBLPDepositEntry
                  key={asset.symbol}
                  asset={asset}
                  RBYield={RBYield}
                />
              );
            } else if (asset.base != denoms.CDT[0]) {
              return (
                <MemoizedNeuroGuardOpenEntry
                  key={asset.symbol}
                  asset={asset}
                  basketAssets={basketAssets}
                  RBYield={RBYield}
                />
              )
            } else { return null }
          })}</Stack>
      </Stack>
    );
  });

  const CDPsSection = memo(({ positions, cdtMarketPrice }: { positions: any[], cdtMarketPrice: string }) => {
    return (
      <Stack>
        <Text marginTop="3%" width="35%" variant="title" textTransform={"capitalize"} fontFamily="Inter" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
          Your CDPs
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
        {positions.map((cdpInfo) =>
          cdpInfo ? (
            <MemoizedVaultEntry
              key={cdpInfo.positionNumber}
              cdp={cdpInfo.position}
              positionNumber={cdpInfo.positionNumber}
              cdtMarketPrice={cdtMarketPrice}
            />
          ) : null
        )}
      </Stack>
    );
  });


  const sectionRef = useRef<HTMLDivElement>(null);

  const scrollToSection = () => {
    sectionRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <Stack gap={1} marginBottom="3%">

      <HStack alignContent={"center"} flexWrap={"wrap"} height={"600px"} justifyContent="center" marginBottom={"5%"} gap="3">
        <RangeBoundVisual />
        <RangeBoundInfoCard RBYield={calculatedRBYield} TVL={num(TVL).times(cdtMarketPrice).toFixed(2) ?? "0"} scrollFn={scrollToSection} />
        {/* Add Button in the middle of the remaining space that allows users to swap any stables to CDT */}
      </HStack>

      {neuroState.assets.length > 0 && neuroState.assets.some(asset =>
        asset && // check if defined
        Number(asset.combinUsdValue) > 0.01 && // check USD value
        !existingGuards?.some(guard => guard?.symbol === asset.symbol) // check not in existing guards
      ) ?
        <WalletSection assets={neuroState.assets} existingGuards={existingGuards} RBYield={calculatedRBYield} boundCDTBalance={Number(boundCDTBalance)} basketAssets={basketAssets ?? []} />
        : null}

      {(existingGuards && existingGuards.length > 0 && existingGuards[0]) || Number(underlyingCDT) > 0 ?
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
          {Number(boundCDTBalance) > 0 ? < RBLPExistingEntry address={address ?? ""} rblpDeposit={Number(underlyingCDT)} cdtMarketPrice={cdtMarketPrice} RBYield={calculatedRBYield} /> : null}
          {existingGuards.map((guard) =>
            //@ts-ignore
            <>{guard && guard.symbol != "CDT" && (guard.symbol == "N/A" ? Number(boundCDTBalance) === 0 : true) ? <NeuroGuardExistingEntry guardedPosition={guard} RBYield={calculatedRBYield} prices={prices} /> : null}</>
          )}
        </Stack>
        : null}

      {nonNeuroGuardPositions && nonNeuroGuardPositions.length > 0 && nonNeuroGuardPositions[0] ?
        <CDPsSection positions={nonNeuroGuardPositions} cdtMarketPrice={cdtMarketPrice} />
        : null}
    </Stack>
  )
}

export default memo(NeuroGuardCard)
import React, { useEffect, useMemo, useState, useCallback, memo, useRef, ChangeEvent, use } from "react"
import { Card, Text, Stack, HStack, Button, Image, Modal, ModalOverlay, Checkbox, useDisclosure, List, ListItem, Input, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, CardHeader, CardBody, CardFooter, TabIndicator, TabList, Tabs } from "@chakra-ui/react"
import { num } from "@/helpers/num"
import { shiftDigits } from "@/helpers/math"
import { colors, denoms, INPUT_DELAY } from "@/config/defaults"
import { PositionResponse } from "@/contracts/codegen/positions/Positions.types"
import Divider from "../Divider"
import { useBasket, useBasketAssets, useCollateralInterest, useUserPositions } from "@/hooks/useCDP"
import { simpleBoundedAPRCalc, useBoundedCDTVaultTokenUnderlying, useBoundedTVL, useEstimatedAnnualInterest, useUserBoundedIntents, useVaultInfo } from "../../hooks/useEarnQueries"
import { useOraclePrice } from "@/hooks/useOracle"
import useCollateralAssets from "../Bid/hooks/useCollateralAssets"
import useNeuroState from "./hooks/useNeuroState"
import useBalance, { useBalanceByAsset } from "@/hooks/useBalance"
import { BasketAsset } from "@/services/cdp"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import { NeuroCloseModal, NeuroDepositModal, NeuroOpenModal, NeuroWithdrawModal, RBLPDepositModal, RBLPWithdrawModal, USDCMintModal, USDCSwapToCDTModal } from "./NeuroModals"
import useVaultSummary from "../Mint/hooks/useVaultSummary"
import NextLink from 'next/link'
import useMintState from "../Mint/hooks/useMintState"
import { getCookie, setCookie } from "@/helpers/cookies"
import BigNumber from "bignumber.js"
import useQuickActionState from "./hooks/useQuickActionState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import useWallet from "@/hooks/useWallet"
import useAppState from "../../persisted-state/useAppState"
import useNeuroIntentPolish from "./hooks/useNeuroIntentPolish"
import useToaster from "@/hooks/useToaster"
import RangeBoundVisual from "./RangeBoundVisual"
import RangeBoundInfoCard from "./RangeBoundInfoCard"
import { ManicRedemptionCard } from "./ManicRedemptionCard"
import { getBestCLRange } from "@/services/osmosis"
import { FAQModal } from "./HomeTitle"
import useSwapToCDT from "./hooks/useUSDCSwapToCDT"
import { parseError } from "@/helpers/parseError"
import { TxButton } from "../TxButton"
import { CustomTab } from "../Mint/AssetWithInput"
import { set } from "react-hook-form"
import useBoundedLP from "./hooks/useRangeBoundLP"
import ConfirmModal from "../ConfirmModal"
import { HomeSummary } from "./HomeSummary"

// Extracted RBLPDepositEntry component
// const RBLPDepositEntry = React.memo(({
//   asset,
//   RBYield
// }: {
//   asset: AssetWithBalance
//   RBYield: string
// }) => {

//   const { isOpen, onOpen, onClose } = useDisclosure()

//   {/* @ts-ignore */ }
//   const isDisabled = false

//   const yieldValue = num(RBYield).times(100).toFixed(2)


//   return (
//     <>
//       <Card width="100%" borderWidth={3} padding={4}>
//         <HStack gap="9%">
//           {asset.logo ? <Image src={asset.logo} w="30px" h="30px" /> : null}
//           <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
//             Your
//             {/* @ts-ignore */}
//             {num((asset?.balance ?? 0)).toFixed(2)}
//             CDT could be earning
//             {yieldValue}% APR
//           </Text>
//           <Button
//             width="36%"
//             minWidth={"262px"}
//             display="flex"
//             padding="0"
//             alignSelf="center"
//             margin="0"
//             onClick={onOpen}
//             isDisabled={isDisabled}
//           >
//             Deposit
//           </Button>
//         </HStack>
//       </Card >

//       <Modal
//         isOpen={isOpen}
//         onClose={onClose}
//         isCentered
//         size="xl"
//         closeOnOverlayClick={true}
//       >
//         <ModalOverlay />
//         <RBLPDepositModal
//           isOpen={isOpen}
//           onClose={onClose}
//           cdtAsset={asset}
//         />
//       </Modal>
//     </>

//   )
// })


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
  const { isOpen, onOpen, onClose } = useDisclosure()

  const minValue = ((21 / ((asset.maxBorrowLTV ?? 0) * 0.8)) + 1)
  const minAmount = num(minValue).dividedBy(asset.price ?? 0).toNumber()
  {/* @ts-ignore */ }
  const isDisabled = asset ? minAmount > asset.balance ?? 0 : false


  const cost = basketAssets.find((basketAsset) => basketAsset?.asset?.base === asset.base)?.interestRate || 0
  // // console.log("yieldValue test", RBYield, asset.maxBorrowLTV, cost)
  const ltv = asset.symbol === "USDC" ? 0.89 : 0.8
  const yieldValue = num(RBYield).minus(cost).times(asset?.maxBorrowLTV ?? 0).times(ltv).times(100).toFixed(1)
  // console.log(RBYield)
  // // console.log("INFiNITY LOGS", (minAmount - asset?.balance).toFixed(2).toString() === "Infinity", (minAmount - asset?.balance) === Infinity)

  return (
    <>
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
          <Text width="25%" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex" opacity={Number(yieldValue) < 0 ? "33%" : "100%"}>
            {/* @ts-ignore */}
            {asset?.default == true ? num(RBYield).times(100).toFixed(1) : yieldValue}%
          </Text>
          <Button
            width="36%"
            minWidth={"262px"}
            display="flex"
            padding="0"
            alignSelf="center"
            margin="0"
            onClick={onOpen}
            isDisabled={isDisabled}
          >
            {/* @ts-ignore */}
            {isDisabled ? `Need ${(minAmount - asset?.balance).toFixed(2).toString() === "Infinity" ? "___" : (minAmount - asset?.balance).toFixed(2)} more to Deposit` : "Deposit"}
          </Button>
        </HStack>
      </Card >

      <Modal
        isOpen={isOpen}
        onClose={onClose}
        isCentered
        size="xl"
        closeOnOverlayClick={true}
      >
        <ModalOverlay />
        <NeuroOpenModal
          key={asset?.symbol}
          isOpen={isOpen}
          onClose={onClose}
          asset={asset}
        />
      </Modal>
    </>
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
  const neuroStateAssets = useNeuroState(state => state.neuroState.assets);
  const { appState } = useAppState();

  //find the asset in the assets array
  //@ts-ignore
  const asset = guardedPosition.symbol === "N/A" ? undefined : neuroStateAssets.find((asset) => asset.base === guardedPosition.position.collateral_assets[0].asset.info.native_token.denom)
  // // console.log("FOUND IT", asset, neuroState.assets, guardedPosition.position.collateral_assets[0].asset.info.native_token.denom)

  //We need the cookie to be set even if these render before the user has checked the cookie box
  const [initialDepositAmount, setInitialDepositAmount] = useState(0);
  useEffect(() => {
    const cookieKey = "neuroGuard " + guardedPosition.position.position_id;
    let cookie = getCookie(cookieKey);
    // console.log("cookie", cookie)

    if (cookie == null && appState.setCookie) {
      // console.log("setting NG cookie", cookie)
      setCookie(cookieKey, guardedPosition.amount.toString(), 3650);
      cookie = guardedPosition.amount.toString();
    }

    setInitialDepositAmount(Number(cookie || 0));
  }, [appState.setCookie, guardedPosition.amount]);

  // // console.log("initialDepositAmount", initialDepositAmount)


  const { isOpen: isDepositOpen, onOpen: onDepositOpen, onClose: onDepositClose } = useDisclosure()
  const { isOpen: isWithdrawOpen, onOpen: onWithdrawOpen, onClose: onWithdrawClose } = useDisclosure()

  {/* @ts-ignore */ }
  const isDisabled = (asset?.balance ?? 0) === 0 || guardedPosition.symbol === "N/A"
  // // console.log("isDisabled", isDisabled, asset?.balance, asset)
  const yieldValue = num(RBYield).minus(guardedPosition.cost).times(guardedPosition.LTV).times(100).toFixed(1)

  return (
    <>
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
              onClick={onDepositOpen}
              isDisabled={isDisabled}
            >
              Deposit
            </Button>
            <Button
              width="50%"
              display="flex"
              padding="0"
              alignSelf="center"
              margin="0"
              onClick={onWithdrawOpen}
              isDisabled={guardedPosition.symbol == "N/A" ? true : false}
            >
              Withdraw
            </Button>
          </HStack>
        </HStack>
      </Card>

      <Modal
        isOpen={isDepositOpen}
        onClose={onDepositClose}
        isCentered
        size="xl"
        closeOnOverlayClick={true}
      >
        <ModalOverlay />
        <NeuroDepositModal isOpen={isDepositOpen} onClose={onDepositClose} asset={asset} position_id={guardedPosition.position.position_id} />

      </Modal>
      <Modal
        isOpen={isWithdrawOpen}
        onClose={onWithdrawClose}
        isCentered
        size="xl"
        closeOnOverlayClick={true}
      >
        <ModalOverlay />
        <NeuroWithdrawModal isOpen={isWithdrawOpen} onClose={onWithdrawClose} asset={asset} guardedPosition={guardedPosition} prices={prices} />

      </Modal>

    </>
  )
})

// Extracted RBLPExistingEntry component
// const RBLPExistingEntry = React.memo(({
//   rblpDeposit,
//   RBYield,
//   cdtMarketPrice,
//   address
// }: {
//   rblpDeposit: number
//   RBYield: string
//   cdtMarketPrice: string
//   address: string
// }) => {

//   const neuroStateAssets = useNeuroState(state => state.neuroState.assets);
//   const { appState } = useAppState();
//   //find the asset in the assets array
//   //@ts-ignore
//   const asset = neuroStateAssets.find((asset) => asset.base === denoms.CDT[0]) || { logo: "/images/cdt.svg", symbol: "CDT", balance: 0 }
//   // // console.log("cdtAsset", asset, neuroState.assets)

//   //We need the cookie to be set even if these render before the user has checked the cookie box
//   const [initialDepositAmount, setInitialDepositAmount] = useState(0);
//   useEffect(() => {
//     const cookieKey = "rblp " + address;
//     let cookie = getCookie(cookieKey);
//     // console.log("rblp cookie", cookie)

//     if (cookie == null && appState.setCookie) {
//       // console.log("setting RBLP cookie", cookie)
//       setCookie(cookieKey, rblpDeposit.toString(), 3650);
//       cookie = rblpDeposit.toString();
//     }

//     setInitialDepositAmount(Number(cookie || 0));
//   }, [appState.setCookie, rblpDeposit]);

//   // // console.log("initialDepositAmount", initialDepositAmount)


//   const { isOpen: isDepositOpen, onOpen: onDepositOpen, onClose: onDepositClose } = useDisclosure()
//   const { isOpen: isWithdrawOpen, onOpen: onWithdrawOpen, onClose: onWithdrawClose } = useDisclosure()


//   {/* @ts-ignore */ }
//   const isDisabled = (asset?.symbol === "N/A") || false
//   // // console.log("isDisabled", isDisabled, asset?.balance, asset)
//   const yieldValue = num(RBYield).times(100).toFixed(1)



//   return (
//     <>
//       <Card width="fit-content" alignSelf="center" marginBottom="5%" borderWidth={3} padding={4}>
//         <HStack>
//           <Image src={"/images/cdt.svg"} w="45px" h="45px" />
//           <Text width="fit-content" justifyContent="left" variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
//             {rblpDeposit.toFixed(2)}&nbsp;CDT earning&nbsp;
//             {yieldValue}% APR
//             {/* {initialDepositAmount == 0 ? "0.00" : Math.max(0, num(rblpDeposit).dividedBy(initialDepositAmount).minus(1).times(100).toNumber()).toFixed(2)}%&nbsp; */}
//             {/* historical profits */}
//           </Text>
//           <HStack width="55%">
//             {/* @ts-ignore */}
//             <Button
//               width="100%"
//               display="flex"
//               padding="0"
//               alignSelf="center"
//               margin="0"
//               onClick={onDepositOpen}
//               //@ts-ignore
//               isDisabled={isDisabled || (asset?.balance ?? 0) === 0}
//             >
//               Deposit
//             </Button>

//             <Button
//               width="100%"
//               display="flex"
//               padding="0"
//               alignSelf="center"
//               margin="0"
//               onClick={onWithdrawOpen}
//               isDisabled={isDisabled || rblpDeposit === 0}
//             >
//               Withdraw
//             </Button>
//           </HStack>
//         </HStack>
//       </Card>

//       <Modal
//         isOpen={isDepositOpen}
//         onClose={onDepositClose}
//         isCentered
//         size="xl"
//         closeOnOverlayClick={true}
//       >
//         <ModalOverlay />
//         {/* @ts-ignore */}
//         <RBLPDepositModal isOpen={isDepositOpen} onClose={onDepositClose} cdtAsset={asset} />

//       </Modal>
//       <Modal
//         isOpen={isWithdrawOpen}
//         onClose={onWithdrawClose}
//         isCentered
//         size="xl"
//         closeOnOverlayClick={true}
//       >
//         <ModalOverlay />
//         <RBLPWithdrawModal isOpen={isWithdrawOpen} onClose={onWithdrawClose} cdtMarketPrice={cdtMarketPrice} rblpDeposit={rblpDeposit} />

//       </Modal>

//     </>
//   )
// })


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


  const { isOpen, onOpen, onClose } = useDisclosure()


  return (
    <>
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
              href={'/borrow'}
              display="flex"
              padding="0"
              alignSelf="center"
              margin="0"
              isDisabled={false}
              onClick={() => { setMintState({ positionNumber }) }}
            >
              {positionNumber == 0 ? "Create" : "Edit"}
            </Button>
            <Button
              width="50%"
              display="flex"
              padding="0"
              alignSelf="center"
              margin="0"
              onClick={onOpen}
              isDisabled={positionNumber == 0 ? true : false}
            >
              Close
            </Button>
          </HStack>
        </HStack>
      </Card>
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


// Extracted RBLPExistingEntry component
const AcquireCDTEntry = React.memo(({
  usdcBalance,
  RBYield,
  rblpDeposit,
  address
}: {
  usdcBalance: number
  RBYield: string
  rblpDeposit: number
  address: string
}) => {

  // const { isOpen: isSwapOpen, onOpen: onSwapOpen, onClose: onSwapClose } = useDisclosure()
  // const { isOpen: isMintOpen, onOpen: onMintOpen, onClose: onMintClose } = useDisclosure()


  {/* @ts-ignore */ }
  const [inputValue, setInputValue] = useState<number | undefined>(1000); // Tracks user input
  const yieldValue = num(RBYield).times(100).toFixed(1)
  // const usdcMintAPR = num(RBYield).minus(usdcCost).times(0.89).times(100).toFixed(1)
  // const isMintDisabled = usdcBalance < 24
  // // console.log("log usdc balance", shiftDigits(usdcBalance, -6).toNumber())



  const [txType, setTxType] = useState("deposit");
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const { action: swap, tokenOutMinAmount } = useSwapToCDT({ onSuccess: () => { }, run: txType === "deposit" })
  const { action: rblp } = useBoundedLP({ onSuccess: () => { }, run: txType != "deposit" })
  // const isLoading = swap?.simulate.isLoading || swap?.tx.isPending || rblp?.simulate.isLoading || rblp?.tx.isPending
  const isSwapDisabled = usdcBalance === 0
  const isRBLPDisabled = inputValue === 0
  // console.log("isDisabled", usdcBalance === 0, swap?.simulate.error?.message, !swap?.simulate.data, rblp?.simulate.error?.message, !rblp?.simulate.data)
  useEffect(() => {
    setTxType("deposit")
  }, [address])


  //@ts-ignore
  const maxDepositAmount = usdcBalance
  const maxWithdrawAmount = rblpDeposit
  const maxAmount = txType === "deposit" ? maxDepositAmount : maxWithdrawAmount
  const updateTimeout = useRef<NodeJS.Timeout | null>(null);


  // console.log("maxDepositAmount", maxDepositAmount, "rb WithdrawAmount", quickActionState.rangeBoundLPwithdrawal, "maxAmount", maxAmount)
  const onMaxClick = () => {
    setInputValue(Number(maxAmount.toFixed(2)))
    if (txType === "deposit") {
      setQuickActionState({
        usdcSwapToCDT: maxAmount
      })
    }
    else {
      setQuickActionState({
        rangeBoundLPwithdrawal: maxAmount
      })
    }
  }

  const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    const value = Number(e.target.value)

    setInputValue(num(value).isGreaterThan(Number(maxAmount.toFixed(2))) ? Number(maxAmount.toFixed(2)) : value); // Updates the input value immediately


    if (updateTimeout.current) {
      clearTimeout(updateTimeout.current); // Clears previous timeout
    }

    updateTimeout.current = setTimeout(() => {
      if (txType === "deposit") {
        setQuickActionState({
          usdcSwapToCDT: num(value).isGreaterThan(maxAmount) ? maxAmount : value
        });
      }
      else {
        setQuickActionState({
          rangeBoundLPwithdrawal: num(value).isGreaterThan(maxAmount) ? maxAmount : value
        });
      }
    }, INPUT_DELAY); // Delay before updating the state

  }, [quickActionState?.usdcSwapToCDT, setQuickActionState, maxAmount])


  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const handleTabClick = (index: string) => {
    setActiveTabIndex(index === "deposit" ? 0 : 1);
    setTxType(index);
    setInputValue(0);
    setQuickActionState({
      usdcSwapToCDT: 0,
      rangeBoundLPwithdrawal: 0
    });
  };

  const dailyYield = num(yieldValue).dividedBy(100).times(txType === "deposit" ? (inputValue ?? 0) : (rblpDeposit + (inputValue ?? 0))).dividedBy(365).toNumber()
  const yearlyYield = num(yieldValue).dividedBy(100).times(txType === "deposit" ? (inputValue ?? 0) : rblpDeposit + (inputValue ?? 0)).toNumber()

  return (
    <>
      <HStack justifyContent={"center"} gap="1.5rem">
        <Card width="fit-content" alignSelf="center" borderWidth={3} padding={4} bg="rgb(90, 90, 90, 0.4)" borderColor="rgba(255, 255, 255, 0.16)">
          <Stack gap="1.5rem">
            <Image src={"/images/cdt.svg"} w="65px" h="65px" alignSelf={"center"} />

            <Text width="fitcontent" justifyContent="center" variant="title" textAlign="center" fontSize="1.7rem" letterSpacing="1px" display="flex">
              Earn &nbsp;<a className="textShadow">{yieldValue}%</a>&nbsp; with CDT
            </Text>
            <List spacing={3} styleType="disc" padding="6" paddingTop="0">
              <ListItem fontFamily="Inter" fontSize="md">Sourced from revenue & LP profits. All in stablecoins.</ListItem>
              <ListItem fontFamily="Inter" fontSize="md"> 100% liquid. No lock-in or withdrawal penalty.</ListItem>
              <ListItem fontFamily="Inter" fontSize="md"> Earn MBRN for every $1 in yield you earn.</ListItem>
            </List>
          </Stack>


        </Card>
        <Card width="50%" maxW="640px" p={4} borderWidth="3px" borderColor="white">
          {/* <CardHeader>
            <Text variant="title" textTransform="capitalize" letterSpacing="1px">Buy</Text>
          </CardHeader> */}
          <CardBody>
            <Stack>
              {rblpDeposit !== 0 && <Tabs position="relative" variant="unstyled" align="center" w="full" index={activeTabIndex}>
                <TabList bg="white" borderRadius="28px" color="black" w="fit-content">
                  <CustomTab onClick={() => handleTabClick("deposit")} label="Deposit" />
                  <CustomTab onClick={() => handleTabClick("withdraw")} label="Withdraw" />
                </TabList>

                <TabIndicator
                  top="0"
                  position="absolute"
                  height="40px"
                  bg={"rgb(121, 144, 254, 0.7)"}
                  borderRadius="28px"
                />
              </Tabs>}
              <HStack width="100%" justifyContent="left">
                <HStack width="75%">
                  {txType === "deposit" ? <>
                    <Image src={"https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/usdc.svg"} w="50px" h="50px" />
                    <Text variant="title" textAlign="center" fontSize="2rem" letterSpacing="1px" display="flex">
                      USDC
                    </Text>
                  </>
                    : <>
                      <Image src={"/images/cdt.svg"} w="50px" h="50px" />
                      <Text variant="title" textAlign="center" fontSize="2rem" letterSpacing="1px" display="flex">
                        CDT
                      </Text>
                    </>
                  }
                </HStack>
              </HStack>
              <Input
                width={"100%"}
                textAlign={"right"}
                placeholder="0"
                type="number"
                variant={"ghost"}
                value={inputValue}
                max={maxAmount}
                onChange={onInputChange}
              />
              <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                <Button onClick={onMaxClick} width="20%" variant="unstyled" fontWeight="normal">
                  <Text justifySelf="end" variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                    max
                  </Text>
                </Button>
              </HStack>

              <Text variant="body" textTransform="none" fontSize="md" letterSpacing="1px" display="flex">
                {txType === "deposit" ? tokenOutMinAmount ? `Minimum CDT: ${shiftDigits(tokenOutMinAmount, -6).toFixed(2)}` : "Minimum CDT: N/A"
                  : "Current Deposit: " + rblpDeposit.toFixed(2) + " CDT"}
              </Text>
            </Stack>
          </CardBody>
          <CardFooter as={Stack} justifyContent="end" borderTop="1px solid" borderColor="whiteAlpha.200" pt="5" gap="5">
            {/* <Text variant="title" textAlign="center" fontSize="sm" letterSpacing="1px" width="100%">
              {parseError(num(quickActionState?.usdcSwapToCDT).isGreaterThan(0) && txType === "deposit" && swap.simulate.isError ? swap.simulate.error?.message ?? "" : "")}
              {parseError((quickActionState?.rangeBoundLPwithdrawal > 0 || quickActionState?.rangeBoundLPdeposit > 0) && txType != "deposit" && rblp.simulate.isError ? rblp.simulate.error?.message ?? "" : "")}
            </Text> */}
            <HStack justify="space-between" width="100%">
              <Stack align="center">
                <Text fontSize="xl" fontWeight="bold">{yieldValue}%</Text>
                <Text fontSize="sm" color="white">Estimated APY</Text>
              </Stack>
              <Stack align="center">
                <Text fontSize="xl" fontWeight="bold">{dailyYield > 0 && dailyYield.toFixed(2) === "0.00" ? "< $0.01" : `$${dailyYield.toFixed(2)}`}</Text>
                <Text fontSize="sm" color="white">Est. Per Day</Text>
              </Stack>
              <Stack align="center">
                <Text fontSize="xl" fontWeight="bold">{yearlyYield > 0 && yearlyYield.toFixed(2) === "0.00" ? "< $0.01" : `$${yearlyYield.toFixed(2)}`}</Text>
                <Text fontSize="sm" color="white">Est. Per Year</Text>
              </Stack>
            </HStack>

            <HStack mt="0" gap="0">
              <ConfirmModal
                label={txType === "deposit" ? "Buy & Deposit Now" : "Withdraw & Lose Yield"}
                action={txType === "deposit" ? swap : rblp}
                isDisabled={txType === "deposit" ? isSwapDisabled : isRBLPDisabled}
              >
                <HomeSummary tokenOutMinAmount={tokenOutMinAmount} />
              </ConfirmModal>
            </HStack>
            {/* <TxButton
              w="100%"
              isLoading={isLoading}
              isDisabled={txType === "deposit" ? isSwapDisabled : isRBLPDisabled}
              onClick={() => { txType === "deposit" ? swap?.tx.mutate() : rblp?.tx.mutate() }}
              toggleConnectLabel={false}
              style={{ alignSelf: "center" }}
            >
              
            </TxButton> */}
          </CardFooter>
        </Card>
      </HStack >

      {/* <Modal
        isOpen={isSwapOpen}
        onClose={onSwapClose}
        isCentered
        size="xl"
        closeOnOverlayClick={true}
      >
        <ModalOverlay />
        <USDCSwapToCDTModal isOpen={isSwapOpen} onClose={onSwapClose} usdcBalance={usdcBalance} />

      </Modal> */}
      {/* <Modal
        isOpen={isMintOpen}
        onClose={onMintClose}
        isCentered
        size="xl"
        closeOnOverlayClick={true}
      >
        <ModalOverlay />
        <USDCMintModal isOpen={isMintOpen} onClose={onMintClose} usdcBalance={usdcBalance} usdcPrice={Number(usdcPrice)} expectedAPR={Number(usdcMintAPR)} />

      </Modal> */}

    </>
  )
})

// Memoize child components
const MemoizedNeuroGuardOpenEntry = memo(NeuroGuardOpenEntry);
const MemoizedNeuroGuardExistingEntry = memo(NeuroGuardExistingEntry);
const MemoizedVaultEntry = memo(VaultEntry);
// const MemoizedRBLPDepositEntry = memo(RBLPDepositEntry);
// const MemoizedAcquireCDTEntry = memo(AcquireCDTEntry);
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

  // const { data: clRewardList } = getBestCLRange()
  console.time("NG")
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()

  console.log("finsihed basketPositions")
  // // console.log("basketPositions", basketPositions)
  const { data: basket } = useBasket()
  console.log("finsihed basket")
  // // console.log("basketPositions", basketPositions)
  const { data: TVL } = useBoundedTVL()
  console.log("finsihed boundedTVL")
  const { data: userIntents } = useUserBoundedIntents()
  console.log("finsihed userIntents")
  const { setNeuroState } = useNeuroState()

  const neuroStateAssets = useNeuroState(state => state.neuroState.assets);
  // useEstimatedAnnualInterest(false)
  const { data: walletBalances } = useBalance()
  console.log("finsihed useBalance")
  const assets = useCollateralAssets()
  console.log("finsihed CollaterarlAssets")
  const { data: prices } = useOraclePrice()
  console.log("finsihed prices")
  // const { data: clRewardList } = getBestCLRange()
  const { data: interest } = useCollateralInterest()
  console.log("finsihed CollateralInterest")
  const { data: basketAssets } = useBasketAssets()
  console.log("finsihed basketASsets")
  const { action: polishIntents } = useNeuroIntentPolish()
  console.log("finsihed polish action")

  const cdtAsset = useAssetBySymbol('CDT')
  // const cdtBalance = useBalanceByAsset(cdtAsset) ?? "0"
  const usdcAsset = useAssetBySymbol('USDC')
  const usdcBalance = useBalanceByAsset(usdcAsset) ?? "0"
  const toaster = useToaster();

  const boundCDTAsset = useAssetBySymbol('range-bound-CDT')
  const boundCDTBalance = useBalanceByAsset(boundCDTAsset) ?? "1"
  const { data: underlyingData } = useBoundedCDTVaultTokenUnderlying(
    num(shiftDigits(boundCDTBalance, 6)).toFixed(0)
  )
  console.log("finsihed asset shit")


  console.timeEnd("NG")


  // Determine if any of these are still loading
  const areQueriesLoading = [
    basketPositions,
    basket,
    TVL,
    userIntents,
    walletBalances,
    prices,
    interest,
    basketAssets,
    cdtAsset,
    usdcAsset,
    boundCDTAsset,
    boundCDTBalance,
    underlyingData
  ].some(data => data === undefined || data === null);

  const [hasShownToast, setHasShownToast] = useState(false);


  const isDisabled = polishIntents?.simulate.isError || !polishIntents?.simulate.data
  const isLoading = polishIntents?.simulate.isLoading || polishIntents?.tx.isPending

  // Memoize the toggle handler to prevent recreating on each render
  const onClick = useCallback(() => {
    polishIntents?.tx.mutate()
  }, [polishIntents?.tx]);

  //Toast if a msg is ever ready to rock
  useEffect(() => {

    // console.log("isDisabled polish", isDisabled, isLoading)

    if (!hasShownToast && !isDisabled && !isLoading) {
      toaster.message({
        title: 'Execute to Claim Yield Dust & Re-Activate Intents',
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
        title: 'Execute to Claim Yield Dust & Re-Activate Intents',
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

    // console.log(" calculatedRBYield")
    if (!basket || !interest || !TVL) return "0";
    return simpleBoundedAPRCalc(shiftDigits(basket.credit_asset.amount, -6).toNumber(), interest, TVL, 0);
  }, [basket, interest, TVL]);
  // // console.log(calculatedRBYield, basket, interest, TVL)

  ////
  const underlyingCDT = useMemo(() =>
    shiftDigits(underlyingData, -6).toString() ?? "0"
    , [underlyingData])
  ////


  const cdtMarketPrice = prices?.find((price) => price.denom === denoms.CDT[0])?.price || basket?.credit_price.price || "1"
  // const usdcPrice = useMemo(() => {
  //   // console.log(" usdcPrice")
  //   return prices?.find((price) => price.denom === denoms.USDC[0])?.price ?? "1"
  // }, [prices])

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
  useMemo(() => {

    // console.log(" sortedAssets")
    if (sortedAssets && sortedAssets.length > 0) {
      setNeuroState({
        //@ts-ignore
        assets: sortedAssets ?? []
        // openSelectedAsset: sortedAssets[0] ?? {}
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
    // console.log(" existingGuards")
    // // console.log("userIntents close", userIntents, basket, prices, basketPositions, assets)
    if (userIntents && userIntents[0] && userIntents[0].intent.intents.purchase_intents && basket && prices && basketPositions && assets && basketAssets) {
      // // console.log(" in guards")
      //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
      // const neuroGuardIntents = userIntents[0].intent.intents.purchase_intents.filter((intent) => {
      //   return intent.position_id !== undefined
      // })

      //If there are neuroGuardIntents, create an object that saves the ID, the compounding asset & the LTV
      return neuroGuardIntents.map((intent) => {
        // // console.log("big checkers", neuroGuardIntents, intent, basketPositions)
        let position = basketPositions[0].positions.find((position) => position.position_id === (intent.position_id ?? 0).toString())
        // // console.log("position", basketPositions[0].positions[0].position_id,(intent.position_id??0).toString(), basketPositions[0].positions[0].position_id === (intent.position_id??0).toString())
        // // console.log("position", position)
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


        // // console.log("basketAssets", basketAssets.find((basketAsset) => basketAsset?.asset?.base === asset.asset.info.native_token.denom)?.interestRate , asset.asset.info.native_token.denom, basketAssets)
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

    }
    else return []
  }, [basketPositions, userIntents, assets, prices, basket, underlyingCDT, basketAssets])
  // // console.log("existingGuards", existingGuards)


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
  // // console.log("nonNeuroGuardPositions", nonNeuroGuardPositions, basketPositions, neuroGuardIntents)


  // Separate complex sections into components
  const WalletSection = memo(({ assets, existingGuards, RBYield, basketAssets }: { assets: any[], existingGuards: any[], RBYield: string, basketAssets: BasketAsset[] }) => {
    const [showAllYields, setShowAllYields] = useState(false);

    const usableAssets = useMemo(() => assets
      .filter(asset =>
        asset &&
        num(asset.combinUsdValue).isGreaterThan(0.01) &&
        !existingGuards?.some(guard => guard?.symbol === asset.symbol) &&
        asset.base !== denoms.CDT[0] // Exclude assets with base equal to CDT
        && (asset.symbol != "CDT" || asset.symbol != "marsUSDC" || asset.symbol != "OSMO/USDC.axl LP" || asset.symbol != "ATOM/OSMO LP" || asset.symbol != "USDC")
      ), [assets, existingGuards]);

    // console.log("usableAssets", usableAssets)


    return (
      <Stack>
        <Text width="35%" variant="title" textTransform={"capitalize"} fontFamily="Inter" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
          Your Wallet -&nbsp;
          <a onClick={toggleExpanded} style={{ color: colors.tabBG, textDecoration: "underline", cursor: "pointer" }}>FAQ</a>
        </Text>

        <FAQModal isOpen={isExpanded} onClose={toggleExpanded}>
        </FAQModal>
        <Checkbox
          checked={showAllYields}
          onChange={() => { setShowAllYields(!showAllYields) }}
          fontFamily="Inter"
          fontSize={"9px"}
        >
          Show All Yields
        </Checkbox>
        {usableAssets && usableAssets.length != 0 &&
          <HStack gap="1%" p={4}>
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
          </HStack>}
        <Stack gap={"1rem"}>{showAllYields ?

          basketAssets.map((basketAsset) => {
            if (!basketAsset || basketAsset.asset?.symbol === "marsUSDC" || basketAsset.asset?.symbol === "OSMO/USDC.axl LP" || basketAsset.asset?.symbol === "ATOM/OSMO LP" || basketAsset.asset?.symbol === "USDC") {
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
                  // @ts-ignore
                  balance: 0,
                  combinUsdValue: num(basketAsset.interestRate).toNumber(),
                }}
                RBYield={RBYield}
                basketAssets={basketAssets}
              />
            );
          })

          : <Stack>
            {/* Wallet Assets */}
            {usableAssets.map((asset) => {
              if (!asset) {
                return null;
              }
              // // console.log("wallet asset symbol", asset.symbol)
              return (
                <MemoizedNeuroGuardOpenEntry
                  key={asset.symbol}
                  asset={asset}
                  basketAssets={basketAssets}
                  RBYield={RBYield}
                />
              )
            })}
          </Stack>

        }</Stack>
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


  // const sectionRef = useRef<HTMLDivElement>(null);

  // const scrollToSection = () => {
  //   sectionRef.current?.scrollIntoView({ behavior: "smooth" });
  // };


  const [isExpanded, setIsExpanded] = useState(false)
  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])


  // Prevent rendering until all required data is ready
  if (areQueriesLoading) {
    return <Image src={"/images/cdt.svg"} w="65px" h="65px" alignSelf={"center"} />; // Replace with your actual loading component
  }

  return (
    <Stack gap={1} marginBottom="3%">
      {/* This handles all deposits and withdrawals into the Rangebound LP */}
      <AcquireCDTEntry usdcBalance={Number(usdcBalance)} RBYield={calculatedRBYield} rblpDeposit={Number(underlyingCDT)} address={address ?? ""} />

      <Divider mt="5%" />

      <h1
        className={"home-title"}
        style={{ marginTop: "2%" }}
      >
        Market Making Dashboard
      </h1>
      <HStack w={"100%"} justifyContent={"center"} marginBottom={"4%"}>
        <Text>
          Earning fees and revenue by providing liquidity to the <a href="https://app.osmosis.zone/pool/1268" style={{ textDecoration: "underline", fontWeight: "bold" }}> CDT/USDC LP</a>
        </Text>

      </HStack>
      <HStack alignItems="none" flexWrap={"wrap"} height={"600px"} justifyContent="center" marginBottom={"5%"} gap="3">
        <RangeBoundVisual />
        {/* <Stack width={"32%"} justifyContent={(Number(cdtMarketPrice) < 0.985 && Number(minimumSwapCapacity) > 22) ? "center" : "none"} gap="1.5rem">
          <RangeBoundInfoCard RBYield={calculatedRBYield} TVL={num(TVL).times(cdtMarketPrice).toFixed(2) ?? "0"} scrollFn={scrollToSection} />
          {Number(cdtMarketPrice) < 0.985 && Number(minimumSwapCapacity) > 22 && <ManicRedemptionCard basket={basket} cdtMarketPrice={Number(cdtMarketPrice)} />}
        </Stack> */}
        {/* Add Button in the middle of the remaining space that allows users to swap any stables to CDT */}
      </HStack>

      {/* If there are wallet assets & at least one of the assets has a balance that isn't also in an existing Guardian */}
      {/* {neuroState.assets.length > 0 && neuroState.assets.some(asset =>
        asset && // check if defined
        Number(asset.combinUsdValue) > 0.01 && // check USD value
        !existingGuards?.some(guard => guard?.symbol === asset.symbol) // check not in existing guards
      ) ? */}
      <WalletSection assets={neuroStateAssets} existingGuards={existingGuards} RBYield={calculatedRBYield} basketAssets={basketAssets ?? []} />
      {/* : null} */}

      {(existingGuards && existingGuards.length > 0 && existingGuards[0]) ?
        <Stack>
          <Text marginTop="3%" width="35%" variant="title" textTransform={"capitalize"} fontFamily="Inter" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
            Your Yielding Positions
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
            //@ts-ignore
            <>{guard && guard.symbol != "CDT" && (guard.symbol == "N/A" ? Number(boundCDTBalance) === 0 : true) ? <MemoizedNeuroGuardExistingEntry guardedPosition={guard} RBYield={calculatedRBYield} prices={prices} /> : null}</>
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
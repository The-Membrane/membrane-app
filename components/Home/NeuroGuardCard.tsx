import React, { useEffect, useMemo, useState, useCallback, memo, useRef, ChangeEvent, use } from "react"
import { Card, Text, Stack, HStack, Button, Image, Modal, ModalOverlay, Checkbox, useDisclosure, List, ListItem, Input, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, CardHeader, CardBody, CardFooter, TabIndicator, TabList, Tabs, Switch, FormControl, FormLabel } from "@chakra-ui/react"
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
import { useBestCLRange } from "@/services/osmosis"
import { FAQModal } from "./HomeTitle"
import useSwapToCDT from "./hooks/useUSDCSwapToCDT"
import { parseError } from "@/helpers/parseError"
import { useChainRoute } from "@/hooks/useChainRoute"
import { TxButton } from "../TxButton"
import { CustomTab } from "../Mint/AssetWithInput"
import { set } from "react-hook-form"
import useBoundedLP from "./hooks/useRangeBoundLP"
import ConfirmModal from "../ConfirmModal"
import { HomeSummary } from "./HomeSummary"
import useNeuroGuardData from "./hooks/useNeuroGuardData"
import { MemoizedNeuroGuardExistingEntry } from "./NeuroGuardParts/NeuroGuardExistingEntry"
import { CDPsSection } from "./NeuroGuardParts/CDPsSection"
// AcquireCDTEntry and VaultEntry/MemoizedVaultEntry are extracted under ./NeuroGuardParts/ too;
// only the pieces rendered here (MemoizedNeuroGuardExistingEntry, CDPsSection) are imported.
// import AnimatedBorderImage from "./AnimatedBorder"

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
const NeuroGuardOpenEntry = React.memo(function NeuroGuardOpenEntry({
  asset,
  RBYield,
  basketAssets
}: {
  asset: AssetWithBalance
  RBYield: string
  basketAssets: BasketAsset[]
}) {
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

// NeuroGuardExistingEntry extracted to ./NeuroGuardParts/NeuroGuardExistingEntry
// (rendered here via MemoizedNeuroGuardExistingEntry, imported at the top).

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
//   const asset = neuroStateAssets.find((asset) => asset.base === denoms.CDT[0]) || { logo: "/images/cdt.png", symbol: "CDT", balance: 0 }
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
//           <Image src={"/images/cdt.png"} w="45px" h="45px" />
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


// VaultEntry extracted to ./NeuroGuardParts/VaultEntry
// (rendered inside the extracted CDPsSection via MemoizedVaultEntry).


// AcquireCDTEntry extracted to ./NeuroGuardParts/AcquireCDTEntry
// (currently not rendered anywhere in this file; import it from there if re-enabled).

// Memoize child components
const MemoizedNeuroGuardOpenEntry = memo(NeuroGuardOpenEntry);
// MemoizedNeuroGuardExistingEntry now lives in ./NeuroGuardParts/NeuroGuardExistingEntry
// MemoizedVaultEntry now lives in ./NeuroGuardParts/VaultEntry
// const MemoizedRBLPDepositEntry = memo(RBLPDepositEntry);
// const MemoizedRBLPExistingEntry = memo(RBLPExistingEntry);


// CDPsSection extracted to ./NeuroGuardParts/CDPsSection (imported at the top).
// It stays hoisted out of NeuroGuardCard's body so it keeps a stable component
// identity across parent renders; everything it needs is threaded via props.


const NeuroGuardCard = () => {
  console.log("NG render")

  const {
    existingGuards,
    boundCDTBalance,
    calculatedRBYield,
    prices,
    nonNeuroGuardPositions,
    cdtMarketPrice,
  } = useNeuroGuardData()


  // Separate complex sections into components
  // const WalletSection = memo(({ assets, existingGuards, RBYield, basketAssets }: { assets: any[], existingGuards: any[], RBYield: string, basketAssets: BasketAsset[] }) => {
  //   const [showAllYields, setShowAllYields] = useState(false);

  //   const usableAssets = useMemo(() => assets
  //     .filter(asset =>
  //       asset &&
  //       num(asset.combinUsdValue).isGreaterThan(0.01) &&
  //       !existingGuards?.some(guard => guard?.symbol === asset.symbol) &&
  //       asset.base !== denoms.CDT[0] // Exclude assets with base equal to CDT
  //       && (asset.symbol != "CDT" || asset.symbol != "marsUSDC" || asset.symbol != "OSMO/USDC.axl LP" || asset.symbol != "ATOM/OSMO LP" || asset.symbol != "USDC")
  //     ), [assets, existingGuards]);

  //   console.log("wallet rerendered", assets, existingGuards, RBYield, basketAssets)


  //   return (
  //     <Stack>
  //       <Text width="35%" variant="title" textTransform={"capitalize"} fontFamily="var(--font-inter)" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
  //         Your Wallet -&nbsp;
  //         <a onClick={toggleExpanded} style={{ color: colors.tabBG, textDecoration: "underline", cursor: "pointer" }}>FAQ</a>
  //       </Text>

  //       <FAQModal isOpen={isExpanded} onClose={toggleExpanded}>
  //       </FAQModal>
  //       <Checkbox
  //         checked={showAllYields}
  //         onChange={() => { setShowAllYields(!showAllYields) }}
  //         fontFamily="var(--font-inter)"
  //         fontSize={"9px"}
  //       >
  //         Show All Yields
  //       </Checkbox>
  //       {usableAssets && usableAssets.length != 0 &&
  //         <HStack gap="1%" p={4}>
  //           <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
  //             Asset
  //           </Text>
  //           <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
  //             Balance
  //           </Text>
  //           <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
  //             Potential APR
  //           </Text>
  //           <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
  //             Actions
  //           </Text>
  //         </HStack>}
  //       <Stack gap={"1rem"}>{showAllYields ?

  //         basketAssets.map((basketAsset) => {
  //           if (!basketAsset || basketAsset.asset?.symbol === "marsUSDC" || basketAsset.asset?.symbol === "OSMO/USDC.axl LP" || basketAsset.asset?.symbol === "ATOM/OSMO LP" || basketAsset.asset?.symbol === "USDC") {
  //             return null;
  //           }

  //           return (
  //             <MemoizedNeuroGuardOpenEntry
  //               key={basketAsset.asset?.symbol ?? basketAsset.asset?.base}
  //               asset={{
  //                 base: basketAsset.asset?.base,
  //                 symbol: basketAsset.asset?.symbol ?? "",
  //                 logo: basketAsset.asset?.logo ?? "",
  //                 maxBorrowLTV: basketAsset.maxBorrowLTV,
  //                 // @ts-ignore
  //                 balance: 0,
  //                 combinUsdValue: num(basketAsset.interestRate).toNumber(),
  //               }}
  //               RBYield={RBYield}
  //               basketAssets={basketAssets}
  //             />
  //           );
  //         })

  //         : <Stack>
  //           {/* Wallet Assets */}
  //           {usableAssets.map((asset) => {
  //             if (!asset) {
  //               return null;
  //             }
  //             // // console.log("wallet asset symbol", asset.symbol)
  //             return (
  //               <MemoizedNeuroGuardOpenEntry
  //                 key={asset.symbol}
  //                 asset={asset}
  //                 basketAssets={basketAssets}
  //                 RBYield={RBYield}
  //               />
  //             )
  //           })}
  //         </Stack>

  //       }</Stack>
  //     </Stack>
  //   );
  // });

  // const sectionRef = useRef<HTMLDivElement>(null);

  // const scrollToSection = () => {
  //   sectionRef.current?.scrollIntoView({ behavior: "smooth" });
  // };


  // react-doctor(rerender-state-only-in-handlers) FP: controls the FAQ modal's isOpen in the commented-out block (~L874/877). Keep useState so re-enabling opens/closes it; useRef would break it.
  const [isExpanded, setIsExpanded] = useState(false)
  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev)
  }, [])


  // Prevent rendering until all required data is ready
  // if (areQueriesLoading) {
  //   return <AnimatedBorderImage />;
  // }

  return (
    <Stack gap={1} marginBottom="3%">
      <Divider mt="5%" />

      <h1
        className={"home-title"}
        style={{ marginTop: "2%" }}
      >
        Yield Vault Dashboard
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
      {/* <WalletSection assets={neuroStateAssets} existingGuards={existingGuards} RBYield={calculatedRBYield} basketAssets={basketAssets ?? []} /> */}
      {/* : null} */}

      {(existingGuards && existingGuards.length > 0 && existingGuards[0]) ?
        <Stack>
          <Text marginTop="3%" width="35%" variant="title" textTransform={"capitalize"} fontFamily="var(--font-inter)" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
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
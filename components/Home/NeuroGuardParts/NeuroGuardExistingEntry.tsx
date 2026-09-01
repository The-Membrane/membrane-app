import React, { useEffect, useState, memo } from "react"
import { Card, Text, HStack, Button, Image, Modal, ModalOverlay, useDisclosure } from "@chakra-ui/react"
import { num } from "@/helpers/num"
import { PositionResponse } from "@/contracts/codegen/positions/Positions.types"
import BigNumber from "bignumber.js"
import { getCookie, setCookie } from "@/helpers/cookies"
import useNeuroState from "../hooks/useNeuroState"
import useAppState from "../../../persisted-state/useAppState"
import { NeuroDepositModal, NeuroWithdrawModal } from "../NeuroModals"

// Extracted NeuroGuardExistingEntry component
const NeuroGuardExistingEntry = React.memo(function NeuroGuardExistingEntry({
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
}) {
  const neuroStateAssets = useNeuroState(state => state.neuroState.assets);
  const { appState } = useAppState();

  //find the asset in the assets array
  //@ts-ignore
  const asset = guardedPosition.symbol === "N/A" ? undefined : neuroStateAssets.find((asset) => asset.base === guardedPosition.position.collateral_assets[0].asset.info.native_token.denom)
  // // console.log("FOUND IT", asset, neuroState.assets, guardedPosition.position.collateral_assets[0].asset.info.native_token.denom)

  //We need the cookie to be set even if these render before the user has checked the cookie box
  const [initialDepositAmount, setInitialDepositAmount] = useState(0);
  // react-doctor(no-adjust-state-on-prop-change) FP: external-store sync, not prop-mirroring — hydrates from a per-position cookie and lazily writes it on first mount. Can't derive during render (the cookie write is a side effect). Keep as an effect.
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
  }, [appState.setCookie, guardedPosition.amount, guardedPosition.position.position_id]);

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

// Memoize child component (preserved from NeuroGuardCard.tsx)
export const MemoizedNeuroGuardExistingEntry = memo(NeuroGuardExistingEntry);

export default NeuroGuardExistingEntry

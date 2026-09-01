import React, { useMemo, memo } from "react"
import { Card, Text, HStack, Button, Modal, ModalOverlay, useDisclosure } from "@chakra-ui/react"
import { num } from "@/helpers/num"
import { PositionResponse } from "@/contracts/codegen/positions/Positions.types"
import NextLink from 'next/link'
import useMintState from "../../Mint/hooks/useMintState"
import useVaultSummary from "../../Mint/hooks/useVaultSummary"
import { NeuroCloseModal } from "../NeuroModals"

// Extracted VaultEntry component
const VaultEntry = React.memo(function VaultEntry({
  cdp,
  positionNumber,
  cdtMarketPrice
}: {
  cdp: PositionResponse;
  positionNumber: number
  cdtMarketPrice: string
}) {
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

// Memoize child component (preserved from NeuroGuardCard.tsx)
export const MemoizedVaultEntry = memo(VaultEntry);

export default VaultEntry

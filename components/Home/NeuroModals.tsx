import React, { ChangeEvent, PropsWithChildren, useCallback } from "react"
import useNeuroState from "./hooks/useNeuroState"
import useNeuroGuard from "./hooks/useNeuroGuard"
import { num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { Card, Text, Stack, HStack, Button, List, ListItem, Image, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input } from "@chakra-ui/react"
import { parseError } from "@/helpers/parseError"
import { colors } from "@/config/defaults"
import { PositionResponse } from "@/contracts/codegen/positions/Positions.types"
import { getAssetBySymbol } from "@/helpers/chain"
import { shiftDigits } from "@/helpers/math"
import useNeuroClose from "./hooks/useNeuroClose"
import useExistingNeuroGuard from "./hooks/useExistingNeuroGuard"
import useCloseCDP from "./hooks/useCloseCDP"

export const NeuroOpenModal = React.memo(({
    isOpen, onClose, asset, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, asset: string }>) => {


    const { neuroState, setNeuroState } = useNeuroState()
    const { action: neuro } = useNeuroGuard({ onSuccess: onClose })
    const isLoading = neuro?.simulate.isLoading || neuro?.tx.isPending
    const isDisabled = asset !== neuroState?.openSelectedAsset?.base || neuroState?.openSelectedAsset?.sliderValue == 0 || neuro?.simulate.isError || !neuro?.simulate.data


    const minValue = ((21 / ((neuroState?.openSelectedAsset?.maxBorrowLTV ?? 0) * 0.8)) + 1)
    const minAmount = num(minValue).dividedBy(neuroState?.openSelectedAsset?.price ?? 0).toNumber()
    //@ts-ignore
    const maxAmount = num(neuroState?.openSelectedAsset?.balance).toNumber()

    const onMaxClick = () => {
        setNeuroState({
            //@ts-ignore
            openSelectedAsset: {
                ...neuroState?.openSelectedAsset,
                sliderValue: maxAmount
            }
        })
    }
    const onMinClick = () => {
        setNeuroState({
            //@ts-ignore
            openSelectedAsset: {
                ...neuroState?.openSelectedAsset,
                sliderValue: minAmount
            }
        })
    }


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setNeuroState({
            //@ts-ignore
            openSelectedAsset: {
                ...neuroState?.openSelectedAsset,
                sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            }
        })
    }, [neuroState?.openSelectedAsset, setNeuroState])



    return (<>
        <Button onClick={() => { }} width="25%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button>

        <Modal isOpen={isOpen} onClose={onClose} closeOnOverlayClick={true}>
            <ModalOverlay />
            <ModalContent maxW="400px">
                <ModalHeader>
                    <Text variant="title" textTransform={"capitalize"} letterSpacing={"1px"}>Deposit</Text>
                </ModalHeader>
                <ModalCloseButton />
                <ModalBody pb="5">
                    <Stack>
                        <HStack width="100%" justifyContent="left">
                            <HStack width="75%">
                                {neuroState?.openSelectedAsset?.logo ? <Image src={neuroState?.openSelectedAsset?.logo} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {neuroState?.openSelectedAsset?.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(neuroState?.openSelectedAsset?.sliderValue).times(neuroState?.openSelectedAsset?.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={neuroState?.openSelectedAsset?.sliderValue?.toFixed(2)}
                            onChange={onInputChange}
                        />
                        <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>

                            <Button onClick={onMinClick} width="10%" variant="unstyled" fontWeight="normal">
                                <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                                    min
                                </Text>
                            </Button>
                            <Button onClick={onMaxClick} width="10%" variant="unstyled" fontWeight="normal">
                                <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                                    max
                                </Text>
                            </Button>
                        </HStack>
                    </Stack>
                </ModalBody>
                {(
                    <ModalFooter
                        as={Stack}
                        justifyContent="end"
                        borderTop="1px solid"
                        borderColor="whiteAlpha.200"
                        pt="5"
                        gap="5"
                    >


                        <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="100%">
                            {parseError(num(neuroState?.openSelectedAsset?.sliderValue).isGreaterThan(0) && neuro.simulate.isError ? neuro.simulate.error?.message ?? "" : "")}
                        </Text>


                        <TxButton
                            w="100%"
                            isLoading={isLoading}
                            isDisabled={isDisabled}
                            onClick={() => neuro?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            Open Loan for Passive Yield
                        </TxButton>
                    </ModalFooter>
                )}
            </ModalContent>
        </Modal>
    </>)
})

export const NeuroDepositModal = React.memo(({
    isOpen, onClose, asset, position_id, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, asset: string, position_id: string }>) => {


    const { neuroState, setNeuroState } = useNeuroState()
    const { action: existingNeuro } = useExistingNeuroGuard({ position_id, onSuccess: onClose })
    const isLoading = existingNeuro?.simulate.isLoading || existingNeuro?.tx.isPending
    const isDisabled = asset !== neuroState?.depositSelectedAsset?.base || existingNeuro?.simulate.isError || !existingNeuro?.simulate.data


    // const minValue = ((21 / ((neuroState?.depositSelectedAsset?.maxBorrowLTV ?? 0) * 0.8)) + 1)
    // const minAmount = num(minValue).dividedBy(neuroState?.depositSelectedAsset?.price ?? 0).toNumber()
    //@ts-ignore
    const maxAmount = num(neuroState?.depositSelectedAsset?.balance).toNumber()

    const onMaxClick = () => {
        setNeuroState({
            //@ts-ignore
            depositSelectedAsset: {
                ...neuroState?.depositSelectedAsset,
                sliderValue: maxAmount
            }
        })
    }


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setNeuroState({
            //@ts-ignore
            depositSelectedAsset: {
                ...neuroState?.depositSelectedAsset,
                sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            }
        })
    }, [neuroState?.depositSelectedAsset, setNeuroState])



    return (<>
        <Button onClick={() => { }} width="50%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button>

        <Modal isOpen={isOpen} onClose={onClose} closeOnOverlayClick={true}>
            <ModalOverlay />
            <ModalContent maxW="400px">
                <ModalHeader>
                    <Text variant="title" textTransform={"capitalize"} letterSpacing={"1px"}>Deposit</Text>
                </ModalHeader>
                <ModalCloseButton />
                <ModalBody pb="5">
                    <Stack>
                        <HStack width="100%" justifyContent="left">
                            <HStack width="75%">
                                {neuroState?.depositSelectedAsset?.logo ? <Image src={neuroState?.depositSelectedAsset?.logo} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {neuroState?.depositSelectedAsset?.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(neuroState?.depositSelectedAsset?.sliderValue).times(neuroState?.depositSelectedAsset?.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={neuroState?.depositSelectedAsset?.sliderValue?.toFixed(2)}
                            onChange={onInputChange}
                        />
                        <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                            <Button onClick={onMaxClick} width="10%" variant="unstyled" fontWeight="normal">
                                <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                                    max
                                </Text>
                            </Button>
                        </HStack>
                    </Stack>
                </ModalBody>
                {(
                    <ModalFooter
                        as={Stack}
                        justifyContent="end"
                        borderTop="1px solid"
                        borderColor="whiteAlpha.200"
                        pt="5"
                        gap="5"
                    >


                        <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="100%">
                            {parseError(num(neuroState?.depositSelectedAsset?.sliderValue).isGreaterThan(0) && existingNeuro.simulate.isError ? existingNeuro.simulate.error?.message ?? "" : "")}
                        </Text>


                        <TxButton
                            w="100%"
                            isLoading={isLoading}
                            isDisabled={isDisabled}
                            onClick={() => existingNeuro?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            Add to Guardian
                        </TxButton>
                    </ModalFooter>
                )}
            </ModalContent>
        </Modal>
    </>)
})

export const NeuroWithdrawModal = React.memo(({
    isOpen, onClose, guardedPosition, children
}: PropsWithChildren<{
    isOpen: boolean, onClose: () => void,
    guardedPosition: {
        position: PositionResponse;
        symbol: string;
        image: string;
        LTV: string;
        amount: string,
        cost: number
    }
}>) => {
    const { neuroState, setNeuroState } = useNeuroState()
    const { action: sheathe } = useNeuroClose({ position: guardedPosition.position, onSuccess: onClose })
    const isDisabled = sheathe?.simulate.isError || !sheathe?.simulate.data
    const isLoading = sheathe?.simulate.isLoading || sheathe?.tx.isPending


    //Get asset by symbol
    // const collateralAsset = guardedPosition.position.collateral_assets[0].asset
    const assetInfo = getAssetBySymbol(guardedPosition.symbol)
    //@ts-ignore
    const maxAmount = shiftDigits(guardedPosition.position.collateral_assets[0].asset.amount, -assetInfo?.decimal).toNumber()

    const onMaxClick = () => {
        setNeuroState({
            //@ts-ignore
            withdrawSelectedAsset: {
                ...neuroState?.withdrawSelectedAsset,
                sliderValue: maxAmount
            }
        })
    }

    console.log("neuroState?.withdrawSelectedAsset", neuroState?.withdrawSelectedAsset)


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setNeuroState({
            //@ts-ignore
            withdrawSelectedAsset: {
                ...neuroState?.withdrawSelectedAsset,
                sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            }
        })
    }, [neuroState?.withdrawSelectedAsset, setNeuroState])



    return (<>
        <Button onClick={() => { }} width="50%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button>

        <Modal isOpen={isOpen} onClose={onClose} closeOnOverlayClick={true}>
            <ModalOverlay />
            <ModalContent maxW="400px">
                <ModalHeader>
                    <Text variant="title" textTransform={"capitalize"} letterSpacing={"1px"}>Withdraw</Text>
                </ModalHeader>
                <ModalCloseButton />
                <ModalBody pb="5">
                    <Stack>
                        <HStack width="100%" justifyContent="left">
                            <HStack width="75%">
                                {guardedPosition?.image ? <Image src={guardedPosition.image} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {guardedPosition.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(neuroState?.withdrawSelectedAsset?.sliderValue).times(neuroState?.withdrawSelectedAsset?.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={neuroState?.withdrawSelectedAsset?.sliderValue?.toFixed(2)}
                            onChange={onInputChange}
                        />
                        <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                            <Button onClick={onMaxClick} width="10%" variant="unstyled" fontWeight="normal">
                                <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                                    max
                                </Text>
                            </Button>
                        </HStack>
                    </Stack>
                </ModalBody>
                {(
                    <ModalFooter
                        as={Stack}
                        justifyContent="end"
                        borderTop="1px solid"
                        borderColor="whiteAlpha.200"
                        pt="5"
                        gap="5"
                    >


                        <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="100%">
                            {parseError(num(neuroState?.withdrawSelectedAsset?.sliderValue).isGreaterThan(0) && sheathe.simulate.isError ? sheathe.simulate.error?.message ?? "" : "")}
                        </Text>


                        <TxButton
                            w="100%"
                            isLoading={isLoading}
                            isDisabled={isDisabled}
                            onClick={() => sheathe?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            Withdraw from Guardian
                        </TxButton>
                    </ModalFooter>
                )}
            </ModalContent>
        </Modal>
    </>)
})

export const NeuroCloseModal = React.memo(({
    isOpen, onClose, position, debtAmount, positionNumber, cdtMarketPrice, children
}: PropsWithChildren<{
    isOpen: boolean, onClose: () => void,
    position: PositionResponse
    debtAmount: number
    positionNumber: number
    cdtMarketPrice: string
}>) => {
    const { neuroState, setNeuroState } = useNeuroState()
    const { action: close } = useCloseCDP({ position, debtAmount, onSuccess: onClose })
    const isDisabled = close?.simulate.isError || !close?.simulate.data
    const isLoading = close?.simulate.isLoading || close?.tx.isPending

    const maxAmount = debtAmount


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setNeuroState({
            //@ts-ignore
            closeInputValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
        })
    }, [neuroState?.closeInputValue, setNeuroState])

    const onMaxClick = () => {
        setNeuroState({
            //@ts-ignore
            closeInputValue: maxAmount

        })
    }


    return (<>
        <Button onClick={() => { }} width="50%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button>

        <Modal isOpen={isOpen} onClose={onClose} closeOnOverlayClick={true}>
            <ModalOverlay />
            <ModalContent maxW="400px">
                <ModalHeader>
                    <Text variant="title" textTransform={"capitalize"} letterSpacing={"1px"}>Debt to Repay</Text>
                </ModalHeader>
                <ModalCloseButton />
                <ModalBody pb="5">
                    <Stack>
                        <HStack width="100%" justifyContent="left">
                            <HStack width="75%">
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    Position {positionNumber}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(neuroState?.closeInputValue).times(cdtMarketPrice).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={neuroState?.closeInputValue?.toFixed(2)}
                            onChange={onInputChange}
                        />
                        <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                            <Button onClick={onMaxClick} width="10%" variant="unstyled" fontWeight="normal">
                                <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                                    max
                                </Text>
                            </Button>
                        </HStack>
                    </Stack>
                </ModalBody>
                {(
                    <ModalFooter
                        as={Stack}
                        justifyContent="end"
                        borderTop="1px solid"
                        borderColor="whiteAlpha.200"
                        pt="5"
                        gap="5"
                    >


                        <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="100%">
                            {parseError((num(neuroState?.closeInputValue).isGreaterThan(0) || debtAmount == 0) && close.simulate.isError ? close.simulate.error?.message ?? "" : "")}
                        </Text>


                        <TxButton
                            w="100%"
                            isLoading={isLoading}
                            isDisabled={isDisabled}
                            onClick={() => close?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            {debtAmount == 0 ? "Withdraw All Collateral" : "Sell Collateral to Repay Debt"}
                        </TxButton>
                    </ModalFooter>
                )}
            </ModalContent>
        </Modal>
    </>)
})
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

export const NeuroOpenModal = React.memo(({
    isOpen, onClose, asset, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, asset: string }>) => {


    const { neuroState, setNeuroState } = useNeuroState()
    const { action: neuro } = useNeuroGuard()
    const isLoading = neuro?.simulate.isLoading || neuro?.tx.isPending
    const isDisabled = asset !== neuroState?.selectedAsset?.base || neuro?.simulate.isError || !neuro?.simulate.data


    const minValue = ((21 / ((neuroState?.selectedAsset?.maxBorrowLTV ?? 0) * 0.8)) + 1)
    const minAmount = num(minValue).dividedBy(neuroState?.selectedAsset?.price ?? 0).toNumber()
    //@ts-ignore
    const maxAmount = num(neuroState?.selectedAsset?.balance).toNumber()

    const onMaxClick = () => {
        setNeuroState({
            //@ts-ignore
            selectedAsset: {
                ...neuroState?.selectedAsset,
                sliderValue: maxAmount
            }
        })
    }
    const onMinClick = () => {
        setNeuroState({
            //@ts-ignore
            selectedAsset: {
                ...neuroState?.selectedAsset,
                sliderValue: minAmount
            }
        })
    }


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setNeuroState({
            //@ts-ignore
            selectedAsset: {
                ...neuroState?.selectedAsset,
                sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            }
        })
    }, [neuroState?.selectedAsset, setNeuroState])



    return (<>
        <Button onClick={() => { }} width="25%" variant="unstyled" fontWeight="normal" mb="3">
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
                                {neuroState?.selectedAsset?.logo ? <Image src={neuroState?.selectedAsset?.logo} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {neuroState?.selectedAsset?.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(neuroState?.selectedAsset?.sliderValue).times(neuroState?.selectedAsset?.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={neuroState?.selectedAsset?.sliderValue?.toFixed(2)}
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
                            {parseError(num(neuroState?.selectedAsset?.sliderValue).isGreaterThan(0) && neuro.simulate.isError ? neuro.simulate.error?.message ?? "" : "")}
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
    const { action: existingNeuro } = useExistingNeuroGuard({ position_id })
    const isLoading = existingNeuro?.simulate.isLoading || existingNeuro?.tx.isPending
    const isDisabled = asset !== neuroState?.selectedAsset?.base || existingNeuro?.simulate.isError || !existingNeuro?.simulate.data


    // const minValue = ((21 / ((neuroState?.selectedAsset?.maxBorrowLTV ?? 0) * 0.8)) + 1)
    // const minAmount = num(minValue).dividedBy(neuroState?.selectedAsset?.price ?? 0).toNumber()
    //@ts-ignore
    const maxAmount = num(neuroState?.selectedAsset?.balance).toNumber()

    const onMaxClick = () => {
        setNeuroState({
            //@ts-ignore
            selectedAsset: {
                ...neuroState?.selectedAsset,
                sliderValue: maxAmount
            }
        })
    }


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setNeuroState({
            //@ts-ignore
            selectedAsset: {
                ...neuroState?.selectedAsset,
                sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            }
        })
    }, [neuroState?.selectedAsset, setNeuroState])



    return (<>
        <Button onClick={() => { }} width="50%" variant="unstyled" fontWeight="normal" mb="3">
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
                                {neuroState?.selectedAsset?.logo ? <Image src={neuroState?.selectedAsset?.logo} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {neuroState?.selectedAsset?.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(neuroState?.selectedAsset?.sliderValue).times(neuroState?.selectedAsset?.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={neuroState?.selectedAsset?.sliderValue?.toFixed(2)}
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
                            {parseError(num(neuroState?.selectedAsset?.sliderValue).isGreaterThan(0) && existingNeuro.simulate.isError ? existingNeuro.simulate.error?.message ?? "" : "")}
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
    const { action: sheathe } = useNeuroClose({ position: guardedPosition.position })
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
            selectedAsset: {
                ...neuroState?.selectedAsset,
                sliderValue: maxAmount
            }
        })
    }


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setNeuroState({
            //@ts-ignore
            selectedAsset: {
                ...neuroState?.selectedAsset,
                sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            }
        })
    }, [neuroState?.selectedAsset, setNeuroState])



    return (<>
        <Button onClick={() => { }} width="50%" variant="unstyled" fontWeight="normal" mb="3">
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
                                {neuroState?.selectedAsset?.logo ? <Image src={neuroState?.selectedAsset?.logo} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {neuroState?.selectedAsset?.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(neuroState?.selectedAsset?.sliderValue).times(neuroState?.selectedAsset?.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={neuroState?.selectedAsset?.sliderValue?.toFixed(2)}
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
                            {parseError(num(neuroState?.selectedAsset?.sliderValue).isGreaterThan(0) && sheathe.simulate.isError ? sheathe.simulate.error?.message ?? "" : "")}
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
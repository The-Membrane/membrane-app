import React, { ChangeEvent, PropsWithChildren, useCallback } from "react"
import { num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { Card, Text, Stack, HStack, Button, Image, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input, Checkbox } from "@chakra-ui/react"
import { parseError } from "@/helpers/parseError"
import { colors } from "@/config/defaults"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import BigNumber from "bignumber.js"
import useRedemptionState from "./hooks/useRedemptionState"

export const RBLPDepositModal = React.memo(({
    isOpen, onClose, marsUSDCAsset, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, marsUSDCAsset: AssetWithBalance }>) => {


    const { redemptionState, setRedemptionState } = useRedemptionState()
    //
    const { action: rblp } = useBoundedLP({ onSuccess: onClose, run: isOpen })
    const isLoading = rblp?.simulate.isLoading || rblp?.tx.isPending
    const isDisabled = redemptionState?.deposit == 0 || rblp?.simulate.isError || !rblp?.simulate.data
    //

    //@ts-ignore
    const maxAmount = num(marsUSDCAsset.balance).toNumber()

    const onMaxClick = () => {
        setRedemptionState({
            deposit: maxAmount
        })
    }

    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setRedemptionState({
            deposit: num(value).isGreaterThan(maxAmount) ? maxAmount : value
        })
    }, [redemptionState?.deposit, setRedemptionState])



    return (<>
        {/* <Button onClick={() => { }} width="100%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button> */}

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
                                {marsUSDCAsset.logo ? <Image src={marsUSDCAsset.logo} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {marsUSDCAsset.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(redemptionState?.deposit).times(marsUSDCAsset.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={redemptionState?.deposit.toFixed(2)}
                            onChange={onInputChange}
                        />
                        <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                            <Button onClick={onMaxClick} width="20%" variant="unstyled" fontWeight="normal">
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
                            {parseError(num(redemptionState?.deposit).isGreaterThan(0) && rblp.simulate.isError ? rblp.simulate.error?.message ?? "" : "")}
                        </Text>


                        <TxButton
                            w="100%"
                            isLoading={isLoading}
                            isDisabled={isDisabled}
                            onClick={() => rblp?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            Deposit into The Membrane
                        </TxButton>
                    </ModalFooter>
                )}
            </ModalContent>
        </Modal>
    </>)
})

export const RBLPWithdrawModal = React.memo(({
    isOpen, onClose, rblpDeposit, cdtMarketPrice, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, rblpDeposit: number, cdtMarketPrice: string }>) => {


    const { redemptionState, setQuickActionState } = useQuickActionState()
    const { action: rblp } = useBoundedLP({ onSuccess: onClose, run: isOpen })
    const isLoading = rblp?.simulate.isLoading || rblp?.tx.isPending
    const isDisabled = redemptionState?.rangeBoundLPwithdrawal == 0 || rblp?.simulate.isError || !rblp?.simulate.data

    //@ts-ignore
    const maxAmount = rblpDeposit

    const onMaxClick = () => {
        setQuickActionState({
            rangeBoundLPwithdrawal: maxAmount
        })
    }

    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setQuickActionState({
            rangeBoundLPwithdrawal: num(value).isGreaterThan(maxAmount) ? maxAmount : value
        })
    }, [redemptionState?.rangeBoundLPwithdrawal, setQuickActionState])



    return (<>
        {/* <Button onClick={() => { }} width="100%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button> */}

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
                                <Image src={"/images/cdt.svg"} w="30px" h="30px" />
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    CDT
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(redemptionState?.rangeBoundLPwithdrawal).times(cdtMarketPrice).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={redemptionState?.rangeBoundLPwithdrawal.toFixed(2)}
                            onChange={onInputChange}
                        />
                        <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                            <Button onClick={onMaxClick} width="20%" variant="unstyled" fontWeight="normal">
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
                            {parseError(num(redemptionState?.rangeBoundLPwithdrawal).isGreaterThan(0) && rblp.simulate.isError ? rblp.simulate.error?.message ?? "" : "")}
                        </Text>


                        <TxButton
                            w="100%"
                            isLoading={isLoading}
                            isDisabled={isDisabled}
                            onClick={() => rblp?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            Withdraw from The Membrane
                        </TxButton>
                    </ModalFooter>
                )}
            </ModalContent>
        </Modal>
    </>)
})

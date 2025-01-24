import React, { ChangeEvent, PropsWithChildren, useCallback } from "react"
import { num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { Card, Text, Stack, HStack, Button, Image, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input, Checkbox } from "@chakra-ui/react"
import { parseError } from "@/helpers/parseError"
import { colors } from "@/config/defaults"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import BigNumber from "bignumber.js"

export const RBLPDepositModal = React.memo(({
    isOpen, onClose, cdtAsset, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, cdtAsset: AssetWithBalance }>) => {


    const { quickActionState, setQuickActionState } = useQuickActionState()
    const { action: rblp } = useBoundedLP({ onSuccess: onClose, run: isOpen })
    const isLoading = rblp?.simulate.isLoading || rblp?.tx.isPending
    const isDisabled = quickActionState?.rangeBoundLPdeposit == 0 || rblp?.simulate.isError || !rblp?.simulate.data

    //@ts-ignore
    const maxAmount = num(cdtAsset.balance).toNumber()

    const onMaxClick = () => {
        setQuickActionState({
            rangeBoundLPdeposit: maxAmount
        })
    }

    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setQuickActionState({
            rangeBoundLPdeposit: num(value).isGreaterThan(maxAmount) ? maxAmount : value
        })
    }, [quickActionState?.rangeBoundLPdeposit, setQuickActionState])



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
                                {cdtAsset.logo ? <Image src={cdtAsset.logo} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {cdtAsset.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(quickActionState?.rangeBoundLPdeposit).times(cdtAsset.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={quickActionState?.rangeBoundLPdeposit.toFixed(2)}
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
                            {parseError(num(quickActionState?.rangeBoundLPdeposit).isGreaterThan(0) && rblp.simulate.isError ? rblp.simulate.error?.message ?? "" : "")}
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


    const { quickActionState, setQuickActionState } = useQuickActionState()
    const { action: rblp } = useBoundedLP({ onSuccess: onClose, run: isOpen })
    const isLoading = rblp?.simulate.isLoading || rblp?.tx.isPending
    const isDisabled = quickActionState?.rangeBoundLPwithdrawal == 0 || rblp?.simulate.isError || !rblp?.simulate.data

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
    }, [quickActionState?.rangeBoundLPwithdrawal, setQuickActionState])



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
                                ~${num(quickActionState?.rangeBoundLPwithdrawal).times(cdtMarketPrice).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={quickActionState?.rangeBoundLPwithdrawal.toFixed(2)}
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
                            {parseError(num(quickActionState?.rangeBoundLPwithdrawal).isGreaterThan(0) && rblp.simulate.isError ? rblp.simulate.error?.message ?? "" : "")}
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

import React, { ChangeEvent, PropsWithChildren, useCallback } from "react"
import { num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { Card, Text, Stack, HStack, Button, Image, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input, Checkbox } from "@chakra-ui/react"
import { parseError } from "@/helpers/parseError"
import { colors } from "@/config/defaults"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import useRedemptionState from "./hooks/useRedemptionState"
import useMarsUSDCRedemptions from "./hooks/useMarsUSDCRedemptions"
import useMarsUSDCRedemptionWithdraw from "./hooks/useMarsUSDCRedemptionWithdraw"

export const RedemptionDepositModal = React.memo(({
    isOpen, onClose, marsUSDCAsset, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, marsUSDCAsset: AssetWithBalance }>) => {


    const { redemptionState, setRedemptionState } = useRedemptionState()
    //
    const { action: setRedemptions } = useMarsUSDCRedemptions({ onSuccess: onClose, run: isOpen })
    const isLoading = setRedemptions?.simulate.isLoading || setRedemptions?.tx.isPending
    const isDisabled = redemptionState?.deposit == 0 || setRedemptions?.simulate.isError || !setRedemptions?.simulate.data
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
                            {parseError(num(redemptionState?.deposit).isGreaterThan(0) && setRedemptions.simulate.isError ? setRedemptions.simulate.error?.message ?? "" : "")}
                        </Text>


                        <TxButton
                            w="100%"
                            isLoading={isLoading}
                            isDisabled={isDisabled}
                            onClick={() => setRedemptions?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            Set Redemption Arb
                        </TxButton>
                    </ModalFooter>
                )}
            </ModalContent>
        </Modal>
    </>)
})

export const RedemptionWithdrawModal = React.memo(({
    isOpen, onClose, marsUSDCDeposit, usdcMarketPrice, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, marsUSDCDeposit: number, usdcMarketPrice: string }>) => {


    //@ts-ignore
    const maxAmount = marsUSDCDeposit

    const { redemptionState, setRedemptionState } = useRedemptionState()
    const { action: setRedemptions } = useMarsUSDCRedemptionWithdraw({ onSuccess: onClose, run: isOpen, max: maxAmount })
    const isLoading = setRedemptions?.simulate.isLoading || setRedemptions?.tx.isPending
    const isDisabled = redemptionState?.withdraw == 0 || setRedemptions?.simulate.isError || !setRedemptions?.simulate.data


    const onMaxClick = () => {
        setRedemptionState({
            withdraw: maxAmount
        })
    }

    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setRedemptionState({
            withdraw: num(value).isGreaterThan(maxAmount) ? maxAmount : value
        })
    }, [redemptionState?.withdraw, setRedemptionState])



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
                                    USDC
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(redemptionState?.withdraw).times(usdcMarketPrice).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={redemptionState?.withdraw.toFixed(2)}
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
                            {parseError(num(redemptionState?.withdraw).isGreaterThan(0) && setRedemptions.simulate.isError ? setRedemptions.simulate.error?.message ?? "" : "")}
                        </Text>


                        <TxButton
                            w="100%"
                            isLoading={isLoading}
                            isDisabled={isDisabled}
                            onClick={() => setRedemptions?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            Withdraw Redeemable USDC
                        </TxButton>
                    </ModalFooter>
                )}
            </ModalContent>
        </Modal>
    </>)
})

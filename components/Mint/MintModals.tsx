import React, { ChangeEvent, PropsWithChildren, useCallback, useMemo } from "react"
import { num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { Text, Stack, HStack, Button, Image, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input } from "@chakra-ui/react"
import { parseError } from "@/helpers/parseError"
import { colors } from "@/config/defaults"
import useRedemptionState from "./hooks/useRedemptionState"
import useUSDCRedemptions from "./hooks/useUSDCRedemptions"
import useUSDCRedemptionWithdraw from "./hooks/useUSDCRedemptionWithdraw"
import { useOraclePrice } from "@/hooks/useOracle"
import { shiftDigits } from "@/helpers/math"

export const RedemptionDepositModal = React.memo(({
    isOpen, onClose, children, usdcAsset
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, usdcAsset: any }>) => {


    const { redemptionState, setRedemptionState } = useRedemptionState()
    //
    const { action: setRedemptions } = useUSDCRedemptions({ onSuccess: onClose, run: isOpen })
    const isLoading = setRedemptions?.simulate.isLoading || setRedemptions?.tx.isPending
    const isDisabled = redemptionState?.deposit == 0 || setRedemptions?.simulate.isError || !setRedemptions?.simulate.data
    //

    //@ts-ignore
    const maxAmount = num(usdcAsset.balance).toNumber()

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
    }, [redemptionState.deposit, setRedemptionState])


    const onSalePriceInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setRedemptionState({
            salePrice: num(value).isGreaterThan(99) ? 99 : value
        })
    }, [redemptionState.salePrice, setRedemptionState])



    return (<>
        {/* <Button onClick={() => { }} width="100%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button> */}

        <ModalContent maxW="500px">
            <ModalHeader>
                <Text variant="title" textTransform={"capitalize"} letterSpacing={"1px"}>Deposit</Text>
            </ModalHeader>
            <ModalCloseButton />
            <ModalBody pb="5">
                <Stack>
                    <Stack>
                        <HStack width="100%" justifyContent="left">
                            <HStack width="75%">
                                {usdcAsset.logo ? <Image src={usdcAsset.logo} w="30px" h="30px" /> : null}
                                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                    {usdcAsset.symbol}
                                </Text>
                            </HStack>
                            <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                                ~${num(redemptionState?.deposit).times(usdcAsset.price ?? 0).toFixed(2)}
                            </Text>
                        </HStack>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="0"
                            type="number"
                            variant={"ghost"}
                            value={redemptionState?.deposit}
                            onChange={onInputChange}
                        />
                        <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                            <Button onClick={onMaxClick} width="0%" variant="unstyled" fontWeight="normal">
                                <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                                    max
                                </Text>
                            </Button>
                        </HStack>
                    </Stack>

                    <Stack>
                        <Text variant="title" paddingTop="3%" textTransform={undefined} textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                            What price did you sell CDT? Set to 1.00 if you haven't sold any.
                        </Text>
                        <Input
                            width={"100%"}
                            textAlign={"right"}
                            placeholder="1.00"
                            type="number"
                            variant={"ghost"}
                            defaultValue={1.00}
                            value={redemptionState.salePrice}
                            onChange={onSalePriceInputChange}
                        />
                        <a href="https://app.osmosis.zone/transactions" style={{ textAlign: "center", justifyContent: "center", fontSize: "12px", letterSpacing: "1px", display: "flex" }}>
                            Go to Osmosis to check swap history -&gt;
                        </a>
                    </Stack>
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


                    <Text variant="title" fontWeight="500" color={colors.alert} textAlign="center" fontSize="lg" letterSpacing="1px" width="100%">
                        {parseError((redemptionState.deposit > 0 || redemptionState.salePrice > 0) && setRedemptions.simulate.isError ? setRedemptions.simulate.error?.message ?? "" : "")}
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
    </>)
})

export const RedemptionWithdrawModal = React.memo(({
    isOpen, onClose, children, usdcDeposit, usdcImage
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, usdcDeposit: number, usdcImage: string | undefined }>) => {

    const { data: prices } = useOraclePrice()
    const usdcMarketPrice = useMemo(() =>
        parseFloat(prices?.find((price) => price.denom === "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4")?.price ?? "0"),
        [prices])

    //@ts-ignore
    const maxAmount = shiftDigits(usdcDeposit, -6).toNumber()

    const { redemptionState, setRedemptionState } = useRedemptionState()
    const { action: setRedemptions } = useUSDCRedemptionWithdraw({ onSuccess: onClose, run: isOpen, max: maxAmount })
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

        <ModalContent maxW="400px">
            <ModalHeader>
                <Text variant="title" textTransform={"capitalize"} letterSpacing={"1px"}>Withdraw</Text>
            </ModalHeader>
            <ModalCloseButton />
            <ModalBody pb="5">
                <Stack>
                    <HStack width="100%" justifyContent="left">
                        <HStack width="75%">
                            {usdcImage ? <Image src={usdcImage} w="30px" h="30px" /> : null}
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
                        value={redemptionState?.withdraw}
                        onChange={onInputChange}
                    />
                    <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                        <Button onClick={onMaxClick} width="0%" variant="unstyled" fontWeight="normal">
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
    </>)
})

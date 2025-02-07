import React, { ChangeEvent, PropsWithChildren, useCallback, useRef, useState } from "react"
import useNeuroState from "./hooks/useNeuroState"
import useNeuroGuard from "./hooks/useNeuroGuard"
import { num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { Card, Text, Stack, HStack, Button, Image, Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Input, Checkbox } from "@chakra-ui/react"
import { parseError } from "@/helpers/parseError"
import { colors } from "@/config/defaults"
import { PositionResponse } from "@/contracts/codegen/positions/Positions.types"
import { getAssetBySymbol } from "@/helpers/chain"
import { shiftDigits } from "@/helpers/math"
import useNeuroClose from "./hooks/useNeuroClose"
import useExistingNeuroGuard from "./hooks/useExistingNeuroGuard"
import useCloseCDP from "./hooks/useCloseCDP"
import useQuickActionState from "./hooks/useQuickActionState"
import useBoundedLP from "./hooks/useRangeBoundLP"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import BigNumber from "bignumber.js"

const INPUT_DELAY = 300;

export const RBLPDepositModal = React.memo(({
    isOpen, onClose, cdtAsset, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, cdtAsset: AssetWithBalance }>) => {


    const { quickActionState, setQuickActionState } = useQuickActionState()
    const { action: rblp } = useBoundedLP({ onSuccess: onClose, run: isOpen })
    const isLoading = rblp?.simulate.isLoading || rblp?.tx.isPending
    const isDisabled = quickActionState?.rangeBoundLPdeposit == 0 || rblp?.simulate.isError || !rblp?.simulate.data

    //@ts-ignore
    const maxAmount = num(cdtAsset.balance).toNumber()
    const [inputValue, setInputValue] = useState<number | undefined>(); // Tracks user input
    const updateTimeout = useRef<NodeJS.Timeout | null>(null);

    const onMaxClick = () => {
        setInputValue(maxAmount)
        setQuickActionState({
            rangeBoundLPdeposit: maxAmount
        })
    }

    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setInputValue(num(value).isGreaterThan(maxAmount) ? maxAmount : value); // Updates the input value immediately


        if (updateTimeout.current) {
            clearTimeout(updateTimeout.current); // Clears previous timeout
        }

        updateTimeout.current = setTimeout(() => {
            setQuickActionState({
                rangeBoundLPdeposit: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            });
        }, INPUT_DELAY); // Delay before updating the state

    }, [quickActionState?.rangeBoundLPdeposit, setQuickActionState, maxAmount])



    return (<>
        {/* <Button onClick={() => { }} width="100%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button> */}

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
                            ~${num(inputValue ?? 0).times(cdtAsset.price ?? 0).toFixed(2)}
                        </Text>
                    </HStack>
                    <Input
                        width={"100%"}
                        textAlign={"right"}
                        placeholder="0"
                        type="number"
                        variant={"ghost"}
                        value={inputValue}
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
        setInputValue(maxAmount)
        setQuickActionState({
            rangeBoundLPwithdrawal: maxAmount
        })
    }
    const [inputValue, setInputValue] = useState<number | undefined>(); // Tracks user input
    const updateTimeout = useRef<NodeJS.Timeout | null>(null);

    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const value = Number(e.target.value);

        setInputValue(num(value).isGreaterThan(maxAmount) ? maxAmount : value); // Updates the input value immediately

        if (updateTimeout.current) {
            clearTimeout(updateTimeout.current); // Clears previous timeout
        }

        updateTimeout.current = setTimeout(() => {
            setQuickActionState({
                rangeBoundLPwithdrawal: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            });
        }, INPUT_DELAY); // Delay before updating the state
    }, [quickActionState?.rangeBoundLPwithdrawal, setQuickActionState, maxAmount]);



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
                            <Image src={"/images/cdt.svg"} w="30px" h="30px" />
                            <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                CDT
                            </Text>
                        </HStack>
                        <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                            ~${num(inputValue).times(cdtMarketPrice).toFixed(2)}
                        </Text>
                    </HStack>
                    <Input
                        width={"100%"}
                        textAlign={"right"}
                        placeholder="0"
                        type="number"
                        variant={"ghost"}
                        value={inputValue}
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
    </>)
})

export const NeuroOpenModal = React.memo(({
    isOpen, onClose, asset, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, asset: string }>) => {


    const { neuroState, setNeuroState } = useNeuroState()
    const { action: rblp } = useNeuroGuard({ onSuccess: onClose, run: isOpen })
    const isLoading = rblp?.simulate.isLoading || rblp?.tx.isPending
    const isDisabled = asset !== neuroState?.openSelectedAsset?.base || neuroState?.openSelectedAsset?.sliderValue == 0 || rblp?.simulate.isError || !rblp?.simulate.data


    const minValue = ((21 / ((neuroState?.openSelectedAsset?.maxBorrowLTV ?? 0) * 0.8)) + 1)
    const minAmount = num(minValue).dividedBy(neuroState?.openSelectedAsset?.price ?? 0).toNumber()
    //@ts-ignore
    const maxAmount = num(neuroState?.openSelectedAsset?.balance).toNumber()
    const [inputValue, setInputValue] = useState<number | undefined>(); // Tracks user input
    const updateTimeout = useRef<NodeJS.Timeout | null>(null);

    const onMaxClick = () => {
        setInputValue(maxAmount)
        setNeuroState({
            //@ts-ignore
            openSelectedAsset: {
                ...neuroState?.openSelectedAsset,
                sliderValue: maxAmount
            }
        })
    }
    const onMinClick = () => {
        setInputValue(minAmount)
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

        setInputValue(num(value).isGreaterThan(maxAmount) ? maxAmount : value); // Updates the input value immediately

        if (updateTimeout.current) {
            clearTimeout(updateTimeout.current); // Clears previous timeout
        }


        updateTimeout.current = setTimeout(() => {
            setNeuroState({
                //@ts-ignore
                openSelectedAsset: {
                    ...neuroState?.openSelectedAsset,
                    sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
                }
            })
        }, INPUT_DELAY); // Delay before updating the state

    }, [neuroState?.openSelectedAsset, setNeuroState, maxAmount])

    return (<>
        {/* <Button onClick={() => { }} width="25%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button> */}

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
                            ~${num(inputValue ?? 0).times(neuroState?.openSelectedAsset?.price ?? 0).toFixed(2)}
                        </Text>
                    </HStack>
                    <Input
                        width={"100%"}
                        textAlign={"right"}
                        placeholder="0"
                        type="number"
                        variant={"ghost"}
                        value={inputValue}
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
                        {parseError(num(neuroState?.openSelectedAsset?.sliderValue).isGreaterThan(0) && rblp.simulate.isError ? rblp.simulate.error?.message ?? "" : "")}
                    </Text>

                    <TxButton
                        w="100%"
                        isLoading={isLoading}
                        isDisabled={isDisabled}
                        onClick={() => rblp?.tx.mutate()}
                        toggleConnectLabel={false}
                        style={{ alignSelf: "center" }}
                    >
                        Open Loan for Passive Yield
                    </TxButton>
                </ModalFooter>
            )}
        </ModalContent>
    </>)
})

export const NeuroDepositModal = React.memo(({
    isOpen, onClose, asset, position_id, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void, asset: string, position_id: string }>) => {

    const { neuroState, setNeuroState } = useNeuroState()
    const { action: existingNeuro } = useExistingNeuroGuard({ position_id, onSuccess: onClose, run: isOpen })
    const isLoading = existingNeuro?.simulate.isLoading || existingNeuro?.tx.isPending
    const isDisabled = asset !== neuroState?.depositSelectedAsset?.base || existingNeuro?.simulate.isError || !existingNeuro?.simulate.data


    // const minValue = ((21 / ((neuroState?.depositSelectedAsset?.maxBorrowLTV ?? 0) * 0.8)) + 1)
    // const minAmount = num(minValue).dividedBy(neuroState?.depositSelectedAsset?.price ?? 0).toNumber()
    //@ts-ignore
    const maxAmount = num(neuroState?.depositSelectedAsset?.balance).toNumber()

    const onMaxClick = () => {
        setInputValue(maxAmount)
        setNeuroState({
            //@ts-ignore
            depositSelectedAsset: {
                ...neuroState?.depositSelectedAsset,
                sliderValue: maxAmount
            }
        })
    }

    const [inputValue, setInputValue] = useState<number | undefined>(); // Tracks user input
    const updateTimeout = useRef<NodeJS.Timeout | null>(null);


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setInputValue(num(value).isGreaterThan(maxAmount) ? maxAmount : value); // Updates the input value immediately

        if (updateTimeout.current) {
            clearTimeout(updateTimeout.current); // Clears previous timeout
        }

        updateTimeout.current = setTimeout(() => {
            setNeuroState({
                //@ts-ignore
                depositSelectedAsset: {
                    ...neuroState?.depositSelectedAsset,
                    sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
                }
            })
        }, INPUT_DELAY); // Delay before updating the state

    }, [neuroState?.depositSelectedAsset, setNeuroState, maxAmount])



    return (<>
        {/* <Button onClick={() => { }} width="100%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button> */}

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
                            ~${num(inputValue).times(neuroState?.depositSelectedAsset?.price ?? 0).toFixed(2)}
                        </Text>
                    </HStack>
                    <Input
                        width={"100%"}
                        textAlign={"right"}
                        placeholder="0"
                        type="number"
                        variant={"ghost"}
                        value={inputValue}
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
    </>)
})

export const NeuroWithdrawModal = React.memo(({
    isOpen, onClose, guardedPosition, prices, children
}: PropsWithChildren<{
    isOpen: boolean, onClose: () => void,
    guardedPosition: {
        position: PositionResponse;
        symbol: string;
        image: string;
        LTV: string;
        amount: BigNumber;
        cost: number
    },
    prices: any
}>) => {
    const { neuroState, setNeuroState } = useNeuroState()
    const { action: sheathe } = useNeuroClose({ position: guardedPosition.position, onSuccess: onClose, ledger: false, run: isOpen })
    const { action: ledgerSheathe } = useNeuroClose({ position: guardedPosition.position, onSuccess: onClose, ledger: true, run: isOpen })
    const isDisabled = sheathe?.simulate.isError || !sheathe?.simulate.data
    const isLoading = sheathe?.simulate.isLoading || sheathe?.tx.isPending
    const isLedgerDisabled = ledgerSheathe?.simulate.isError || !ledgerSheathe?.simulate.data
    const isLedgerLoading = ledgerSheathe?.simulate.isLoading || ledgerSheathe?.tx.isPending

    //Get asset by symbol
    const assetInfo = getAssetBySymbol(guardedPosition.symbol)
    //Get asset price
    const assetPrice = Number(prices?.find((p: any) => p.denom === assetInfo?.base)?.price ?? "0")
    //@ts-ignore
    const maxAmount = shiftDigits(guardedPosition.position.collateral_assets[0].asset.amount, -assetInfo?.decimal).toNumber()

    const onMaxClick = () => {
        setInputValue(maxAmount)
        setNeuroState({
            //@ts-ignore
            withdrawSelectedAsset: {
                ...neuroState?.withdrawSelectedAsset,
                sliderValue: maxAmount
            }
        })
    }
    const [inputValue, setInputValue] = useState<number | undefined>(); // Tracks user input
    const updateTimeout = useRef<NodeJS.Timeout | null>(null);


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setInputValue(num(value).isGreaterThan(maxAmount) ? maxAmount : value); // Updates the input value immediately

        if (updateTimeout.current) {
            clearTimeout(updateTimeout.current); // Clears previous timeout
        }

        updateTimeout.current = setTimeout(() => {
            setNeuroState({
                //@ts-ignore
                withdrawSelectedAsset: {
                    ...neuroState?.withdrawSelectedAsset,
                    sliderValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
                }
            })
        }, INPUT_DELAY); // Delay before updating the state
    }, [neuroState?.withdrawSelectedAsset, setNeuroState, maxAmount])



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
                            {guardedPosition?.image ? <Image src={guardedPosition.image} w="30px" h="30px" /> : null}
                            <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                                {guardedPosition.symbol}
                            </Text>
                        </HStack>
                        <Text variant="title" textTransform="none" textAlign="right" fontSize="lg" letterSpacing="1px" width="40%" color={colors.noState}>
                            ~${num(inputValue).times(assetPrice).toFixed(2)}
                        </Text>
                    </HStack>
                    <Input
                        width={"100%"}
                        textAlign={"right"}
                        placeholder="0"
                        type="number"
                        variant={"ghost"}
                        value={inputValue}
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

                    <Stack>
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
                        <TxButton
                            w="100%"
                            isLoading={isLedgerLoading}
                            isDisabled={isLedgerDisabled}
                            onClick={() => ledgerSheathe?.tx.mutate()}
                            toggleConnectLabel={false}
                            style={{ alignSelf: "center" }}
                        >
                            Withdraw with Ledger
                        </TxButton>
                    </Stack>
                </ModalFooter>
            )}
        </ModalContent>
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
    const { action: close } = useCloseCDP({ position, debtAmount, onSuccess: onClose, run: isOpen })
    const isDisabled = close?.simulate.isError || !close?.simulate.data
    const isLoading = close?.simulate.isLoading || close?.tx.isPending

    const maxAmount = debtAmount
    const [inputValue, setInputValue] = useState<number | undefined>(); // Tracks user input
    const updateTimeout = useRef<NodeJS.Timeout | null>(null);


    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setInputValue(num(value).isGreaterThan(maxAmount) ? maxAmount : value); // Updates the input value immediately

        if (updateTimeout.current) {
            clearTimeout(updateTimeout.current); // Clears previous timeout
        }

        updateTimeout.current = setTimeout(() => {
            setNeuroState({
                //@ts-ignore
                closeInputValue: num(value).isGreaterThan(maxAmount) ? maxAmount : value
            })
        }, INPUT_DELAY); // Delay before updating the state
    }, [neuroState?.closeInputValue, setNeuroState, maxAmount])

    const onMaxClick = () => {
        setInputValue(maxAmount)
        setNeuroState({
            //@ts-ignore
            closeInputValue: maxAmount

        })
    }


    return (<>
        {/* <Button onClick={() => { }} width="100%" variant="unstyled" fontWeight="normal" mb="0">
            {children}
        </Button> */}

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
                            ~${num(inputValue).times(cdtMarketPrice).toFixed(2)}
                        </Text>
                    </HStack>
                    <Input
                        width={"100%"}
                        textAlign={"right"}
                        placeholder="0"
                        type="number"
                        variant={"ghost"}
                        value={inputValue}
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
    </>)
})
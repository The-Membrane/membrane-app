import React, { useEffect, useMemo, useState, useCallback, memo, useRef, ChangeEvent } from "react"
import { Card, Text, Stack, HStack, Button, Image, Checkbox, useDisclosure, List, ListItem, Input, CardBody, CardFooter, TabIndicator, TabList, Tabs, } from "@chakra-ui/react"
import { num } from "@/helpers/num"
import { shiftDigits } from "@/helpers/math"
import { INPUT_DELAY } from "@/config/defaults"
import { CustomTab } from "../Mint/AssetWithInput"
import useQuickActionState from "./hooks/useQuickActionState"
import useSwapToCDT from "./hooks/useUSDCSwapToCDT"
import useBoundedLP from "./hooks/useRangeBoundLP"
import ConfirmModal from "../ConfirmModal"
import { HomeSummary } from "./HomeSummary"

const AcquireCDTEntry = ({
    usdcBalance,
    RBYield,
    rblpDeposit,
    address
}: {
    usdcBalance: number
    RBYield: string
    rblpDeposit: number
    address: string
}) => {

    {/* @ts-ignore */ }
    const [inputValue, setInputValue] = useState<number | undefined>(1000); // Tracks user input
    const yieldValue = num(RBYield).times(100).toFixed(1)

    const [swapToCDT, setSwapToCDT] = useState<boolean>(true);



    const [txType, setTxType] = useState("deposit");
    const { quickActionState, setQuickActionState } = useQuickActionState()
    const { action: swap, tokenOutMinAmount } = useSwapToCDT({ onSuccess: () => { }, run: txType === "deposit" })
    const { action: rblp } = useBoundedLP({ onSuccess: () => { }, run: txType != "deposit", swapToCDT })
    const isSwapDisabled = usdcBalance === 0 || quickActionState?.usdcSwapToCDT === 0
    const isRBLPDisabled = inputValue === 0 || rblpDeposit === 0 || quickActionState?.rangeBoundLPwithdrawal === 0
    useEffect(() => {
        setTxType("deposit")
    }, [address])


    //@ts-ignore
    const maxDepositAmount = usdcBalance
    const maxWithdrawAmount = rblpDeposit
    const maxAmount = txType === "deposit" ? maxDepositAmount : maxWithdrawAmount
    const updateTimeout = useRef<NodeJS.Timeout | null>(null);


    const onMaxClick = () => {
        setInputValue(Number(maxAmount.toFixed(2)))
        if (txType === "deposit") {
            setQuickActionState({
                usdcSwapToCDT: maxAmount
            })
        }
        else {
            setQuickActionState({
                rangeBoundLPwithdrawal: maxAmount
            })
        }
    }

    const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setInputValue(num(value).isGreaterThan(Number(maxAmount.toFixed(2))) ? Number(maxAmount.toFixed(2)) : value); // Updates the input value immediately


        if (updateTimeout.current) {
            clearTimeout(updateTimeout.current); // Clears previous timeout
        }

        updateTimeout.current = setTimeout(() => {
            if (txType === "deposit") {
                setQuickActionState({
                    usdcSwapToCDT: num(value).isGreaterThan(maxAmount) ? maxAmount : value
                });
            }
            else {
                setQuickActionState({
                    rangeBoundLPwithdrawal: num(value).isGreaterThan(maxAmount) ? maxAmount : value
                });
            }
        }, INPUT_DELAY); // Delay before updating the state

    }, [quickActionState?.usdcSwapToCDT, setQuickActionState, maxAmount])


    const [activeTabIndex, setActiveTabIndex] = useState(0);
    const handleTabClick = (index: string) => {
        setActiveTabIndex(index === "deposit" ? 0 : 1);
        setTxType(index);
        setInputValue(0);
        setQuickActionState({
            usdcSwapToCDT: 0,
            rangeBoundLPwithdrawal: 0
        });
    };

    const dailyYield = num(yieldValue).dividedBy(100).times(txType === "deposit" ? (inputValue ?? 0) : (rblpDeposit + (inputValue ?? 0))).dividedBy(365).toNumber()
    const yearlyYield = num(yieldValue).dividedBy(100).times(txType === "deposit" ? (inputValue ?? 0) : rblpDeposit + (inputValue ?? 0)).toNumber()

    return (
        <>
            <Stack
                direction={{ base: 'column', md: 'row' }}
                justifyContent="center"
                spacing={{ base: 4, md: '1.5rem' }}
                alignItems="stretch"
                w="full"
            >
                <Card width="fit-content" alignSelf="center" borderWidth={3} padding={4} bg="rgb(90, 90, 90, 0.4)" borderColor="rgba(255, 255, 255, 0.16)">
                    <Stack gap="1.5rem">
                        <Image src={"/images/cdt.svg"} w="65px" h="65px" alignSelf={"center"} />

                        <Text width="fit-content" justifyContent="center" variant="title" textAlign="center" fontSize="1.7rem" letterSpacing="1px">
                            Earn &nbsp;<a className="textShadow">{yieldValue}%</a>&nbsp; with CDT
                        </Text>
                        <List spacing={3} styleType="disc" padding="6" paddingTop="0">
                            <ListItem fontFamily="Inter" fontSize="md"> All in stablecoins. Sourced from revenue & LP profits.</ListItem>
                            <ListItem fontFamily="Inter" fontSize="md"> 100% liquid. No lock-in or withdrawal penalty.</ListItem>
                            <ListItem fontFamily="Inter" fontSize="md"> Earn 100 MBRN for every $1 in yield you earn.</ListItem>
                        </List>
                    </Stack>


                </Card>
                <Card
                    w={{ base: '100%', md: '50%' }}
                    maxW={{ base: 'full', md: '640px' }}
                    p={4}
                    borderWidth="3px"
                    borderColor="white"
                >
                    <CardBody>
                        <Stack>
                            {rblpDeposit !== 0 && <Tabs position="relative" variant="unstyled" align="center" w="full" index={activeTabIndex}>
                                <TabList bg="white" borderRadius="28px" color="black" w="fit-content">
                                    <CustomTab onClick={() => handleTabClick("deposit")} label="Deposit" />
                                    <CustomTab onClick={() => handleTabClick("withdraw")} label="Withdraw" />
                                </TabList>

                                <TabIndicator
                                    top="0"
                                    position="absolute"
                                    height="40px"
                                    bg={"rgb(121, 144, 254, 0.7)"}
                                    borderRadius="28px"
                                />
                            </Tabs>}
                            <HStack width="100%" justifyContent="left">
                                <HStack width="75%">
                                    {txType === "deposit" ? <>
                                        <Image src={"https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/usdc.svg"} w="50px" h="50px" />
                                        <Text variant="title" textAlign="center" fontSize="2rem" letterSpacing="1px" display="flex">
                                            USDC
                                        </Text>
                                    </>
                                        : <>
                                            <Image src={"/images/cdt.svg"} w="50px" h="50px" />
                                            <Text variant="title" textAlign="center" fontSize="2rem" letterSpacing="1px" display="flex">
                                                CDT
                                            </Text>
                                        </>
                                    }
                                </HStack>
                            </HStack>
                            <Input
                                width={"100%"}
                                textAlign={"right"}
                                placeholder="0"
                                type="number"
                                variant={"ghost"}
                                value={inputValue}
                                max={maxAmount}
                                onChange={onInputChange}
                            />
                            <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                                <Button onClick={onMaxClick} width="20%" variant="unstyled" fontWeight="normal">
                                    <Text justifySelf="end" variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                                        max
                                    </Text>
                                </Button>
                            </HStack>

                            <Text variant="body" textTransform="none" fontSize="md" letterSpacing="1px" display="flex">
                                {txType === "deposit" ? tokenOutMinAmount ? `Minimum CDT: ${shiftDigits(tokenOutMinAmount, -6).toFixed(2)}` : "Minimum CDT: N/A"
                                    : "Current Deposit: " + rblpDeposit.toFixed(2) + " CDT"}
                            </Text>
                            {txType === 'withdraw' && (
                                <Checkbox
                                    id="swap-to-cdt-checkbox"
                                    isChecked={swapToCDT}
                                    onChange={() => setSwapToCDT(v => !v)}
                                    mt={4}
                                    fontWeight={"700"}
                                >
                                    Swap any USDC to CDT on exit
                                </Checkbox>
                            )}
                        </Stack>
                    </CardBody>
                    <CardFooter as={Stack} justifyContent="end" borderTop="1px solid" borderColor="whiteAlpha.200" pt="5" gap="5">
                        <HStack justify="space-between" width="100%">
                            <Stack align="center">
                                <Text fontSize="xl" fontWeight="bold">{yieldValue}%</Text>
                                <Text fontSize="sm" color="white">Estimated APY</Text>
                            </Stack>
                            <Stack align="center">
                                <Text fontSize="xl" fontWeight="bold">{dailyYield > 0 && dailyYield.toFixed(2) === "0.00" ? "< $0.01" : `$${dailyYield.toFixed(2)}`}</Text>
                                <Text fontSize="sm" color="white">Est. Per Day</Text>
                            </Stack>
                            <Stack align="center">
                                <Text fontSize="xl" fontWeight="bold">{yearlyYield > 0 && yearlyYield.toFixed(2) === "0.00" ? "< $0.01" : `$${yearlyYield.toFixed(2)}`}</Text>
                                <Text fontSize="sm" color="white">Est. Per Year</Text>
                            </Stack>
                        </HStack>

                        <HStack mt="0" gap="0">
                            <ConfirmModal
                                label={txType === "deposit" ? "Buy & Deposit Now" : "Withdraw & Lose Yield"}
                                action={txType === "deposit" ? swap : rblp}
                                isDisabled={txType === "deposit" ? isSwapDisabled : isRBLPDisabled}
                            >
                                <HomeSummary tokenOutMinAmount={tokenOutMinAmount} />
                            </ConfirmModal>
                        </HStack>
                    </CardFooter>
                </Card>
            </Stack>
        </>
    )
}

export default memo(AcquireCDTEntry) 
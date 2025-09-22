import { denoms, INPUT_DELAY } from "@/config/defaults"
import { useOraclePrice } from "@/hooks/useOracle"
import { Input, Stack, HStack, Text, Button, Card, Image } from "@chakra-ui/react"
import useQuickActionState from "../Home/hooks/useQuickActionState"
import useUSDCToMint from "../Home/hooks/useUSDCToMint"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import { ChangeEvent, useCallback, useRef, useState } from "react"
import { num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { parseError } from "@/helpers/parseError"
import { useChainRoute } from "@/hooks/useChainRoute"

export const USDCMintCard = () => {
    const { chainName } = useChainRoute()
    const { data: prices } = useOraclePrice()
    const usdcPrice = prices?.find((price) => price.denom === denoms.USDC[0])?.price ?? "1"
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const usdcBalance = Number(useBalanceByAsset(usdcAsset)) ?? 0


    const { quickActionState, setQuickActionState } = useQuickActionState()
    const { action: mint } = useUSDCToMint({ onSuccess: () => { }, run: true })
    const isLoading = mint?.simulate.isLoading || mint?.tx.isPending
    const isDisabled = usdcBalance === 0 || mint?.simulate.isError || !mint?.simulate.data

    //@ts-ignore
    const depositMaxAmount = usdcBalance
    const depositMinAmount = 25
    const [depositInputValue, setDepositInputValue] = useState<number | undefined>(); // Tracks user input
    const depositUpdateTimeout = useRef<NodeJS.Timeout | null>(null);

    const onDepositMaxClick = () => {
        setDepositInputValue(depositMaxAmount)
        setQuickActionState({
            usdcMint: {
                deposit: depositMaxAmount,
                mint: quickActionState?.usdcMint?.mint
            }
        })
    }

    const onDepositInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setDepositInputValue(num(value).isGreaterThan(depositMaxAmount) ? depositMaxAmount : value); // Updates the input value immediately

        if (depositUpdateTimeout.current) {
            clearTimeout(depositUpdateTimeout.current); // Clears previous timeout
        }

        depositUpdateTimeout.current = setTimeout(() => {
            setQuickActionState({
                usdcMint: {
                    deposit: num(value).isGreaterThan(depositMaxAmount) ? depositMaxAmount : value,
                    mint: quickActionState?.usdcMint?.mint
                }
            });
        }, INPUT_DELAY); // Delay before updating the state

    }, [quickActionState?.usdcMint.deposit, setQuickActionState, depositMaxAmount])


    //USDC to CDT amount conversion
    const mintMaxAmount = num(depositMaxAmount).times(usdcPrice).times(0.89).toNumber()
    const mintMinAmount = 21
    const [mintInputValue, setMintInputValue] = useState<number | undefined>(); // Tracks user input
    const mintUpdateTimeout = useRef<NodeJS.Timeout | null>(null);

    const onMintMaxClick = () => {
        setMintInputValue(mintMaxAmount)
        setQuickActionState({
            usdcMint: {
                mint: mintMaxAmount,
                deposit: depositMaxAmount
            }
        })
    }
    const onMintMinClick = () => {
        setMintInputValue(mintMinAmount)
        setQuickActionState({
            usdcMint: {
                mint: mintMinAmount,
                deposit: depositMinAmount
            }
        })
    }

    const onMintInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const value = Number(e.target.value)

        setMintInputValue(num(value).isGreaterThan(mintMaxAmount) ? mintMaxAmount : value < 20 ? mintMinAmount : value); // Updates the input value immediately

        if (mintUpdateTimeout.current) {
            clearTimeout(mintUpdateTimeout.current); // Clears previous timeout
        }

        mintUpdateTimeout.current = setTimeout(() => {
            setQuickActionState({
                usdcMint: {
                    mint: num(value).isGreaterThan(mintMaxAmount) ? mintMaxAmount : value,
                    deposit: quickActionState?.usdcMint?.deposit
                }
            });
        }, INPUT_DELAY); // Delay before updating the state

    }, [quickActionState?.usdcMint.mint, setQuickActionState, mintMaxAmount])

    return (
        <Card boxShadow={"0 0 25px rgba(90, 90, 90, 0.5)"} alignSelf={"center"} mt="3%">
            <Stack>
                <HStack width="100%" justifyContent="left">
                    <HStack width="75%">
                        <Image src={"https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/usdc.svg"} w="30px" h="30px" />
                        <Text variant="title" textTransform={"none"} textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                            Deposit USDC
                        </Text>
                    </HStack>
                </HStack>
                <Input
                    width={"100%"}
                    textAlign={"right"}
                    placeholder="0"
                    type="number"
                    variant={"ghost"}
                    value={depositInputValue}
                    max={depositMaxAmount}
                    onChange={onDepositInputChange}
                />
                <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                    <Button onClick={onDepositMaxClick} width="0%" variant="unstyled" fontWeight="normal">
                        <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                            max
                        </Text>
                    </Button>
                </HStack>
            </Stack>

            <Stack>
                <HStack width="100%" justifyContent="left">
                    <HStack width="75%">
                        <Image src={"/images/cdt.svg"} w="30px" h="30px" />
                        <Text variant="title" textTransform={"none"} textAlign="center" fontSize="lg" letterSpacing="1px" display="flex">
                            Borrow CDT
                        </Text>
                    </HStack>
                </HStack>
                <Input
                    width={"100%"}
                    textAlign={"right"}
                    placeholder="0"
                    type="number"
                    variant={"ghost"}
                    value={mintInputValue}
                    max={mintMaxAmount}
                    onChange={onMintInputChange}
                />
                <HStack alignContent={"right"} width={"100%"} justifyContent={"right"}>
                    <Button onClick={onMintMinClick} width="0%" variant="unstyled" fontWeight="normal">
                        <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                            min
                        </Text>
                    </Button>
                    <Button onClick={onMintMaxClick} width="0%" variant="unstyled" fontWeight="normal">
                        <Text variant="body" textTransform="none" fontSize="sm" letterSpacing="1px" display="flex">
                            max
                        </Text>
                    </Button>
                </HStack>

                <Text variant="title" textAlign="center" fontSize="lg" letterSpacing="1px" width="100%">
                    {parseError(quickActionState?.usdcMint.deposit > 0 && quickActionState?.usdcMint.mint > 20 && mint.simulate.isError ? mint.simulate.error?.message ?? "" : "")}
                </Text>

                <Text variant="title" marginTop="auto" textAlign="center" fontSize="sm" letterSpacing="1px" width="100%">
                    Minimum 25 USDC to Borrow
                </Text>
                <TxButton
                    w="100%"
                    mt="auto"
                    isLoading={isLoading}
                    isDisabled={isDisabled}
                    onClick={() => mint?.tx.mutate()}
                    toggleConnectLabel={false}
                    style={{ alignSelf: "center" }}
                >
                    Deposit & Borrow
                </TxButton>
            </Stack>
        </Card>
    )
}
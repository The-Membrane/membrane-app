import { num } from '@/helpers/num'
import { Stack, HStack, Text, Input, Button, Image } from '@chakra-ui/react'
import { useEffect, useMemo, useState } from 'react'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'

export type MintInputProps = {
    label?: string
}

export const MintInput = ({ label = "Mint CDT" }: MintInputProps) => {
    const { setMintState, mintState } = useMintState()
    const { data } = useVaultSummary()
    const [sumData, setSumData] = useState(data)
    const [mintInputValue, setMintInputValue] = useState<number>(0)

    useEffect(() => {
        if (data != undefined) setSumData(data)
    }, [data])

    const { debtAmount, maxMint } = sumData || {
        debtAmount: 0,
        cost: 0,
        tvl: 0,
        ltv: 0,
        borrowLTV: 0,
        liquidValue: 0,
        liqudationLTV: 0,
        maxMint: 0,
    }

    const CDT = useAssetBySymbol('CDT')
    const walletCDT = useBalanceByAsset(CDT)

    const mintMaxAmount = useMemo(() => {
        if (num(maxMint).minus(debtAmount).dp(0).toNumber() < 0) return 0
        return num(maxMint).minus(debtAmount).dp(2).toNumber()
    }, [maxMint, debtAmount])

    const handleInputChange = (value: number) => {
        const newValue = num(value).dp(2).toNumber()
        setMintInputValue(newValue)

        // Check for minimum debt
        if (newValue < 20 && newValue != 0 && !mintState?.belowMinDebt) {
            setMintState({ belowMinDebt: true })
        } else if ((newValue >= 20 || newValue === 0) && mintState?.belowMinDebt) {
            setMintState({ belowMinDebt: false })
        }

        const currentDebt = num(debtAmount)
        const targetValue = num(newValue)

        let mint = 0
        let repay = 0

        if (targetValue.isGreaterThan(currentDebt)) {
            mint = targetValue.minus(currentDebt).toNumber()
        } else {
            repay = currentDebt.minus(targetValue).toNumber()
        }

        // Handle repay limitations based on wallet balance
        if (repay > parseFloat(walletCDT)) {
            repay = parseFloat(walletCDT)
        }

        // Calculate new LTV
        const ltvSlider = newValue > 0
            ? num(newValue).times(100).dividedBy(maxMint ?? 1).dp(2).toNumber()
            : 0

        setMintState({
            mint,
            repay,
            ltvSlider,
            newDebtAmount: newValue
        })
    }

    const onMintInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseFloat(e.target.value)
        if (!isNaN(value)) {
            handleInputChange(value)
        }
    }

    const onMintMinClick = () => {
        handleInputChange(20) // Minimum debt amount
    }

    const onMintMaxClick = () => {
        handleInputChange(mintMaxAmount)
    }

    return (
        <Stack>
            <HStack width="100%" justifyContent="left">
                <HStack width="75%">
                    <Image src={"/images/cdt.svg"} w="30px" h="30px" />
                    <Text
                        variant="title"
                        textTransform="none"
                        textAlign="center"
                        fontSize="lg"
                        letterSpacing="1px"
                        display="flex"
                    >
                        {label}
                    </Text>
                </HStack>
            </HStack>
            <Input
                width="100%"
                textAlign="right"
                placeholder="0"
                type="number"
                variant="ghost"
                value={mintInputValue?.toFixed(2)}
                max={mintMaxAmount}
                onChange={onMintInputChange}
            />
            <HStack alignContent="right" width="100%" justifyContent="right">
                <Button
                    onClick={onMintMinClick}
                    width="20%"
                    variant="unstyled"
                    fontWeight="normal"
                >
                    <Text
                        variant="body"
                        textTransform="none"
                        fontSize="sm"
                        letterSpacing="1px"
                        display="flex"
                    >
                        min
                    </Text>
                </Button>
                <Button
                    onClick={onMintMaxClick}
                    width="20%"
                    variant="unstyled"
                    fontWeight="normal"
                >
                    <Text
                        variant="body"
                        textTransform="none"
                        fontSize="sm"
                        letterSpacing="1px"
                        display="flex"
                    >
                        max
                    </Text>
                </Button>
            </HStack>
        </Stack>
    )
}
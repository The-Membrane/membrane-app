import { Button, Card, HStack, Input, Stack, Text } from '@chakra-ui/react'
import { TxButton } from '../TxButton'
import { Basket } from '@/contracts/codegen/positions/Positions.types'
import { num } from '@/helpers/num'
import React, { ChangeEvent } from 'react'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import useBuyAndRedeem from './hooks/useBuyAndRedeem'
import useQuickActionState from './hooks/useQuickActionState'



export const HomeRedeemButton = React.memo(({ basket, cdtMarketPrice }: { basket: Basket | undefined, cdtMarketPrice: number }) => {

    const { quickActionState, setQuickActionState } = useQuickActionState()
    const usdcAsset = useAssetBySymbol('USDC')
    const USDCBalance = useBalanceByAsset(usdcAsset)

    const { action: redeem } = useBuyAndRedeem()
    console.log("redeem", redeem.simulate.data, redeem.simulate.isError, redeem.simulate.error)


    const handleRedeemInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        setQuickActionState({ redeemSwapAmount: parseInt(e.target.value) })
    }

    return (

        <Stack py="5" w="full" gap="3" mb={"0"} >
            <Text variant="body"> {num(0.985).minus(cdtMarketPrice).times(100).toFixed(2)}% instant arbitrage available, input to collect:</Text>
            <HStack>
                <Input
                    width={"40%"}
                    textAlign={"center"}
                    placeholder="0"
                    type="number"
                    value={quickActionState.redeemSwapAmount ?? 0}
                    max={USDCBalance}
                    onChange={handleRedeemInputChange}
                />
                {/* Redeem Button */}
                <TxButton
                    maxW="75px"
                    isLoading={redeem?.simulate.isLoading || redeem?.tx.isPending}
                    isDisabled={redeem?.simulate.isError || !redeem?.simulate.data}
                    onClick={() => redeem?.tx.mutate()}
                    toggleConnectLabel={false}
                    style={{ alignSelf: "end" }}
                >
                    Collect
                </TxButton>
            </HStack>
        </Stack>
    )
})
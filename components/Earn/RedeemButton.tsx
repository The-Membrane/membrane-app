import { Button, Card, HStack, Input, Stack, Text } from '@chakra-ui/react'
import { TxButton } from '../TxButton'
import type { EvmBasket } from '@/services/chain/cdp'
import useEarnState from './hooks/useEarnState'
import { num } from '@/helpers/num'
import React, { ChangeEvent } from 'react'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import useCDPRedeem from './hooks/useCDPRedeem'



// TODO(evm-migration): CDT redemption is stubbed (no user-facing redemption surface in
// the port — see useCDPRedeem); EvmBasket carries no credit_price (separate getCreditPrice
// read), so the price hint renders $0 until this section is redesigned or removed.
export const RedeemButton = React.memo(({ basket }: { basket: EvmBasket | undefined }) => {

    const { earnState, setEarnState } = useEarnState()
    const cdtAsset = useAssetBySymbol('CDT')
    const CDTBalance = useBalanceByAsset(cdtAsset)

    const { action: redeem } = useCDPRedeem()
    console.log("redeem", redeem.simulate.data, redeem.simulate.isError, redeem.simulate.error)


    const handleRedeemInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        setEarnState({ redeemAmount: parseInt(e.target.value) })
    }

    return (

        <Stack py="5" w="full" gap="3" mb={"0"} >
            <Text variant="body"> Did you buy CDT {`<= $`}{num((basket as any)?.credit_price?.price ?? "0").multipliedBy(0.985).toFixed(3)}?</Text>
            <HStack>
                <Input
                    width={"40%"}
                    textAlign={"center"}
                    placeholder="0"
                    type="number"
                    value={earnState.redeemAmount ?? 0}
                    max={CDTBalance}
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
                    Redeem
                </TxButton>
            </HStack>
        </Stack>
    )
})
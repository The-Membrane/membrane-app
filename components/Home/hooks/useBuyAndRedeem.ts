import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import { PositionsMsgComposer } from '@/contracts/codegen/positions/Positions.message-composer'
import { denoms } from '@/config/defaults'

import useBalance from '@/hooks/useBalance'
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { toUtf8 } from "@cosmjs/encoding";
import { useOraclePrice } from '@/hooks/useOracle'
import { useBasket } from '@/hooks/useCDP'
import { num } from '@/helpers/num'
import useQuickActionState from './useQuickActionState'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { swapToCDTMsg } from '@/helpers/osmosis'

//NOTE: This and the Redeem function in Earn/hooks/useCDPRedeem.ts both assume the only redeemed asset is marsUSDC
const useBuyAndRedeem = () => {
    const { address } = useWallet()
    const { quickActionState } = useQuickActionState()
    const { data: basket } = useBasket()
    const { data: prices } = useOraclePrice()
    const usdcAsset = useAssetBySymbol('USDC')


    type QueryData = {
        msgs: MsgExecuteContractEncodeObject[] | undefined
    }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'home_page_swap_and_redeem_msg_creation',
            address,
            quickActionState.redeemSwapAmount,
            prices,
            basket,
            usdcAsset
        ],
        queryFn: () => {
            if (!address || quickActionState.redeemSwapAmount === 0 || !prices || !basket || !usdcAsset) return { msgs: undefined }
            var msgs = [] as MsgExecuteContractEncodeObject[]
            const cdtPrice = parseFloat(prices?.find((price) => price.denom === denoms.CDT[0])?.price ?? "0")


            //Set max slippage to the difference between market prie & 0.985 
            const maxSlippage = num(0.985 - cdtPrice).times(100).dp(2).toNumber()
            //We don't render this if price is higher so this should be safe logic

            //1) Swap USDC to CDT
            const { msg: swap, tokenOutMinAmount, foundToken } = swapToCDTMsg({
                address,
                swapFromAmount: quickActionState?.redeemSwapAmount, //This will add decimals
                swapFromAsset: usdcAsset,
                prices,
                cdtPrice,
                tokenOut: 'CDT',
                slippage: maxSlippage
            })
            msgs.push(swap as MsgExecuteContractEncodeObject)

            //2) Redeem using the swapped for CDT 
            let messageComposer = new PositionsMsgComposer(address, contracts.cdp)
            const redemptionAmount = tokenOutMinAmount.toString()
            const funds = [{ amount: redemptionAmount, denom: denoms.CDT[0].toString() }]
            let redeemMsg = messageComposer.redeemCollateral({ maxCollateralPremium: "1" }, funds)
            msgs.push(redeemMsg)

            /////How many marsUSDC VT tokens will we redeem at a 1% discount using the CDT paid?///
            //CDT peg price * 99% * (cdtAmount - fee) = value redeemed
            const cdtRedemptionPrice = num(basket?.credit_price.price ?? "0").multipliedBy(0.99)
            const redemptionAmountMinusFee = num(redemptionAmount).multipliedBy(0.995)
            const valueRedeemed = cdtRedemptionPrice.multipliedBy(redemptionAmountMinusFee)

            //valueRedeemed / marsUSDC VT token price = VT tokens redeemed
            const vtPrice = parseFloat(prices?.find((price) => price.denom === "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized")?.price ?? "0")
            const vtTokensRedeemed = shiftDigits(valueRedeemed.dividedBy(vtPrice).toString(), 6).dp(0)

            // console.log("vt tokens redeemed", vtTokensRedeemed.toString(), "vt price", vtPrice.toString(), "prices", prices)

            //3) Withdraw redeemed VT
            const fundsVT = [{ amount: vtTokensRedeemed.toString(), denom: "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized" }]
            let withdrawMsg = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: contracts.marsUSDCvault,
                    msg: toUtf8(JSON.stringify({
                        exit_vault: {}
                    })),
                    funds: fundsVT
                })
            } as MsgExecuteContractEncodeObject
            msgs.push(withdrawMsg)

            return { msgs }
        },
        enabled: !!address,
    })

    const { msgs }: QueryData = useMemo(() => {
        if (!queryData) return { msgs: undefined }
        else return queryData
    }, [queryData])

    console.log("redeem msg:", msgs)

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['useVaultInfo'] })
        queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['home_page_swap_and_redeem_sim', (msgs?.toString() ?? "0")],
            onSuccess: onInitialSuccess,
            enabled: !!msgs,
        })
    }
}

export default useBuyAndRedeem

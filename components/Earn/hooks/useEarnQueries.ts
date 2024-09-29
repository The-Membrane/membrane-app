import { useOraclePrice } from "@/hooks/useOracle"
import contracts from '@/config/contracts.json'
import { cdpClient } from "@/services/cdp"
import { getUnderlyingUSDC, getVaultAPRResponse } from "@/services/earn"
import { useQuery } from "@tanstack/react-query"
import { num, shiftDigits } from "@/helpers/num"
import { useBasket } from "@/hooks/useCDP"
import { useRpcClient } from "@/hooks/useRpcClient"

export const useVaultTokenUnderlying = (vtAmount: string) => {
    return useQuery({
        queryKey: ['useVaultTokenUnderlying', vtAmount],
        queryFn: async () => {
        return getUnderlyingUSDC(vtAmount)
        },
    })
}

export const useAPR = () => {
    return useQuery({
        queryKey: ['useAPR'],
        queryFn: async () => {
        return getVaultAPRResponse()
        },
    })
}

export const useVaultInfo = () => {
    const { data: prices } = useOraclePrice()
    const { data: basket } = useBasket()
    const { data: apr } = useAPR()
    const { getRpcClient } = useRpcClient("osmosis")
    
    return useQuery({
        queryKey: ['useVaultInfo', apr, prices, basket],
        queryFn: async () => {
            
            //Query Vault's CDP 
            const client = await cdpClient()            
            const vaultCDPs = await client.getBasketPositions({
                user: contracts.earn,
            })
            const vaultCDP = vaultCDPs?.[0]?.positions?.[0]

            ////Get value of the position's collateral///
            //Find price of the collateral
            //@ts-ignore
            const collateralPrice = prices?.find((price) => price.denom === vaultCDP.collateral_assets[0].asset.info.native_token.denom)?.price??"0"
            //Get the amount of collateral
            const collateralAmount = shiftDigits(vaultCDP.collateral_assets[0].asset.amount, -12)
            //Calculate the value of the collateral
            const collateralValue = num(collateralAmount).times(collateralPrice)

            ////Get value of the position's debt///
            //Normalize the debt amount
            const debtAmount = shiftDigits(vaultCDP.credit_amount, -6)
            //Set price from basket peg
            const debtPrice = basket?.credit_price.price??"0"
            //Calc the value of the debt
            const debtValue = num(debtAmount).times(debtPrice)

            //Find ratio of debt to collateral
            const debtToCollateral = num(debtValue).div(collateralValue)

            ////Get the leverage///
            //Query balance of the buffer in the vault
            const rpcClient = await getRpcClient()
            const earnBalances = await rpcClient.cosmos.bank.v1beta1
                .allBalances({
                address: contracts.earn,
                pagination: {
                    key: new Uint8Array(),
                    offset: BigInt(0),
                    limit: BigInt(1000),
                    countTotal: false,
                    reverse: false,
                },
                })
                .then((res) => {
                return res.balances
            })
            //Find the amount of the buffer
            const bufferAmount = earnBalances?.find((balance) => balance.denom === "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized")?.amount??"0"

            //Add buffer amount to the collateral amount
            const totalVTokens = num(collateralAmount).plus(shiftDigits(bufferAmount, -12))
            //Calculate the value of the total vTokens
            const totalVTValue = num(totalVTokens).times(collateralPrice)
            //Subtract the debt value from the total vToken value to find the unleveraged value
            const unleveragedValue = num(totalVTValue).minus(debtValue)

            //Find the leverage
            const leverage = totalVTValue.div(unleveragedValue)
            console.log("leverage logs", leverage.toString(), totalVTValue.toString(), unleveragedValue.toString(), debtValue.toString())


            //////////////////

            //Calc the cost of the debt using the ratio of debt to collateral * the leverage
            const cost = num(debtToCollateral).times(apr?.cost??"0")
            console.log("Earn cost", cost.toString())
            return {
                collateralValue,
                debtValue,
                leverage,
                cost,
            }
        },
    })

}
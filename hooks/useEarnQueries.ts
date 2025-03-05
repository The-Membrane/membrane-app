import { useOraclePrice } from "@/hooks/useOracle"
import contracts from '@/config/contracts.json'
import { cdpClient, getUserDiscount } from "@/services/cdp"
import { getUnderlyingUSDC, getUnderlyingCDT, getBoundedTVL, getBoundedUnderlyingCDT, getVaultAPRResponse, getEarnUSDCRealizedAPR, getEstimatedAnnualInterest, getEarnCDTRealizedAPR, getBoundedCDTRealizedAPR, getBoundedConfig, getBoundedIntents, getDepositTokenConversionforMarsUSDC, getMarsUSDCSupplyAPR } from "@/services/earn"
import { useQueries, useQuery } from "@tanstack/react-query"
import { num, shiftDigits } from "@/helpers/num"
import { useBasket, useBasketAssets, useBasketPositions, useCollateralInterest } from "@/hooks/useCDP"
import { useRpcClient } from "@/hooks/useRpcClient"
import useBidState from "@/components/Bid/hooks/useBidState"
import { useBalanceByAsset } from "@/hooks/useBalance"
import { useAssetBySymbol } from "@/hooks/useAssets"
import useWallet from "@/hooks/useWallet"
import { mainnetAddrs } from "@/config/defaults"
import { CollateralInterestResponse } from "@/contracts/codegen/positions/Positions.types"
import useAppState from "@/persisted-state/useAppState"

export const useBoundedConfig = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['use_Bounded_Config_plz_run'],
        queryFn: async () => {
            return getBoundedConfig(appState.rpcUrl)
        },
        staleTime: 1000 * 60 * 5,
    })
}

// export const useBoundedPositions = () => {
//     return useQuery({
//         queryKey: ['useBoundedPositions'],
//         queryFn: async () => {
//             return getCLPositionsForVault()
//         },
//     })
// }

export const useUserBoundedIntents = () => {
    const { address } = useWallet()
    const { appState } = useAppState()

    const result = useQuery({
        queryKey: ['useUserBoundedIntents', address],
        queryFn: async () => {
            if (!address) return

            // If we need fresh data, fetch from API
            return getBoundedIntents(appState.rpcUrl).then((intents) => {
                return intents.filter((intent) => intent.user === address)
            })
        },
    })

    return result

}

export const useBoundedIntents = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useBoundedIntents'],
        queryFn: async () => {
            return getBoundedIntents(appState.rpcUrl)
        },
        staleTime: 1000 * 60 * 5,
    })
}

export const useBoundedTVL = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useBoundedTVL'],
        queryFn: async () => {
            return getBoundedTVL(appState.rpcUrl)
        },
        staleTime: 1000 * 60 * 5,
    })
}

export const useUSDCVaultTokenUnderlying = (vtAmount: string) => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useUSDCVaultTokenUnderlying', vtAmount],
        queryFn: async () => {
            return getUnderlyingUSDC(vtAmount, appState.rpcUrl)
        },
    })
}
export const useCDTVaultTokenUnderlying = (vtAmount: string) => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useCDTVaultTokenUnderlying', vtAmount],
        queryFn: async () => {
            return getUnderlyingCDT(vtAmount, appState.rpcUrl)
        },
    })
}

export const useDepositTokenConversionforMarsUSDC = (depositAmount: string) => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useDepositTokenConversionforMarsUSDC', depositAmount],
        queryFn: async () => {
            return getDepositTokenConversionforMarsUSDC(depositAmount, appState.rpcUrl)
        },
    })
}

export const useBoundedCDTVaultTokenUnderlying = (vtAmount: string) => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useBoundedCDTVaultTokenUnderlying', vtAmount],
        queryFn: async () => {
            return getBoundedUnderlyingCDT(vtAmount, appState.rpcUrl)
        },
    })
}

export const useEarnUSDCEstimatedAPR = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useEarnUSDCEstimatedAPR'],
        queryFn: async () => {
            return getVaultAPRResponse(appState.rpcUrl)
        },
    })
}

export const useMarsUSDCSupplyAPR = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useMarsUSDCSupplyAPR'],
        queryFn: async () => {
            return (await getMarsUSDCSupplyAPR(appState.rpcUrl))?.liquidity_rate ?? 0
        },
    })
}

export const useEarnUSDCRealizedAPR = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useEarnUSDCRealizedAPR'],
        queryFn: async () => {
            const claimTracker = await getEarnUSDCRealizedAPR(appState.rpcUrl)
            const currentClaim = await getUnderlyingUSDC("1000000000000", appState.rpcUrl)
            const blockTime = await cdpClient(appState.rpcUrl).then(client => client.client.getBlock()).then(block => Date.parse(block.header.time) / 1000)
            const time_since_last_checkpoint = blockTime - claimTracker.last_updated
            const currentClaimTracker = {
                vt_claim_of_checkpoint: num(currentClaim).minus(40237).toString(), //subtracting gains from the exit bug
                time_since_last_checkpoint
            }
            console.log("claim tracker", currentClaimTracker)

            //Add the current claim to the claim tracker
            claimTracker.vt_claim_checkpoints.push(currentClaimTracker)
            //Parse the claim tracker to get the realized APR//
            const runningDuration = claimTracker.vt_claim_checkpoints.reduce((acc, checkpoint) => {
                return acc + checkpoint.time_since_last_checkpoint
            }, 0);

            var APR = num(claimTracker.vt_claim_checkpoints[claimTracker.vt_claim_checkpoints.length - 1].vt_claim_of_checkpoint).dividedBy(claimTracker.vt_claim_checkpoints[0].vt_claim_of_checkpoint).minus(1)
            var negative = false

            //If the APR is negative, set the negative flag to true and multiply the APR by -1
            if (APR.toNumber() < 0) {
                APR = APR.times(-1)
                negative = true
            }

            // console.log("APR calcs", APR.dividedBy(runningDuration/(86400*365)).toString(), runningDuration.toString(), claimTracker)

            //Divide the APR by the duration in years
            return { apr: APR.dividedBy(runningDuration / (86400 * 365)).toString(), negative, runningDuration: num(runningDuration).dividedBy(86400).dp(0) }

        },
    })
}

export const useEarnCDTRealizedAPR = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useCDTUSDCRealizedAPR'],
        queryFn: async () => {
            const claimTracker = await getEarnCDTRealizedAPR(appState.rpcUrl)
            const currentClaim = await getUnderlyingCDT("1000000000000", appState.rpcUrl)
            const blockTime = await cdpClient(appState.rpcUrl).then(client => client.client.getBlock()).then(block => Date.parse(block.header.time) / 1000)
            const time_since_last_checkpoint = blockTime - claimTracker.last_updated
            const currentClaimTracker = {
                vt_claim_of_checkpoint: num(currentClaim).toString(), //subtracting gains from the exit bug
                time_since_last_checkpoint
            }
            console.log("Manic Vault claim tracker", currentClaimTracker)

            //Add the current claim to the claim tracker
            claimTracker.vt_claim_checkpoints.push(currentClaimTracker)
            //Parse the claim tracker to get the realized APR//
            const runningDuration = claimTracker.vt_claim_checkpoints.reduce((acc, checkpoint) => {
                return acc + checkpoint.time_since_last_checkpoint
            }, 0);

            //We are skipping the first checkpoint because it saved incorrectly in state
            var APR = num(claimTracker.vt_claim_checkpoints[claimTracker.vt_claim_checkpoints.length - 1].vt_claim_of_checkpoint).dividedBy(claimTracker.vt_claim_checkpoints[0].vt_claim_of_checkpoint).minus(1)
            var negative = false

            //If the APR is negative, set the negative flag to true and multiply the APR by -1
            if (APR.toNumber() < 0) {
                APR = APR.times(-1)
                negative = true
            }

            // console.log("APR calcs", APR.dividedBy(runningDuration/(86400*365)).toString(), runningDuration.toString(), claimTracker)

            //Divide the APR by the duration in years
            return { apr: APR.dividedBy(runningDuration / (86400 * 365)).toString(), negative, runningDuration: num(runningDuration).dividedBy(86400).dp(0) }

        },
    })
}


export const useBoundedCDTRealizedAPR = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useBoundedCDTRealizedAPR'],
        queryFn: async () => {
            const claimTracker = await getBoundedCDTRealizedAPR(appState.rpcUrl)
            const currentClaim = await getBoundedUnderlyingCDT("1000000000000", appState.rpcUrl)
            const blockTime = await cdpClient(appState.rpcUrl).then(client => client.client.getBlock()).then(block => Date.parse(block.header.time) / 1000)
            const time_since_last_checkpoint = blockTime - claimTracker.last_updated
            const currentClaimTracker = {
                vt_claim_of_checkpoint: num(currentClaim).toString(),
                time_since_last_checkpoint
            }
            console.log("autoSP claim tracker", currentClaimTracker)

            //Add the current claim to the claim tracker
            claimTracker.vt_claim_checkpoints.push(currentClaimTracker)
            //Parse the claim tracker to get the realized APR//
            const runningDuration = claimTracker.vt_claim_checkpoints.reduce((acc, checkpoint) => {
                return acc + checkpoint.time_since_last_checkpoint
            }, 0);

            var APR = num(claimTracker.vt_claim_checkpoints[claimTracker.vt_claim_checkpoints.length - 1].vt_claim_of_checkpoint).dividedBy(claimTracker.vt_claim_checkpoints[1].vt_claim_of_checkpoint).minus(1)
            var negative = false

            //If the APR is negative, set the negative flag to true and multiply the APR by -1
            if (APR.toNumber() < 0) {
                APR = APR.times(-1)
                negative = true
            }

            // console.log("APR calcs", APR.dividedBy(runningDuration/(86400*365)).toString(), runningDuration.toString(), claimTracker)

            //Divide the APR by the duration in years
            return { apr: APR.dividedBy(runningDuration / (86400 * 365)).toString(), negative, runningDuration: num(runningDuration).dividedBy(86400).dp(0) }

        },
    })
}

//Get the CDTBalance of the rangebound LP vault
export const useRBLPCDTBalance = () => {
    const { getRpcClient } = useRpcClient("osmosis")

    return useQuery({
        queryKey: ['useRBLPCDTBalance'],
        queryFn: async () => {
            //Query balance of the buffer in the vault
            const rpcClient = await getRpcClient()
            const rbLPBalances = await rpcClient.cosmos.bank.v1beta1
                .allBalances({
                    address: mainnetAddrs.rangeboundLP,
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
            return rbLPBalances?.find((balance) => balance.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt")?.amount ?? "0"
        },
        staleTime: 1000 * 60 * 5,
    })
}

export const getBoundedCDTBalance = () => {
    const boundCDTAsset = useAssetBySymbol("range-bound-CDT")
    const boundCDTBalance = useBalanceByAsset(boundCDTAsset)
    console.log("bound balance", boundCDTAsset, boundCDTBalance)

    //Get VTs that are in RBLP's intents
    const { data } = useUserBoundedIntents()
    console.log("user intents", data)

    return useQuery({
        queryKey: ['getBoundedCDTBalance', data, boundCDTBalance],
        queryFn: async () => {
            if (!data || !boundCDTBalance) return "0"
            const intents = data
            console.log("hello", intents)
            console.log("hello1", intents[0].intent)
            console.log("hello2", intents[0].intent.vault_tokens)
            const totalVTs = num(boundCDTBalance).plus(intents[0].intent.vault_tokens).toString()
            console.log("made it here", intents, totalVTs)

            const { data: underlyingData } = useBoundedCDTVaultTokenUnderlying(num(shiftDigits(totalVTs, 6)).toFixed(0))
            console.log("underlyiG", underlyingData, totalVTs, shiftDigits(underlyingData ?? "1000000", -6).toString() ?? "0")
            return shiftDigits(underlyingData ?? "1000000", -6).toString()
        },
        staleTime: 1000 * 60 * 5,
    })
    ////////////////////////////////////
}

export const useBoundedCDTBalance = () => {
    return useQuery({
        queryKey: ['useBoundedCDTBalance'],
        queryFn: async () => {
            return getBoundedCDTBalance()
        },
        staleTime: 1000 * 60 * 5,
    })
}

export const simpleBoundedAPRCalc = (cdpDebt: number, interest: CollateralInterestResponse, vaultCDT: any, manicDebt: number) => {
    if (!cdpDebt || !interest || !vaultCDT) {
        return "0"
    }


    cdpDebt = Number(shiftDigits(cdpDebt, 6));

    //Get the lowest rate
    const sortedRates = interest.rates
        .filter(rate => !isNaN(Number(rate)))  // Ensure all elements are numbers
        .sort((a, b) => Number(a) - Number(b));

    const totalDebt = cdpDebt - manicDebt
    const estimatedRate = sortedRates.length > 0 ? sortedRates[0] : null;
    const estimatedRevenue = estimatedRate ? num(estimatedRate).times(totalDebt) : num(0);

    const apr = num(estimatedRevenue)
        .times(0.80)
        .dividedBy(vaultCDT)
        .toString()

    return apr
}

export const useEstimatedAnnualInterest = (useDiscounts: boolean) => {
    const { data: prices } = useOraclePrice()
    const { data: allPositions } = useBasketPositions()
    // console.log("AP in interstquery", allPositions) 
    const { data: basketAssets } = useBasketAssets()
    const { setBidState } = useBidState()
    const { appState } = useAppState()


    const userDiscountQueries = useDiscounts ? useQueries({
        queries: (allPositions || []).map((basketPosition) => ({
            queryKey: ['user', 'discount', 'cdp', basketPosition.user],
            queryFn: async () => {
                // console.log(`Fetching discount for address: ${basketPosition.user}`);
                if (basketPosition.positions.reduce((acc, position) => acc + parseInt(position.credit_amount), 0) <= 1000) return { discount: 0 }
                return getUserDiscount(basketPosition.user, appState.rpcUrl)
            },
            staleTime: 60000, // 60 seconds (adjust based on your needs)
        })) || [],
    }) : [];

    return useQuery({
        queryKey: ['useEstimatedAnnualInterest',
            allPositions,
            prices,
            basketAssets,
            userDiscountQueries.map((query) => query.data), // Extract data for stability
            setBidState
        ],
        queryFn: async () => {
            if (!allPositions || !prices || !basketAssets || !setBidState || !userDiscountQueries.every(query => query.isSuccess || query.failureReason?.message === "Query failed with (6): Generic error: Querier contract error: alloc::vec::Vec<membrane::types::StakeDeposit> not found: query wasm contract failed: query wasm contract failed: unknown request")) { console.log("revenue calc attempt", allPositions, !prices, !basketAssets); return { totalExpectedRevenue: 0, undiscountedTER: 0 } }

            const cdpCalcs = getEstimatedAnnualInterest(allPositions, prices, userDiscountQueries, basketAssets)
            // console.log("cdpCalcs", cdpCalcs)

            setBidState({ cdpExpectedAnnualRevenue: cdpCalcs.totalExpectedRevenue })

            console.log("undiscounted total expected annual revenue", cdpCalcs.undiscountedTER.toString())
            console.log("total expected annual revenue", cdpCalcs.totalExpectedRevenue.toString())

            return cdpCalcs
        },
    })
}


export const useVaultInfo = () => {
    const { data: prices } = useOraclePrice()
    const { data: basket } = useBasket()
    const { data: apr } = useEarnUSDCEstimatedAPR()
    const { getRpcClient } = useRpcClient("osmosis")
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['useVaultInfo', apr, prices, basket],
        queryFn: async () => {

            //Query Vault's CDP 
            const client = await cdpClient(appState.rpcUrl)
            const vaultCDPs = await client.getBasketPositions({
                user: contracts.earn,
            })
            const vaultCDP = vaultCDPs?.[0]?.positions?.[0]

            ////Get value of the position's collateral///
            //Find price of the collateral
            //@ts-ignore
            const collateralPrice = prices?.find((price) => price.denom === vaultCDP.collateral_assets[0].asset.info.native_token.denom)?.price ?? "0"
            //Get the amount of collateral
            const collateralAmount = shiftDigits(vaultCDP.collateral_assets[0].asset.amount, -12)
            //Calculate the value of the collateral
            const collateralValue = num(collateralAmount).times(collateralPrice)

            ////Get value of the position's debt///
            //Normalize the debt amount
            const debtAmount = shiftDigits(vaultCDP.credit_amount, -6)
            //Set price from basket peg
            const debtPrice = basket?.credit_price.price ?? "0"
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
            const bufferAmount = earnBalances?.find((balance) => balance.denom === "factory/osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l/mars-usdc-tokenized")?.amount ?? "0"
            console.log("bufferAmount", bufferAmount, earnBalances)

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
            const cost = 0
            //num(debtToCollateral).times(basket?.lastest_collateral_rates[31].rate || 1)
            console.log("Earn cost", cost.toString(), debtToCollateral.toString(), basket?.lastest_collateral_rates[31], leverage.toString())
            return {
                totalTVL: totalVTValue,
                unleveragedValue,
                collateralValue,
                debtValue,
                leverage,
                cost,
                debtAmount: parseInt(shiftDigits(vaultCDP?.credit_amount, -6))
            }
        },
    })

}

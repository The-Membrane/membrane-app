import { cdtRoutes, denoms, mainnetAddrs, rpcUrl, SWAP_SLIPPAGE, clPositions } from "@/config/defaults";
import { getPriceByDenom, Price } from "@/services/oracle";
import { Coin, coin, coins } from "@cosmjs/amino";

import { calcAmountWithSlippage, calcShareOutAmount, convertGeckoPricesToDenomPriceHash, LiquidityPoolCalculator } from "@osmonauts/math";

import { osmosis } from 'osmojs';
import { exported_supportedAssets } from "@/helpers/chain";
import { PositionsMsgComposer } from "@/contracts/codegen/positions/Positions.message-composer";

import { asset_list, assets } from '@chain-registry/osmosis';
import BigNumber from "bignumber.js";
import { MsgExecuteContractEncodeObject } from "@cosmjs/cosmwasm-stargate";
import { EncodeObject } from "@cosmjs/proto-signing";
import { Basket, BasketPositionsResponse, Asset as CDPAsset } from "@/contracts/codegen/positions/Positions.types";
import { Asset } from '@/helpers/chain'
import { useEffect, useState } from "react";
import { getAssetRatio, getPositions, getUserPositions, Positions, updatedSummary } from "@/services/cdp";
import useMintState from "@/components/Mint/hooks/useMintState";
import useVaultSummary from "@/components/Mint/hooks/useVaultSummary";
import { useOraclePrice } from "@/hooks/useOracle";
import { useBasket, useUserPositions } from "@/hooks/useCDP";
import { useBalanceByAsset } from "@/hooks/useBalance";
import { useAssetBySymbol } from "@/hooks/useAssets";
import { num } from "@/helpers/num";
import useWallet from "@/hooks/useWallet";
import useQuickActionVaultSummary from "@/components/Home/hooks/useQuickActionVaultSummary";
import { shiftDigits } from "@/helpers/math";
import { useQueries, useQuery } from "@tanstack/react-query";
import { position } from "@chakra-ui/react";
import { getBoundedConfig } from "./earn";
import { useBoundedConfig } from "@/hooks/useEarnQueries";
import useAppState from "@/persisted-state/useAppState";


const secondsInADay = 24 * 60 * 60;
type SwapAmountInRoute = {
    poolId: any,
    tokenOutDenom: string,
}

export interface swapRoutes {
    OSMO: SwapAmountInRoute[],
    ATOM: SwapAmountInRoute[],
    "USDC.axl": SwapAmountInRoute[],
    USDC: SwapAmountInRoute[],
    stATOM: SwapAmountInRoute[],
    stOSMO: SwapAmountInRoute[],
    TIA: SwapAmountInRoute[],
    USDT: SwapAmountInRoute[],
    MBRN: SwapAmountInRoute[],
    CDT: SwapAmountInRoute[],
    milkTIA: SwapAmountInRoute[],
    stTIA: SwapAmountInRoute[],
    ETH: SwapAmountInRoute[],
    WBTC: SwapAmountInRoute[],
    "WBTC.axl": SwapAmountInRoute[],
    INJ: SwapAmountInRoute[],
};

const {
    joinPool,
    exitPool,
    joinSwapExternAmountIn,
    swapExactAmountIn,
} = osmosis.gamm.v1beta1.MessageComposer.withTypeUrl;
const {
    lockTokens,
    beginUnlocking
} = osmosis.lockup.MessageComposer.withTypeUrl;

function getPositionLTV(position_value: number, credit_amount: number, basket: Basket) {
    let debt_value = (credit_amount) * parseFloat(basket.credit_price.price ?? "1");

    return debt_value / position_value;
}

export const OsmosisClient = async (rpcUrl: string) => {
    const { createRPCQueryClient } = osmosis.ClientFactory;
    console.log("osmosis CW client")
    const osmosisClient = await createRPCQueryClient({ rpcEndpoint: rpcUrl })
    return osmosisClient
}


export const useOsmosisClient = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['osmosis_client', appState.rpcUrl],
        queryFn: async () => {
            return OsmosisClient(appState.rpcUrl)
        },
        staleTime: 60000, // 60 seconds (adjust based on your needs)
    })
};

//Pool info
export const getPoolInfo = async (poolId: string, osmosisClient: any) => {
    const pool = await osmosisClient.osmosis.poolmanager.v1beta1.pool({
        poolId: BigInt(poolId),
    })
    return pool
}

//Pool Liquidity
export const getPoolLiquidity = async (poolId: string, osmosisClient: any) => {
    const liquidity = await osmosisClient.osmosis.poolmanager.v1beta1.totalPoolLiquidity({
        poolId: BigInt(poolId),
    })
    return liquidity
}

//Spread Rewards, not incentives
const getCLRewards = async (positionId: string, osmosisClient: any) => {
    const rewards = await osmosisClient.osmosis.concentratedliquidity.v1beta1.claimableSpreadRewards({
        positionId: BigInt(positionId),
    })
    return rewards
}

//Position assets
const getCLPosition = async (positionId: string, osmosisClient: any) => {
    const position = await osmosisClient.osmosis.concentratedliquidity.v1beta1.positionById({
        positionId: BigInt(positionId),
    })
    return position.position
}

//Get the RangeBound positions
export const getCLPositionsForVault = () => {
    const { data: config } = useBoundedConfig()
    const { data: prices } = useOraclePrice()
    const cdtPrice = parseFloat(prices?.find((price) => price.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt")?.price ?? "0")
    const usdcPrice = parseFloat(prices?.find((price) => price.denom === "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4")?.price ?? "0")
    const { data: client } = useOsmosisClient()


    return useQuery({
        queryKey: ['getCLPositionsForVault', config, prices, cdtPrice, usdcPrice, client],
        queryFn: async () => {
            if (!config) return;
            const positions = { ceiling: config.range_position_ids.ceiling, floor: config.range_position_ids.floor }
            const ceilingPosition = await getCLPosition(positions.ceiling.toString(), client)
            const floorPosition = positions.floor === 0 ? undefined : await getCLPosition(positions.floor.toString(), client)

            // console.log("ceiling", ceilingPosition, "floor", floorPosition, "prices", cdtPrice, usdcPrice)

            //Find ceiling amounts
            const ceilingAmounts = ceilingPosition.asset0.denom == "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt"
                ? { cdt: ceilingPosition.asset0.amount, usdc: ceilingPosition.asset1.amount } : { cdt: ceilingPosition.asset1.amount, usdc: ceilingPosition.asset0.amount }
            //Find floor amounts
            const floorAmounts = floorPosition ?
                floorPosition.asset0.denom == "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt"
                    ? { cdt: floorPosition.asset0.amount, usdc: floorPosition.asset1.amount } : { cdt: floorPosition.asset1.amount, usdc: floorPosition.asset0.amount }
                : { cdt: 0, usdc: 0 }

            //Calc Ceiling TVL
            const ceilingTVL = shiftDigits(ceilingAmounts.cdt, -6).times(cdtPrice).plus(shiftDigits(ceilingAmounts.usdc, -6).times(usdcPrice))
            //Calc Floor TVL
            const floorTVL = shiftDigits(floorAmounts.cdt, -6).times(cdtPrice).plus(shiftDigits(floorAmounts.usdc, -6).times(usdcPrice))

            const positionsTVL = { ceilingTVL, floorTVL }
            //Calc CDT TVL
            const cdtTVL = shiftDigits(ceilingAmounts.cdt, -6).times(cdtPrice).plus(shiftDigits(floorAmounts.cdt, -6).times(cdtPrice))
            //Calc USDC TVL
            const usdcTVL = shiftDigits(ceilingAmounts.usdc, -6).times(usdcPrice).plus(shiftDigits(floorAmounts.usdc, -6).times(usdcPrice))
            //Calc total TVL
            const totalTVL = cdtTVL.plus(usdcTVL)
            const assetRatios = {
                cdt: cdtTVL.dividedBy(totalTVL).toNumber(),
                usdc: usdcTVL.dividedBy(totalTVL).toNumber()
            }

            return { ceiling: ceilingPosition, floor: floorPosition, positionsTVL, assetRatios }
        },
    })

}

export const useRBLPRewards = () => {
    const { data: client } = useOsmosisClient()

    return useQuery({
        queryKey: ['RBLPRewards', client],
        queryFn: async () => {

            const ceiling = getCLRewards("11541781", client)
            const floor = getCLRewards("11541780", client)
            return { ceiling, floor }
        },
    })
}


export const useLPRewards = () => {

    const { data: client } = useOsmosisClient()

    return useQueries({
        queries: clPositions.map((position) => ({
            queryKey: ['cl_position_rewards', position.id, client],
            queryFn: async () => {
                return getCLRewards(position.id, client)
            },
            staleTime: 60000, // 60 seconds (adjust based on your needs)
        })) || [],
    });
}

export const getBestCLRange = () => {
    const clRewardsData = useLPRewards()

    return useQuery({
        queryKey: ['getBestCLRange', clRewardsData],
        queryFn: async () => {
            //Set rewards            
            const clRewards = clRewardsData.map((reward, index) => {
                return { reward: reward.data, position: clPositions[index] }
            })
            //Initialize Rewards list
            var rewardList = [];
            //Parse through all positions
            for (const position of clRewards) {
                //Add reward totals
                const totalReward = position.reward && position.reward.claimableSpreadRewards.length == 2 ? parseInt(position.reward.claimableSpreadRewards[0].amount) + parseInt(position.reward.claimableSpreadRewards[1].amount) : 0;
                console.log("LP IDs", position.reward, position.position.id)
                //Add position to list
                rewardList.push({ position: position.position, reward: totalReward });
            }

            //Sort rewards from highest to lowest
            // rewardList.sort((a, b) => b.reward - a.reward);

            //Return
            return rewardList;
        },
    })
}

//////Quick Action functions
// Initialize osmosis client
// const [osmosisQueryClient, setosmosisQueryClient] = useState<any | null>(null);
// //Get Osmosis Client
// useEffect(() => {
//     if (osmosisQueryClient === null || osmosisQueryClient === undefined) {
//         const { createRPCQueryClient } = osmosis.ClientFactory;
//         const osmosisClient = createRPCQueryClient({ rpcEndpoint: "https://osmosis-rpc.polkachu.com/" }).then((osmosisClient) => {
//             if (!osmosisClient) {
//                 console.error('osmosisClient undefined.');
//                 return;
//             }

//             //Set client
//             setosmosisQueryClient(osmosisClient);
//         });
//     }
// }, []); //We'll add dependencies for Quick Actions clicks so that this requeries if the user is about to need it & its undefined
// //Initialize osmosis variables
// //@ts-ignore
// let cg_prices;
// const osmosisAssets = [
//     ...assets.assets,
//     ...asset_list.assets,
// ].filter(({ type_asset }) => type_asset !== 'ics20').filter((asset) => asset !== undefined);
// //@ts-ignore
// cg_prices = convertGeckoPricesToDenomPriceHash(osmosisAssets, priceResponse);
// //@ts-ignore
// let calculator = new LiquidityPoolCalculator({ assets: osmosisAssets });

/////functions/////
export const unloopPosition = (cdtPrice: number, walletCDT: number, address: string, prices: Price[], basket: Basket, tvl: number, debtAmount: number, borrowLTV: number, positions: any, positionId: string, loops: number, desiredWithdrawal?: number) => {
    //Create CDP Message Composer
    const cdp_composer = new PositionsMsgComposer(address!, mainnetAddrs.positions);

    //Set Position value
    var positionValue = tvl;
    //Set credit amount
    var creditAmount = debtAmount;
    //set borrowLTV
    var borrowLTV = borrowLTV / 100;

    //Get Position's LTV
    var currentLTV = getPositionLTV(positionValue, num(shiftDigits(creditAmount, -6)).toNumber(), basket);
    // console.log("LTVS:", currentLTV, borrowLTV, positionValue, creditAmount)
    //If current LTV is over the borrowable LTV, we can't withdraw anything
    if (currentLTV > borrowLTV) {
        // console.log("Current LTV is over the Position's borrowable LTV, we can't withdraw collateral")
        return { msgs: [], newValue: 0, newLTV: 0 };
    }
    //Get position cAsset ratios 
    //Ratios won't change in btwn loops so we can set them outside the loop
    let cAsset_ratios = getAssetRatio(false, tvl, positions);
    // console.log("ratios:", cAsset_ratios, "positions:", positions)

    //Repeat until no more CDT or Loops are done
    var iter = 0;
    var all_msgs: EncodeObject[] = [];
    var withdrawPreSwapValue = 0;
    while ((creditAmount > 0 || iter == 0) && (iter < loops) && (desiredWithdrawal ? desiredWithdrawal != withdrawPreSwapValue : true)) {
        //Set LTV range
        //We can withdraw value up to the borrowable LTV
        //Or the current LTV, whichever is lower
        let LTV_range = Math.min(borrowLTV - currentLTV, currentLTV);
        // console.log("LTV RANGE:", LTV_range, currentLTV, borrowLTV)
        //Set value to withdraw
        var withdrawValue = positionValue * LTV_range;

        //.Divvy withdraw value to the cAssets based on ratio
        //Transform the value to the cAsset's amount using its price & decimals
        var cAsset_prices: number[] = []
        let cAsset_amounts = cAsset_ratios.map((asset) => {
            if (!asset) return;
            const assetPrice = prices?.find((price) => price.denom === asset.denom)?.price || '0'
            cAsset_prices.push(parseFloat(assetPrice))

            return [asset.symbol, parseInt(((asset.ratio * withdrawValue) / parseFloat(assetPrice) * Math.pow(10, denoms[asset.symbol as keyof exported_supportedAssets][1] as number)).toFixed(0))];
        });
        //Save amounts as assets for withdraw msg
        var assets: CDPAsset[] = [];
        cAsset_amounts.forEach((amount) => {
            if (!amount) return;
            if (amount[1] as number != 0) {
                assets.push(
                    {
                        amount: amount[1].toString(),
                        //@ts-ignore
                        info: {
                            //@ts-ignore
                            native_token: {
                                denom: denoms[amount[0] as keyof exported_supportedAssets][0] as string
                            }
                        }
                    });
            }
        });


        //Create withdraw msg for assets
        var withdraw_msg: MsgExecuteContractEncodeObject = cdp_composer.withdraw({
            positionId: positionId,
            assets,
        });
        // console.log("CASSET LOGS:", cAsset_amounts, cAsset_prices)
        //Create Swap msgs to CDT for each cAsset & save tokenOutMinAmount
        var swap_msgs: EncodeObject[] = [];
        var tokenOutMin = 0;
        cAsset_amounts.forEach((amount, index) => {
            if (!amount) return;
            if (amount[1] as number != 0) {
                let swap_output = handleCDTswaps(address, cdtPrice, cAsset_prices[index], amount[0] as keyof exported_supportedAssets, parseInt(amount[1].toString()) as number);
                swap_msgs.push(swap_output.msg);
                tokenOutMin += swap_output.tokenOutMinAmount;
            }
        });

        //Create repay msg with newly swapped CDT
        var repay_msg: EncodeObject = cdp_composer.repay({
            positionId: positionId,
        });
        repay_msg.value.funds = [coin(tokenOutMin.toString(), denoms.CDT[0] as string)];

        // console.log("repay value:", repay_msg.value.funds)

        //Save non-slippage withdraw value
        withdrawPreSwapValue = withdrawValue;

        //Subtract slippage to mint value
        withdrawValue = parseFloat(calcAmountWithSlippage(withdrawValue.toString(), SWAP_SLIPPAGE));
        // console.log("here we")
        //Calc new TVL (w/ slippage calculated into the mintValue)
        positionValue = positionValue - withdrawValue;
        // console.log("here we we")

        //Repayments under 100 CDT will fail unless fully repaid
        //NOTE: This will leave the user with leftover CDT in their wallet, maximum 50 CDT
        if ((creditAmount - repay_msg.value.funds[0].amount) < 100_000_000 && (creditAmount - repay_msg.value.funds[0].amount) > 0) {
            // console.log("inside here")
            //Set repay amount so that credit amount is 100
            repay_msg.value.funds = [coin((creditAmount - 100_000_000).toString(), denoms.CDT[0] as string)];
            //break loop
            iter = loops;
        }

        //Attempted full repay
        if (LTV_range === currentLTV) {
            // console.log("full repay")
            //Set credit amount to 0
            creditAmount = 0;
            //Add any walletCDT to the repay amount to account for interest & slippage
            repay_msg.value.funds = [coin((creditAmount + (walletCDT * 1_000_000)).toFixed(0), denoms.CDT[0] as string)];
        } else {
            // console.log("minus credit", creditAmount)
            //Set credit amount including slippage
            creditAmount -= repay_msg.value.funds[0].amount;
        }

        //Calc new LTV
        currentLTV = getPositionLTV(positionValue, num(shiftDigits(creditAmount, -6)).toNumber(), basket);

        // console.log("current LTV", currentLTV)
        //Add msgs to all_msgs
        if (desiredWithdrawal && desiredWithdrawal === withdrawPreSwapValue) {
            all_msgs.push(withdraw_msg)
        } else all_msgs = all_msgs.concat([withdraw_msg]).concat(swap_msgs).concat([repay_msg]);
        // console.log("right before iter", all_msgs)

        //Increment iter
        iter += 1;
    }

    // console.log("unloop msgs:", all_msgs, iter, creditAmount)

    return { msgs: all_msgs, newValue: positionValue, newLTV: currentLTV };

}
//Ledger has a msg max of 3 msgs per tx (untested), so users can only loop with a max of 1 collateral
//LTV as a decimal
export const loopPosition = (skipStable: boolean, cdtPrice: number, LTV: number, positionId: string, loops: number, address: string, prices: Price[], basket: Basket, tvl: number, debtAmount: number, borrowLTV: number, positions: any) => {

    //Create CDP Message Composer
    const cdp_composer = new PositionsMsgComposer(address, mainnetAddrs.positions);

    //Set Position value
    var positionValue = tvl;
    //Set credit amount
    var creditAmount = debtAmount;
    //Confirm desired LTV isn't over the borrowable LTV
    if (LTV > borrowLTV / 100) {
        // console.log("Desired LTV is over the Position's borrowable LTV")
        console.log(LTV, borrowLTV / 100)
        LTV = borrowLTV / 100;
        // return { msgs: [], newValue: 0, newLTV: 0 };
    }
    //Get position cAsset ratios 
    //Ratios won't change in btwn loops so we can set them outside the loop
    let cAsset_ratios = getAssetRatio(skipStable, tvl, positions);
    // console.log(cAsset_ratios)
    //Get Position's LTV
    var currentLTV = getPositionLTV(positionValue, creditAmount, basket);
    if (LTV < currentLTV) {
        console.log("Desired LTV is under the Position's current LTV")
        return { msgs: [], newValue: 0, newLTV: 0 };
    }
    //Repeat until CDT to mint is under 1 or Loops are done
    var mintAmount = 0;
    var iter = 0;
    var all_msgs: EncodeObject[] = [];
    while ((mintAmount > 1_000_000 || iter == 0) && iter < loops) {
        //Set LTV range
        let LTV_range = LTV - currentLTV;
        //Set value to mint
        var mintValue = positionValue * LTV_range;
        //Set amount to mint
        mintAmount = parseInt(((mintValue / parseFloat(basket.credit_price.price)) * 1_000_000).toFixed(0));
        // console.log("mintAmount", mintAmount)
        if (!mintAmount) {
            console.log("mintAmount please return us", mintAmount)
            return { msgs: [], newValue: 0, newLTV: 0 };
        }
        //Create mint msg
        let mint_msg: EncodeObject = cdp_composer.increaseDebt({
            positionId: positionId,
            amount: mintAmount.toString(),
        });
        //Divvy mint amount to the cAssets based on ratio
        let cAsset_amounts = cAsset_ratios.map((asset) => {
            if (!asset) return;
            return [asset.base, (asset.ratio * mintAmount), asset.symbol];
        });

        //Create Swap msgs from CDT for each cAsset & save tokenOutMinAmount
        var swap_msgs = [] as MsgExecuteContractEncodeObject[];
        var tokenOutMins: Coin[] = [];
        cAsset_amounts.forEach((amount) => {
            if (!amount || !address) return;
            if (amount[1] as number > 0) {
                //Get price for denom 
                let price = prices?.find((price) => price.denom === amount[0])?.price || '0';
                let swap_output = handleCollateralswaps(address, cdtPrice, parseFloat(price), amount[2] as keyof exported_supportedAssets, parseInt(amount[1].toString()) as number);
                swap_msgs.push(swap_output.msg as MsgExecuteContractEncodeObject);
                tokenOutMins.push(coin(swap_output.tokenOutMinAmount, amount[0] as string));
            }
        });
        //If there are no swaps, don't add mint or deposit msgs
        if (swap_msgs.length !== 0) {

            //Create deposit msgs for newly swapped assets
            var deposit_msg: MsgExecuteContractEncodeObject = cdp_composer.deposit({
                positionId,
            });
            //Sort tokenOutMins alphabetically
            tokenOutMins.sort((a, b) => (a.denom > b.denom) ? 1 : -1);
            deposit_msg.value.funds = tokenOutMins;
            //////////////////////////

            //Subtract slippage to mint value
            mintValue = parseFloat(calcAmountWithSlippage(mintValue.toString(), SWAP_SLIPPAGE));
            //Calc new TVL (w/ slippage calculated into the mintValue)
            positionValue = positionValue + mintValue;

            //Set credit amount
            creditAmount += shiftDigits(mintAmount, -6).toNumber();
            //Calc new LTV
            currentLTV = getPositionLTV(positionValue, creditAmount, basket);

            //Add msgs to all_msgs
            all_msgs = all_msgs.concat([mint_msg]).concat(swap_msgs).concat([deposit_msg]);

            //Increment iter
            iter += 1;
        }
    }

    return { msgs: all_msgs, newValue: positionValue, newLTV: currentLTV };
}
// export const exitCLPools = (poolId: number) => {
//     // console.log("exit_cl_attempt")
//     let msg = [] as EncodeObject[];
//     const { address } = useWallet()

//     //Query CL pool
//     osmosisQueryClient!.osmosis.concentratedliquidity.v1beta1.userPositions({
//         address: address! as string,
//         poolId,
//     }).then((userPoolResponse) => {

//         //Convert user positions to a list of position IDs
//         //@ts-ignore
//         let positionIds = userPoolResponse.positions.map((position) => {
//             return position.position.positionId;
//         });

//         let collect_msg = osmosis.concentratedliquidity.v1beta1.MessageComposer.withTypeUrl.collectSpreadRewards({
//             positionIds,
//             sender: address! as string,
//         });
//         let collect_msg_2 = osmosis.concentratedliquidity.v1beta1.MessageComposer.withTypeUrl.collectIncentives({
//             positionIds,
//             sender: address! as string,
//         });
//         let withdraw_msg = osmosis.concentratedliquidity.v1beta1.MessageComposer.withTypeUrl.withdrawPosition({
//             positionId: userPoolResponse.positions[0].position.positionId,
//             sender: address! as string,
//             liquidityAmount: userPoolResponse.positions[0].position.liquidity,
//         });
//         //Add msgs
//         msg = msg.concat([collect_msg, collect_msg_2, withdraw_msg]);
//     });

//     return msg
// }
// export const exitGAMMPools = (poolId: number, shareInAmount: string) => {
//     const { address } = useWallet()
//     let msg = [] as EncodeObject[];

//     //Query pool
//     osmosisQueryClient!.osmosis.gamm.v1beta1.pool({
//         poolId
//     }).then((poolResponse) => {

//         let pool = poolResponse.pool;
//         let poolAssets = pool.poolAssets;
//         let totalShares = pool.totalShares;
//         //Calc user's share of pool
//         let shareAmount = new BigNumber(shareInAmount);
//         let totalShareAmount = new BigNumber(totalShares.amount);
//         let userShare = shareAmount.div(totalShareAmount);
//         // console.log(userShare)
//         //Calc user's share of poolAssets
//         //@ts-ignore
//         let tokenOutMins = poolAssets.map((asset) => {
//             if (asset.token.amount !== undefined) {
//                 return coin(
//                     parseInt(calcAmountWithSlippage((parseInt(asset.token.amount) * parseFloat(userShare.valueOf())).toFixed(0), SWAP_SLIPPAGE)),
//                     asset.token.denom);
//             }
//         });
//         // console.log(tokenOutMins)

//         //Exit pool
//         msg.push(exitPool({
//             poolId: BigInt(poolId),
//             sender: address! as string,
//             shareInAmount,
//             tokenOutMins,
//         }));
//     });

//     return msg

// }
//////joinPools
//The input tokens must be in the order of the pool's assets
//pool 1268 is CDT/USDC
export const joinCLPools = (address: string, tokenIn1: Coin, poolId: number, tokenIn2: Coin) => {
    let joinCoins = [tokenIn1, tokenIn2];

    return osmosis.concentratedliquidity.v1beta1.MessageComposer.withTypeUrl.createPosition({
        poolId: BigInt(poolId),
        sender: address as string,
        //This range is .98 to 1.02
        // lowerTick: BigInt("-200000"),
        // upperTick: BigInt(20000),
        //This is range .99 to 1.01
        // lowerTick: BigInt("-100000"),
        // upperTick: BigInt(10000),
        //This is range 0.99988 to 1.003
        // lowerTick: BigInt("-1200"),
        // upperTick: BigInt(3900),        
        //This is range 1.00000 to 1.0005
        lowerTick: BigInt("-100"),
        upperTick: BigInt(500),
        /**
         * tokens_provided is the amount of tokens provided for the position.
         * It must at a minimum be of length 1 (for a single sided position)
         * and at a maximum be of length 2 (for a position that straddles the current
         * tick).
         */
        tokensProvided: joinCoins,
        //Do we care about input minimums since we are depositing both?
        tokenMinAmount0: "0",
        tokenMinAmount1: "0",
    })
}
//This is used primarily to loop GAMM shares used as collateral
// export const joinGAMMPools = (tokenIn1: Coin, poolId: number, tokenIn2?: Coin) => {
//     var msg = [] as EncodeObject[];
//     //@ts-ignore
//     if (osmosisQueryClient !== null && cg_prices !== null && osmosisAssets !== undefined) {
//         // console.log("join_pool_attempt")
//         const { address } = useWallet()
//         //Query pool
//         osmosisQueryClient!.osmosis.gamm.v1beta1.pool({
//             poolId
//         }).then((poolResponse) => {

//             let pool = poolResponse.pool;
//             //JoinPool no Swap
//             if (tokenIn2 !== undefined) {
//                 let joinCoins = [tokenIn1, tokenIn2];
//                 const shareOutAmount = calcShareOutAmount(pool, joinCoins);
//                 const tokenInMaxs = joinCoins.map((c: Coin) => {
//                     return coin(c.amount, c.denom);
//                 });

//                 msg.push(joinPool({
//                     poolId: BigInt(poolId),
//                     sender: address! as string,
//                     tokenInMaxs: tokenInMaxs,
//                     shareOutAmount: parseInt(calcAmountWithSlippage(shareOutAmount, SWAP_SLIPPAGE)).toString(),
//                 }))

//             } else {
//                 //Join with Swap        
//                 //@ts-ignore
//                 let tokenPrice = cg_prices[tokenIn1.denom as CoinDenom];

//                 //Find the key for the denom
//                 let tokenKey = Object.keys(denoms).find(key => denoms[key as keyof exported_supportedAssets][0] === tokenIn1.denom);
//                 let tokenInValue = (parseFloat(tokenPrice) * parseFloat(tokenIn1.amount) / Math.pow(10, denoms[tokenKey as keyof exported_supportedAssets][1] as number));
//                 // // console.log(tokenInValue)
//                 //@ts-ignore
//                 const coinsNeeded = calculator.convertDollarValueToCoins(tokenInValue, pool, cg_prices);
//                 // // console.log(coinsNeeded)
//                 const shareOutAmount = calcShareOutAmount(pool, coinsNeeded);
//                 // // console.log(shareOutAmount)

//                 msg.push(joinSwapExternAmountIn({
//                     poolId: BigInt(poolId),
//                     sender: address! as string,
//                     tokenIn: tokenIn1,
//                     shareOutMinAmount: parseInt(calcAmountWithSlippage(shareOutAmount, SWAP_SLIPPAGE)).toString(),
//                 }))

//             }
//         });
//     }
//     return msg
// }

// export const lockGAMMPool = (shareInAmount: Coin) => {
//     // console.log("lock_pool_attempt")
//     let msg = [] as EncodeObject[];
//     const { address } = useWallet()

//     msg.push(lockTokens({
//         owner: address! as string,
//         duration: {
//             seconds: BigInt(7 * secondsInADay),
//             nanos: 0,
//         },
//         coins: [shareInAmount],
//     }));

//     return msg
// }

// export const unlockGAMMPool = (poolID: string, shareInAmount: Coin) => {
//     // console.log("unlock_pool_attempt")
//     let msg = [] as EncodeObject[];
//     const { address } = useWallet()

//     msg.push(beginUnlocking({
//         owner: address! as string,
//         coins: [shareInAmount],
//         ID: BigInt(poolID),
//     }));

//     return msg

// }

//This is for CDT using the oracle's prices
const getCDTtokenOutAmount = (tokenInAmount: number, cdtPrice: number, swapFromPrice: number) => {
    return tokenInAmount * (swapFromPrice / cdtPrice)
}
//Parse through saved Routes until we reach CDT
const getCDTRoute = (tokenIn: keyof exported_supportedAssets, tokenOut?: keyof exported_supportedAssets) => {
    // console.log(tokenIn)
    var route = cdtRoutes[tokenIn];
    console.log("cdtRoutes", route)
    //to protect against infinite loops
    var iterations = 0;

    while (route != undefined && route[route.length - 1].tokenOutDenom as string !== denoms.CDT[0] && iterations < 5) {
        console.log("route denoms", route[route.length - 1].tokenOutDenom === denoms[tokenOut ?? "CDT"][0] as string)
        if (tokenOut && route[route.length - 1].tokenOutDenom === denoms[tokenOut][0] as string) return { route, foundToken: true };

        //Find the key from this denom
        let routeDenom = route[route.length - 1].tokenOutDenom as string;
        //Set the next node in the route path
        let routeKey = Object.keys(denoms).find(key => denoms[key as keyof exported_supportedAssets][0] === routeDenom);
        //Add the next node to the route
        route = route.concat(cdtRoutes[routeKey as keyof exported_supportedAssets]);

        //output to test
        if (tokenOut && route[route.length - 1].tokenOutDenom === denoms[tokenOut][0] as string) return { route, foundToken: true };
        iterations += 1;
    }

    return { route, foundToken: false };
}
//This is getting Swaps To CDT w/ optional different tokenOut
export const handleCDTswaps = (address: string, cdtPrice: number, swapFromPrice: number, tokenIn: keyof exported_supportedAssets, tokenInAmount: number, tokenOut?: keyof exported_supportedAssets, slippage?: number) => {

    //Get tokenOutAmount
    // console.log("boom1")
    const decimalDiff = denoms[tokenIn][1] as number - 6;
    const tokenOutAmount = shiftDigits(getCDTtokenOutAmount(tokenInAmount, cdtPrice, swapFromPrice), -decimalDiff);
    //Swap routes
    // console.log("boom2")
    const { route: routes, foundToken } = getCDTRoute(tokenIn, tokenOut);

    // console.log("boom3", tokenOutAmount )
    const tokenOutMinAmount = parseInt(calcAmountWithSlippage(tokenOutAmount.toString(), slippage ?? SWAP_SLIPPAGE)).toString();

    // console.log("boom4", address, denoms[tokenIn][0] as string)
    const msg = swapExactAmountIn({
        sender: address! as string,
        routes,
        tokenIn: coin(tokenInAmount, denoms[tokenIn][0] as string),
        tokenOutMinAmount
    });
    // console.log("boom5", msg)

    return { msg, tokenOutMinAmount: parseInt(tokenOutMinAmount), foundToken };
};

//Parse through saved Routes until we reach CDT
const getCollateralRoute = (tokenOut: keyof exported_supportedAssets) => {//Swap routes
    //Hardcoded route for USDC since the dynamic routing logic is breaking
    if (tokenOut === "USDC") {
        return [{ poolId: 1268, tokenOutDenom: denoms.USDC[0] as string }];
    }


    const { route: temp_routes, foundToken, } = getCDTRoute(tokenOut);
    console.log("cdt routes", temp_routes, foundToken)
    //Reverse the route
    console.log("pre")
    temp_routes.reverse();
    //This route key logic is breaking the fn
    console.log("before routeKey", cdtRoutes["CDT"][0].tokenOutDenom)
    console.log("post", temp_routes)
    var routes = temp_routes;
    //Swap tokenOutdenom of the route to the key of the route
    routes = routes.map((route) => {
        console.log("pre", route.tokenOutDenom, route.poolId)
        let routeKey = Object.keys(cdtRoutes).find(key => cdtRoutes[key as keyof exported_supportedAssets][0].tokenOutDenom === route.tokenOutDenom && route.poolId === cdtRoutes[key as keyof exported_supportedAssets][0].poolId);
        console.log("routeKey", routeKey)

        let keyDenom = denoms[routeKey as keyof exported_supportedAssets][0] as string;
        console.log("keyDenom", keyDenom)
        return {
            poolId: route.poolId,
            tokenOutDenom: keyDenom,
        }
    });


    return routes;
}

//This is for Collateral using the oracle's prices
const getCollateraltokenOutAmount = (cdtPrice: number, CDTInAmount: number, tokenOutPrice: number) => {
    return num(CDTInAmount).multipliedBy(num(cdtPrice).div(tokenOutPrice)).toNumber()
}

//Swapping CDT to collateral
export const handleCollateralswaps = (address: string, cdtPrice: number, tokenOutPrice: number, tokenOut: keyof exported_supportedAssets, CDTInAmount: number, slippage?: number): { msg: any, tokenOutMinAmount: number } => {
    console.log("herein 1")
    //Get tokenOutAmount
    const decimalDiff = denoms[tokenOut][1] as number - 6;
    // const tokenOutAmount = shiftDigits(getCDTtokenOutAmount(tokenInAmount, cdtPrice, swapFromPrice), -decimalDiff);
    const tokenOutAmount = shiftDigits(getCollateraltokenOutAmount(cdtPrice, CDTInAmount, tokenOutPrice), decimalDiff);
    console.log("herein 2")

    //Swap routes
    const routes: SwapAmountInRoute[] = getCollateralRoute(tokenOut);
    console.log("herein 3")

    const tokenOutMinAmount = parseInt(calcAmountWithSlippage(tokenOutAmount.toString(), slippage ?? SWAP_SLIPPAGE)).toString();
    console.log("herein 4")


    const msg = swapExactAmountIn({
        sender: address as string,
        routes,
        tokenIn: coin(CDTInAmount.toString(), denoms.CDT[0] as string),
        tokenOutMinAmount
    });
    console.log("herein 5")

    // await base_client?.signAndBroadcast(user_address, [msg], "auto",).then((res) => {// console.log(res)});
    return { msg, tokenOutMinAmount: parseInt(tokenOutMinAmount) };
};
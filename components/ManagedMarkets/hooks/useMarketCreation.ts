import { useQuery } from '@tanstack/react-query';
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { toUtf8 } from '@cosmjs/encoding';
import useWallet from '@/hooks/useWallet';
import { useMarketCollateralPrice, useMarketDebtPrice, useManagedMarket } from '@/hooks/useManaged';
import contracts from '@/config/contracts.json';
import { num } from '@/helpers/num';
import BigNumber from 'bignumber.js';
import useManagedAction, { ManagedActionState } from './useManagedMarketState';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import { shiftDigits } from '@/helpers/math';
import { Asset } from '@/helpers/chain';
import useLendState from './useLendState';
import { LendState } from './useLendState';
import { CDT_ASSET, denoms } from '@/config/defaults';
import { MarketCreateState } from '../ManagedTable';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { usePoolInfo } from '@/hooks/useOsmosis';

const useMarketCreation = ({
  marketCreateState,
  poolsForOsmoTwap = [],
  collateralAsset,
  isWhitelistedManager = false,
  run = true,
}: {
  marketCreateState: MarketCreateState;
  poolsForOsmoTwap?: any[];
  collateralAsset: Asset;
  run?: boolean;
  isWhitelistedManager?: boolean;
}) => {
  console.log("marketCreateState");
  const { address } = useWallet();
  //   console.log("poolInfo", poolInfo)
  //  poolInfo?.pool?.poolAssets[0].token.denom, poolInfo?.pool?.poolAssets[1].token.denom);

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'market_create_msgs',
      address,
      marketCreateState,
      collateralAsset,
      poolsForOsmoTwap,
      isWhitelistedManager,
      //   poolInfo.pool.,
      run,
    ],
    queryFn: () => {
      if (
        !run ||
        !address ||
        !marketCreateState ||
        !collateralAsset ||
        !poolsForOsmoTwap
      ) {
        return { msgs: [] };
      }
      //Set rate kink if it exists
      var rate_kink = undefined;
      if (marketCreateState.postKinkRateMultiplier || marketCreateState.kinkStartingPointRatio) {
        rate_kink = {
          rate_mulitplier: marketCreateState.postKinkRateMultiplier?.toString() ?? undefined,
          kink_starting_point_ratio: marketCreateState.kinkStartingPointRatio ? num(marketCreateState.kinkStartingPointRatio).dividedBy(100).toString() : undefined
        }
      }

      //Set funds if the user isn't whitelisted
      var funds: MsgExecuteContractEncodeObject['value']['funds'] = [];
      if (!isWhitelistedManager) {
        funds = [
          {
            denom: CDT_ASSET.base,
            amount: "25000000" //25 CDT
          }
        ]
      }


      // Prepare Market Instantiation message
      const marketInstantiationMsg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.marketManager,
          msg: toUtf8(
            JSON.stringify({
              instantiate_market: {
                params: {
                  manager: marketCreateState.managerAddress,
                  name: marketCreateState.name,
                  socials: marketCreateState.socialLinks == "" ? [] : [marketCreateState.socialLinks],
                  whitelisted_debt_suppliers: undefined,
                  max_slippage: num(marketCreateState.maxSlippage).div(100).toString(),
                  collateral_params: {
                    collateral_asset: collateralAsset.base,
                    max_borrow_LTV: num(marketCreateState.maxBorrowLTV).div(100).toString(),
                    liquidation_LTV: num(marketCreateState.liquidationLTV).div(100).toString(),
                  },
                  rate_params: {
                    base_rate: num(marketCreateState.baseRate).div(100).toString(),
                    rate_max: num(marketCreateState.rateMax).div(100).toString(),
                    rate_kink,
                  },
                  collateral_oracle_info: {
                    pools_for_osmo_twap: poolsForOsmoTwap,
                    decimals: collateralAsset.decimal
                  },

                  debt_oracle_info: {
                    pools_for_osmo_twap: poolsForOsmoTwap,
                    decimals: collateralAsset.decimal
                  },
                  //todo: wrong debt token
                  debt_token: collateralAsset.base,
                  borrow_fee: num(marketCreateState.borrowFee).div(100).toString(),
                  whitelisted_collateral_suppliers: undefined,
                  pause_option: true,
                  debt_supply_cap: marketCreateState.totalDebtSupplyCap ? num(marketCreateState.totalDebtSupplyCap).times(10 ** 6).toString() : undefined,
                  borrow_cap: {
                    cap_borrows_by_liquidity: false
                  },
                  manager_fee: "0.05",
                  oracle_contract: "osmo1a0k36dskvskmghhkmwtkgt2qmxpkwzfnspupl09fnsezljhxxryqu2wyxe",
                  swap_contract: "osmo1zwfha9a73a7wsug3vvn2mmvhp3x53v886eskrmsusyy2mgx8faxqw7fjjw",
                }
              },
            })
          ),
          funds, // Add funds if needed
        }),
      };

      return { msgs: [marketInstantiationMsg] };
    },
    enabled: !!address && !!marketCreateState && run,
  });

  const msgs = queryData?.msgs ?? [];

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['market_create_msgs', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
};

export default useMarketCreation; 
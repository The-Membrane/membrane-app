import { useQuery } from '@tanstack/react-query';
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { toUtf8 } from '@cosmjs/encoding';
import useWallet from '@/hooks/useWallet';
import { ManagerState, AssetOracleInfo, TWAPPoolInfo } from './useManagerState';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import { getPoolInfo } from '@/services/osmosis';
import { rpcUrl } from '@/config/defaults';
import { OsmosisClient } from '@/services/osmosis';
import { useManagedMarket } from '@/hooks/useManaged';

/**
 * Prepares a MsgExecuteContract for updating a market contract with update_config msg (collateral params).
 * @param marketContract The address of the market contract
 * @param managerState The managerState object containing updateCollateralParams
 */
const useUpdateCollateral = ({
  collateralDenom,
  marketContract,
  managerState,
  run = true,
}: {
  collateralDenom: string;
  marketContract: string;
  managerState: ManagerState;
  run?: boolean;
}) => {
  const { address } = useWallet();
  //Get market config
  const { data: marketParams } = useManagedMarket(marketContract, collateralDenom);

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[]>({
    queryKey: [
      'updateCollateral_msgs',
      address,
      marketContract,
      managerState?.updateCollateralParams,
      run,
    ],
    queryFn: async () => {
      if (!run || !address || !managerState?.updateCollateralParams) {
        return [];
      }
      // Clone and prepare updateCollateralParams
      const params = { ...managerState.updateCollateralParams };
      // If pool_for_oracle_and_liquidations is a string, fetch pool info for each pool ID
      if (typeof params.pool_for_oracle_and_liquidations === 'string') {
        const poolIds = (typeof params.pool_for_oracle_and_liquidations === 'string' ? params.pool_for_oracle_and_liquidations : '').split(',').map((id: string) => id.trim()).filter(Boolean);
        if (poolIds.length > 0 && marketParams && marketParams[0]?.pool_for_oracle_and_liquidations) {
          const osmosisClient = await OsmosisClient(rpcUrl);
          // Fetch pool info for each pool ID and build TWAPPoolInfo objects
          const poolsForOsmoTwap: TWAPPoolInfo[] = [];
          for (const poolId of poolIds) {
            const poolInfo = await getPoolInfo(poolId, osmosisClient);
            // Extract pool_id, base_asset_denom, quote_asset_denom from poolInfo
            // This assumes poolInfo.pool contains these fields; adjust as needed
            console.log(poolInfo);
            poolsForOsmoTwap.push({
              pool_id: Number(poolId),
              base_asset_denom: poolInfo.token0 || '',
              quote_asset_denom: poolInfo.token1 || '',
            });
          }
          const currentOracleInfo = marketParams[0].pool_for_oracle_and_liquidations;
          params.pool_for_oracle_and_liquidations = {
            basket_id: currentOracleInfo.basket_id,
            is_usd_par: currentOracleInfo.is_usd_par,
            decimals: currentOracleInfo.decimals,
            pools_for_osmo_twap: poolsForOsmoTwap,
            pyth_price_feed_id: currentOracleInfo.pyth_price_feed_id,
            lp_pool_info: currentOracleInfo.lp_pool_info,
            vault_info: currentOracleInfo.vault_info,
          };
        }
      }
      // If already an array, use as-is
      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: marketContract,
          msg: toUtf8(
            JSON.stringify({
              update_config: params,
            })
          ),
          funds: [],
        }),
      };
      return [msg];
    },
    enabled: !!address && !!managerState?.updateCollateralParams && run,
  });

  
  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['updateCollateral_msgs', (msgs?.toString() ?? "0")],
      onSuccess: () => {},
      enabled: !!msgs?.length,
    })
  }
};

export default useUpdateCollateral; 
import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import { Asset } from '@/helpers/chain';
import { MarketCreateState } from '../ManagedTable';
import type { EvmCall } from '@/services/chain/types';

const onInitialSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['positions'] });
  queryClient.invalidateQueries({ queryKey: ['balances'] });
};

/**
 * TODO(evm-migration): Managed Markets do NOT exist in the Solidity port — no
 * market-manager contract was ported, so there is no instantiate_market to map. This hook
 * returns no msgs so the market-creation CTA stays inert; the Managed Markets UI it serves
 * is slated for removal in the component-layer wave. {action} shape and params preserved.
 */
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
  const { address } = useWallet();

  const { data: queryMsgs } = useQuery<EvmCall[]>({
    queryKey: [
      'market_create_msgs',
      address,
      marketCreateState,
      collateralAsset,
      poolsForOsmoTwap,
      isWhitelistedManager,
      run,
    ],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && !!marketCreateState && run,
  });

  const msgs = queryMsgs ?? [];

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['market_create_msgs', msgs?.toString() ?? '0'],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  };
};

export default useMarketCreation;

import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarketState';
import type { EvmCall } from '@/services/chain/types';

interface CloseAndEditBoostsTxParams {
  marketContract: string;
  collateralDenom: string;
  managedActionState: any;
  collateralPrice: string;
  currentLTV: string;
  maxSpread: string;
  decimals: number;
  run?: boolean;
}

/**
 * TODO(evm-migration): Managed Markets do NOT exist in the Solidity port — no market
 * contract was ported, so close_position / edit_u_x_boosts / supply_collateral / borrow /
 * repay have no mapping. This hook returns no msgs so the close-and-edit-boosts CTA stays
 * inert; the Managed Markets UI it serves is slated for removal in the component-layer wave.
 * {action} shape and params preserved.
 */
const useCloseAndEditBoostsTx = ({
  marketContract,
  collateralDenom,
  managedActionState,
  collateralPrice,
  currentLTV,
  maxSpread,
  decimals,
  run = true,
}: CloseAndEditBoostsTxParams) => {
  const { address } = useWallet();
  const { setManagedActionState } = useManagedAction();

  const { data: queryMsgs } = useQuery<EvmCall[]>({
    queryKey: [
      'closeAndEditBoostsTx',
      address || '',
      marketContract || '',
      collateralDenom || '',
      JSON.stringify(managedActionState),
      currentLTV || '',
      collateralPrice || '',
      maxSpread,
    ],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && !!marketContract && !!collateralDenom && run,
  });

  const msgs = queryMsgs ?? [];

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] });
    queryClient.invalidateQueries({ queryKey: ['managed_market_user_position'] });
    queryClient.invalidateQueries({ queryKey: ['managed_market_user_ux_boosts'] });
    queryClient.invalidateQueries({ queryKey: ['user_position'] });

    setManagedActionState({
      ...managedActionState,
      collateralAmount: '',
      multiplier: 1,
      takeProfit: '',
      stopLoss: '',
      borrowAmount: '',
      repayAmount: '',
    });
  };

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['EditManagedMarket_msgs', msgs?.toString() ?? '0'],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  };
};

export default useCloseAndEditBoostsTx;

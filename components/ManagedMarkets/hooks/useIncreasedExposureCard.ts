import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import useManagedAction, { ManagedActionState } from './useManagedMarketState';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import { Asset } from '@/helpers/chain';
import type { EvmCall } from '@/services/chain/types';

/**
 * TODO(evm-migration): Managed Markets do NOT exist in the Solidity port — no market
 * contract was ported, so supply_collateral / edit_u_x_boosts / loop_position / borrow have
 * no mapping. This hook returns no msgs so the transform-exposure CTA stays inert; the
 * Managed Markets UI it serves is slated for removal in the component-layer wave. {action}
 * shape and params preserved.
 */
const useTransformExposure = ({
  marketContract,
  asset,
  managedActionState,
  borrowAmount,
  mode,
  maxBorrowLTV,
  collateralValue,
  run = true,
}: {
  marketContract: string;
  asset: Asset;
  managedActionState: ManagedActionState;
  borrowAmount: string;
  mode: 'multiply' | 'de-risk';
  maxBorrowLTV: number;
  collateralValue: number;
  run?: boolean;
}) => {
  const { address } = useWallet();
  const { setManagedActionState } = useManagedAction();

  const { data: queryMsgs } = useQuery<EvmCall[]>({
    queryKey: [
      'transformExposure_msgs',
      address,
      marketContract,
      asset,
      managedActionState,
      borrowAmount,
      mode,
      collateralValue,
      maxBorrowLTV,
      run,
    ],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && !!collateralValue && !!managedActionState.collateralAmount && run,
  });

  const msgs = queryMsgs ?? [];

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] });
    queryClient.invalidateQueries({ queryKey: ['balances'] });
    setManagedActionState({
      ...managedActionState,
      collateralAmount: '',
      multiplier: 1,
      takeProfit: '',
      stopLoss: '',
    });
  };

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['transformExposure_msg_sim', msgs?.toString() ?? '0'],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  };
};

export default useTransformExposure;

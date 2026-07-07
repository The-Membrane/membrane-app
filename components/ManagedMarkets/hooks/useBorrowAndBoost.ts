import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import useManagedAction, { ManagedActionState } from './useManagedMarketState';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import { Asset } from '@/helpers/chain';
import type { EvmCall } from '@/services/chain/types';

/**
 * TODO(evm-migration): Managed Markets do NOT exist in the Solidity port — no market
 * contract was ported, so supply_collateral / edit_u_x_boosts / loop_position have no
 * mapping. This hook returns no msgs (and debtAmount '0') so the borrow-and-boost CTA stays
 * inert; the Managed Markets UI it serves is slated for removal in the component-layer wave.
 * {action, debtAmount} shape and params preserved.
 */
const useBorrowAndBoost = ({
  marketContract,
  asset,
  managedActionState,
  maxBorrowLTV,
  run = true,
}: {
  marketContract: string;
  asset: Asset;
  managedActionState: ManagedActionState;
  maxBorrowLTV: number;
  run?: boolean;
}) => {
  const { address } = useWallet();
  const { setManagedActionState } = useManagedAction();

  type QueryData = {
    msgs: EvmCall[];
    debtAmount: string;
  };

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['borrowAndBoost_msgs', address, marketContract, asset, managedActionState, run],
    queryFn: () => ({ msgs: [] as EvmCall[], debtAmount: '0' }),
    enabled: !!address && !!managedActionState.collateralAmount && !!managedActionState.multiplier && run,
  });

  const msgs = queryData?.msgs ?? [];
  const debtAmount = queryData?.debtAmount ?? '0';

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
      queryKey: ['borrowAndBoost_msg_sim', msgs?.toString() ?? '0'],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
    debtAmount,
  };
};

export default useBorrowAndBoost;

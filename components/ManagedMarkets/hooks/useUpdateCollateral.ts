import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import { ManagerState } from './useManagerState';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import type { EvmCall } from '@/services/chain/types';

/**
 * TODO(evm-migration): Managed Markets do NOT exist in the Solidity port — no market /
 * market-manager contract was ported. This hook returns no msgs so the update-collateral
 * CTA stays inert; the Managed Markets UI it serves is slated for removal in the
 * component-layer wave. {action} shape and params preserved.
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

  const { data: msgs } = useQuery<EvmCall[]>({
    queryKey: ['updateCollateral_msgs', address, marketContract, managerState?.updateCollateralParams, run],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && !!managerState?.updateCollateralParams && run,
  });

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['updateCollateral_msgs', msgs?.toString() ?? '0'],
      onSuccess: () => {},
      enabled: !!msgs?.length,
    }),
  };
};

export default useUpdateCollateral;

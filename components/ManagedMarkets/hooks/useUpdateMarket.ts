import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import { ManagerState } from './useManagerState';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import type { EvmCall } from '@/services/chain/types';

/**
 * TODO(evm-migration): Managed Markets do NOT exist in the Solidity port — no market /
 * market-manager contract was ported (managed/margin markets are out of scope). This hook
 * returns no msgs so the update-market CTA stays inert; the Managed Markets UI it serves is
 * slated for removal in the component-layer wave. {action} shape and params preserved.
 */
const useUpdateMarket = ({
  marketContract,
  managerState,
  run = true,
}: {
  marketContract: string;
  managerState: ManagerState;
  run?: boolean;
}) => {
  const { address } = useWallet();

  const { data: msgs } = useQuery<EvmCall[]>({
    queryKey: ['updateMarket_msgs', address, marketContract, managerState?.updateOverallMarket, run],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && !!managerState?.updateOverallMarket && run,
  });

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['updateMarket_msgs', msgs?.toString() ?? '0'],
      onSuccess: () => {},
      enabled: !!msgs?.length,
    }),
  };
};

export default useUpdateMarket;

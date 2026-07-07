import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import useLendState, { LendState } from './useLendState';
import type { EvmCall } from '@/services/chain/types';

/**
 * TODO(evm-migration): Managed Markets do NOT exist in the Solidity port — no market
 * contract was ported, so there is no supply_debt / withdraw_debt to map. This hook returns
 * no msgs so the lend CTA stays inert; the Managed Markets UI it serves is slated for
 * removal in the component-layer wave. {action} shape and params preserved.
 */
const useLend = ({
  marketAddress,
  lendState,
  vaultTokenBalance,
  withdrawMax,
  run = true,
}: {
  marketAddress: string;
  lendState: LendState;
  vaultTokenBalance: string;
  withdrawMax: string;
  run?: boolean;
}) => {
  const { address } = useWallet();
  const { setLendState } = useLendState();

  const { data: queryMsgs } = useQuery<EvmCall[]>({
    queryKey: ['lend_msgs', address, marketAddress, lendState, run],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && !!marketAddress && run,
  });

  const msgs = queryMsgs ?? [];

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] });
    queryClient.invalidateQueries({ queryKey: ['balances'] });
    setLendState({
      ...lendState,
      supplyAmount: '0',
    });
  };

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['lend_msg_sim', msgs?.toString() ?? '0'],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  };
};

export default useLend;

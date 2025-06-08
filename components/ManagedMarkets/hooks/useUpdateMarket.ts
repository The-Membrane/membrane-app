import { useQuery } from '@tanstack/react-query';
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { toUtf8 } from '@cosmjs/encoding';
import useWallet from '@/hooks/useWallet';
import { ManagerState } from './useManagerState';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';

/**
 * Prepares a MsgExecuteContract for updating a market contract with update_market msg.
 * @param marketContract The address of the market contract
 * @param managerState The managerState object containing updateOverallMarket
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

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[]>({
    queryKey: [
      'updateMarket_msgs',
      address,
      marketContract,
      managerState?.updateOverallMarket,
      run,
    ],
    queryFn: () => {
      if (!run || !address || !managerState?.updateOverallMarket) {
        return [];
      }
      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: marketContract,
          msg: toUtf8(
            JSON.stringify({
              update_config: managerState.updateOverallMarket,
            })
          ),
          funds: [],
        }),
      };
      return [msg];
    },
    enabled: !!address && !!managerState?.updateOverallMarket && run,
  });
  

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['updateMarket_msgs', (msgs?.toString() ?? "0")],
      onSuccess: () => {},
      enabled: !!msgs?.length,
    })
  }
};

export default useUpdateMarket; 
import { useQuery } from '@tanstack/react-query';
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { toUtf8 } from '@cosmjs/encoding';
import useWallet from '@/hooks/useWallet';
import { ManagerState } from './useManagerState';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';

/**
 * Prepares a MsgExecuteContract for updating a market contract with update_config msg (collateral params).
 * @param marketContract The address of the market contract
 * @param managerState The managerState object containing updateCollateralParams
 */
const useUpdateCollateral = ({
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
      'updateCollateral_msgs',
      address,
      marketContract,
      managerState?.updateCollateralParams,
      run,
    ],
    queryFn: () => {
      if (!run || !address || !managerState?.updateCollateralParams) {
        return [];
      }
      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: marketContract,
          msg: toUtf8(
            JSON.stringify({
              update_config: managerState.updateCollateralParams,
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
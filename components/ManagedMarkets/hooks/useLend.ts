import { useQuery } from '@tanstack/react-query';
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { toUtf8 } from '@cosmjs/encoding';
import useWallet from '@/hooks/useWallet';
import { useMarketCollateralPrice, useMarketDebtPrice, useManagedMarket } from '@/hooks/useManaged';
import contracts from '@/config/contracts.json';
import { num } from '@/helpers/num';
import BigNumber from 'bignumber.js';
import useManagedAction, { ManagedActionState } from './useManagedMarketState';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import { shiftDigits } from '@/helpers/math';
import { Asset } from '@/helpers/chain';
import useLendState from './useLendState';
import { LendState } from './useLendState';
import { denoms } from '@/config/defaults';


const useLend = ({
  marketAddress,
  lendState,
  run = true,
}: {
  marketAddress: string;
  lendState: LendState;
  run?: boolean;
}) => {
  const { address } = useWallet();
  const { setLendState } = useLendState();

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'lend_msgs',
      address,
      marketAddress,
      lendState,
      run,
    ],
    queryFn: () => {
      if (
        !run ||
        !address ||
        !lendState.supplyAmount
      ) {
        return { msgs: [] };
      }

      // Prepare Lend CDT message
      const lendMsg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: marketAddress,
          msg: toUtf8(
            JSON.stringify({
              supply_debt: {},
            })
          ),
          funds: [
            {
              denom: denoms.CDT[0] as string,
              amount: shiftDigits(lendState.supplyAmount, 6).toString(),
            },
          ],
        }),
      };


      return { msgs: [lendMsg] };
    },
    enabled: !!address && !!marketAddress && !!lendState.supplyAmount && run,
  });



  const msgs = queryData?.msgs ?? []

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    //setManagedActionState to 0s
    setLendState({
      ...lendState,
      supplyAmount: '0',
    })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['lend_msgs', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
};

export default useLend; 
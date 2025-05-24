import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import { toUtf8 } from '@cosmjs/encoding';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarket';

interface CloseAndEditBoostsTxParams {
  marketContract: string;
  collateralDenom: string;
  managedActionState: any;
  run?: boolean;
}

const useCloseAndEditBoostsTx = ({
  marketContract,
  collateralDenom,
  managedActionState,
  run = true,
}: CloseAndEditBoostsTxParams) => {
  const { address } = useWallet();

  const { setManagedActionState } = useManagedAction();

  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'closeAndEditBoostsTx',
      address || '',
      marketContract || '',
      collateralDenom || '',
      JSON.stringify(managedActionState),
    ],
    queryFn: async () => {
      const msgs: any[] = [];
      // ClosePosition msg
      if (managedActionState.closePercent) {
        msgs.push({
          typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          value: {
            sender: address,
            contract: marketContract,
            msg: {
              close_position: {
                collateral_denom: collateralDenom,
                position_owner: address,
                close_percentage: (managedActionState.closePercent / 100).toString(),
                max_spread: '0.01', // placeholder
                send_to: address,
              },
            },
            funds: [],
          },
        });
      } else {

      
        if (
            //EditUXBoosts msg
            managedActionState.takeProfit ||
            managedActionState.takeProfit ||
            managedActionState.stopLoss ||
            (managedActionState.multiplier && managedActionState.multiplier !== 1)
        ) {
            msgs.push({
            typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
            value: {
                sender: address,
                contract: marketContract,
                msg: {
                edit_ux_boosts: {
                    collateral_denom: collateralDenom,
                    loop_ltv:
                    managedActionState.multiplier && managedActionState.multiplier !== 1
                        ? (1 - 1 / managedActionState.multiplier).toString()
                        : undefined,
                    take_profit_params: managedActionState.takeProfit
                    ? [{
                        ltv: managedActionState.takeProfit, // Should be converted to LTV if needed
                        percent_to_close: '1',
                        send_to: undefined,
                        }]
                    : null,
                    stop_loss_params: managedActionState.stopLoss
                    ? [{
                        ltv: managedActionState.stopLoss, // Should be converted to LTV if needed
                        percent_to_close: '1',
                        send_to: undefined,
                        }]
                    : null,
                    collateral_value_fee_to_executor: undefined,
                },
                },
                funds: [],
            },
            });
        }

        //Deposit or withdraw msg
        if (managedActionState.deposit && managedActionState.collateralAmount != 0) {
            // Prepare Deposit message
            const depositMsg: MsgExecuteContractEncodeObject = {
                typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
                value: MsgExecuteContract.fromPartial({
                sender: address,
                contract: marketContract,
                msg: toUtf8(
                    JSON.stringify({
                    supply_collateral: {
                        collateral_denom: collateralDenom,
                        send_to: undefined,
                    }})
                ),
                funds: [
                    {
                    denom: collateralDenom,
                    amount: managedActionState.collateralAmount,
                    },
                ],
                }),
            };
            msgs.push(depositMsg); 
        } else if (managedActionState.withdraw && managedActionState.collateralAmount != 0) {
            // Prepare Withdraw message
            const withdrawMsg: MsgExecuteContractEncodeObject = {
                typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
                value: MsgExecuteContract.fromPartial({
                sender: address,
                contract: marketContract,
                msg: toUtf8(
                    JSON.stringify({
                    withdraw_collateral: {
                        collateral_denom: collateralDenom,
                        send_to: undefined,
                        withdraw_amount: managedActionState.collateralAmount,
                    }})
                ),
                    funds: [],
                }),
            };
            msgs.push(withdrawMsg); 
            
        }
    }
      return { msgs };
    },
    enabled: !!address && !!marketContract && !!collateralDenom && run,
  });


  const msgs = queryData?.msgs ?? []

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    //setManagedActionState to 0s
    setManagedActionState({
      ...managedActionState,
      collateralAmount: '0',
      multiplier: 0,
      takeProfit: '0',
      stopLoss: '0',
    })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['EditManagedMarket_msgs', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    })
  }

};

export default useCloseAndEditBoostsTx; 
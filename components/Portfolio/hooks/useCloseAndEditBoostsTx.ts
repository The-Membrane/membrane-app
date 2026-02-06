import { useQuery } from '@tanstack/react-query';
import useWallet from '@/hooks/useWallet';
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import { toUtf8 } from '@cosmjs/encoding';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarketState';
import { shiftDigits } from '@/helpers/math';

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

  // console.log('maxSpread', maxSpread);
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
      currentLTV || '',
      collateralPrice || '',
      maxSpread,
    ],
    queryFn: async () => {
      const msgs: any[] = [];
      console.log('maxSpread', maxSpread);
      // console.log('(managedActionState.closePercent / 100).toString()', (managedActionState.closePercent / 100).toString());
      // ClosePosition msg
      if (managedActionState.closePercent) {
        msgs.push({
          typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          value: {
            sender: address,
            contract: marketContract,
            msg: toUtf8(
              JSON.stringify({
                close_position: {
                  collateral_denom: collateralDenom,
                  position_owner: address,
                  close_percentage: (managedActionState.closePercent / 100).toString(),
                  max_spread: maxSpread,
                  send_to: address,
                }
              })
            ),
            funds: [],
          },
        });
      } else {
        //Convert take profit and stop loss to LTV from a price 
        let takeProfitLTV, stopLossLTV;
        const tpPrice = Number(managedActionState.takeProfit);
        const slPrice = Number(managedActionState.stopLoss);
        if (tpPrice && currentLTV && collateralPrice) {
          takeProfitLTV = (Number(currentLTV) * (Number(collateralPrice) / tpPrice)).toString();
        } 
        if (slPrice && currentLTV && collateralPrice) {
          stopLossLTV = (Number(currentLTV) * (Number(collateralPrice) / slPrice)).toString();
        }
        if (
            //EditUXBoosts msg
            managedActionState.takeProfit ||
            managedActionState.stopLoss ||
            (managedActionState.multiplier && managedActionState.multiplier !== 1)
        ) {
            msgs.push({
            typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
            value: {
                sender: address,
                contract: marketContract,
                msg: 
                  toUtf8(
                    JSON.stringify({
                      edit_u_x_boosts: {
                    collateral_denom: collateralDenom,
                    loop_ltv:
                    managedActionState.multiplier && managedActionState.multiplier !== 1
                        ? (1 - 1 / managedActionState.multiplier).toString()
                        : undefined,
                    take_profit_params: takeProfitLTV && !isNaN(Number(takeProfitLTV))
                    ? {
                        ltv: takeProfitLTV,
                        percent_to_close: '1',
                        send_to: undefined,
                        perpetual: false,
                        }
                    : undefined,
                    stop_loss_params: stopLossLTV && !isNaN(Number(stopLossLTV))
                    ? {
                        ltv: stopLossLTV,
                        percent_to_close: '1',
                        send_to: undefined,
                        perpetual: false,
                        }
                    : undefined,
                    collateral_value_fee_to_executor: undefined,
                }}
              )),
                funds: [],
            },
            });
            
        }

        console.log("managedActionState.collateralAmount", shiftDigits(managedActionState.collateralAmount, decimals).toString())
        //Deposit msg
        if (managedActionState.collateralAmount != 0) {
            // Prepare Deposit message
            const depositMsg: MsgExecuteContractEncodeObject = {
                typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
                value: MsgExecuteContract.fromPartial({
                sender: address,
                contract: marketContract,
                msg: toUtf8(
                    JSON.stringify({
                    supply_collateral: {
                    }})
                ),
                funds: [
                    {
                    denom: collateralDenom,
                    amount: shiftDigits(managedActionState.collateralAmount, decimals).toFixed(0)
                    },
                ],
                }),
            };
            msgs.push(depositMsg); 
        } 
        
        // Borrow msg
        if (managedActionState.borrowAmount && Number(managedActionState.borrowAmount) > 0) {
            const borrowMsg: MsgExecuteContractEncodeObject = {
                typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: marketContract,
                    msg: toUtf8(
                        JSON.stringify({
                            borrow: {
                                collateral_denom: collateralDenom,
                                borrow_amount: {
                                    amount: shiftDigits(managedActionState.borrowAmount, 6).toFixed(0),
                                    ltv: undefined,
                                },
                            },
                        })
                    ),
                    funds: [],
                }),
            };
            msgs.push(borrowMsg);
        }

        // Repay msg
        if (managedActionState.repayAmount && Number(managedActionState.repayAmount) > 0) {
            const repayMsg: MsgExecuteContractEncodeObject = {
                typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: marketContract,
                    msg: toUtf8(
                        JSON.stringify({
                            repay: {
                                collateral_denom: collateralDenom,
                                send_excess_to: address,
                            },
                        })
                    ),
                    funds: [
                        {
                            denom: 'ucdt',
                            amount: shiftDigits(managedActionState.repayAmount, 6).toFixed(0)
                        },
                    ],
                }),
            };
            msgs.push(repayMsg);
        }

        // else if (managedActionState.withdraw && managedActionState.collateralAmount != 0) {
        //     // Prepare Withdraw message
        //     const withdrawMsg: MsgExecuteContractEncodeObject = {
        //         typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        //         value: MsgExecuteContract.fromPartial({
        //         sender: address,
        //         contract: marketContract,
        //         msg: toUtf8(
        //             JSON.stringify({
        //             withdraw_collateral: {
        //                 collateral_denom: collateralDenom,
        //                 send_to: undefined,
        //                 withdraw_amount: managedActionState.collateralAmount,
        //             }})
        //         ),
        //             funds: [],
        //         }),
        //     };
        //     msgs.push(withdrawMsg); 
            
        // }
    }
      return { msgs };
    },
    enabled: !!address && !!marketContract && !!collateralDenom && run,
  });


  const msgs = queryData?.msgs ?? []
  // console.log('msgs', msgs);

  const onInitialSuccess = () => {
    // queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['managed_market_user_position'] })
    queryClient.invalidateQueries({ queryKey: ['managed_market_user_ux_boosts'] })
    queryClient.invalidateQueries({ queryKey: ['user_position'] })

    //setManagedActionState to 0s
    setManagedActionState({
      ...managedActionState,
      collateralAmount: '',
      multiplier: 1,
      takeProfit: '',
      stopLoss: '',
      borrowAmount: '',
      repayAmount: '',
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
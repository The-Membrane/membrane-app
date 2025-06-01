import { useQuery } from '@tanstack/react-query';
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { toUtf8 } from '@cosmjs/encoding';
import useWallet from '@/hooks/useWallet';
import { useMarketCollateralPrice, useMarketDebtPrice, useManagedMarket } from '@/hooks/useManaged';
import contracts from '@/config/contracts.json';
import { num } from '@/helpers/num';
import BigNumber from 'bignumber.js';
import useManagedAction, { ManagedActionState } from './useManagedMarket';
import { queryClient } from '@/pages/_app';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import { shiftDigits } from '@/helpers/math';


const useBorrowAndBoost = ({
  marketContract,
  collateralDenom,
  managedActionState,
  run = true,
}: {
  marketContract: string;
  collateralDenom: string;
  managedActionState: ManagedActionState;
  run?: boolean;
}) => {
  const { address } = useWallet();
  const { data: collateralPriceData } = useMarketCollateralPrice(marketContract, collateralDenom);
  const { data: debtPriceData } = useMarketDebtPrice(marketContract);
  const { data: marketParams } = useManagedMarket(marketContract, collateralDenom);
  const { setManagedActionState } = useManagedAction();

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'borrowAndBoost_msgs',
      address,
      marketContract,
      collateralDenom,
      managedActionState,
      collateralPriceData,
      debtPriceData,
      marketParams,
      run,
    ],
    queryFn: () => {
      if (
        !run ||
        !address ||
        !marketParams ||
        !collateralPriceData?.price ||
        !debtPriceData?.price ||
        !managedActionState.collateralAmount ||
        !managedActionState.multiplier
      ) {
        return { msgs: [] };
      }

      // Calculate LTV from multiplier: multiplier = 1 / (1 - LTV) => LTV = 1 - 1/multiplier
      const loopLTV = 1 - 1 / managedActionState.multiplier;
      // Collateral value in USD
      const collateralValue = num(managedActionState.collateralAmount).times(collateralPriceData.price);
      // Borrow amount in debt token units
      const borrowAmount = collateralValue.times(loopLTV).div(debtPriceData.price);

      // Collateral value fee to executor: min($1, 1% of collateral value)
      const feeToExecutor = BigNumber.min(new BigNumber(1), collateralValue.times(0.01));

      // Convert TP/SL price to LTV
      let takeProfitLTV: string | undefined = undefined;
      let stopLossLTV: string | undefined = undefined;
      const collateralAmount = num(managedActionState.collateralAmount);
      // const currentCollateralPrice = num(collateralPriceData.price);
      const currentDebtPrice = num(debtPriceData.price);
      const borrowAmountValue = borrowAmount;

      if (managedActionState.takeProfit) {
        const tpPrice = num(managedActionState.takeProfit);
        // LTV = (debt_price * debt_amount) / (tpPrice * collateralAmount)
        takeProfitLTV = borrowAmountValue.times(currentDebtPrice).div(tpPrice.times(collateralAmount)).toString();
      }
      if (managedActionState.stopLoss) {
        const slPrice = num(managedActionState.stopLoss);
        // LTV = (debt_price * debt_amount) / (slPrice * collateralAmount)
        stopLossLTV = borrowAmountValue.times(currentDebtPrice).div(slPrice.times(collateralAmount)).toString();
      }

      // Prepare Deposit message
      const depositMsg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: marketContract,
          msg: toUtf8(
            JSON.stringify({
              supply_collateral: { }})
          ),
          funds: [
            {
              denom: collateralDenom,
              amount: shiftDigits(managedActionState.collateralAmount, 6).toString(),
            },
          ],
        }),
      };

      // Prepare Borrow message
      const borrowMsg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: marketContract,
          msg: toUtf8(
            JSON.stringify({
              borrow: {
                collateral_denom: collateralDenom,
                send_to: undefined,
                borrow_amount: {
                  amount: borrowAmount.integerValue().toString(),
                  ltv: undefined,
                },
              },
            })
          ),
          funds: [],
        }),
      };

      // Prepare EditUXBoosts message
      const editUXBoostsMsg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: marketContract,
          msg: toUtf8(
            JSON.stringify({
              edit_ux_boosts: {
                collateral_denom: collateralDenom,
                loop_ltv: loopLTV ? loopLTV.toString() : undefined,
                take_profit_params: takeProfitLTV
                  ? [{
                      ltv: takeProfitLTV,
                      percent_to_close: '1',
                      send_to: undefined,
                    }]
                  : null,
                stop_loss_params: stopLossLTV
                  ? [{
                      ltv: stopLossLTV,
                      percent_to_close: '1',
                      send_to: undefined,
                    }]
                  : null,
                collateral_value_fee_to_executor: feeToExecutor.toString(),
              },
            })
          ),
          funds: [],
        }),
      };

      return { msgs: [depositMsg, borrowMsg, editUXBoostsMsg] };
    },
    enabled: !!address && !!marketParams && !!collateralPriceData?.price && !!debtPriceData?.price && !!managedActionState.collateralAmount && !!managedActionState.multiplier && run,
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
      queryKey: ['borrowAndBoost_msgs', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    })
  }
};

export default useBorrowAndBoost; 
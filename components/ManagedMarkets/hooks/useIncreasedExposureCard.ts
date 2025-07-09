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


const useTransformExposure = ({
  marketContract,
  asset,
  managedActionState,
  borrowAmount,
  mode,
  maxBorrowLTV,
  collateralValue,
  run = true,
}: {
  marketContract: string;
  asset: Asset;
  managedActionState: ManagedActionState;
  borrowAmount: string;
  mode: 'multiply' | 'de-risk';
  maxBorrowLTV: number;
  collateralValue: number;
  run?: boolean;
}) => {
  const { address } = useWallet();
  const { setManagedActionState } = useManagedAction();

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'transformExposure_msgs',
      address,
      marketContract,
      asset,
      managedActionState,
      borrowAmount,
      mode,
      collateralValue,
      maxBorrowLTV,
      run,
    ],
    queryFn: () => {
      console.log('🔍 useTransformExposure queryFn called with params:', {
        run,
        address,
        asset: asset?.base,
        borrowAmount,
        maxBorrowLTV,
        mode,
        collateralValue,
        managedActionState: {
          collateralAmount: managedActionState.collateralAmount,
          multiplier: managedActionState.multiplier,
        }
      });

      if (
        !run ||
        !address ||
        !asset ||
        !borrowAmount ||
        !maxBorrowLTV ||
        !mode ||
        !managedActionState.collateralAmount 
      ) {
        console.log('❌ useTransformExposure: Early return due to missing required params');
        return { msgs: [] };
      }

      console.log('✅ useTransformExposure: All required params present, proceeding with message creation');

      var msgs: MsgExecuteContractEncodeObject[] = [];

      // Calculate LTV from multiplier: multiplier = 1 / (1 - LTV) => LTV = 1 - 1/multiplier
      var loopLTV = 1 - 1 / managedActionState.multiplier;
      console.log('📊 useTransformExposure: Calculated loopLTV:', loopLTV, 'from multiplier:', managedActionState.multiplier);
      
      if (loopLTV > maxBorrowLTV) {
        console.log('⚠️ useTransformExposure: loopLTV capped from', loopLTV, 'to maxBorrowLTV:', maxBorrowLTV);
        loopLTV = maxBorrowLTV;
      }

      // Collateral value fee to executor: min($1, 1% of collateral value)
      const feeToExecutor = BigNumber.min(new BigNumber(1), num(collateralValue).times(0.01));
      console.log('💰 useTransformExposure: Calculated feeToExecutor:', feeToExecutor.toString(), 'from collateralValue:', collateralValue);

      /// Deposit no matter what

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
              denom: asset.base,
              amount: shiftDigits(managedActionState.collateralAmount, asset.decimal).toFixed(0),
            },
          ],
        }),
      };
      msgs.push(depositMsg);
      console.log('📤 useTransformExposure: Added deposit message for', managedActionState.collateralAmount, asset.base);

      if (mode === 'multiply') {
        console.log('🚀 useTransformExposure: Processing MULTIPLY mode');
        
        // Prepare EditUXBoosts message
        const editUXBoostsMsg: MsgExecuteContractEncodeObject = {
            typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
            value: MsgExecuteContract.fromPartial({
            sender: address,
            contract: marketContract,
            msg: toUtf8(
                JSON.stringify({
                edit_u_x_boosts: {
                    collateral_denom: asset.base,
                    loop_ltv: loopLTV ? loopLTV.toString() : undefined,
                    // loop_ltv: loopLTV ? { 
                    // loop_ltv: loopLTV.toString(), 
                    // perpetual: false 
                    // } : undefined,
                    collateral_value_fee_to_executor: feeToExecutor.toFixed(2),
                },
                })
            ),
            funds: [],
            }),
        };
        msgs.push(editUXBoostsMsg);
        console.log('⚙️ useTransformExposure: Added editUXBoosts message with loopLTV:', loopLTV);

        // Prepare Loop Position message
        const loopPositionMsg: MsgExecuteContractEncodeObject = {
            typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
            value: MsgExecuteContract.fromPartial({
            sender: address,
            contract: marketContract,
            msg: toUtf8(
                JSON.stringify({
                loop_position: {
                    collateral_denom: asset.base,
                    position_owner: address,
                },
                })
            ),
            funds: [],
            }),
        };
        msgs.push(loopPositionMsg);
        console.log('🔄 useTransformExposure: Added loopPosition message for position owner:', address);
      } else {
        console.log('🛡️ useTransformExposure: Processing DE-RISK mode');

        // Prepare Borrow message
        const borrowMsg: MsgExecuteContractEncodeObject = {
          typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          value: MsgExecuteContract.fromPartial({
            sender: address,
            contract: marketContract,
            msg: toUtf8(
              JSON.stringify({
                borrow: {
                  collateral_denom: asset.base,
                  send_to: undefined,
                  borrow_amount: {
                    amount: shiftDigits(borrowAmount, 6).toString(),
                    ltv: undefined,
                  },
                },
              })
            ),
            funds: [],
          }),
        };
        msgs.push(borrowMsg);
        console.log("💸 useTransformExposure: Added borrow message with borrowAmount:", borrowAmount.toString());
      }

      console.log('📋 useTransformExposure: Final message count:', msgs.length, 'messages created');
      console.log('📋 useTransformExposure: Message types:', msgs.map(msg => msg.typeUrl));

      return { msgs };
    },
    enabled: !!address  && !!collateralValue && !!managedActionState.collateralAmount && run,
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
      queryKey: ['transformExposure_msg_sim', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
};


export default useTransformExposure; 
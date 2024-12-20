import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useEffect, useMemo, useState } from 'react'

import contracts from '@/config/contracts.json'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { shiftDigits } from '@/helpers/math'
import useQuickActionState from './useQuickActionState'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from "@cosmjs/encoding";
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useCDTVaultTokenUnderlying } from '@/components/Earn/hooks/useEarnQueries'
import { num } from '@/helpers/num'
import useNeuroState from "./useNeuroState"
import { useBasket } from "@/hooks/useCDP"


import EventEmitter from 'events';
import useCollateralAssets from '@/components/Bid/hooks/useCollateralAssets'
EventEmitter.defaultMaxListeners = 25; // Increase the limit

const useNeuroGuard = ( ) => { 
  const { address } = useWallet()
  const { data: basket } = useBasket()
  const assets = useCollateralAssets()
  const { neuroState } = useNeuroState()

//   const { data } = useCDTVaultTokenUnderlying(shiftDigits(earnCDTBalance, 6).toFixed(0))
//   const underlyingCDT = data ?? "1"
  
  // Debounce the slider value to prevent too many queries
  const [debouncedValue, setDebouncedValue] = useState<{selectedAsset: any}>(
    { selectedAsset: undefined}
  );
  
  useEffect(() => {
    console.log('Debounce effect triggered:', neuroState);
    const timer = setTimeout(() => {
      console.log('Setting debounced values:', neuroState);
      setDebouncedValue({
        selectedAsset: neuroState.selectedAsset
      });
    }, 300);
    
    return () =>{
      console.log('Cleaning up debounce effect');
       clearTimeout(timer)
      };
  }, [neuroState.selectedAsset]);

  const guardedAsset = useAssetBySymbol(debouncedValue.selectedAsset?.symbol || "N/A")
    
  // useEffect(() => {console.log("debounced changed")}, [debouncedValue])
  // useEffect(() => {console.log("debounced selectedAsset changed")}, [debouncedValue.selectedAsset])

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'neuroGuard_msg_creation',
      address,
      debouncedValue.selectedAsset,
      guardedAsset,
      basket,
      assets
    ],
    queryFn: () => {
      console.log("in query guardian", guardedAsset)


      if (!address || !debouncedValue.selectedAsset || !guardedAsset || !basket || !assets) {console.log("neuroGuard early return", address, debouncedValue, guardedAsset, basket, assets); return { msgs: [] }}
      var msgs = [] as MsgExecuteContractEncodeObject[]

        const newDeposit = num(debouncedValue.selectedAsset.sliderValue).toNumber()
        const amount = shiftDigits(num(newDeposit).dividedBy(debouncedValue.selectedAsset.price).toString(), debouncedValue.selectedAsset.decimal).toFixed(0)
        console.log("Neuro funds", newDeposit, amount, debouncedValue.selectedAsset)
        const funds = [{ amount, denom: guardedAsset.base }]      
        console.log(funds)

        //Deposit msg
        let depositMsg  = {
            typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
            value: MsgExecuteContract.fromPartial({
            sender: address,
            contract: contracts.cdp,
            msg: toUtf8(JSON.stringify({
                deposit: { }
            })),
            funds: funds
            })
        } as MsgExecuteContractEncodeObject
        msgs.push(depositMsg)

        //Mint msg 
        //Add vault intent
        let mintMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.cdp,
          msg: toUtf8(JSON.stringify({
              set_intent: { 
                mint_intent: {
                  user: address,
                  position_id: basket.current_position_id,
                  mint_to_ltv: num(assets.find((p: any) => p.base === debouncedValue.selectedAsset.base)?.maxBorrowLTV).times(1).toString()
                }
            }
          })),
          funds: []
          })
        } as MsgExecuteContractEncodeObject
        msgs.push(mintMsg)

        //Fulfill intent thru CDP to set the intent on the RBLP vault & mint the initial CDT
        let fulfillIntentMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.cdp,
          msg: toUtf8(JSON.stringify({
              fulfill_intents: {
                users: [address],
              }
          })),
          funds: []
          })
        } as MsgExecuteContractEncodeObject
        msgs.push(fulfillIntentMsg)
      

      console.log("in query guardian msgs:", msgs)
      
      return { msgs }
    },
    enabled: !!address,
    // staleTime: 5000,
    // Disable automatic refetching
    // refetchOnWindowFocus: false,
    // refetchOnReconnect: false,
    // refetchOnMount: false,
    // retry: false
    /////ERRORS ON THE 3RD OR 4TH MODAL OPEN, CHECKING TO SEE IF ITS THE INVALIDATED QUERY////
  })
  
  console.log("neuroGuard msgs:", "enabled", !!address)
  const  msgs = queryData?.msgs ?? []

  console.log("neuroGuard msgs:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['home_page_neuroGuard', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useNeuroGuard
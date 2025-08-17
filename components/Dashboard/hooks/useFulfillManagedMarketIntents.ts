import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { toUtf8 } from '@cosmjs/encoding'
import { useAllMarkets } from '@/hooks/useManaged'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { getMarketCollateralDenoms, getManagedUXBoosts, getMarketCollateralPrice, getUserPositioninMarket, getMarketDebtPrice } from '@/services/managed'
import { shiftDigits } from '@/helpers/math'
import { queryClient } from '@/pages/_app'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useChainRoute } from '@/hooks/useChainRoute'
import useAppState from '@/persisted-state/useAppState'

/**
 * Create a loop position execution message.
 */
const createLoopPositionMsg = (
  sender: string,
  marketContract: string,
  collateralDenom: string,
  positionOwner: string,
): MsgExecuteContractEncodeObject => ({
  typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
  value: MsgExecuteContract.fromPartial({
    sender,
    contract: marketContract,
    msg: toUtf8(
      JSON.stringify({
        loop_position: {
          collateral_denom: collateralDenom,
          position_owner: positionOwner,
        },
      }),
    ),
    funds: [],
  }),
})

/**
 * Create a close position execution message.
 */
const createClosePositionMsg = (
  sender: string,
  marketContract: string,
  collateralDenom: string,
  positionOwner: string,
): MsgExecuteContractEncodeObject => ({
  typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
  value: MsgExecuteContract.fromPartial({
    sender,
    contract: marketContract,
    msg: toUtf8(
      JSON.stringify({
        close_position: {
          collateral_denom: collateralDenom,
          position_owner: positionOwner,
          close_percentage: '1', // close full position
          max_spread: undefined,
          send_to: positionOwner,
        },
      }),
    ),
    funds: [],
  }),
})


/**
 * Hook that compiles up to 11 messages required to fulfil all outstanding managed market intents.
 *
 * The hook inspects every managed market, evaluates each users UXBoost parameters versus
 * current market state and prepares the appropriate execution messages:
 *   • loop_position when current LTV deviates by >3% from desired loop_ltv
 *   • close_position when current LTV is below take-profit or above stop-loss thresholds
 *   • close_position when current debt price triggers an arbitrage intent
 */
export const useFulfillManagedMarketIntents = (
  run = true,
) => {
  const { appState } = useAppState()
  const { data: client } = useCosmWasmClient(appState.rpcUrl)
  const markets = useAllMarkets()
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)


  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
    status: 'pending' | 'finished' | 'error'
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['fulfill_managed_market_intents', client, markets, address, run],
    queryFn: async () => {
      console.log(`[Intents] Query function called - run: ${run}, client: ${!!client}, markets: ${!!markets}, address: ${!!address}`)
      if (!client || !markets || !address || !run) {
        console.log(`[Intents] Early return - missing dependencies`)
        return { msgs: [], status: 'error' }
      }

      console.log('[Intents] Starting scan of managed markets')
      console.log(`[Intents] Markets count: ${markets.length}`)
      const msgs: MsgExecuteContractEncodeObject[] = []

      for (const market of markets) {
        console.log(`[Intents] Checking market ${market.address}`)
        if (msgs.length >= 11) break

        const marketContract = market.address

        // Fetch debt price once per market (used for SL/TP & arb)
        console.log(`[Intents]   Fetching debt price`)
        let debtPrice = 0
        try {
          const debtPriceResp = await getMarketDebtPrice(client, marketContract)
          debtPrice = Number(debtPriceResp.price)
          console.log(`[Intents]   Debt price: ${debtPrice}`)
        } catch (e) {
          console.warn(`[Intents]   Failed to fetch debt price for ${marketContract}`, e)
          continue
        }

        // Retrieve collateral denoms handled by the market
        console.log(`[Intents]   Fetching collateral denoms`)
        let collateralDenoms: string[] = []
        try {
          collateralDenoms = await getMarketCollateralDenoms(client, marketContract)
          console.log(`[Intents]   Collateral denoms:`, collateralDenoms)
        } catch (e) {
          console.warn(`[Intents]   Failed to fetch collateral denoms for ${marketContract}`, e)
          continue
        }

        for (const collateralDenom of collateralDenoms) {
          console.log(`[Intents]     Processing collateral ${collateralDenom}`)
          if (msgs.length >= 11) break

          // Parallel data fetches: UX boosts + collateral price
          console.log(`[Intents]       Fetching UX boosts & collateral price`)
          let uxBoosts: any[] = []
          let collateralPriceResp: any = null

          try {
            const [uxBoostsResult, collateralPriceResult] = await Promise.all([
              getManagedUXBoosts(client, marketContract, collateralDenom),
              getMarketCollateralPrice(client, marketContract, collateralDenom),
            ])
            uxBoosts = uxBoostsResult || []
            collateralPriceResp = collateralPriceResult
            console.log(`[Intents]       Successfully fetched UX boosts (${uxBoosts.length}) and collateral price`)
          } catch (e) {
            console.error(`[Intents]       Failed to fetch UX boosts or collateral price for ${collateralDenom}:`, e)
            continue
          }

          const collateralPrice = Number(collateralPriceResp.price)
          console.log(`[Intents]       Collateral price: ${collateralPrice}`)
          if (!uxBoosts?.length) {
            console.log(`[Intents]       No UX boosts found`)
            continue
          }

          // Iterate through each user boost entry
          for (const boost of uxBoosts as any[]) {
            if (msgs.length >= 11) break
            const { user } = boost
            console.log(`[Intents]       Evaluating user ${user}`)

            // Obtain user position in the market for this collateral
            let userPositions: any[] = []
            try {
              userPositions = await getUserPositioninMarket(client, marketContract, collateralDenom, user)
            } catch (e) {
              console.warn(`[Intents]         Failed to fetch position for ${user}`, e)
              continue
            }
            if (!userPositions?.length) {
              console.log(`[Intents]         User has no position`)
              continue
            }

            const position = userPositions[0].position
            const collateralAmount = Number(shiftDigits(position.collateral_amount, -6).toString())
            const debtAmount = Number(shiftDigits(position.debt_amount, -6).toString())
            if (!collateralAmount) continue

            const currentLTV = (debtAmount * debtPrice) / (collateralAmount * collateralPrice)
            console.log(`[Intents]         Current LTV for ${user}: ${currentLTV}`)

            /* ---------- LOOP INTENT ---------- */
            if (boost.loop_ltv?.loop_ltv) {
              const desiredLTV = Number(boost.loop_ltv.loop_ltv)
              const deviation = Math.abs(currentLTV - desiredLTV) / desiredLTV
              if (deviation > 0.03 && msgs.length < 11) {
                msgs.push(createLoopPositionMsg(address, marketContract, collateralDenom, user))
                console.log(`[Intents]         Added loop_position msg for ${user}`)
              }
            }

            /* ---------- TAKE PROFIT ---------- */
            if (boost.take_profit_params?.ltv) {
              const tpLTV = Number(boost.take_profit_params.ltv)
              if (currentLTV <= tpLTV && msgs.length < 11) {
                msgs.push(createClosePositionMsg(address, marketContract, collateralDenom, user))
                console.log(`[Intents]         Added close_position msg for take-profit ${user}`)
              }
            }

            /* ---------- STOP LOSS ---------- */
            if (boost.stop_loss_params?.ltv) {
              const slLTV = Number(boost.stop_loss_params.ltv)
              if (currentLTV >= slLTV && msgs.length < 11) {
                msgs.push(createClosePositionMsg(address, marketContract, collateralDenom, user))
                console.log(`[Intents]         Added close_position msg for stop-loss ${user}`)
              }
            }

            /* ---------- ARBITRAGE PRICE INTENT ---------- */
            if (boost.arb_price_intent) {
              const arbPrice = Number(boost.arb_price_intent)
              if (debtPrice <= arbPrice && msgs.length < 11) {
                msgs.push(createClosePositionMsg(address, marketContract, collateralDenom, user))
                console.log(`[Intents]         Added close_position msg for arb-price ${user}`)
              }
            }
          }
        }
      }

      console.log(`[Intents] Scan complete – prepared ${msgs.length} msgs`)

      return { msgs, status: 'finished' }
    },
    enabled: !!client && !!markets && !!address && run,
    staleTime: 60 * 1000, // 1 min – fresh enough for intent scanning
    retry: 1, // Limit retries to avoid infinite loops
    retryDelay: 1000, // Wait 1 second between retries
  })


  const msgs = queryData?.msgs ?? []
  const status = queryData?.status ?? 'pending'
  // console.log("msgs", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['managed_market_intents_sim', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
    msgs,
    status,
  }
}


export default useFulfillManagedMarketIntents
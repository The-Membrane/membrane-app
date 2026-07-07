import { erc20Abi, zeroHash } from 'viem'
import { useQuery } from '@tanstack/react-query'

import { transmuterAbi } from '@/contracts/abis/transmuter'
import { assetKey } from '@/services/chain/transmuter'
import { getContractAddress } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { shiftDigits } from '@/helpers/math'
import useEarnState from './useEarnState'

/**
 * Earn deposit/withdraw CTA — migrated to EVM (EvmCall[]).
 *
 * The Cosmos "Earn vault" (Mars-USDC looped CDP: EarnMsgComposer.enterVault/exitVault +
 * close_c_d_p) does NOT exist in the port. The EVM analog is the Transmuter PSM vault, whose
 * tranche capital IS the swap inventory (see services/chain/transmuter.ts / Transmuter.sol):
 *   deposit  → Transmuter.enterVault(recipient, fundsCdt, fundsPaired, trancheAssets,
 *                                    trancheJunior, trancheAmounts, affiliate)
 *   withdraw → Transmuter.exitVault(effectiveUser, recipient, trancheAssets, trancheJunior,
 *                                   vtAmounts, withdrawAs)
 *
 * USDC is the paired asset, deposited into a single SENIOR tranche keyed by the paired-asset
 * denom. There is no `close_c_d_p` equivalent (no per-user CDP behind the vault).
 */
const useEarn = () => {
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()
  const usdcAsset = useAssetBySymbol('USDC')
  const earnUSDCAsset = useAssetBySymbol('earnUSDC')

  const { chain } = useWallet()
  const transmuterAddr = chain ? getContractAddress(chain.id, 'transmuter') : undefined

  const { data: queryData } = useQuery<{ msgs: EvmCall[] }>({
    queryKey: [
      'earn_msgs_creation',
      address,
      transmuterAddr,
      earnState.withdraw,
      earnState.deposit,
      usdcAsset?.base,
    ],
    queryFn: () => {
      if (!address || !usdcAsset || !transmuterAddr) return { msgs: [] }
      const msgs: EvmCall[] = []

      // TODO(evm-migration): the canonical paired-asset bytes32 key is config.paired_asset_denom
      // (getConfig() in services/chain/transmuter.ts) — deployment-defined. Derived here from the
      // USDC symbol via the shared assetKey() convention. Senior tranche (junior=false).
      const trancheDenom = assetKey(usdcAsset.symbol)
      const pairedErc20 = usdcAsset.base as `0x${string}`

      if (earnState.withdraw != 0) {
        // exitVault burns vault-token shares. earnState.withdraw is a USDC *underlying* amount;
        // the precise underlying→VT conversion is `vt = underlying * vault_token_supply / total_staked`
        // (getTrancheState / getTrancheUnderlying). Wired 1:1 in VT base units here.
        // TODO(evm-migration): read trancheState to convert underlying→VT exactly before enabling.
        const vtDecimals = earnUSDCAsset?.decimal ?? 18
        const vtAmount = BigInt(shiftDigits(earnState.withdraw, vtDecimals).dp(0).toString())
        if (vtAmount > 0n) {
          msgs.push({
            address: transmuterAddr,
            abi: transmuterAbi,
            functionName: 'exitVault',
            // (effectiveUser, recipient, trancheAssets, trancheJunior, vtAmounts, withdrawAs)
            // withdrawAs = 0 (PROPORTIONAL).
            args: [address, address, [trancheDenom], [false], [vtAmount], 0],
          })
        }
      }

      if (earnState.deposit != 0) {
        const microAmount = BigInt(shiftDigits(earnState.deposit, usdcAsset.decimal).dp(0).toString())
        if (microAmount > 0n) {
          // ERC-20 pattern: approve then enterVault. NOT atomic — two wallet signatures
          // (see services/chain/types.ts). enterVault pulls the paired asset via transferFrom.
          msgs.push({
            address: pairedErc20,
            abi: erc20Abi,
            functionName: 'approve',
            args: [transmuterAddr, microAmount],
          })
          msgs.push({
            address: transmuterAddr,
            abi: transmuterAbi,
            functionName: 'enterVault',
            // (recipient, fundsCdt, fundsPaired, trancheAssets, trancheJunior, trancheAmounts, affiliate)
            // fundsCdt=0 (pure paired deposit); affiliate = bytes32(0).
            args: [
              address,
              0n,
              microAmount,
              [trancheDenom],
              [false],
              [microAmount],
              zeroHash,
            ],
          })
        }
      }

      return { msgs }
    },
    enabled: !!address && !!usdcAsset && !!transmuterAddr,
  })

  const msgs = queryData?.msgs ?? []

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['useVaultInfo'] })
    setEarnState({ withdraw: 0, deposit: 0 })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['earn_page_transmuter_vault', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
}

export default useEarn

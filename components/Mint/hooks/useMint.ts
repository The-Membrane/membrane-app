import { erc20Abi } from 'viem'
import { cdpAbi } from '@/contracts/abis/cdp'
import { assetKey } from '@/services/chain/liquidation'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import { useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import useMintState from './useMintState'
import { queryClient } from '@/pages/_app'
import { MAX_CDP_POSITIONS } from '@/config/defaults'

/**
 * Mint / borrower CTA — EVM port of the CosmWasm deposit/withdraw/mint/repay flow.
 * Migration counterpart: the old helpers/mint.ts (getDepostAndWithdrawMsgs +
 * getMintAndRepayMsgs) built CosmWasm MsgExecuteContract objects. Here we build an
 * EvmCall[] against Cdp.sol (contracts/abis/cdp.ts):
 *   - collateral deposit  → erc20.approve(cdp, amt) + cdp.deposit(id, owner, funds[])
 *   - collateral withdraw → cdp.withdraw(id, funds[])
 *   - borrow (mint)       → cdp.increaseDebt(id, cdtDenom, amt)   [3-arg, variable rate]
 *   - repay               → erc20(CDT).approve(cdp, amt) + cdp.repay(id, owner, amt, cdtDenom)
 *
 * NOTE: EvmCall[] of length > 1 is NOT atomic — each entry is a separate wallet signature
 * (see services/chain/types.ts). approve+action pairs are the accepted 2-step.
 *
 * TODO(evm-migration): the CosmWasm flow also emitted Points check/give sandwich msgs around
 * repay (PointsMsgComposer). The EVM Points surface is not wired into the CDP domain yet, so
 * those are dropped here; re-add once a Points service exists.
 */

const toBase = (amount: string | number, decimals: number): bigint =>
  BigInt(shiftDigits(num(amount).abs().toString(), decimals).dp(0).toString())

// Cdp.sol Fund tuple: { denom: bytes32, amount: uint256 }.
type Fund = { denom: `0x${string}`; amount: bigint }

const useMint = () => {
  const { mintState, setMintState } = useMintState()
  const { summary = [] } = mintState
  const { address, chain } = useWallet()
  const { data: positions } = useUserPositions()
  const cdtAsset = useAssetBySymbol('CDT')

  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined

  // positionNumber is 1-based into the user's positions. When it points past the last
  // position we open a NEW position — Cdp.sol.deposit treats positionId 0 as "new position"
  // and returns the minted finalPositionId.
  const positionId = useMemo<bigint>(() => {
    if (
      positions &&
      positions.length > 0 &&
      mintState.positionNumber >= 1 &&
      mintState.positionNumber <= Math.min(positions.length, MAX_CDP_POSITIONS)
    ) {
      return positions[mintState.positionNumber - 1].positionId
    }
    return 0n
  }, [positions, mintState.positionNumber])

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'mint',
      'evm',
      address ?? '',
      cdpAddr ?? '',
      positionId.toString(),
      JSON.stringify(summary.map((s) => `${s.base}:${s.amount}`)),
      String(mintState?.mint ?? 0),
      String(mintState?.repay ?? 0),
    ],
    queryFn: () => {
      if (!address || !cdpAddr) return undefined

      const approvals: EvmCall[] = []
      const depositFunds: Fund[] = []
      const withdrawFunds: Fund[] = []

      // Collateral moves: positive amount = deposit (ERC-20 pull → needs approve),
      // negative = withdraw. denom is the bytes32 asset key; token is asset.base (ERC-20 addr).
      summary.forEach((asset) => {
        const signed = num(asset.amount)
        if (signed.abs().dp(asset.decimal ?? 18).isZero()) return
        const amount = toBase(asset.amount ?? 0, asset.decimal ?? 18)
        // TODO(evm-migration): bytes32 asset denom is deployment-defined (see
        // services/chain/liquidation.ts assetKey). Derived from the asset symbol here;
        // confirm against the registered Cdp.sol denom before relying on write paths.
        const denom = assetKey(asset.symbol)
        if (signed.isGreaterThan(0)) {
          approvals.push({
            address: asset.base as Address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [cdpAddr, amount],
          })
          depositFunds.push({ denom, amount })
        } else {
          withdrawFunds.push({ denom, amount })
        }
      })

      const deposits: EvmCall[] =
        depositFunds.length > 0
          ? [{ address: cdpAddr, abi: cdpAbi, functionName: 'deposit', args: [positionId, address, depositFunds] }]
          : []
      const withdraws: EvmCall[] =
        withdrawFunds.length > 0
          ? [{ address: cdpAddr, abi: cdpAbi, functionName: 'withdraw', args: [positionId, withdrawFunds] }]
          : []

      // Borrow (mint CDT) — increaseDebt(positionId, borrowAsset, amount).
      const mintCalls: EvmCall[] = []
      if (num(mintState?.mint ?? 0).isGreaterThan(0)) {
        mintCalls.push({
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'increaseDebt',
          args: [positionId, assetKey('CDT'), toBase(mintState.mint, cdtAsset?.decimal ?? 18)],
        })
      }

      // Repay — pulls CDT (18 dec) → approve CDT then repay(id, owner, amount, cdtDenom).
      const repayCalls: EvmCall[] = []
      if (num(mintState?.repay ?? 0).isGreaterThan(0) && cdtAsset) {
        const amount = toBase(mintState.repay, cdtAsset.decimal)
        repayCalls.push({
          address: cdtAsset.base as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [cdpAddr, amount],
        })
        repayCalls.push({
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'repay',
          args: [positionId, address, amount, assetKey('CDT')],
        })
      }

      // When repaying, repay first (frees LTV) before collateral moves / new borrow.
      const calls = num(mintState?.repay ?? 0).isGreaterThan(0)
        ? [...repayCalls, ...approvals, ...deposits, ...withdraws, ...mintCalls]
        : [...approvals, ...deposits, ...withdraws, ...mintCalls]

      return calls.length > 0 ? calls : undefined
    },
    enabled: !!address && !!cdpAddr && !mintState.overdraft,
  })

  const finalMsgs = useMemo(() => msgs, [msgs])

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    setMintState({ positionNumber: 1, mint: 0, repay: 0, summary: [], reset: true })
    queryClient.invalidateQueries({ queryKey: ['all users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users level'] })
  }

  return useSimulateAndBroadcast({
    msgs: finalMsgs,
    queryKey: ['mint_msg_sim', finalMsgs?.length ? JSON.stringify(finalMsgs.map((m) => m.functionName)) : '0'],
    onSuccess,
    enabled: !!finalMsgs?.length,
  })
}

export default useMint

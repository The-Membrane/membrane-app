import { erc20Abi } from 'viem'
import { cdpAbi } from '@/contracts/abis/cdp'
import { assetKey } from '@/services/chain/liquidation'
import {
  buildDepositAndBorrow,
  buildRepayAndWithdraw,
  type Fund,
} from '@/services/chain/router'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import { useUserPositions } from '@/hooks/useCDP'
import usePositionOperator from '@/hooks/usePositionOperator'
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
 * getMintAndRepayMsgs) built CosmWasm MsgExecuteContract objects.
 *
 * The COMBINED borrower actions now route through the CdpRouter periphery
 * (services/chain/router.ts) so they execute ATOMICALLY in a single on-chain call:
 *   - deposit + borrow  → [erc20.approve(router, amt)…, router.depositAndBorrow(…)]
 *   - repay   + withdraw → [erc20(CDT).approve(router, amt), router.repayAndWithdraw(…)]
 * The router drives the borrow/withdraw legs as an OPERATOR on the user's position,
 * so a first-time user needs Cdp.setPositionOperator(router, true) once — that
 * EvmCall is PREPENDED to the flow while usePositionOperator reports the flag unset,
 * adding one extra wallet prompt on the very first router action ONLY. After that the
 * on-chain operator flag persists and steady-state is: approve + router action
 * (2 prompts), or a single router action once the ERC-20 allowance is standing.
 *
 * The NON-combined / single-sided actions stay on direct Cdp calls (the owner is
 * always allowed to drive their own position, so no operator consent is needed):
 *   - deposit-only  → erc20.approve(cdp, amt) + cdp.deposit(id, owner, funds[])
 *   - withdraw-only → cdp.withdraw(id, funds[])
 *   - borrow-only   → cdp.increaseDebt(id, cdtDenom, amt)   [3-arg, variable rate]
 *   - repay-only    → erc20(CDT).approve(cdp, amt) + cdp.repay(id, owner, amt, cdtDenom)
 * If the router address is unavailable we transparently fall back to these direct
 * (non-atomic) paths.
 *
 * NOTE: EvmCall[] of length > 1 is only atomic WITHIN a single router call — the
 * approve leg (and the one-time operator approval) are still separate signatures
 * (see services/chain/types.ts).
 *
 * TODO(permit): single-prompt flows. Both router entrypoints accept ERC-2612
 * PermitData (CDT + collateral gained ERC20Permit on the frontend-support-views
 * merge). This pipeline builds msgs ahead of time in useQuery and cannot embed a
 * fresh signature, so every call here emits the ALLOWANCE path (permit deadline 0).
 * Follow-up: sign at mutation time via wagmi signTypedData against the token's
 * ERC20Permit domain, pass the {value,deadline,v,r,s} into buildDepositAndBorrow /
 * buildRepayAndWithdraw, and drop the paired erc20.approve — collapsing each combined
 * flow to a single wallet prompt.
 *
 * TODO(evm-migration): the CosmWasm flow also emitted Points check/give sandwich msgs
 * around repay (PointsMsgComposer). The EVM Points surface is not wired into the CDP
 * domain yet, so those are dropped here; re-add once a Points service exists.
 */

const toBase = (amount: string | number, decimals: number): bigint =>
  BigInt(shiftDigits(num(amount).abs().toString(), decimals).dp(0).toString())

// Collateral deposit entry: the Cdp/router Fund plus the ERC-20 address to approve.
type DepositEntry = Fund & { base: Address }

const useMint = () => {
  const { mintState, setMintState } = useMintState()
  const { summary = [] } = mintState
  const { address, chain } = useWallet()
  const { data: positions } = useUserPositions()
  const cdtAsset = useAssetBySymbol('CDT')
  const { isApproved: operatorApproved, approveOperatorMsg } = usePositionOperator()

  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined
  const routerAddr = chain ? getContractAddress(chain.id, 'cdpRouter') : undefined
  const canRouter = !!routerAddr

  // positionNumber is 1-based into the user's positions. When it points past the last
  // position we open a NEW position — Cdp.sol.deposit treats positionId 0 as "new position"
  // and returns the minted finalPositionId (the router forwards the same convention).
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
      routerAddr ?? '',
      operatorApproved ? '1' : '0',
      positionId.toString(),
      JSON.stringify(summary.map((s) => `${s.base}:${s.amount}`)),
      String(mintState?.mint ?? 0),
      String(mintState?.repay ?? 0),
    ],
    queryFn: () => {
      if (!address || !cdpAddr) return undefined

      // Collateral moves: positive amount = deposit (ERC-20 pull → needs approve),
      // negative = withdraw. denom is the bytes32 asset key; base is the ERC-20 addr.
      const depositEntries: DepositEntry[] = []
      const withdrawFunds: Fund[] = []
      summary.forEach((asset) => {
        const signed = num(asset.amount)
        if (signed.abs().dp(asset.decimal ?? 18).isZero()) return
        const amount = toBase(asset.amount ?? 0, asset.decimal ?? 18)
        // TODO(evm-migration): bytes32 asset denom is deployment-defined (see
        // services/chain/liquidation.ts assetKey). Derived from the asset symbol here;
        // confirm against the registered Cdp.sol denom before relying on write paths.
        const denom = assetKey(asset.symbol)
        if (signed.isGreaterThan(0)) {
          depositEntries.push({ denom, amount, base: asset.base as Address })
        } else {
          withdrawFunds.push({ denom, amount })
        }
      })
      const depositFunds: Fund[] = depositEntries.map(({ denom, amount }) => ({ denom, amount }))

      const cdtDenom = assetKey('CDT')
      const mintAmount = num(mintState?.mint ?? 0).isGreaterThan(0)
        ? toBase(mintState.mint, cdtAsset?.decimal ?? 18)
        : 0n
      const repayAmount =
        num(mintState?.repay ?? 0).isGreaterThan(0) && cdtAsset
          ? toBase(mintState.repay, cdtAsset.decimal)
          : 0n

      const hasDeposit = depositFunds.length > 0
      const hasWithdraw = withdrawFunds.length > 0
      const hasMint = mintAmount > 0n
      const hasRepay = repayAmount > 0n

      // A deposit paired with a borrow, or a repay paired with a withdraw, collapses
      // to a single atomic router call. Anything else stays a direct Cdp call.
      const useDepositBorrow = canRouter && hasDeposit && hasMint
      const useRepayWithdraw = canRouter && hasRepay && hasWithdraw

      // --- repay / withdraw side (repay first frees LTV before any new borrow) ---
      const repayWithdrawCalls: EvmCall[] = []
      if (useRepayWithdraw && routerAddr && cdtAsset) {
        const call = buildRepayAndWithdraw(chain?.id, {
          positionId,
          repayAmount,
          borrowAsset: cdtDenom,
          withdrawFunds,
        })
        if (call) {
          repayWithdrawCalls.push({
            address: cdtAsset.base as Address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [routerAddr, repayAmount],
          })
          repayWithdrawCalls.push(call)
        }
      } else {
        // repay-only → approve CDT to Cdp then cdp.repay(id, owner, amount, cdtDenom).
        if (hasRepay && cdtAsset) {
          repayWithdrawCalls.push({
            address: cdtAsset.base as Address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [cdpAddr, repayAmount],
          })
          repayWithdrawCalls.push({
            address: cdpAddr,
            abi: cdpAbi,
            functionName: 'repay',
            args: [positionId, address, repayAmount, cdtDenom],
          })
        }
        // withdraw-only → cdp.withdraw(id, funds[]).
        if (hasWithdraw) {
          repayWithdrawCalls.push({
            address: cdpAddr,
            abi: cdpAbi,
            functionName: 'withdraw',
            args: [positionId, withdrawFunds],
          })
        }
      }

      // --- deposit / borrow side ---
      const depositBorrowCalls: EvmCall[] = []
      if (useDepositBorrow && routerAddr) {
        const call = buildDepositAndBorrow(chain?.id, {
          positionId,
          funds: depositFunds,
          borrowAsset: cdtDenom,
          borrowAmount: mintAmount,
        })
        if (call) {
          // Collateral is pulled by the ROUTER, so approve the router (not Cdp).
          depositEntries.forEach(({ base, amount }) => {
            depositBorrowCalls.push({
              address: base,
              abi: erc20Abi,
              functionName: 'approve',
              args: [routerAddr, amount],
            })
          })
          depositBorrowCalls.push(call)
        }
      } else {
        // deposit-only → approve each collateral to Cdp then cdp.deposit.
        if (hasDeposit) {
          depositEntries.forEach(({ base, amount }) => {
            depositBorrowCalls.push({
              address: base,
              abi: erc20Abi,
              functionName: 'approve',
              args: [cdpAddr, amount],
            })
          })
          depositBorrowCalls.push({
            address: cdpAddr,
            abi: cdpAbi,
            functionName: 'deposit',
            args: [positionId, address, depositFunds],
          })
        }
        // borrow-only → cdp.increaseDebt(id, cdtDenom, amount).
        if (hasMint) {
          depositBorrowCalls.push({
            address: cdpAddr,
            abi: cdpAbi,
            functionName: 'increaseDebt',
            args: [positionId, cdtDenom, mintAmount],
          })
        }
      }

      // Operator consent: only the router legs need it, and only until the on-chain
      // flag is set. Prepended as a one-time extra prompt on the first router action.
      const needsOperator = (useDepositBorrow || useRepayWithdraw) && !operatorApproved
      const operatorCalls: EvmCall[] =
        needsOperator && approveOperatorMsg ? [approveOperatorMsg] : []

      const calls = [...operatorCalls, ...repayWithdrawCalls, ...depositBorrowCalls]
      return calls.length > 0 ? calls : undefined
    },
    enabled: !!address && !!cdpAddr && !mintState.overdraft,
  })

  const finalMsgs = useMemo(() => msgs, [msgs])

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['position_operator'] })
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

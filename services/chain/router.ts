import type { PublicClient } from 'viem'
import { cdpRouterAbi } from '@/contracts/abis/cdpRouter'
import { cdpAbi } from '@/contracts/abis/cdp'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'

/**
 * CdpRouter periphery service (EVM) — typed EvmCall builders for the ATOMIC
 * borrower flows the router enables, plus the operator-consent read/approval the
 * router requires.
 *
 * Source of truth: membrane-solidity contracts/periphery/CdpRouter.sol
 *   - depositAndBorrow(positionId, Fund[] funds, bytes32 borrowAsset,
 *       uint256 borrowAmount, PermitData[] collateralPermits)
 *   - repayAndWithdraw(positionId, uint256 repayAmount, bytes32 borrowAsset,
 *       Fund[] withdrawFunds, PermitData cdtPermit)
 *   - PermitData{value,deadline,v,r,s}; deadline == 0 → skip permit, use allowance.
 *
 * Unlike the per-contract READ services (cdp.ts, liquidation.ts) these are mostly
 * pure CALL builders (no RPC), so they resolve addresses from a chainId and return
 * null when an address is missing — the same null-on-failure contract the README
 * mandates (services/chain/README.md), applied to address resolution instead of an
 * RPC read. readPositionOperator is the one true read and follows the
 * PublicClient|null → null-on-failure shape exactly.
 *
 * OPERATOR CONSENT: the router's borrow/withdraw legs call Cdp.increaseDebt /
 * Cdp.withdraw as an operator on the user's behalf. Cdp gates those on
 * positionOperator(owner, router); without it the router reverts
 * RouterNotApprovedOperator (CdpRouter.sol:125-127,194-196). A first-time user must
 * therefore call Cdp.setPositionOperator(router, true) ONCE
 * (buildSetPositionOperator); the on-chain flag then persists, so the extra prompt
 * disappears on every subsequent flow.
 *
 * PERMIT (single-prompt): every builder still emits the ALLOWANCE path
 * (collateralPermits = [] / cdtPermit zeroed with deadline 0, which the contract
 * reads as "no permit supplied, use the standard allowance", CdpRouter.sol:236
 * _tryPermit early-return). ERC-2612 permits are embedded at MUTATION time by
 * services/chain/permit.ts embedRouterPermits — builders stay signature-free so
 * they remain usable from ahead-of-time useQuery msg builders.
 */

type Bytes32 = `0x${string}`

/** CdpRouter / Cdp Fund tuple: { denom: bytes32, amount: uint256 }. */
export type Fund = { denom: Bytes32; amount: bigint }

const ZERO_BYTES32: Bytes32 = `0x${'00'.repeat(32)}`

/**
 * Zeroed ERC-2612 PermitData. deadline === 0 tells the router to SKIP the permit
 * and fall back to the standard allowance path (CdpRouter.sol _tryPermit). Used for
 * the single `cdtPermit` slot of repayAndWithdraw while permit is out of scope.
 */
export const ALLOWANCE_ONLY_PERMIT = {
  value: 0n,
  deadline: 0n,
  v: 0,
  r: ZERO_BYTES32,
  s: ZERO_BYTES32,
} as const

// ---------------------------------------------------------------------------
// address helpers (null-on-failure, config fallback — README service contract)
// ---------------------------------------------------------------------------

function routerAddress(chainId: number | undefined, override?: Address): Address | undefined {
  return override ?? (chainId ? getContractAddress(chainId, 'cdpRouter') : undefined)
}

function cdpAddress(chainId: number | undefined, override?: Address): Address | undefined {
  return override ?? (chainId ? getContractAddress(chainId, 'cdp') : undefined)
}

// ---------------------------------------------------------------------------
// call builders
// ---------------------------------------------------------------------------

/**
 * cdp.setPositionOperator(router, approved) — the one-time operator consent that
 * unlocks the router's borrow/withdraw legs. Prepend to a combined flow only when
 * readPositionOperator is false; it never needs re-sending once approved.
 */
export function buildSetPositionOperator(
  chainId: number | undefined,
  approved: boolean = true,
  cdpOverride?: Address,
  routerOverride?: Address,
): EvmCall | null {
  const cdp = cdpAddress(chainId, cdpOverride)
  const router = routerAddress(chainId, routerOverride)
  if (!cdp || !router) return null
  return {
    address: cdp,
    abi: cdpAbi,
    functionName: 'setPositionOperator',
    args: [router, approved],
  }
}

/**
 * router.depositAndBorrow(positionId, funds, borrowAsset, borrowAmount, []).
 * positionId 0 opens a new position owned by the caller. Emits the allowance path
 * (collateralPermits = []) — the caller must have approved the ROUTER (not Cdp) to
 * pull each collateral. See TODO(permit) for the permit follow-up.
 */
export function buildDepositAndBorrow(
  chainId: number | undefined,
  params: {
    positionId: bigint
    funds: Fund[]
    borrowAsset: Bytes32
    borrowAmount: bigint
  },
  routerOverride?: Address,
): EvmCall | null {
  const router = routerAddress(chainId, routerOverride)
  if (!router) return null
  const { positionId, funds, borrowAsset, borrowAmount } = params
  return {
    address: router,
    abi: cdpRouterAbi,
    functionName: 'depositAndBorrow',
    // collateralPermits = [] → allowance path for every collateral slot.
    args: [positionId, funds, borrowAsset, borrowAmount, []],
  }
}

/**
 * router.repayAndWithdraw(positionId, repayAmount, borrowAsset, withdrawFunds,
 * cdtPermit). Emits the allowance path (cdtPermit zeroed, deadline 0) — the caller
 * must have approved the ROUTER (not Cdp) to pull the CDT repay amount. See
 * TODO(permit) for the permit follow-up.
 */
export function buildRepayAndWithdraw(
  chainId: number | undefined,
  params: {
    positionId: bigint
    repayAmount: bigint
    borrowAsset: Bytes32
    withdrawFunds: Fund[]
  },
  routerOverride?: Address,
): EvmCall | null {
  const router = routerAddress(chainId, routerOverride)
  if (!router) return null
  const { positionId, repayAmount, borrowAsset, withdrawFunds } = params
  return {
    address: router,
    abi: cdpRouterAbi,
    functionName: 'repayAndWithdraw',
    // cdtPermit zeroed with deadline 0 → allowance path.
    args: [positionId, repayAmount, borrowAsset, withdrawFunds, ALLOWANCE_ONLY_PERMIT],
  }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * Cdp.positionOperator(owner, router) — true once `owner` has approved this router
 * as a position operator. Wallet-independent read; null on failure / missing
 * address (never throws), per the service contract.
 */
export async function readPositionOperator(
  client: PublicClient | null,
  owner: Address,
  routerOverride?: Address,
  cdpOverride?: Address,
): Promise<boolean | null> {
  if (!client) return null
  const chainId = client.chain?.id
  const cdp = cdpAddress(chainId, cdpOverride)
  const router = routerAddress(chainId, routerOverride)
  if (!cdp || !router) return null
  try {
    return await client.readContract({
      address: cdp,
      abi: cdpAbi,
      functionName: 'positionOperator',
      args: [owner, router],
    })
  } catch (error) {
    console.error('Error querying Cdp positionOperator:', error)
    return null
  }
}

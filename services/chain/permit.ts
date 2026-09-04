import { parseSignature } from 'viem'
import type { PublicClient, WalletClient } from 'viem'
import type { Address } from '@/config/evm/contracts'
import { ALLOWANCE_ONLY_PERMIT, type Fund } from '@/services/chain/router'
import type { EvmCall } from '@/services/chain/types'

/**
 * ERC-2612 permit signing for single-prompt router flows.
 *
 * CdpRouter accepts PermitData{value,deadline,v,r,s} per collateral slot
 * (depositAndBorrow) and for CDT (repayAndWithdraw); deadline === 0 means
 * "skip permit, use the standing allowance" (CdpRouter.sol _tryPermit).
 * Signing a permit at mutation time replaces the paired erc20.approve, so a
 * combined flow collapses to ONE wallet prompt (typed-data signature is
 * gasless; only the router call is a transaction).
 *
 * Failure contract: everything here is null-on-failure. A token without
 * ERC-2612, a failed domain read, or a rejected signature all resolve to null
 * and the caller keeps the allowance path — the permit is an optimization,
 * never a gate.
 */

export type PermitData = {
  value: bigint
  deadline: bigint
  v: number
  r: `0x${string}`
  s: `0x${string}`
}

/** Seconds a signed permit stays valid. Generous: covers a slow wallet prompt. */
const PERMIT_TTL_SECONDS = 20n * 60n

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const erc2612Abi = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    // ERC-5267 — OpenZeppelin v4.9+ / v5 EIP712 base exposes the exact domain.
    type: 'function',
    name: 'eip712Domain',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1' },
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'extensions', type: 'uint256[]' },
    ],
  },
] as const

// chainId:token → whether the token answered nonces(); permit support is
// immutable per deployment, so the probe result never goes stale.
const permitSupportCache = new Map<string, boolean>()

/** True when the token exposes ERC-2612 nonces(). Cached per chain+token. */
export async function supportsPermit(
  client: PublicClient | null,
  token: Address,
): Promise<boolean> {
  if (!client) return false
  const key = `${client.chain?.id ?? 0}:${token.toLowerCase()}`
  const cached = permitSupportCache.get(key)
  if (cached !== undefined) return cached
  try {
    await client.readContract({
      address: token,
      abi: erc2612Abi,
      functionName: 'nonces',
      args: ['0x0000000000000000000000000000000000000000'],
    })
    permitSupportCache.set(key, true)
    return true
  } catch {
    permitSupportCache.set(key, false)
    return false
  }
}

type Eip712Domain = {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

/** ERC-5267 read with an OZ-default fallback ({name(), version '1'}). */
async function readDomain(client: PublicClient, token: Address): Promise<Eip712Domain | null> {
  try {
    const [, name, version, chainId, verifyingContract] = await client.readContract({
      address: token,
      abi: erc2612Abi,
      functionName: 'eip712Domain',
    })
    return { name, version, chainId: Number(chainId), verifyingContract: verifyingContract as Address }
  } catch {
    try {
      const name = await client.readContract({
        address: token,
        abi: erc2612Abi,
        functionName: 'name',
      })
      return { name, version: '1', chainId: client.chain?.id ?? 0, verifyingContract: token }
    } catch (error) {
      console.error('Error reading EIP-712 domain for permit:', error)
      return null
    }
  }
}

/**
 * Sign an ERC-2612 permit(owner → spender, value) via wallet typed-data.
 * Null when the token lacks permit support, a read fails, or the user rejects
 * the signature — callers fall back to the erc20.approve path.
 */
export async function signPermit(params: {
  publicClient: PublicClient | null
  walletClient: WalletClient | null
  token: Address
  owner: Address
  spender: Address
  value: bigint
}): Promise<PermitData | null> {
  const { publicClient, walletClient, token, owner, spender, value } = params
  if (!publicClient || !walletClient) return null
  if (!(await supportsPermit(publicClient, token))) return null

  try {
    const [domain, nonce] = await Promise.all([
      readDomain(publicClient, token),
      publicClient.readContract({
        address: token,
        abi: erc2612Abi,
        functionName: 'nonces',
        args: [owner],
      }),
    ])
    if (!domain) return null

    const deadline = BigInt(Math.floor(Date.now() / 1000)) + PERMIT_TTL_SECONDS
    const signature = await walletClient.signTypedData({
      account: owner,
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: { owner, spender, value, nonce, deadline },
    })
    const { v, r, s } = parseSignature(signature)
    if (v === undefined) return null
    return { value, deadline, v: Number(v), r, s }
  } catch (error) {
    // Includes user-rejected signature — the allowance path still works.
    console.error('Error signing ERC-2612 permit:', error)
    return null
  }
}

/**
 * Mutation-time batch rewrite: collapse [approve(router)…, routerCall] segments
 * into a single router call carrying signed PermitData.
 *
 * Walks the batch keeping a window of approve calls whose spender is the
 * router; on hitting a router entrypoint it pairs those approves — in order —
 * with the call's permit slots (collateralPermits[i] ↔ funds[i] for
 * depositAndBorrow, the single cdtPermit for repayAndWithdraw; pairing order is
 * guaranteed by the useMint builder, and CdpRouter enforces
 * PermitLengthMismatch on funds/permits). Each pairing signs an ERC-2612
 * permit; a token that fails to sign keeps its approve and a zeroed
 * ALLOWANCE_ONLY_PERMIT slot. Any structural surprise (approve/funds count
 * mismatch) leaves that segment untouched. Worst case output === input.
 *
 * Permits sign sequentially — one wallet prompt at a time.
 */
export async function embedRouterPermits(params: {
  msgs: EvmCall[]
  router: Address
  owner: Address
  publicClient: PublicClient | null
  walletClient: WalletClient | null
}): Promise<EvmCall[]> {
  const { msgs, router, owner, publicClient, walletClient } = params
  if (!publicClient || !walletClient) return msgs

  const out: EvmCall[] = []
  // approve(router, …) calls awaiting their router call, with out[] positions
  // so signed ones can be removed after pairing.
  let pending: { call: EvmCall; token: Address; amount: bigint; outIdx: number }[] = []
  let rewrote = false

  const signFor = async (token: Address, value: bigint): Promise<PermitData | null> =>
    signPermit({ publicClient, walletClient, token, owner, spender: router, value })

  for (const call of msgs) {
    const isRouterApprove =
      call.functionName === 'approve' &&
      call.args?.length === 2 &&
      String(call.args[0]).toLowerCase() === router.toLowerCase()
    if (isRouterApprove) {
      out.push(call)
      pending.push({
        call,
        token: call.address,
        amount: call.args![1] as bigint,
        outIdx: out.length - 1,
      })
      continue
    }

    const isRouterCall = call.address.toLowerCase() === router.toLowerCase()
    if (isRouterCall && call.functionName === 'depositAndBorrow' && call.args?.length === 5) {
      const funds = call.args[1] as Fund[]
      if (pending.length === funds.length && funds.length > 0) {
        const permits: (PermitData | typeof ALLOWANCE_ONLY_PERMIT)[] = []
        const signedIdxs: number[] = []
        for (let i = 0; i < funds.length; i++) {
          const signed = await signFor(pending[i].token, pending[i].amount)
          permits.push(signed ?? ALLOWANCE_ONLY_PERMIT)
          if (signed) signedIdxs.push(pending[i].outIdx)
        }
        if (signedIdxs.length > 0) {
          rewrote = true
          signedIdxs.sort((a, b) => b - a).forEach((idx) => out.splice(idx, 1))
          out.push({ ...call, args: [call.args[0], funds, call.args[2], call.args[3], permits] })
          pending = []
          continue
        }
      }
      out.push(call)
      pending = []
      continue
    }

    if (isRouterCall && call.functionName === 'repayAndWithdraw' && call.args?.length === 5) {
      if (pending.length === 1) {
        const signed = await signFor(pending[0].token, pending[0].amount)
        if (signed) {
          rewrote = true
          out.splice(pending[0].outIdx, 1)
          out.push({
            ...call,
            args: [call.args[0], call.args[1], call.args[2], call.args[3], signed],
          })
          pending = []
          continue
        }
      }
      out.push(call)
      pending = []
      continue
    }

    out.push(call)
  }

  return rewrote ? out : msgs
}

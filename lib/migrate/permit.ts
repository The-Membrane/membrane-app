/**
 * Typed-data signatures the migrate flow asks for: ERC-2612 permits (aTokens, the proceeds
 * token) and the Morpho Blue authorization.
 *
 * DOMAIN: a permit is only valid under the token's exact EIP-712 domain. Mainnet USDC uses
 * version "2", Aave aTokens and OpenZeppelin tokens "1". Rather than assume, the domain is
 * VERIFIED: each candidate version is hashed and compared with the token's own
 * DOMAIN_SEPARATOR(). No match → no permit (the sheet says why) — a wrong domain would be a
 * signature that silently fails inside the bundle (skipRevert) and then reverts the flash loan.
 */

import {
  hashDomain,
  parseSignature,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
  type WalletClient,
} from 'viem'

import { morphoAbi, permitTokenAbi } from './abis'
import type { SignedMorphoAuthorization, SignedPermit } from './bundle'
import type { Address } from './types'

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const MORPHO_AUTHORIZATION_TYPES = {
  Authorization: [
    { name: 'authorizer', type: 'address' },
    { name: 'authorized', type: 'address' },
    { name: 'isAuthorized', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const PERMIT_VERSION_CANDIDATES = ['1', '2'] as const

/** Seconds a signature stays valid: long enough for a slow wallet, short enough to expire. */
export const SIGNATURE_TTL_SECONDS = 30n * 60n

/** The candidate version whose domain hash equals the token's DOMAIN_SEPARATOR, else null. */
export function matchPermitDomain(
  name: string,
  chainId: number,
  token: Address,
  separator: Hex,
): TypedDataDomain | null {
  for (const version of PERMIT_VERSION_CANDIDATES) {
    const domain = { name, version, chainId, verifyingContract: token } as const
    const h = hashDomain({
      domain: { ...domain, chainId: BigInt(chainId) },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
      },
    })
    if (h.toLowerCase() === separator.toLowerCase()) return domain
  }
  return null
}

export async function readPermitDomain(client: PublicClient, token: Address): Promise<TypedDataDomain | null> {
  const chainId = client.chain?.id ?? (await client.getChainId())
  const [name, separator] = await Promise.all([
    client.readContract({ address: token, abi: permitTokenAbi, functionName: 'name' }),
    client.readContract({ address: token, abi: permitTokenAbi, functionName: 'DOMAIN_SEPARATOR' }),
  ])
  return matchPermitDomain(name, chainId, token, separator)
}

export async function signPermitExact(p: {
  client: PublicClient
  wallet: WalletClient
  token: Address
  owner: Address
  spender: Address
  value: bigint
  now: bigint
}): Promise<SignedPermit> {
  const domain = await readPermitDomain(p.client, p.token)
  if (!domain) throw new Error(`permit: no EIP-712 domain version matches ${p.token}'s DOMAIN_SEPARATOR`)
  const nonce = await p.client.readContract({ address: p.token, abi: permitTokenAbi, functionName: 'nonces', args: [p.owner] })
  const deadline = p.now + SIGNATURE_TTL_SECONDS
  const signature = await p.wallet.signTypedData({
    account: p.owner,
    domain,
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: p.owner, spender: p.spender, value: p.value, nonce, deadline },
  })
  const { v, r, s, yParity } = parseSignature(signature)
  return { token: p.token, owner: p.owner, spender: p.spender, value: p.value, deadline, v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s }
}

export async function signMorphoAuthorization(p: {
  client: PublicClient
  wallet: WalletClient
  morpho: Address
  owner: Address
  authorized: Address
  now: bigint
}): Promise<SignedMorphoAuthorization> {
  const chainId = p.client.chain?.id ?? (await p.client.getChainId())
  const nonce = await p.client.readContract({ address: p.morpho, abi: morphoAbi, functionName: 'nonce', args: [p.owner] })
  const deadline = p.now + SIGNATURE_TTL_SECONDS
  const message = { authorizer: p.owner, authorized: p.authorized, isAuthorized: true, nonce, deadline }
  const signature = await p.wallet.signTypedData({
    account: p.owner,
    domain: { chainId, verifyingContract: p.morpho },
    types: MORPHO_AUTHORIZATION_TYPES,
    primaryType: 'Authorization',
    message,
  })
  const { v, r, s, yParity } = parseSignature(signature)
  return { ...message, v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s }
}

// Session-key lifecycle + the burner fee guard for the on-chain Q-Racing game.
//
// A "play session" grants a burner key (lib/qgame/burner.ts) a time-boxed PocketGP
// session so gameplay txs (train/race/runDaily) are burner-signed and PROMPTLESS. The
// owner wallet signs only grantSession / revokeSession (and the burner top-up transfer).
//
// FEE GUARD: the burner auto-sends without a wallet prompt, so a runaway gas market must
// not silently drain its dust. Every burner send first checks the current block base fee
// against a user-configurable cap (default 5 gwei, stored per-user) and REFUSES to send
// when the base fee exceeds it.

import {
  createWalletClient,
  http,
  parseGwei,
  type Account,
  type Address,
  type PublicClient,
} from 'viem'
import { pocketGPAbi } from './abi'
import type { EvmCall } from '@/services/chain/types'

export const FEECAP_STORAGE_KEY = 'membrane.qgame.feecap.gwei'
export const DEFAULT_FEECAP_GWEI = 5
/** Session length granted by default: 7 days (contract clamps to ≤30). */
export const DEFAULT_SESSION_DAYS = 7
/** Default burner top-up: 0.02 ETH of dust gas. */
export const DEFAULT_TOPUP_ETH = '0.02'

function isBrowser(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

/** The user's configured base-fee cap, in gwei (default 5). */
export function getFeeCapGwei(): number {
  if (!isBrowser()) return DEFAULT_FEECAP_GWEI
  const raw = window.localStorage.getItem(FEECAP_STORAGE_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FEECAP_GWEI
}

export function setFeeCapGwei(gwei: number) {
  if (!isBrowser()) return
  if (Number.isFinite(gwei) && gwei > 0) {
    window.localStorage.setItem(FEECAP_STORAGE_KEY, String(gwei))
  }
}

/** The fee cap as wei. */
export function getFeeCapWei(): bigint {
  return parseGwei(String(getFeeCapGwei()))
}

/** Thrown when the current base fee exceeds the user's cap — the burner refuses to send. */
export class FeeCapExceededError extends Error {
  readonly baseFeeWei: bigint
  readonly capWei: bigint
  constructor(baseFeeWei: bigint, capWei: bigint) {
    super(
      `Gas base fee (${(Number(baseFeeWei) / 1e9).toFixed(2)} gwei) exceeds your ` +
        `${(Number(capWei) / 1e9).toFixed(2)} gwei cap. Raise the cap in the play session card ` +
        `or wait for the network to cool down.`,
    )
    this.name = 'FeeCapExceededError'
    this.baseFeeWei = baseFeeWei
    this.capWei = capWei
  }
}

/** Current pending-block base fee in wei (0n on chains that don't report one, e.g. some anvils). */
export async function currentBaseFeeWei(publicClient: PublicClient): Promise<bigint> {
  const block = await publicClient.getBlock({ blockTag: 'latest' })
  return block.baseFeePerGas ?? 0n
}

/** Throw FeeCapExceededError if the base fee is over the cap. */
export async function assertFeeUnderCap(publicClient: PublicClient, capWei = getFeeCapWei()) {
  const baseFee = await currentBaseFeeWei(publicClient)
  if (baseFee > capWei) throw new FeeCapExceededError(baseFee, capWei)
}

/** Default session expiry: now + DEFAULT_SESSION_DAYS, as a uint64 unix-seconds bigint. */
export function defaultSessionExpiry(days = DEFAULT_SESSION_DAYS): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + days * 86_400)
}

export type SessionInfo = { key: Address; expiry: bigint }

/** Read the owner's current session grant. key == 0x0 means no live session. */
export async function readSession(
  publicClient: PublicClient,
  pocketGP: Address,
  owner: Address,
): Promise<SessionInfo> {
  const [key, expiry] = (await publicClient.readContract({
    address: pocketGP,
    abi: pocketGPAbi,
    functionName: 'sessionOf',
    args: [owner],
  })) as [Address, bigint]
  return { key, expiry }
}

/** True when `key` is the live session key and the grant has not expired. */
export function isSessionLive(info: SessionInfo | undefined, key: Address | undefined): boolean {
  if (!info || !key) return false
  if (info.key.toLowerCase() !== key.toLowerCase()) return false
  return info.expiry > BigInt(Math.floor(Date.now() / 1000))
}

// ---- owner-signed grant/revoke as EvmCalls (routed through the standard tx pipeline) ----

export function buildGrantSessionCall(pocketGP: Address, key: Address, expiry: bigint): EvmCall {
  return { address: pocketGP, abi: pocketGPAbi as any, functionName: 'grantSession', args: [key, expiry] }
}

export function buildRevokeSessionCall(pocketGP: Address): EvmCall {
  return { address: pocketGP, abi: pocketGPAbi as any, functionName: 'revokeSession', args: [] }
}

// ---- burner-signed sends (promptless, fee-guarded) ----

/** Build a viem walletClient for the burner on the same chain/RPC as `publicClient`. */
export function makeBurnerWalletClient(account: Account, publicClient: PublicClient) {
  const transportUrl = (publicClient.transport as { url?: string })?.url
  return createWalletClient({
    account,
    chain: publicClient.chain,
    transport: transportUrl ? http(transportUrl) : http(),
  })
}

/**
 * Send one burner-signed contract call, promptlessly, behind the fee guard. Checks the
 * base fee against the cap FIRST (throws FeeCapExceededError), then writes and awaits the
 * receipt, throwing on revert. Returns the tx hash.
 */
export async function sendBurnerCall(params: {
  call: EvmCall
  account: Account
  publicClient: PublicClient
  capWei?: bigint
}): Promise<`0x${string}`> {
  const { call, account, publicClient } = params
  await assertFeeUnderCap(publicClient, params.capWei ?? getFeeCapWei())

  const wallet = makeBurnerWalletClient(account, publicClient)
  // The QRaceEngine's Q-table storage writes make gas estimates undershoot the real
  // execution, so a bare writeContract can out-of-gas revert. Estimate + 60% buffer.
  const est = await publicClient.estimateContractGas({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args as any,
    value: call.value,
    account: account.address,
  })
  const hash = await wallet.writeContract({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args as any,
    value: call.value,
    account,
    chain: publicClient.chain,
    gas: (est * 160n) / 100n,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`Burner tx reverted on-chain (${call.functionName}). Your pet is unchanged.`)
  }
  return hash
}

// ─────────────────────────────────────────────────────────────────────────────
//  QGAME BURNER — an ephemeral session-key signer kept in PLAIN-TEXT localStorage.
//
//  ⚠️  SECURITY BOUNDARY — READ THIS ⚠️
//  The burner private key is stored UNENCRYPTED in localStorage under
//  `membrane.qgame.burner`. This is acceptable ONLY because the key never holds
//  anything but DUST GAS: it is funded with a small ETH top-up to pay for
//  promptless gameplay txs (train/race/runDaily), and it has NO on-chain
//  authority beyond a time-boxed PocketGP session grant (≤30 days, revocable).
//  All pet rewards, BYTES, and NFTs accrue to the OWNER wallet on-chain — never
//  to the burner. A leaked burner key can at most burn its own dust gas and play
//  the owner's pet; it can never move funds or assets. Do NOT ever store a key
//  with real value this way. `endSession` revokes the grant and sweeps the dust
//  back to the owner.
// ─────────────────────────────────────────────────────────────────────────────

import { createWalletClient, http, type Account, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

export const BURNER_STORAGE_KEY = 'membrane.qgame.burner'

type StoredBurner = { privateKey: `0x${string}` }

function isBrowser(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readStored(): StoredBurner | null {
  if (!isBrowser()) return null
  try {
    const raw = window.localStorage.getItem(BURNER_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredBurner
    if (parsed?.privateKey?.startsWith('0x')) return parsed
    return null
  } catch {
    return null
  }
}

function writeStored(s: StoredBurner) {
  if (!isBrowser()) return
  window.localStorage.setItem(BURNER_STORAGE_KEY, JSON.stringify(s))
}

/** The burner viem Account, or null if none exists yet (or SSR). */
export function getBurnerAccount(): Account | null {
  const stored = readStored()
  if (!stored) return null
  return privateKeyToAccount(stored.privateKey)
}

/** The burner address, or null if none exists yet. */
export function getBurnerAddress(): `0x${string}` | null {
  return getBurnerAccount()?.address ?? null
}

/** Load the existing burner, or generate + persist a fresh one. Browser-only. */
export function loadOrCreateBurner(): Account {
  const existing = getBurnerAccount()
  if (existing) return existing
  const privateKey = generatePrivateKey()
  writeStored({ privateKey })
  return privateKeyToAccount(privateKey)
}

/** Wipe the stored burner key (after a sweep-back). */
export function clearBurner() {
  if (!isBrowser()) return
  window.localStorage.removeItem(BURNER_STORAGE_KEY)
}

/**
 * Send every wei the burner holds, minus the gas the send itself costs, back to
 * `owner`. Returns the tx hash, or null when the balance is dust below the gas cost
 * (nothing to sweep). Uses the same RPC/chain as the supplied publicClient.
 */
export async function sweepBackTo(
  owner: `0x${string}`,
  publicClient: PublicClient,
): Promise<`0x${string}` | null> {
  const account = getBurnerAccount()
  if (!account) return null

  const balance = await publicClient.getBalance({ address: account.address })
  if (balance === 0n) return null

  const chain = publicClient.chain
  const transportUrl = (publicClient.transport as { url?: string })?.url
  const wallet = createWalletClient({
    account,
    chain,
    transport: transportUrl ? http(transportUrl) : http(),
  })

  // A plain ETH transfer is 21000 gas. Price it at the current maxFeePerGas so the
  // send is never priced out, and leave exactly that reserve behind.
  const gas = 21_000n
  const { maxFeePerGas, gasPrice } = await publicClient.estimateFeesPerGas().catch(() => ({
    maxFeePerGas: undefined,
    gasPrice: undefined,
  }))
  const feePerGas = maxFeePerGas ?? gasPrice ?? 1_000_000_000n
  const cost = gas * feePerGas
  if (balance <= cost) return null

  const value = balance - cost
  const hash = await wallet.sendTransaction({
    account,
    chain,
    to: owner,
    value,
    gas,
    ...(maxFeePerGas ? { maxFeePerGas } : {}),
  })
  return hash
}

// Shared venue-read layer for the withdrawal-ability recorder. Imported by
// scripts/record-venue-liquidity.mjs (observed pass) and
// scripts/backfill-venue-history.mjs (historical reconstruction) so BOTH read
// on-chain state identically — the only difference is the block they read at.
//
// External mainnet venues (Ethena/Aave on Ethereum), read via a viem
// PublicClient over RECORDER_RPC_URL. Standalone: no Next env injection.

import { createPublicClient, http, fallback, defineChain } from 'viem'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..', '..')

// --- .env.local hand-parse (tsx/node get NO Next injection) ----------------
export function readEnv() {
  const env = readFileSync(join(ROOT, '.env.local'), 'utf8')
  const get = (k) =>
    (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '')
  return { get }
}

export function loadConfig() {
  const raw = readFileSync(join(ROOT, 'tools', 'venue-recorder.config.json'), 'utf8')
  return JSON.parse(raw).venues
}

// Mainnet (chain id 1). The RPC must be a mainnet endpoint; historical reads
// additionally require an ARCHIVE node (list it FIRST — viem's fallback ranks
// by order and only moves on when an endpoint errors/times out).
//
// Accepts a single URL or a comma-separated list. Prefer setting
// RECORDER_RPC_URLS in .env.local; the free tiers rate-limit after heavy
// getLogs backfills, and a fallback ring keeps the hourly tick alive.
export function makeClient(rpcUrl) {
  const urls = String(rpcUrl)
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  const mainnet = defineChain({
    id: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: urls } },
    // Multicall3 (canonical mainnet deployment) so client.multicall() works for
    // the per-address position reader (scripts/lib/position-reads.mjs). viem's
    // built-in `mainnet` chain carries this; a hand-rolled defineChain must
    // declare it or multicall throws ChainDoesNotSupportContract.
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 14353601 } },
  })
  const transport =
    urls.length === 1
      ? http(urls[0])
      : fallback(urls.map((u) => http(u, { timeout: 15_000 })), { rank: false })
  return createPublicClient({ chain: mainnet, transport })
}

// Minimal ABIs — only the reads we need.
const erc4626CooldownAbi = [
  { type: 'function', name: 'cooldownDuration', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'silo', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
]
// Depth-market ABIs. Curve stableswap exposes coins(i)/balances(i); Uniswap v3
// exposes token0()/token1() (no reserve view — pool token balances are read via
// erc20 balanceOf as an honest raw measure of swappable inventory).
const curvePoolAbi = [
  { type: 'function', name: 'coins', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'balances', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
]
const univ3PoolAbi = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]

// Every read is wrapped so a single missing method never aborts the snapshot —
// we store what succeeded (task rule: store-raw, never fabricate).
async function tryRead(client, call) {
  try {
    return await client.readContract(call)
  } catch {
    return undefined
  }
}

// JSON can't hold bigint — stringify for params jsonb.
const s = (v) => (typeof v === 'bigint' ? v.toString() : v)

/**
 * Read one venue's withdrawal state at `blockNumber` (undefined = latest).
 * Returns { params, instantUsd, coolingUsd, strandedUsd } — the caller inserts
 * the snapshot. instantUsd is null whenever it is not HONESTLY derivable.
 */
export async function readVenueState(client, venue, blockNumber) {
  const at = blockNumber === undefined ? {} : { blockNumber }
  const params = { kind: venue.kind }

  if (venue.kind === 'erc4626-cooldown') {
    const address = venue.address
    const cooldownDuration = await tryRead(client, { address, abi: erc4626CooldownAbi, functionName: 'cooldownDuration', ...at })
    const totalAssets = await tryRead(client, { address, abi: erc4626CooldownAbi, functionName: 'totalAssets', ...at })
    const totalSupply = await tryRead(client, { address, abi: erc4626CooldownAbi, functionName: 'totalSupply', ...at })
    const vaultDecimals = await tryRead(client, { address, abi: erc4626CooldownAbi, functionName: 'decimals', ...at })
    const silo = await tryRead(client, { address, abi: erc4626CooldownAbi, functionName: 'silo', ...at })

    if (cooldownDuration !== undefined) params.cooldownDuration = Number(cooldownDuration)
    if (totalAssets !== undefined) params.totalAssets = s(totalAssets)
    if (totalSupply !== undefined) params.totalSupply = s(totalSupply)
    if (vaultDecimals !== undefined) params.vaultDecimals = Number(vaultDecimals)
    if (silo !== undefined) params.silo = silo
    params.reads = {
      cooldownDuration: cooldownDuration !== undefined,
      totalAssets: totalAssets !== undefined,
      totalSupply: totalSupply !== undefined,
      decimals: vaultDecimals !== undefined,
      silo: silo !== undefined,
    }
    // STORE-RAW, DO NOT DERIVE: for a cooldown vault the instant/cooling/
    // stranded split depends on per-user cooldown queue state that is not
    // readable from these aggregate views. We refuse to fabricate a number.
    params.instant_note =
      'erc4626-cooldown: instant/cooling/stranded split is venue-specific and not derivable from aggregate reads; raw params stored, instant_usd left null.'
    return { params, instantUsd: null, coolingUsd: null, strandedUsd: null }
  }

  if (venue.kind === 'atoken-liquidity') {
    const decimals = venue.decimals ?? 18
    // instant liquidity = the aToken's underlying balance = what can be
    // withdrawn right now.
    const bal = await tryRead(client, {
      address: venue.underlying,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [venue.address],
      ...at,
    })
    params.underlyingBalance = bal !== undefined ? s(bal) : null
    params.decimals = decimals
    params.priceAssumptionUsd = 1 // stable assumption — RECORDED, not silent
    params.instant_note = 'atoken-liquidity: instant_usd = underlyingBalance / 10^decimals, valued at $1/stable (priceAssumptionUsd).'
    const instantUsd =
      bal !== undefined ? Number(bal) / 10 ** decimals : null
    return { params, instantUsd, coolingUsd: null, strandedUsd: null }
  }

  params.instant_note = `unknown kind '${venue.kind}' — no reader; raw params only.`
  return { params, instantUsd: null, coolingUsd: null, strandedUsd: null }
}

/**
 * Read the venue's DEPTH MARKET(S) — the secondary-market pools that price the
 * venue token and form its INSTANT-exit tier (memo P4). Called by the recorder
 * (latest block) and backfill (historical block) so both read identically.
 *
 * Returns null when the venue configures no enabled depth market (the extension
 * is optional and per-venue). Otherwise returns a partial params object to MERGE
 * into the snapshot params:
 *   { depthMarkets: [ {name, kind, address, token0, token1, exitFrom,
 *                      reserve0Raw, reserve1Raw, reserve0Usd, reserve1Usd,
 *                      skewPct, exitableUsd, reads} ],
 *     depth_usd,          // sum of exitableUsd across enabled markets (the
 *                         // swap-INTO side — NOT the venue-token side)
 *     depth_skew_pct }    // worst (max) one-sidedness across enabled markets
 *
 * HONESTY: every reserve is read via try/catch and stored raw. USD is stated at
 * $1/stable (priceAssumptionUsd), NOT fetched — the same recorded-assumption
 * discipline as the aToken reader. A market whose reserve reads all fail is kept
 * in the list with reads:false and contributes nothing to depth_usd.
 *
 * EXITABLE DEPTH is deliberately the OTHER side's reserve: the tokens a holder
 * can swap INTO when exiting the venue token. The venue-token side is what you
 * are trying to GET RID OF; its balance is not exit capacity.
 */
export async function readDepthMarkets(client, venue, blockNumber) {
  const at = blockNumber === undefined ? {} : { blockNumber }
  const markets = (venue.depthMarkets ?? []).filter((m) => m.enabled)
  if (markets.length === 0) return null

  const decOf = async (token) => {
    const d = await tryRead(client, { address: token, abi: erc20Abi, functionName: 'decimals', ...at })
    return d !== undefined ? Number(d) : 18
  }
  const balOf = async (token, pool) =>
    tryRead(client, { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [pool], ...at })

  const out = []
  let depthUsd = 0
  let worstSkew = null

  for (const m of markets) {
    const [dec0, dec1] = [await decOf(m.token0), await decOf(m.token1)]

    // Reserves: curve balances(i) first, ERC20 balanceOf(pool) fallback (and the
    // only path for uniswap-v3, which has no reserve view). Store what succeeds.
    let r0, r1
    if (m.kind === 'curve-stableswap') {
      r0 = await tryRead(client, { address: m.address, abi: curvePoolAbi, functionName: 'balances', args: [0n], ...at })
      r1 = await tryRead(client, { address: m.address, abi: curvePoolAbi, functionName: 'balances', args: [1n], ...at })
    }
    if (r0 === undefined) r0 = await balOf(m.token0, m.address)
    if (r1 === undefined) r1 = await balOf(m.token1, m.address)

    const usd0 = r0 !== undefined ? Number(r0) / 10 ** dec0 : null
    const usd1 = r1 !== undefined ? Number(r1) / 10 ** dec1 : null

    // Skew = one-sidedness of the pool in [0,100] (stETH 78:22 / MIM 96% genre).
    let skewPct = null
    if (usd0 !== null && usd1 !== null && usd0 + usd1 > 0) {
      skewPct = (Math.max(usd0, usd1) / (usd0 + usd1)) * 100
    }

    // Exitable = the side that is NOT exitFrom (the token you swap INTO). If
    // exitFrom is token0, the exitable reserve is token1's, and vice-versa.
    const exitFromIs0 = m.exitFrom && m.token0 && m.exitFrom.toLowerCase() === m.token0.toLowerCase()
    const exitableUsd = exitFromIs0 ? usd1 : usd0

    if (exitableUsd !== null && Number.isFinite(exitableUsd)) depthUsd += exitableUsd
    if (skewPct !== null && (worstSkew === null || skewPct > worstSkew)) worstSkew = skewPct

    out.push({
      name: m.name,
      kind: m.kind,
      address: m.address,
      token0: m.token0,
      token1: m.token1,
      exitFrom: m.exitFrom ?? null,
      reserve0Raw: r0 !== undefined ? s(r0) : null,
      reserve1Raw: r1 !== undefined ? s(r1) : null,
      reserve0Usd: usd0,
      reserve1Usd: usd1,
      skewPct,
      exitableUsd,
      priceAssumptionUsd: 1,
      note: m.note ?? null,
      reads: { reserve0: r0 !== undefined, reserve1: r1 !== undefined },
    })
  }

  return {
    depthMarkets: out,
    depth_usd: depthUsd,
    depth_skew_pct: worstSkew,
    depth_note:
      'depth_usd = EXITABLE side (tokens swappable INTO on exit), summed across enabled verified markets, at $1/stable. depth_skew_pct = worst pool one-sidedness. This is the INSTANT-exit tier only; protocol redemption (cooldown/instant) is a separate exit path.',
  }
}

// The metric a prediction/diff tracks for a venue: instant_usd when we have it,
// else total_assets (from params). Returns { metric, value } | null.
export function primaryMetric(snapshotRow) {
  if (snapshotRow.instant_usd !== null && snapshotRow.instant_usd !== undefined) {
    return { metric: 'instant_usd', value: Number(snapshotRow.instant_usd) }
  }
  const ta = snapshotRow.params?.totalAssets
  if (ta !== undefined && ta !== null) {
    return { metric: 'total_assets', value: Number(ta) }
  }
  return null
}

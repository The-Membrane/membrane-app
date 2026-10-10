// Shared venue-read layer for the withdrawal-ability recorder. Imported by
// scripts/record-venue-liquidity.mjs (observed pass) and
// scripts/backfill-venue-history.mjs (historical reconstruction) so BOTH read
// on-chain state identically — the only difference is the block they read at.
//
// External mainnet venues (Ethena/Aave on Ethereum), read via a viem
// PublicClient over RECORDER_RPC_URL. Standalone: no Next env injection.

import { createPublicClient, http, fallback, defineChain, isAddress } from 'viem'
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
    contracts: {
      multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 14353601 },
    },
  })
  const transport =
    urls.length === 1
      ? http(urls[0])
      : fallback(
          urls.map((u) => http(u, { timeout: 15_000 })),
          { rank: false },
        )
  return createPublicClient({ chain: mainnet, transport })
}

// Minimal ABIs — only the reads we need.
const erc4626CooldownAbi = [
  {
    type: 'function',
    name: 'cooldownDuration',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint24' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'silo',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]
const erc4626VaultCashAbi = [
  ...erc4626CooldownAbi,
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
]
const psmIdentityAbi = [
  {
    type: 'function',
    name: 'pocket',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'gem',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tout',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]
const usdsPsmWrapperIdentityAbi = [
  {
    type: 'function',
    name: 'psm',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'pocket',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'usds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]
const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]
const aTokenAbi = [
  {
    type: 'function',
    name: 'UNDERLYING_ASSET_ADDRESS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]
// Depth-market ABIs. Curve stableswap exposes coins(i)/balances(i); Uniswap v3
// exposes token0()/token1() (no reserve view — pool token balances are read via
// erc20 balanceOf as an honest raw measure of swappable inventory).
const curvePoolAbi = [
  {
    type: 'function',
    name: 'coins',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'balances',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]
const univ3PoolAbi = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
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

// Aave reserve stock is only displayable as approximate USD after the pinned
// aToken/underlying identity and decimals checks succeeded. A missing read,
// legacy row, or mismatch stays unknown; underlying cash is never a TVL proxy.
export function aTokenSuppliedUsd(params) {
  if (
    params?.underlyingIdentity !== 'match' ||
    params?.decimalsIdentity !== 'match' ||
    params?.priceAssumptionUsd !== 1 ||
    typeof params?.totalSupply !== 'string' ||
    !/^\d+$/.test(params.totalSupply)
  )
    return null
  const decimals = Number(params.decimals)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  const usd = Number(params.totalSupply) / 10 ** decimals
  return Number.isFinite(usd) && usd >= 0 ? usd : null
}

/**
 * Read one venue's withdrawal state at `blockNumber` (undefined = latest).
 * Returns { params, instantUsd, coolingUsd, strandedUsd } — the caller inserts
 * the snapshot. instantUsd is null whenever it is not HONESTLY derivable.
 */
export async function readVenueState(client, venue, blockNumber) {
  const at = blockNumber === undefined ? {} : { blockNumber }
  const params = { kind: venue.kind }

  if (venue.kind === 'erc4626-vault-cash') {
    const [asset, underlyingDecimals, vaultDecimals, totalAssets, totalSupply, paused, cash] =
      await Promise.all([
        tryRead(client, {
          address: venue.address,
          abi: erc4626VaultCashAbi,
          functionName: 'asset',
          ...at,
        }),
        tryRead(client, {
          address: venue.underlying,
          abi: erc20Abi,
          functionName: 'decimals',
          ...at,
        }),
        tryRead(client, {
          address: venue.address,
          abi: erc4626VaultCashAbi,
          functionName: 'decimals',
          ...at,
        }),
        tryRead(client, {
          address: venue.address,
          abi: erc4626VaultCashAbi,
          functionName: 'totalAssets',
          ...at,
        }),
        tryRead(client, {
          address: venue.address,
          abi: erc4626VaultCashAbi,
          functionName: 'totalSupply',
          ...at,
        }),
        tryRead(client, {
          address: venue.address,
          abi: erc4626VaultCashAbi,
          functionName: 'paused',
          ...at,
        }),
        tryRead(client, {
          address: venue.underlying,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [venue.address],
          ...at,
        }),
      ])
    const decimals = venue.decimals
    params.vault = venue.address
    params.underlying = venue.underlying
    params.underlyingOnchain = asset ?? null
    params.underlyingDecimalsOnchain =
      underlyingDecimals !== undefined ? Number(underlyingDecimals) : null
    params.vaultDecimals = vaultDecimals !== undefined ? Number(vaultDecimals) : null
    params.decimals = decimals
    params.totalAssets = totalAssets !== undefined ? s(totalAssets) : null
    params.totalSupply = totalSupply !== undefined ? s(totalSupply) : null
    params.underlyingBalance = cash !== undefined ? s(cash) : null
    params.withdrawalsPaused = typeof paused === 'boolean' ? paused : null
    params.underlyingIdentity =
      typeof asset === 'string' && isAddress(asset)
        ? asset.toLowerCase() === String(venue.underlying).toLowerCase()
          ? 'match'
          : 'mismatch'
        : 'unknown'
    params.decimalsIdentity =
      underlyingDecimals !== undefined && Number.isInteger(Number(underlyingDecimals))
        ? Number(underlyingDecimals) === decimals
          ? 'match'
          : 'mismatch'
        : 'unknown'
    params.reads = {
      asset: asset !== undefined,
      underlyingDecimals: underlyingDecimals !== undefined,
      vaultDecimals: vaultDecimals !== undefined,
      totalAssets: totalAssets !== undefined,
      totalSupply: totalSupply !== undefined,
      paused: paused !== undefined,
      underlyingBalance: cash !== undefined,
    }
    params.priceAssumptionUsd = 1
    params.instant_note =
      'erc4626-vault-cash: instant_usd is GHO.balanceOf(vault) at an explicit $1/GHO assumption, only after asset identity, underlying precision, pause state and cash reads verify. Paused vault means effective instant capacity zero while raw cash is retained. This aggregate cash is an upper bound, not a holder-specific maxWithdraw or executable quote.'
    const scaledCash =
      params.underlyingIdentity === 'match' &&
      params.decimalsIdentity === 'match' &&
      typeof paused === 'boolean' &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 36 &&
      typeof cash === 'bigint' &&
      cash >= 0n
        ? Number(cash) / 10 ** decimals
        : null
    const instantUsd =
      scaledCash !== null && Number.isFinite(scaledCash) && scaledCash >= 0
        ? paused
          ? 0
          : scaledCash
        : null
    return { params, instantUsd, coolingUsd: null, strandedUsd: null }
  }

  if (venue.kind === 'erc4626-cooldown') {
    const address = venue.address
    const cooldownDuration = await tryRead(client, {
      address,
      abi: erc4626CooldownAbi,
      functionName: 'cooldownDuration',
      ...at,
    })
    const totalAssets = await tryRead(client, {
      address,
      abi: erc4626CooldownAbi,
      functionName: 'totalAssets',
      ...at,
    })
    const totalSupply = await tryRead(client, {
      address,
      abi: erc4626CooldownAbi,
      functionName: 'totalSupply',
      ...at,
    })
    const vaultDecimals = await tryRead(client, {
      address,
      abi: erc4626CooldownAbi,
      functionName: 'decimals',
      ...at,
    })
    const silo = await tryRead(client, {
      address,
      abi: erc4626CooldownAbi,
      functionName: 'silo',
      ...at,
    })

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
    const underlyingOnchain = await tryRead(client, {
      address: venue.address,
      abi: aTokenAbi,
      functionName: 'UNDERLYING_ASSET_ADDRESS',
      ...at,
    })
    const underlyingDecimalsOnchain = await tryRead(client, {
      address: venue.underlying,
      abi: erc20Abi,
      functionName: 'decimals',
      ...at,
    })
    // instant liquidity = the aToken's underlying balance = what can be
    // withdrawn right now.
    const bal = await tryRead(client, {
      address: venue.underlying,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [venue.address],
      ...at,
    })
    // Supplied reserve stock is aToken.totalSupply(), not the underlying cash
    // immediately available for withdrawals. Both reads use this snapshot's
    // pinned block; either can fail independently without inventing the other.
    const totalSupply = await tryRead(client, {
      address: venue.address,
      abi: aTokenAbi,
      functionName: 'totalSupply',
      ...at,
    })
    params.underlyingBalance = bal !== undefined ? s(bal) : null
    params.totalSupply = totalSupply !== undefined ? s(totalSupply) : null
    params.aToken = venue.address
    params.underlying = venue.underlying
    params.underlyingOnchain = underlyingOnchain ?? null
    params.underlyingDecimalsOnchain =
      underlyingDecimalsOnchain !== undefined ? Number(underlyingDecimalsOnchain) : null
    params.decimals = decimals
    params.underlyingIdentity =
      typeof underlyingOnchain === 'string' && isAddress(underlyingOnchain)
        ? underlyingOnchain.toLowerCase() === String(venue.underlying).toLowerCase()
          ? 'match'
          : 'mismatch'
        : 'unknown'
    params.decimalsIdentity =
      underlyingDecimalsOnchain !== undefined && Number.isInteger(Number(underlyingDecimalsOnchain))
        ? Number(underlyingDecimalsOnchain) === decimals
          ? 'match'
          : 'mismatch'
        : 'unknown'
    params.reads = {
      underlyingAsset: underlyingOnchain !== undefined,
      underlyingDecimals: underlyingDecimalsOnchain !== undefined,
      underlyingBalance: bal !== undefined,
      totalSupply: totalSupply !== undefined,
    }
    params.priceAssumptionUsd = 1 // stable assumption — RECORDED, not silent
    params.totalSupply_note =
      'atoken-liquidity: totalSupply is the aToken-denominated supplied reserve stock, distinct from immediately withdrawable underlyingBalance. USD display assumes $1/stable and matching underlying identity/decimals.'
    params.instant_note =
      'atoken-liquidity: instant_usd = underlyingBalance / 10^decimals at $1/stable only when the underlying address and decimals are verified matches and the balance is finite and nonnegative; otherwise null, with raw balance retained.'
    const scaledBalance =
      params.underlyingIdentity === 'match' &&
      params.decimalsIdentity === 'match' &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 36 &&
      typeof bal === 'bigint' &&
      bal >= 0n
        ? Number(bal) / 10 ** decimals
        : null
    const instantUsd =
      scaledBalance !== null && Number.isFinite(scaledBalance) && scaledBalance >= 0
        ? scaledBalance
        : null

    // UTILIZATION extension (Fraxlend/Morpho genre: utilization at 100% = lenders
    // can't exit even though the market is "solvent"). debt = the reserve's
    // variableDebtToken totalSupply; available = the aToken's underlying balance
    // (== instant liquidity). utilization_pct = debt/(debt+available)*100. The
    // variableDebtToken address is config-supplied and on-chain-verified once
    // (symbol contains 'variableDebt' + UNDERLYING_ASSET_ADDRESS()==underlying) —
    // the same discipline as the aToken address itself. If it is absent or the
    // read fails, utilization is simply not recorded (store-raw, never fabricate).
    if (venue.variableDebtToken) {
      const debt = await tryRead(client, {
        address: venue.variableDebtToken,
        abi: erc20Abi,
        functionName: 'totalSupply',
        ...at,
      })
      if (debt !== undefined) {
        params.variableDebt = s(debt)
        params.variableDebtToken = venue.variableDebtToken
        if (bal !== undefined) {
          const d = Number(debt)
          const a = Number(bal)
          const denom = d + a
          params.utilization_pct = denom > 0 ? (d / denom) * 100 : null
          params.utilization_note =
            'utilization_pct = variableDebt/(variableDebt+underlyingBalance)*100, both at $1/stable. 100% = lenders cannot exit (Fraxlend/Morpho genre).'
        }
      }
      params.reads.variableDebt = debt !== undefined
    }
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
    const d = await tryRead(client, {
      address: token,
      abi: erc20Abi,
      functionName: 'decimals',
      ...at,
    })
    // Unknown precision must not silently become 18 (USDC/USDT are 6).
    return d !== undefined ? Number(d) : null
  }
  const balOf = async (token, pool) =>
    tryRead(client, {
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [pool],
      ...at,
    })

  const out = []
  let depthUsd = 0
  let worstSkew = null
  let complete = true

  for (const m of markets) {
    // psm-buffer: a peg-stability module (Sky LitePSM), NOT a two-sided AMM. The
    // exit path is a 1:1 redemption (USDS→USDC) against a single-sided buffer of
    // the swap-INTO token (USDC) held in a `buffer` address (the PSM's pocket).
    // Exitable depth = bufferToken.balanceOf(buffer). There is no pool ratio, so
    // skewPct is null — a draining PSM buffer surfaces in depth_collapse
    // (depth_usd falling over 7d), never in depth_skew (which is pool
    // one-sidedness). Every read is try/caught and stored raw; USD is $1/stable.
    if (m.kind === 'psm-buffer') {
      const wrapperAddress =
        typeof m.wrapper === 'string' && m.wrapper.length > 0 ? m.wrapper : null
      const [wrapperPsmOnchain, wrapperPocketOnchain, wrapperUsdsOnchain] = wrapperAddress
        ? await Promise.all(
            ['psm', 'pocket', 'usds'].map((functionName) =>
              tryRead(client, {
                address: wrapperAddress,
                abi: usdsPsmWrapperIdentityAbi,
                functionName,
                ...at,
              }),
            ),
          )
        : [undefined, undefined, undefined]
      const wrapperIdentity =
        !wrapperAddress ||
        wrapperPsmOnchain === undefined ||
        wrapperPocketOnchain === undefined ||
        wrapperUsdsOnchain === undefined
          ? 'unknown'
          : typeof wrapperPsmOnchain === 'string' &&
              typeof wrapperPocketOnchain === 'string' &&
              typeof wrapperUsdsOnchain === 'string' &&
              wrapperPsmOnchain.toLowerCase() === m.address.toLowerCase() &&
              wrapperPocketOnchain.toLowerCase() === m.buffer.toLowerCase() &&
              typeof venue.underlying === 'string' &&
              wrapperUsdsOnchain.toLowerCase() === venue.underlying.toLowerCase() &&
              wrapperUsdsOnchain.toLowerCase() === m.exitFrom?.toLowerCase()
            ? 'match'
            : 'mismatch'
      const pocketOnchain = await tryRead(client, {
        address: m.address,
        abi: psmIdentityAbi,
        functionName: 'pocket',
        ...at,
      })
      const gemOnchain = await tryRead(client, {
        address: m.address,
        abi: psmIdentityAbi,
        functionName: 'gem',
        ...at,
      })
      const toutRaw = await tryRead(client, {
        address: m.address,
        abi: psmIdentityAbi,
        functionName: 'tout',
        ...at,
      })
      const buyGemState =
        typeof toutRaw !== 'bigint'
          ? 'unknown'
          : toutRaw === 2n ** 256n - 1n
            ? 'halted'
            : toutRaw >= 0n && toutRaw <= 10n ** 18n
              ? 'open'
              : 'invalid'
      const pocketIdentity =
        typeof pocketOnchain === 'string' && pocketOnchain.toLowerCase() === m.buffer.toLowerCase()
          ? 'match'
          : pocketOnchain === undefined
            ? 'unknown'
            : 'mismatch'
      const gemIdentity =
        typeof gemOnchain === 'string' && gemOnchain.toLowerCase() === m.bufferToken.toLowerCase()
          ? 'match'
          : gemOnchain === undefined
            ? 'unknown'
            : 'mismatch'
      const exitIdentity =
        typeof venue.underlying === 'string' &&
        typeof m.exitFrom === 'string' &&
        m.exitFrom.toLowerCase() === venue.underlying.toLowerCase()
          ? 'match'
          : 'mismatch'
      const decB = await decOf(m.bufferToken)
      const bal = await balOf(m.bufferToken, m.buffer)
      const usd =
        wrapperIdentity === 'match' &&
        pocketIdentity === 'match' &&
        gemIdentity === 'match' &&
        exitIdentity === 'match' &&
        (buyGemState === 'open' || buyGemState === 'halted') &&
        bal !== undefined &&
        decB !== null
          ? buyGemState === 'halted'
            ? 0
            : Number(bal) / 10 ** decB
          : null
      if (usd !== null && Number.isFinite(usd)) depthUsd += usd
      else complete = false
      out.push({
        name: m.name,
        kind: m.kind,
        address: m.address, // the PSM contract (provenance; buffer holds the gem)
        wrapper: wrapperAddress,
        wrapperPsmOnchain: wrapperPsmOnchain ?? null,
        wrapperPocketOnchain: wrapperPocketOnchain ?? null,
        wrapperUsdsOnchain: wrapperUsdsOnchain ?? null,
        wrapperIdentity,
        buffer: m.buffer,
        bufferToken: m.bufferToken,
        pocketOnchain: pocketOnchain ?? null,
        gemOnchain: gemOnchain ?? null,
        pocketIdentity,
        gemIdentity,
        exitIdentity,
        toutRaw: typeof toutRaw === 'bigint' ? toutRaw.toString() : null,
        buyGemState,
        exitFrom: m.exitFrom ?? null,
        bufferBalanceRaw: bal !== undefined ? s(bal) : null,
        bufferDecimals: decB,
        exitableUsd: usd,
        skewPct: null, // single-sided buffer: no pool ratio to skew
        priceAssumptionUsd: 1,
        note: m.note ?? null,
        reads: {
          wrapperPsm: wrapperPsmOnchain !== undefined,
          wrapperPocket: wrapperPocketOnchain !== undefined,
          wrapperUsds: wrapperUsdsOnchain !== undefined,
          pocket: pocketOnchain !== undefined,
          gem: gemOnchain !== undefined,
          tout: toutRaw !== undefined,
          buffer: bal !== undefined,
          decimals: decB !== null,
        },
      })
      continue
    }

    const [dec0, dec1] = [await decOf(m.token0), await decOf(m.token1)]
    // A configured Curve pool can change or be misidentified. Pin coins(i)
    // at this same block before calling its balances output-side capacity.
    let coin0Onchain, coin1Onchain
    if (m.kind === 'curve-stableswap') {
      coin0Onchain = await tryRead(client, {
        address: m.address,
        abi: curvePoolAbi,
        functionName: 'coins',
        args: [0n],
        ...at,
      })
      coin1Onchain = await tryRead(client, {
        address: m.address,
        abi: curvePoolAbi,
        functionName: 'coins',
        args: [1n],
        ...at,
      })
    }
    const coinsIdentity =
      m.kind !== 'curve-stableswap'
        ? 'not_applicable'
        : coin0Onchain === undefined || coin1Onchain === undefined
          ? 'unknown'
          : typeof coin0Onchain === 'string' &&
              typeof coin1Onchain === 'string' &&
              coin0Onchain.toLowerCase() === m.token0.toLowerCase() &&
              coin1Onchain.toLowerCase() === m.token1.toLowerCase()
            ? 'match'
            : 'mismatch'
    const exitIdentity =
      typeof m.exitFrom === 'string' &&
      typeof m.token0 === 'string' &&
      typeof m.token1 === 'string' &&
      [m.token0.toLowerCase(), m.token1.toLowerCase()].includes(m.exitFrom.toLowerCase())
        ? 'match'
        : 'mismatch'

    // Reserves: curve balances(i) first, ERC20 balanceOf(pool) fallback (and the
    // only path for uniswap-v3, which has no reserve view). Store what succeeds.
    let r0, r1
    if (m.kind === 'curve-stableswap') {
      r0 = await tryRead(client, {
        address: m.address,
        abi: curvePoolAbi,
        functionName: 'balances',
        args: [0n],
        ...at,
      })
      r1 = await tryRead(client, {
        address: m.address,
        abi: curvePoolAbi,
        functionName: 'balances',
        args: [1n],
        ...at,
      })
    }
    if (r0 === undefined) r0 = await balOf(m.token0, m.address)
    if (r1 === undefined) r1 = await balOf(m.token1, m.address)

    const usd0 = r0 !== undefined && dec0 !== null ? Number(r0) / 10 ** dec0 : null
    const usd1 = r1 !== undefined && dec1 !== null ? Number(r1) / 10 ** dec1 : null
    if (
      usd0 === null ||
      usd1 === null ||
      !Number.isFinite(usd0) ||
      !Number.isFinite(usd1) ||
      (m.kind === 'curve-stableswap' && coinsIdentity !== 'match') ||
      exitIdentity !== 'match'
    )
      complete = false

    // Skew = one-sidedness of the pool in [0,100] (stETH 78:22 / MIM 96% genre).
    let skewPct = null
    if (
      (m.kind !== 'curve-stableswap' || coinsIdentity === 'match') &&
      exitIdentity === 'match' &&
      usd0 !== null &&
      usd1 !== null &&
      usd0 + usd1 > 0
    ) {
      skewPct = (Math.max(usd0, usd1) / (usd0 + usd1)) * 100
    }

    // Exitable = the side that is NOT exitFrom (the token you swap INTO). If
    // exitFrom is token0, the exitable reserve is token1's, and vice-versa.
    const exitFromIs0 =
      m.exitFrom && m.token0 && m.exitFrom.toLowerCase() === m.token0.toLowerCase()
    const exitableUsd =
      (m.kind === 'curve-stableswap' && coinsIdentity !== 'match') || exitIdentity !== 'match'
        ? null
        : exitFromIs0
          ? usd1
          : usd0

    if (exitableUsd !== null && Number.isFinite(exitableUsd)) depthUsd += exitableUsd
    if (skewPct !== null && (worstSkew === null || skewPct > worstSkew)) worstSkew = skewPct

    out.push({
      name: m.name,
      kind: m.kind,
      address: m.address,
      token0: m.token0,
      token1: m.token1,
      coin0Onchain: coin0Onchain ?? null,
      coin1Onchain: coin1Onchain ?? null,
      coinsIdentity,
      exitIdentity,
      exitFrom: m.exitFrom ?? null,
      reserve0Raw: r0 !== undefined ? s(r0) : null,
      reserve1Raw: r1 !== undefined ? s(r1) : null,
      decimals0: dec0,
      decimals1: dec1,
      reserve0Usd: usd0,
      reserve1Usd: usd1,
      skewPct,
      exitableUsd,
      priceAssumptionUsd: 1,
      note: m.note ?? null,
      reads: {
        reserve0: r0 !== undefined,
        reserve1: r1 !== undefined,
        decimals0: dec0 !== null,
        decimals1: dec1 !== null,
        coins0: coin0Onchain !== undefined,
        coins1: coin1Onchain !== undefined,
      },
    })
  }

  return {
    depthMarkets: out,
    // Keep raw partial market rows for diagnosis, but never publish a partial
    // sum as if exit inventory collapsed. Null is an unpriced observation.
    depth_usd: complete ? depthUsd : null,
    depth_complete: complete,
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

/**
 * MetaMorpho vaults (Morpho's curated ERC-4626 vaults, V1) on mainnet: an address's vault
 * shares, the markets each vault lends into, and the vault-level exit.
 *
 * DISCOVERY. Vault shares cannot be enumerated on-chain from the holder's side, so the LIST
 * of vaults comes from Morpho's keyless API (`userByAddress { vaultPositions }`), as the
 * Morpho Blue adapter's market list does. Only the list does: every number is read on-chain
 * at one pinned block. When the API cannot be asked, the read FAILS with the API's error (a
 * retry is offered): no list, no claim of "no vault". Vault V2 positions the API names are
 * counted and named as not read.
 *
 * THE EXIT. A vault pays a withdrawal out of its markets in withdraw-queue order, each up
 * to the market's unborrowed supply. So the vault's liquidity is
 *     Σ over its withdraw queue of min(vault's supply in the market, market's liquidity)
 * and this address's exit now is the vault's own ERC-4626 maxWithdraw(user) (read, not
 * derived). Market supply is as stored at each market's last update (no accrual here: a
 * slight under-count, never an over-count).
 */

import type { PublicClient } from 'viem'

import { getMainnetClient, rpcLabel, toNumber } from '../rpc'
import { stamp, type LendMarketState, type ProtocolPosition, type VaultMarketAllocation, type VaultState } from '../types'
import { toAssetsDown } from '../../curatorFeed/exposure'
import { aaveOracleUsdPrices } from './aaveV3'
import { MORPHO_API_URL, MORPHO_API_TIMEOUT_MS } from './morphoDiscovery'
import { ASSUMED_ONE_DOLLAR, MORPHO_BLUE_MAINNET, MULTICALL3, morphoAbi, morphoErc20Abi, multicall3Abi } from './morphoBlue'
import { mc, optional, pinBlock, unwrap, type Call, type LendingAdapter } from './types'

const vaultAbi = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ name: 's', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxWithdraw', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint96' }] },
  { type: 'function', name: 'curator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'withdrawQueueLength', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'withdrawQueue', stateMutability: 'view', inputs: [{ name: 'i', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
] as const

/** At most this many vaults are read per address (largest first, by the API's own size). */
export const MAX_VAULTS = 8
const ZERO = /^0x0{40}$/i
const WAD_DECIMALS = 18

const QUERY = `query MembraneMorphoVaults($address: String!, $chainId: Int!) {
  userByAddress(address: $address, chainId: $chainId) {
    vaultPositions { vault { address } state { shares assetsUsd } }
    vaultV2Positions { vault { address } }
  }
}`

export interface DiscoveredVaults {
  /** Vaults with shares, largest first. */
  vaults: `0x${string}`[]
  /** Vaults past MAX_VAULTS, not read. */
  cut: number
  /** Vault V2 positions the API named (another contract design; not read). */
  v2: number
}

/** The API's body → the vaults to read. Pure. Throws naming what is missing. */
export function parseVaultDiscovery(body: unknown): DiscoveredVaults {
  const b = body as {
    errors?: { message?: string }[]
    data?: {
      userByAddress?: {
        vaultPositions?: { vault?: { address?: string }; state?: { shares?: string | number | null; assetsUsd?: number | null } | null }[] | null
        vaultV2Positions?: unknown[] | null
      } | null
    }
  }
  if (b?.errors?.length) {
    // The API answers an address it has never indexed with this error: no positions.
    if (b.errors.every((e) => /No results matching given parameters/i.test(e.message ?? ''))) return { vaults: [], cut: 0, v2: 0 }
    throw new Error(`Morpho API: ${b.errors.map((e) => e.message ?? '?').join('; ')}`)
  }
  const u = b?.data?.userByAddress
  if (!u || !Array.isArray(u.vaultPositions)) throw new Error('Morpho API: no userByAddress.vaultPositions in the response')
  const held = u.vaultPositions
    .filter((p) => {
      try {
        return BigInt(String(p.state?.shares ?? 0)) > 0n
      } catch {
        return true // unparseable: read it, the chain decides
      }
    })
    .filter((p) => typeof p.vault?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(p.vault.address))
    .sort((p, q) => (q.state?.assetsUsd ?? 0) - (p.state?.assetsUsd ?? 0))
  const seen = new Set<string>()
  const vaults: `0x${string}`[] = []
  for (const p of held) {
    const a = (p.vault?.address as string).toLowerCase()
    if (seen.has(a)) continue
    seen.add(a)
    vaults.push(p.vault?.address as `0x${string}`)
  }
  return { vaults: vaults.slice(0, MAX_VAULTS), cut: Math.max(0, vaults.length - MAX_VAULTS), v2: (u.vaultV2Positions ?? []).length }
}

/** Σ min(vault supply, market liquidity) over the withdraw queue. Pure. */
export const vaultLiquidity = (allocation: Pick<VaultMarketAllocation, 'available'>[]): number =>
  allocation.reduce((a, m) => a + m.available, 0)

/** One queue market's allocation from its reads, loan-token units. Pure. */
export function allocationOf(input: {
  marketId: `0x${string}`
  label: string
  decimals: number
  vaultSupplyShares: bigint
  /** market(): totalSupplyAssets, totalSupplyShares, totalBorrowAssets. */
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
}): VaultMarketAllocation {
  const d = input.decimals
  const assetsRaw = input.vaultSupplyShares === 0n ? 0n : toAssetsDown(input.vaultSupplyShares, input.totalSupplyAssets, input.totalSupplyShares)
  const liqRaw = input.totalSupplyAssets > input.totalBorrowAssets ? input.totalSupplyAssets - input.totalBorrowAssets : 0n
  const availRaw = assetsRaw < liqRaw ? assetsRaw : liqRaw
  const supply = toNumber(input.totalSupplyAssets, d)
  return {
    marketId: input.marketId,
    label: input.label,
    assets: toNumber(assetsRaw, d),
    marketLiquidity: toNumber(liqRaw, d),
    available: toNumber(availRaw, d),
    utilization: supply > 0 ? Math.min(1, toNumber(input.totalBorrowAssets, d) / supply) : 0,
  }
}

/** The vault as a lend market: its own liquidity, what of it is lent and borrowed. Pure. */
export function vaultLendMarket(input: {
  symbol: string
  token: `0x${string}`
  priceUsd: number
  totalAssets: number
  vault: VaultState
  block: bigint
  blockTs: bigint | null
}): LendMarketState {
  const liquidity = Math.min(input.totalAssets, vaultLiquidity(input.vault.allocation))
  const lent = Math.max(0, input.totalAssets - liquidity)
  const ts = input.blockTs === null ? null : Number(input.blockTs)
  return {
    venue: 'morpho-vault',
    symbol: input.symbol,
    token: input.token,
    priceUsd: input.priceUsd,
    totalSupply: input.totalAssets,
    totalBorrow: lent,
    liquidity,
    utilization: input.totalAssets > 0 ? lent / input.totalAssets : 0,
    borrowApr: null,
    fee: input.vault.fee,
    supplyApr: null,
    aprBasis: 'not read on-chain: a vault’s rate is its markets’ rates by allocation, less its fee',
    block: Number(input.block),
    lastUpdate: ts ?? 0,
    blockTs: ts,
    vault: input.vault,
  }
}

export interface MorphoVaultDeps {
  client: () => PublicClient
  fetch: typeof fetch
  usdPrices: (tokens: `0x${string}`[], block: bigint) => Promise<Record<string, number>>
}

const DEFAULT_DEPS: MorphoVaultDeps = {
  client: getMainnetClient,
  fetch: (input, init) => fetch(input, init),
  usdPrices: (tokens, block) => aaveOracleUsdPrices(tokens, undefined, undefined, block),
}

async function discover(user: `0x${string}`, deps: MorphoVaultDeps): Promise<DiscoveredVaults> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => ctl?.abort(), MORPHO_API_TIMEOUT_MS)
  try {
    const res = await deps.fetch(MORPHO_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { address: user, chainId: 1 } }),
      ...(ctl ? { signal: ctl.signal } : {}),
    })
    if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}: vault shares not checked`)
    return parseVaultDiscovery(await res.json())
  } catch (e) {
    const m = (e as Error).message
    throw new Error(/vault shares not checked|Morpho API/.test(m) ? m : `Morpho API unreachable (${m}): vault shares not checked`)
  } finally {
    clearTimeout(timer)
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const str = (v: unknown, fallback: string) => (typeof v === 'string' && /^[\x20-\x7e]{1,64}$/.test(v.trim()) ? v.trim() : fallback)

export function createMorphoVaultAdapter(overrides: Partial<MorphoVaultDeps> = {}): LendingAdapter {
  const deps: MorphoVaultDeps = { ...DEFAULT_DEPS, ...overrides }
  return {
    id: 'morpho-vault',
    label: 'Morpho vaults',
    async read(user: `0x${string}`): Promise<ProtocolPosition[]> {
      const client = deps.client()
      const [found, block] = await Promise.all([discover(user, deps), pinBlock(client)])
      if (found.vaults.length === 0) return []

      // --- 1. each vault's head ------------------------------------------------
      const fns = ['asset', 'name', 'totalAssets', 'fee', 'curator', 'owner', 'withdrawQueueLength'] as const
      const head = await mc<unknown>(
        client,
        [
          ...found.vaults.flatMap((v) => [
            ...fns.map((fn) => ({ address: v, abi: vaultAbi, functionName: fn }) as Call),
            { address: v, abi: vaultAbi, functionName: 'balanceOf', args: [user] },
            { address: v, abi: vaultAbi, functionName: 'maxWithdraw', args: [user] },
          ]),
          { address: MULTICALL3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
        ],
        block,
      )
      const W = fns.length + 2
      const blockTs = optional(head[head.length - 1]) as bigint | null
      const heads = found.vaults.map((v, k) => {
        const at = (i: number) => head[k * W + i]
        const tag = `morpho vault ${short(v)}`
        return {
          v,
          asset: unwrap(at(0), `${tag}: asset()`) as `0x${string}`,
          name: str(optional(at(1)), short(v)),
          totalAssetsRaw: unwrap(at(2), `${tag}: totalAssets()`) as bigint,
          feeRaw: (optional(at(3)) as bigint | null) ?? null,
          curator: optional(at(4)) as `0x${string}` | null,
          owner: optional(at(5)) as `0x${string}` | null,
          queueLen: Number(unwrap(at(6), `${tag}: withdrawQueueLength()`) as bigint),
          shares: unwrap(at(7), `${tag}: balanceOf()`) as bigint,
          maxWithdrawRaw: unwrap(at(8), `${tag}: maxWithdraw()`) as bigint,
        }
      })
      const held = heads.filter((h) => h.shares > 0n)
      if (held.length === 0) return []

      // --- 2. shares → assets, the queue, asset decimals and symbols --------------
      const second: Call[] = []
      const push = (c: Call) => second.push(c) - 1
      const idx = held.map((h) => ({
        assets: push({ address: h.v, abi: vaultAbi, functionName: 'convertToAssets', args: [h.shares] }),
        decimals: push({ address: h.asset, abi: morphoErc20Abi, functionName: 'decimals' }),
        symbol: push({ address: h.asset, abi: morphoErc20Abi, functionName: 'symbol' }),
        queue: Array.from({ length: h.queueLen }, (_, i) => push({ address: h.v, abi: vaultAbi, functionName: 'withdrawQueue', args: [BigInt(i)] })),
      }))
      const r2 = await mc<unknown>(client, second, block)

      // --- 3. every queue market: the vault's position, the market, its params -----
      const third: Call[] = []
      const push3 = (c: Call) => third.push(c) - 1
      const markets = held.map((h, k) =>
        idx[k].queue.map((qi) => {
          const id = unwrap(r2[qi], `morpho vault ${short(h.v)}: withdrawQueue`) as `0x${string}`
          return {
            id,
            position: push3({ address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'position', args: [id, h.v] }),
            market: push3({ address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'market', args: [id] }),
            params: push3({ address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'idToMarketParams', args: [id] }),
          }
        }),
      )
      const r3 = await mc<unknown>(client, third, block, 8_192)

      // Collateral symbols, for the allocation's labels only.
      const collTokens = Array.from(
        new Set(
          markets.flatMap((ms) =>
            ms.map((m) => (optional(r3[m.params]) as readonly unknown[] | null)?.[1] as string | undefined).filter((a): a is string => !!a && !ZERO.test(a)),
          ),
        ),
      ) as `0x${string}`[]
      const r4 = await mc<unknown>(client, collTokens.map((a) => ({ address: a, abi: morphoErc20Abi, functionName: 'symbol' })), block)
      const collSymbol = new Map(collTokens.map((a, i) => [a.toLowerCase(), str(optional(r4[i]), short(a))]))

      // USD per asset: the three listed stablecoins at $1 (as the Morpho adapter), else Aave.
      const needUsd = Array.from(new Set(held.map((h) => h.asset.toLowerCase() as `0x${string}`).filter((a) => ASSUMED_ONE_DOLLAR[a] === undefined)))
      const usd = needUsd.length ? await deps.usdPrices(needUsd, block) : {}

      return held.map((h, k) => {
        const tag = `morpho vault ${h.name}`
        const decimals = Number(unwrap(r2[idx[k].decimals], `${tag}: asset decimals()`) as bigint | number)
        const symbol = str(optional(r2[idx[k].symbol]), short(h.asset))
        const assets = toNumber(unwrap(r2[idx[k].assets], `${tag}: convertToAssets()`) as bigint, decimals)
        const key = h.asset.toLowerCase()
        const priceUsd = ASSUMED_ONE_DOLLAR[key] !== undefined ? 1 : usd[key]
        if (!(priceUsd > 0)) throw new Error(`${tag}: no USD price for its asset ${symbol} (${h.asset}); the Aave V3 oracle does not list it`)
        const allocation = markets[k].map((m) => {
          const pos = unwrap(r3[m.position], `${tag}: position(${m.id})`) as readonly bigint[]
          const mk = unwrap(r3[m.market], `${tag}: market(${m.id})`) as readonly bigint[]
          const params = unwrap(r3[m.params], `${tag}: idToMarketParams(${m.id})`) as readonly [string, string, string, string, bigint]
          const coll = ZERO.test(params[1]) ? null : collSymbol.get(params[1].toLowerCase()) ?? short(params[1])
          const lltv = `${(toNumber(params[4], WAD_DECIMALS) * 100).toFixed(1).replace(/\.0$/, '')}%`
          return allocationOf({
            marketId: m.id,
            label: coll === null ? `${symbol} idle market` : `${coll}/${symbol} ${lltv}`,
            decimals,
            vaultSupplyShares: pos[0],
            totalSupplyAssets: mk[0],
            totalSupplyShares: mk[1],
            totalBorrowAssets: mk[2],
          })
        })
        const vault: VaultState = {
          address: h.v,
          name: h.name,
          assets,
          maxWithdraw: toNumber(h.maxWithdrawRaw, decimals),
          fee: h.feeRaw === null ? 0 : toNumber(h.feeRaw, WAD_DECIMALS),
          curator: h.curator && !ZERO.test(h.curator) ? h.curator : null,
          owner: h.owner && !ZERO.test(h.owner) ? h.owner : null,
          allocation,
        }
        const lendMarket = vaultLendMarket({ symbol, token: h.asset, priceUsd, totalAssets: toNumber(h.totalAssetsRaw, decimals), vault, block, blockTs })
        const notes = [
          found.cut > 0 ? `${found.cut} more vault(s) past the first ${MAX_VAULTS} were not read.` : null,
          found.v2 > 0 ? `${found.v2} Vault V2 position(s) named by the API are not read (another contract design).` : null,
        ].filter(Boolean)
        const position: ProtocolPosition = {
          protocol: 'morpho-vault',
          label: `Morpho vault · ${h.name}`,
          marketId: h.v,
          collateral: [],
          debt: [],
          totalCollateralUsd: 0,
          totalDebtUsd: 0,
          ltv: 0,
          liquidationLtv: 0,
          healthFactor: Number.POSITIVE_INFINITY,
          status: 'supply-only',
          supplied: [{ symbol, address: h.asset, decimals, amount: assets, priceUsd, valueUsd: assets * priceUsd }],
          lendMarket,
          ...(assets < 1 / 10 ** Math.min(decimals, 2) ? { dustSupply: true } : {}),
          provenance: {
            ...stamp(
              'onchain',
              `morpho vault · ${rpcLabel()}`,
              `MetaMorpho vault ${h.v} (${h.name}), found by the Morpho API's vaultPositions index. Shares from balanceOf, their value from convertToAssets; your exit from the vault's own maxWithdraw. Its ${allocation.length} withdraw-queue markets read on Morpho Blue ${MORPHO_BLUE_MAINNET} (position, market, idToMarketParams; supply as stored at each market's last update). ${
                ASSUMED_ONE_DOLLAR[key] !== undefined ? `ASSUMPTION: ${symbol} taken as exactly $1.00.` : `${symbol} priced by the Aave V3 oracle.`
              } ${notes.join(' ')} Every call read block ${block}.`,
            ),
            block: Number(block),
          },
        }
        return position
      })
    },
  }
}

export const morphoVaultAdapter: LendingAdapter = createMorphoVaultAdapter()

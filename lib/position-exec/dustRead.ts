/**
 * THE DUST READ. Every supply position an address holds on the supported venues, read at
 * one block, as DustCandidates (lib/position-exec/dust.ts decides which are dust).
 *
 *   Morpho Blue  position(id, owner).supplyShares over the market ids the caller passes
 *                (Morpho has no reverse index: the discovery list, plus the owner's own
 *                Supply events where those can be read; a market in neither is not seen),
 *                market(id) totals and idToMarketParams(id) for the hits. Assets are
 *                toAssetsDown(shares) = shares × (totalSupplyAssets + 1) / (totalSupplyShares
 *                + 1e6), on the stored totals: interest accrued since the market's last
 *                update is not in them, so the payout can only be a little higher.
 *   Aave V3      Pool.getReservesList(), getReserveData(asset) for each, then the owner's
 *                aToken.balanceOf (which includes accrued interest) and decimals.
 *   Prices       the Aave V3 oracle (getAssetsPrices) for every token, WETH included for
 *                the gas figure. A token the oracle does not price stays null; Morpho's
 *                USDC/USDT/DAI loan tokens are taken at $1, as the Morpho adapter does.
 *
 * Read only. A failed read throws with the call named; nothing is defaulted.
 */

import type { PublicClient } from 'viem'

import { AAVE_V3_MAINNET_ADDRESSES_PROVIDER, MORPHO_BLUE_MAINNET } from '@/lib/position-sim/adapters'
import { aaveOracleUsdPrices } from '@/lib/position-sim/adapters/aaveV3'
import { mc, unwrap, type Call } from '@/lib/position-sim/adapters/types'

import { aaveAddressesProviderAbi, aavePoolAbi, erc20ReadAbi, morphoAbi } from './abis'
import type { Address, MorphoMarketParams } from './builders'
import type { DustCandidate } from './dust'
import { decodeAaveConfig } from './read'

export const WETH_MAINNET = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Address

/** Morpho loan tokens taken at $1 (the Morpho adapter's ASSUMED_ONE_DOLLAR). */
const ONE_DOLLAR = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
  '0x6b175474e89094c44da98b954eedeac495271d0f',
])

const symbolAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

export interface DustRead {
  owner: Address
  block: number
  /** Every supply position held, dust or not. */
  candidates: DustCandidate[]
  /** ETH in USD from the same oracle, for the gas figure; null when unpriced. */
  ethUsd: number | null
  /** Morpho markets scanned (the discovery list's size), for the honest coverage line. */
  morphoMarketsScanned: number
  source: string
}

const lltvLabel = (lltv: bigint) =>
  `${(Number(lltv / 10n ** 13n) / 1000).toFixed(1).replace(/\.0$/, '')}%`

export async function readDust(
  client: PublicClient,
  owner: Address,
  morphoMarkets: readonly `0x${string}`[],
  label = 'public rpc',
  /** Where the market ids came from, for the source line. */
  marketsFrom = 'the discovery list',
): Promise<DustRead> {
  const block = await client.getBlockNumber({ cacheTime: 0 })

  // --- Morpho Blue -------------------------------------------------------------
  const pos = await mc<readonly bigint[]>(
    client,
    morphoMarkets.map((id) => ({
      address: MORPHO_BLUE_MAINNET,
      abi: morphoAbi,
      functionName: 'position',
      args: [id, owner],
    })),
    block,
  )
  const hits = morphoMarkets
    .map((id, i) => ({ id, shares: unwrap(pos[i], `morpho blue: position(${id})`)[0] }))
    .filter((h) => h.shares > 0n)
  const mState = await mc<readonly unknown[]>(
    client,
    hits.flatMap<Call>((h) => [
      { address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'market', args: [h.id] },
      { address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'idToMarketParams', args: [h.id] },
    ]),
    block,
  )
  const morpho = hits.map((h, i) => {
    const m = unwrap(mState[i * 2], `morpho blue: market(${h.id})`)
    const p = unwrap(mState[i * 2 + 1], `morpho blue: idToMarketParams(${h.id})`)
    const params: MorphoMarketParams = {
      loanToken: p[0] as Address,
      collateralToken: p[1] as Address,
      oracle: p[2] as Address,
      irm: p[3] as Address,
      lltv: p[4] as bigint,
    }
    const totalAssets = m[0] as bigint
    const totalShares = m[1] as bigint
    return { ...h, params, assets: (h.shares * (totalAssets + 1n)) / (totalShares + 10n ** 6n) }
  })

  // --- Aave V3 -------------------------------------------------------------------
  const [poolRes] = await mc<Address>(
    client,
    [{ address: AAVE_V3_MAINNET_ADDRESSES_PROVIDER, abi: aaveAddressesProviderAbi, functionName: 'getPool' }],
    block,
  )
  const pool = unwrap(poolRes, 'aave v3: PoolAddressesProvider.getPool()')
  const [listRes] = await mc<readonly Address[]>(
    client,
    [{ address: pool, abi: aavePoolAbi, functionName: 'getReservesList' }],
    block,
  )
  const reserves = unwrap(listRes, 'aave v3: Pool.getReservesList()')
  const rd = await mc<{ configuration: bigint; aTokenAddress: Address }>(
    client,
    reserves.map((a) => ({ address: pool, abi: aavePoolAbi, functionName: 'getReserveData', args: [a] })),
    block,
  )
  const aTokens = reserves.map((asset, i) => {
    const r = unwrap(rd[i], `aave v3: Pool.getReserveData(${asset})`)
    return { asset, aToken: r.aTokenAddress, paused: decodeAaveConfig(r.configuration).paused }
  })
  const bal = await mc<bigint>(
    client,
    aTokens.map((t) => ({ address: t.aToken, abi: erc20ReadAbi, functionName: 'balanceOf', args: [owner] })),
    block,
  )
  const aave = aTokens
    .map((t, i) => ({ ...t, assets: unwrap(bal[i], `aave v3: aToken ${t.aToken} balanceOf(owner)`) }))
    .filter((t) => t.assets > 0n)

  // --- token details and prices ----------------------------------------------------
  const tokens = [...new Set([...morpho.map((m) => m.params.loanToken), ...aave.map((a) => a.asset)].map((t) => t.toLowerCase() as Address))]
  const det = await mc<string | number>(
    client,
    tokens.flatMap<Call>((t) => [
      { address: t, abi: erc20ReadAbi, functionName: 'decimals' },
      { address: t, abi: symbolAbi, functionName: 'symbol' },
    ]),
    block,
  )
  const info = new Map(
    tokens.map((t, i) => [
      t,
      {
        decimals: Number(unwrap(det[i * 2], `decimals() on ${t}`)),
        // MKR-style bytes32 symbols fail to decode as string: the address names it then.
        symbol: det[i * 2 + 1]?.status === 'success' ? String(det[i * 2 + 1].result) : `${t.slice(0, 6)}…`,
      },
    ]),
  )
  const prices = await aaveOracleUsdPrices([...tokens, WETH_MAINNET], undefined, undefined, block)
  const priceOf = (t: Address, morphoLoan: boolean): number | null =>
    prices[t.toLowerCase()] ?? (morphoLoan && ONE_DOLLAR.has(t.toLowerCase()) ? 1 : null)

  const collSym = await mc<string>(
    client,
    morpho.map((m) => ({ address: m.params.collateralToken, abi: symbolAbi, functionName: 'symbol' })),
    block,
  )

  const candidates: DustCandidate[] = [
    ...morpho.map((m, i): DustCandidate => {
      const t = info.get(m.params.loanToken.toLowerCase() as Address)!
      const coll = collSym[i]?.status === 'success' ? String(collSym[i].result) : 'idle'
      return {
        venue: 'morpho-blue',
        label: `Morpho · ${coll}/${t.symbol} ${lltvLabel(m.params.lltv)}`,
        symbol: t.symbol,
        token: m.params.loanToken,
        decimals: t.decimals,
        assets: m.assets,
        priceUsd: priceOf(m.params.loanToken, true),
        morpho: MORPHO_BLUE_MAINNET,
        marketId: m.id,
        params: m.params,
        shares: m.shares,
      }
    }),
    ...aave.map((a): DustCandidate => {
      const t = info.get(a.asset.toLowerCase() as Address)!
      return {
        venue: 'aave-v3',
        label: `Aave V3 · ${t.symbol}`,
        symbol: t.symbol,
        token: a.asset,
        decimals: t.decimals,
        assets: a.assets,
        priceUsd: priceOf(a.asset, false),
        pool,
        paused: a.paused,
      }
    }),
  ]
  return {
    owner,
    block: Number(block),
    candidates,
    ethUsd: prices[WETH_MAINNET] ?? null,
    morphoMarketsScanned: morphoMarkets.length,
    source: `Morpho Blue ${MORPHO_BLUE_MAINNET} position/market/idToMarketParams over ${morphoMarkets.length} markets (${marketsFrom}); Aave V3 Pool ${pool} reserves and aToken balances; Aave V3 oracle prices; ${label}, block ${block}`,
  }
}

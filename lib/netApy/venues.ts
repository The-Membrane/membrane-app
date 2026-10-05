/**
 * The venues net-APY-at-size covers, keyed by venue-key.
 *
 * NEVER GUESS AN ADDRESS (recorder rule, tools/venue-recorder.config.json). Every entry
 * below was read back on-chain on 2026-10-05 at block ~26,123,6xx:
 *   - Aave / Spark: Pool.getReserveData(asset) returned a live aToken and the decoded
 *     decimals match; the strategy answered its getters.
 *   - Morpho: Morpho.idToMarketParams(id) returned this loan token and
 *     irm = AdaptiveCurveIrm 0x870a…00BC.
 *   - Euler: vault.asset() returned this asset; its IRM answered baseRate/slope1/
 *     slope2/kink (IRMLinearKink).
 * The reader re-checks these at every read and throws on a mismatch, and the live test
 * (tests/unit/netApy.live.test.ts) re-verifies all of them.
 *
 * Only USD-stablecoin loan assets are listed, so a USD size converts to token units at
 * a stated $1.00 — no price feed is needed and none is invented.
 */

import type { Address, AssetRef, NetApyProtocol } from './types'

export const AAVE_V3_POOL: Address = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
export const SPARK_POOL: Address = '0xC13e21B648A5Ee794902342038FF3aDAB66BE987'
export const MORPHO_BLUE: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'
export const MORPHO_ADAPTIVE_CURVE_IRM: Address = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC'

const asset = (address: Address, symbol: string, decimals: number): AssetRef => ({
  address,
  symbol,
  decimals,
  usdPriceAssumption: 1,
})
const USDC = asset('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6)
const USDT = asset('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 6)
const USDE = asset('0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', 'USDe', 18)
const USDS = asset('0xdC035D45d973E3EC169d2276DDab16f1e407384F', 'USDS', 18)

interface VenueBase {
  venueKey: string
  label: string
  asset: AssetRef
}
export type VenueDef =
  | (VenueBase & { protocol: 'aave-v3' | 'spark'; pool: Address })
  | (VenueBase & { protocol: 'morpho-blue'; marketId: Address; collateralSymbol: string; lltvPct: number })
  | (VenueBase & { protocol: 'euler-v2'; vault: Address })

export const NET_APY_VENUES: readonly VenueDef[] = [
  { venueKey: 'aave-v3-usdc', protocol: 'aave-v3', label: 'Aave v3 USDC', asset: USDC, pool: AAVE_V3_POOL },
  { venueKey: 'aave-v3-usdt', protocol: 'aave-v3', label: 'Aave v3 USDT', asset: USDT, pool: AAVE_V3_POOL },
  // Same key as the recorder's venue, so this card joins its /venue page.
  { venueKey: 'aave-v3-usde', protocol: 'aave-v3', label: 'Aave v3 USDe', asset: USDE, pool: AAVE_V3_POOL },
  { venueKey: 'aave-v3-usds', protocol: 'aave-v3', label: 'Aave v3 USDS', asset: USDS, pool: AAVE_V3_POOL },
  { venueKey: 'spark-usdc', protocol: 'spark', label: 'SparkLend USDC', asset: USDC, pool: SPARK_POOL },
  { venueKey: 'spark-usdt', protocol: 'spark', label: 'SparkLend USDT', asset: USDT, pool: SPARK_POOL },
  { venueKey: 'spark-usds', protocol: 'spark', label: 'SparkLend USDS', asset: USDS, pool: SPARK_POOL },
  {
    venueKey: 'morpho-blue-cbbtc-usdc-86',
    protocol: 'morpho-blue',
    label: 'Morpho cbBTC/USDC 86%',
    asset: USDC,
    marketId: '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
    collateralSymbol: 'cbBTC',
    lltvPct: 86,
  },
  {
    venueKey: 'morpho-blue-wbtc-usdc-86',
    protocol: 'morpho-blue',
    label: 'Morpho WBTC/USDC 86%',
    asset: USDC,
    marketId: '0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49',
    collateralSymbol: 'WBTC',
    lltvPct: 86,
  },
  {
    venueKey: 'morpho-blue-wsteth-usdc-86',
    protocol: 'morpho-blue',
    label: 'Morpho wstETH/USDC 86%',
    asset: USDC,
    marketId: '0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc',
    collateralSymbol: 'wstETH',
    lltvPct: 86,
  },
  {
    venueKey: 'morpho-blue-wsteth-usdt-86',
    protocol: 'morpho-blue',
    label: 'Morpho wstETH/USDT 86%',
    asset: USDT,
    marketId: '0xe7e9694b754c4d4f7e21faf7223f6fa71abaeb10296a4c43a54a7977149687d2',
    collateralSymbol: 'wstETH',
    lltvPct: 86,
  },
  { venueKey: 'euler-v2-eusdc-2', protocol: 'euler-v2', label: 'Euler eUSDC-2', asset: USDC, vault: '0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9' },
  { venueKey: 'euler-v2-eusdt-2', protocol: 'euler-v2', label: 'Euler eUSDT-2', asset: USDT, vault: '0x313603FA690301b0CaeEf8069c065862f9162162' },
]

export function venueByKey(key: string): VenueDef | null {
  return NET_APY_VENUES.find((v) => v.venueKey === key) ?? null
}

export const PROTOCOL_LABEL: Record<NetApyProtocol, string> = {
  'aave-v3': 'Aave v3',
  spark: 'SparkLend',
  'morpho-blue': 'Morpho Blue',
  'euler-v2': 'Euler v2',
}

/** USD → raw token units at the registry's stated $1.00. Floors to a whole unit. */
export function usdToRaw(usd: number, a: AssetRef): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('size must be a non-negative USD amount')
  // Whole dollars × 10^decimals, then cents, so a $10M size never touches float error.
  const cents = BigInt(Math.round(usd * 100))
  return (cents * 10n ** BigInt(a.decimals)) / 100n
}

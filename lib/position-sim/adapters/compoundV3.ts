/**
 * Compound V3 ("Comet") mainnet.
 *
 * SHAPE: Comet is one contract per BASE asset. Debt is always denominated in that
 * single base token — you cannot borrow anything else — and collateral is a fixed,
 * enumerable list read from `numAssets()` + `getAssetInfo(i)`. That makes enumeration
 * trivial compared with Morpho, but it means one address can hold up to three
 * independent positions (one per Comet), so this adapter returns an array.
 *
 * SCALING CONVENTIONS (Comet.sol):
 *   - `getPrice(priceFeed)` returns USD at PRICE_SCALE = 1e8 (Chainlink-style).
 *   - `AssetInfo.scale` is 10**decimals for that collateral. We derive the token's
 *     decimals from it rather than making a second ERC20 call.
 *   - `borrowCollateralFactor` / `liquidateCollateralFactor` / `liquidationFactor`
 *     are FACTOR_SCALE = 1e18.
 *   - `getBorrowRate(utilization)` is a PER-SECOND rate at 1e18, so the APR is
 *     rate / 1e18 * 31_536_000. Read, not modelled.
 *
 * NOTE ON THE TWO FACTORS: Compound V3 has a genuine borrow/liquidation gap.
 * `borrowCollateralFactor` is the line you may open a position at; the position is
 * only seizable once it crosses `liquidateCollateralFactor`. We map the first to
 * `CollateralLeg.maxLtv` and the second to `liquidationThreshold`, and the
 * collateral-weighted liquidate factor to the position's `liquidationLtv`.
 */

import { getMainnetClient, rpcLabel, toNumber } from '../rpc'
import { stamp, type CollateralLeg, type DebtLeg, type ProtocolPosition } from '../types'
import { decimalsFromScale, mc, optional, ratio, unwrap, type Call, type LendingAdapter } from './types'

// ----------------------------------------------------------------------- ABIs

const cometAbi = [
  {
    type: 'function',
    name: 'borrowBalanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'baseToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'baseTokenPriceFeed',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  { type: 'function', name: 'numAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'getAssetInfo',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint8' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'offset', type: 'uint8' },
          { name: 'asset', type: 'address' },
          { name: 'priceFeed', type: 'address' },
          { name: 'scale', type: 'uint64' },
          { name: 'borrowCollateralFactor', type: 'uint64' },
          { name: 'liquidateCollateralFactor', type: 'uint64' },
          { name: 'liquidationFactor', type: 'uint64' },
          { name: 'supplyCap', type: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'userCollateral',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'asset', type: 'address' },
    ],
    outputs: [
      { name: 'balance', type: 'uint128' },
      { name: '_reserved', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'getPrice',
    stateMutability: 'view',
    inputs: [{ name: 'priceFeed', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'getUtilization', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getBorrowRate',
    stateMutability: 'view',
    inputs: [{ name: 'utilization', type: 'uint256' }],
    outputs: [{ type: 'uint64' }],
  },
] as const

const erc20Abi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

// ----------------------------------------------------------------- deployments

/**
 * The three mainnet Comets. Compound deploys a new contract per base asset, so this
 * list is the enumeration — there is no on-chain registry to resolve it from.
 *
 * QUOTE CURRENCY. `Comet.getPrice` returns each feed's own unit. cUSDCv3 and cUSDTv3 use
 * USD feeds ("USDC / USD", "ETH / USD", …). cWETHv3 uses ETH feeds ("wstETH / ETH CAPO",
 * "CBETH / ETH", …) and a "Constant price feed" of exactly 1 for its WETH base — verified
 * on mainnet 2026-10-14. Its prices are converted to USD at Chainlink ETH/USD, read
 * through the same Comet's getPrice; nothing is assumed.
 */
export const COMET_MAINNET_MARKETS = [
  { address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3', name: 'cUSDCv3', quote: 'USD', quoteUsdFeed: null },
  {
    address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
    name: 'cWETHv3',
    quote: 'ETH',
    // Chainlink ETH/USD proxy (the feed membrane-datasets price-history records).
    quoteUsdFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  },
  { address: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840', name: 'cUSDTv3', quote: 'USD', quoteUsdFeed: null },
] as const satisfies readonly CometMarket[]

export interface CometMarket {
  address: `0x${string}`
  name: string
  /** The unit Comet.getPrice reports for this market's feeds. */
  quote: 'USD' | 'ETH'
  /** A feed giving one quote unit in USD; null when the quote already is USD. */
  quoteUsdFeed: `0x${string}` | null
}

/**
 * A Comet price (1e8-scaled, in the market's quote unit) in USD. `quoteUsd` is one quote
 * unit in USD (1 for a USD market). Pure, so the conversion is unit-tested.
 */
export function cometPriceUsd(priceRaw: bigint, quoteUsd: number): number {
  if (!(quoteUsd > 0)) throw new Error('cometPriceUsd: the quote unit has no USD price')
  return toNumber(priceRaw, PRICE_DECIMALS) * quoteUsd
}

/** Comet PRICE_SCALE. */
const PRICE_DECIMALS = 8
/** Comet FACTOR_SCALE. */
const FACTOR_DECIMALS = 18
const SECONDS_PER_YEAR = 31_536_000

interface AssetInfo {
  offset: number
  asset: `0x${string}`
  priceFeed: `0x${string}`
  scale: bigint
  borrowCollateralFactor: bigint
  liquidateCollateralFactor: bigint
  liquidationFactor: bigint
  supplyCap: bigint
}

// -------------------------------------------------------------------- adapter

async function readComet(market: CometMarket, user: `0x${string}`): Promise<ProtocolPosition | null> {
  const client = getMainnetClient()
  const comet = market.address
  const tag = `compound v3 (${market.name})`

  // --- market shape ---------------------------------------------------------
  const head = await mc<unknown>(client, [
    { address: comet, abi: cometAbi, functionName: 'borrowBalanceOf', args: [user] },
    { address: comet, abi: cometAbi, functionName: 'baseToken' },
    { address: comet, abi: cometAbi, functionName: 'baseTokenPriceFeed' },
    { address: comet, abi: cometAbi, functionName: 'numAssets' },
  ])
  const borrowRaw = unwrap(head[0], `${tag}: borrowBalanceOf()`) as bigint
  const baseToken = unwrap(head[1], `${tag}: baseToken()`) as `0x${string}`
  const baseFeed = unwrap(head[2], `${tag}: baseTokenPriceFeed()`) as `0x${string}`
  const numAssets = Number(unwrap(head[3], `${tag}: numAssets()`))

  const infoCalls: Call[] = Array.from({ length: numAssets }, (_, i) => ({
    address: comet,
    abi: cometAbi,
    functionName: 'getAssetInfo',
    args: [i],
  }))
  const infoRes = await mc<AssetInfo>(client, infoCalls)
  const assets = infoRes.map((entry, i) => unwrap(entry, `${tag}: getAssetInfo(${i})`))

  // --- user collateral ------------------------------------------------------
  const collCalls: Call[] = assets.map((a) => ({
    address: comet,
    abi: cometAbi,
    functionName: 'userCollateral',
    args: [user, a.asset],
  }))
  const collRes = await mc<readonly bigint[]>(client, collCalls)
  const balances = assets.map((a, i) => unwrap(collRes[i], `${tag}: userCollateral(${a.asset})`)[0])

  // Nothing supplied and nothing borrowed → this Comet is simply not in use.
  if (borrowRaw === 0n && balances.every((b) => b === 0n)) return null

  const held = assets
    .map((a, i) => ({ info: a, balance: balances[i] as bigint }))
    .filter((x) => x.balance > 0n)

  // --- prices, base decimals, symbols, rate ---------------------------------
  const tailCalls: Call[] = [
    { address: comet, abi: cometAbi, functionName: 'getPrice', args: [baseFeed] },
    { address: baseToken, abi: erc20Abi, functionName: 'decimals' },
    { address: baseToken, abi: erc20Abi, functionName: 'symbol' },
    { address: comet, abi: cometAbi, functionName: 'getUtilization' },
  ]
  for (const h of held) {
    tailCalls.push({ address: comet, abi: cometAbi, functionName: 'getPrice', args: [h.info.priceFeed] })
    tailCalls.push({ address: h.info.asset, abi: erc20Abi, functionName: 'symbol' })
  }
  // The quote unit's USD price comes last so the indices above stay put.
  if (market.quoteUsdFeed) tailCalls.push({ address: comet, abi: cometAbi, functionName: 'getPrice', args: [market.quoteUsdFeed] })
  const tailRes = await mc<unknown>(client, tailCalls)
  let quoteUsd = 1
  if (market.quoteUsdFeed) {
    const raw = unwrap(tailRes[tailRes.length - 1], `${tag}: getPrice(${market.quote}/USD feed ${market.quoteUsdFeed})`) as bigint
    quoteUsd = toNumber(raw, PRICE_DECIMALS)
    if (!(quoteUsd > 0)) throw new Error(`${tag}: ${market.quote}/USD feed ${market.quoteUsdFeed} returned 0`)
  }

  const basePriceRaw = unwrap(tailRes[0], `${tag}: getPrice(baseTokenPriceFeed ${baseFeed})`) as bigint
  if (basePriceRaw === 0n) throw new Error(`${tag}: base price feed ${baseFeed} returned 0`)
  const baseDecimals = Number(unwrap(tailRes[1], `${tag}: decimals() on base token ${baseToken}`))
  // A symbol is a label, not a number — an unreadable one (e.g. bytes32 symbols) may
  // fall back to the address without violating the no-invented-numbers rule.
  const baseSymbol = (optional(tailRes[2]) as string | null) ?? shortAddress(baseToken)
  // An ETH-quoted Comet prices its own WETH base at exactly 1 ETH; anything else means the
  // quote-unit assumption above is wrong for this market, so stop rather than misprice.
  if (market.quote === 'ETH' && basePriceRaw !== 10n ** BigInt(PRICE_DECIMALS)) {
    throw new Error(`${tag}: expected the base feed ${baseFeed} to price the base at 1 ${market.quote}, got ${basePriceRaw}`)
  }
  const basePriceUsd = cometPriceUsd(basePriceRaw, quoteUsd)

  // Borrow APR: per-second rate at 1e18, annualised. Optional — null if it fails.
  const utilization = optional(tailRes[3]) as bigint | null
  let borrowApr: number | null = null
  if (utilization !== null) {
    const rateRes = await mc<bigint>(client, [
      { address: comet, abi: cometAbi, functionName: 'getBorrowRate', args: [utilization] },
    ])
    const perSecond = optional(rateRes[0])
    if (perSecond !== null) borrowApr = toNumber(perSecond, FACTOR_DECIMALS) * SECONDS_PER_YEAR
  }

  // --- assemble legs --------------------------------------------------------
  const collateral: CollateralLeg[] = held.map((h, i) => {
    const priceRaw = unwrap(
      tailRes[4 + i * 2],
      `${tag}: getPrice(${h.info.priceFeed}) for collateral ${h.info.asset}`,
    ) as bigint
    if (priceRaw === 0n) {
      throw new Error(`${tag}: price feed ${h.info.priceFeed} returned 0 for collateral ${h.info.asset}`)
    }
    const symbol = (optional(tailRes[5 + i * 2]) as string | null) ?? shortAddress(h.info.asset)
    const decimals = decimalsFromScale(h.info.scale, `${tag}: AssetInfo.scale for ${symbol}`)
    const priceUsd = cometPriceUsd(priceRaw, quoteUsd)
    const amount = toNumber(h.balance, decimals)
    return {
      symbol,
      address: h.info.asset,
      decimals,
      amount,
      priceUsd,
      valueUsd: amount * priceUsd,
      liquidationThreshold: toNumber(h.info.liquidateCollateralFactor, FACTOR_DECIMALS),
      maxLtv: toNumber(h.info.borrowCollateralFactor, FACTOR_DECIMALS),
      // Comet expresses the penalty as the fraction of value the borrower KEEPS
      // (`liquidationFactor`), so the liquidator's bonus is its complement.
      liquidationBonus: Math.max(0, 1 - toNumber(h.info.liquidationFactor, FACTOR_DECIMALS)),
    }
  })

  const debt: DebtLeg[] = []
  if (borrowRaw > 0n) {
    const amount = toNumber(borrowRaw, baseDecimals)
    debt.push({
      symbol: baseSymbol,
      address: baseToken,
      decimals: baseDecimals,
      amount,
      priceUsd: basePriceUsd,
      valueUsd: amount * basePriceUsd,
      borrowApr,
    })
  }

  const totalCollateralUsd = collateral.reduce((s, c) => s + c.valueUsd, 0)
  const totalDebtUsd = debt.reduce((s, d) => s + d.valueUsd, 0)
  // Collateral-weighted liquidate factor — the line this Comet position dies at.
  const weightedLine =
    totalCollateralUsd > 0
      ? collateral.reduce((s, c) => s + c.liquidationThreshold * c.valueUsd, 0) / totalCollateralUsd
      : 0

  return {
    protocol: 'compound-v3',
    label: `Compound V3 · ${baseSymbol}`,
    marketId: comet,
    collateral,
    debt,
    totalCollateralUsd,
    totalDebtUsd,
    ltv: ratio(totalDebtUsd, totalCollateralUsd),
    liquidationLtv: weightedLine,
    // Comet exposes `isLiquidatable` as a bool, not a ratio, so the health factor is
    // derived: how far the borrow sits under the weighted liquidation line.
    healthFactor: ratio(totalCollateralUsd * weightedLine, totalDebtUsd),
    provenance: stamp(
      'onchain',
      `compound v3 · ${rpcLabel()}`,
      `Comet ${comet} (${market.name}), base token ${baseToken}. Prices from Comet.getPrice at 1e8${
        market.quote === 'USD' ? ' (USD feeds)' : `, quoted in ${market.quote} and converted at ${market.quote}/USD $${quoteUsd} (feed ${market.quoteUsdFeed})`
      }; collateral decimals from AssetInfo.scale; borrow/liquidate collateral factors at 1e18. Borrow APR annualised from getBorrowRate(getUtilization()) × ${SECONDS_PER_YEAR}s.`,
    ),
  }
}

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export const compoundV3Adapter: LendingAdapter = {
  id: 'compound-v3',
  label: 'Compound V3',
  async read(user: `0x${string}`): Promise<ProtocolPosition[]> {
    // The three Comets are independent contracts; read them concurrently. A revert in
    // one is fatal for the whole adapter — a half-read Compound position would
    // under-report the user's real exposure, which is the failure mode we refuse.
    const results = await Promise.all(COMET_MAINNET_MARKETS.map((m) => readComet(m, user)))
    return results.filter((p): p is ProtocolPosition => p !== null)
  },
}

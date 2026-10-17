/**
 * Compound V3 ("Comet") mainnet.
 *
 * SHAPE: Comet is one contract per BASE asset. Debt is always denominated in that
 * single base token — you cannot borrow anything else — and collateral is a fixed,
 * enumerable list read from `numAssets()` + `getAssetInfo(i)`. That makes enumeration
 * trivial compared with Morpho, but it means one address can hold up to six
 * independent positions (one per Comet), so this adapter returns an array.
 *
 * SCALING CONVENTIONS (Comet.sol):
 *   - `getPrice(priceFeed)` returns the feed's unit at PRICE_SCALE = 1e8 (Chainlink-style):
 *     USD on the stable Comets, ETH / wstETH / BTC on the others (see COMET_MAINNET_MARKETS).
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
import { stamp, type CollateralLeg, type DebtLeg, type LendMarketState, type ProtocolPosition, type SuppliedLeg } from '../types'
import {
  PartialReadError,
  SanityCheckError,
  decimalsFromScale,
  mc,
  optional,
  pinBlock,
  ratio,
  unwrap,
  type Call,
  type LendingAdapter,
} from './types'

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
  // A lender's base supply: balanceOf is the present value, interest included.
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalBorrow', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getSupplyRate',
    stateMutability: 'view',
    inputs: [{ name: 'utilization', type: 'uint256' }],
    outputs: [{ type: 'uint64' }],
  },
  // Negative reserves = bad debt the protocol's reserves no longer cover.
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ type: 'int256' }] },
  {
    type: 'function',
    name: 'totalsBasic',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'baseSupplyIndex', type: 'uint64' },
          { name: 'baseBorrowIndex', type: 'uint64' },
          { name: 'trackingSupplyIndex', type: 'uint64' },
          { name: 'trackingBorrowIndex', type: 'uint64' },
          { name: 'totalSupplyBase', type: 'uint104' },
          { name: 'totalBorrowBase', type: 'uint104' },
          { name: 'lastAccrualTime', type: 'uint40' },
          { name: 'pauseFlags', type: 'uint8' },
        ],
      },
    ],
  },
] as const

const multicall3TsAbi = [
  { type: 'function', name: 'getCurrentBlockTimestamp', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

/** Chainlink-style feed: only its decimals, to check a quote feed's scale. */
const feedAbi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

const erc20Abi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

// ----------------------------------------------------------------- deployments

/** The two base checks every Comet uses but cWBTCv3 (see BASE CHECK below). */
const CONSTANT: BaseCheck = { kind: 'constant' }
const USD_BAND: BaseCheck = { kind: 'band', min: 0.5, max: 2 }

/**
 * The mainnet Comets: every proxy the Compound III Configurator
 * (0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3) has a factory for — its SetFactory events
 * name exactly these six (checked 2026-10-14). Each was checked on-chain the same day:
 * governor() is the Compound Timelock (0x6d903f6003cca6255D85CcA4D3B5E5146dC33925) and
 * Configurator.getConfiguration(comet) names the same base token and base price feed.
 *
 * QUOTE CURRENCY. `Comet.getPrice` returns each feed's own unit, and a Comet's feeds all
 * share one unit, its base feed's:
 *   cUSDCv3, cUSDTv3, cUSDSv3   USD     ("USDC / USD", "ETH / USD", …)
 *   cWETHv3                     ETH     ("wstETH / ETH CAPO", …; base "Constant price feed" = 1)
 *   cwstETHv3                   wstETH  ("rsETH / wstETH CAPO", …; base "Constant price feed" = 1)
 *   cWBTCv3                     BTC     ("LBTC / BTC", …; base "WBTC / BTC" ≈ 0.998)
 * A non-USD Comet's prices are converted at one more feed read through the same Comet's
 * getPrice: Chainlink ETH/USD, Compound's own wstETH/USD CAPO feed (the one cUSDCv3 prices
 * wstETH with), Chainlink BTC/USD — all 8 decimals, checked at read time. Nothing assumed.
 *
 * BASE CHECK. Each Comet's base, priced in its quote unit, must look like that unit: it
 * catches a unit mix-up (a USD feed where ETH was assumed reads ~2,500), never a depeg.
 *   cWETHv3, cwstETHv3   a "Constant price feed": exactly 1e8
 *   USD Comets           0.5–2 (USDC read 0.8833 on cUSDCv3's own feed, 11 Mar 2023)
 *   cWBTCv3              0.5–1.5 (WBTC / BTC)
 * A Comet that fails it is dropped with that message; the other Comets still read.
 */
export const COMET_MAINNET_MARKETS = [
  {
    address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    name: 'cUSDCv3',
    quote: 'USD',
    quoteUsdFeed: null,
    baseCheck: USD_BAND,
  },
  {
    address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
    name: 'cWETHv3',
    quote: 'ETH',
    // Chainlink ETH/USD proxy (the feed membrane-datasets price-history records).
    quoteUsdFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    baseCheck: CONSTANT,
  },
  {
    address: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    name: 'cUSDTv3',
    quote: 'USD',
    quoteUsdFeed: null,
    baseCheck: USD_BAND,
  },
  {
    address: '0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3',
    name: 'cwstETHv3',
    quote: 'wstETH',
    // "wstETH / USD CAPO SVR Price Feed": Compound's wstETH/USD feed in cUSDCv3 and cUSDTv3.
    quoteUsdFeed: '0xA2699232B341881B1Ed85d91592b7c259E029aCf',
    baseCheck: CONSTANT,
  },
  {
    address: '0x5D409e56D886231aDAf00c8775665AD0f9897b56',
    name: 'cUSDSv3',
    quote: 'USD',
    quoteUsdFeed: null,
    baseCheck: USD_BAND,
  },
  {
    address: '0xe85Dc543813B8c2CFEaAc371517b925a166a9293',
    name: 'cWBTCv3',
    quote: 'BTC',
    // Chainlink BTC/USD proxy (the feed membrane-datasets price-history records).
    quoteUsdFeed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    baseCheck: { kind: 'band', min: 0.5, max: 1.5 },
  },
] as const satisfies readonly CometMarket[]

/** How the base, priced in its quote unit, must look (see BASE CHECK above). */
export type BaseCheck = { kind: 'constant' } | { kind: 'band'; min: number; max: number }

export interface CometMarket {
  address: `0x${string}`
  name: string
  /** The unit Comet.getPrice reports for this market's feeds. */
  quote: 'USD' | 'ETH' | 'wstETH' | 'BTC'
  /** A feed giving one quote unit in USD; null when the quote already is USD. */
  quoteUsdFeed: `0x${string}` | null
  baseCheck: BaseCheck
}

/**
 * A Comet price (1e8-scaled, in the market's quote unit) in USD. `quoteUsd` is one quote
 * unit in USD (1 for a USD market). Pure, so the conversion is unit-tested.
 */
export function cometPriceUsd(priceRaw: bigint, quoteUsd: number): number {
  if (!(quoteUsd > 0)) throw new Error('cometPriceUsd: the quote unit has no USD price')
  return toNumber(priceRaw, PRICE_DECIMALS) * quoteUsd
}

/**
 * The check that the quote unit is right, and nothing more: a constant-feed Comet prices
 * its base at exactly 1e8; the others within a band wide enough for any depeg yet ~1,000×
 * short of an ETH or BTC price read as USD. Throws a SanityCheckError, which drops only
 * this Comet.
 */
export function checkBaseInQuote(market: Pick<CometMarket, 'name' | 'quote' | 'baseCheck'>, basePriceRaw: bigint): void {
  const c = market.baseCheck
  const v = toNumber(basePriceRaw, PRICE_DECIMALS)
  if (c.kind === 'constant') {
    if (basePriceRaw !== 10n ** BigInt(PRICE_DECIMALS)) {
      throw new SanityCheckError(`its base priced at ${v} ${market.quote} on a constant feed, expected exactly 1`)
    }
    return
  }
  if (!(v >= c.min && v <= c.max)) {
    throw new SanityCheckError(`its base priced at ${v} ${market.quote}, outside ${c.min}–${c.max}; the quote unit is not ${market.quote}`)
  }
}

/**
 * The adapter's result from every Comet's settled read: positions from the ones that read,
 * a named entry for each one a sanity check dropped. Any other failure (a revert, a missing
 * value) is still fatal: a silently half-read Compound position would under-report.
 */
export function collectComets(
  markets: readonly Pick<CometMarket, 'name'>[],
  settled: PromiseSettledResult<ProtocolPosition | null>[],
): { positions: ProtocolPosition[]; skipped: { market: string; reason: string }[] } {
  const positions: ProtocolPosition[] = []
  const skipped: { market: string; reason: string }[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value) positions.push(r.value)
    } else if (r.reason instanceof SanityCheckError) {
      skipped.push({ market: markets[i].name, reason: r.reason.message })
    } else {
      throw r.reason
    }
  })
  return { positions, skipped }
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

// ------------------------------------------------------------ a lender's Comet

/**
 * The Comet a base-asset supplier lends into, from one block's reads. Pure, so the unit test
 * covers the scaling. Comet rates are per second at 1e18; the supply rate is Comet's own
 * getSupplyRate(getUtilization()), not a derivation. Liquidity is the unborrowed supply.
 * Negative reserves are bad debt the reserves no longer cover: `deficit`.
 */
export function cometLendMarket(input: {
  name: string
  symbol: string
  token: `0x${string}`
  decimals: number
  priceUsd: number
  totalSupplyRaw: bigint
  totalBorrowRaw: bigint
  supplyRatePerSec: bigint | null
  /** The borrow APR this read already annualised. */
  borrowApr: number | null
  reservesRaw: bigint | null
  lastAccrualTime: number
  block: bigint
  blockTs: bigint | null
}): LendMarketState {
  const d = input.decimals
  const totalSupply = toNumber(input.totalSupplyRaw, d)
  const totalBorrow = toNumber(input.totalBorrowRaw, d)
  const perYear = (r: bigint | null) => (r === null ? null : toNumber(r, FACTOR_DECIMALS) * SECONDS_PER_YEAR)
  return {
    venue: 'comet',
    marketName: input.name,
    symbol: input.symbol,
    token: input.token,
    priceUsd: input.priceUsd,
    totalSupply,
    totalBorrow,
    liquidity: input.totalSupplyRaw > input.totalBorrowRaw ? toNumber(input.totalSupplyRaw - input.totalBorrowRaw, d) : 0,
    utilization: totalSupply > 0 ? Math.min(1, totalBorrow / totalSupply) : 0,
    borrowApr: input.borrowApr,
    fee: null,
    supplyApr: perYear(input.supplyRatePerSec),
    aprBasis: 'Comet.getSupplyRate(getUtilization()) per second × a year',
    block: Number(input.block),
    lastUpdate: input.lastAccrualTime,
    blockTs: input.blockTs === null ? null : Number(input.blockTs),
    deficit: input.reservesRaw === null ? null : input.reservesRaw < 0n ? toNumber(-input.reservesRaw, d) : 0,
  }
}

// -------------------------------------------------------------------- adapter

async function readComet(
  client: ReturnType<typeof getMainnetClient>,
  block: bigint,
  market: CometMarket,
  user: `0x${string}`,
): Promise<ProtocolPosition | null> {
  const comet = market.address
  const tag = `compound v3 (${market.name})`

  // --- market shape ---------------------------------------------------------
  const head = await mc<unknown>(
    client,
    [
      { address: comet, abi: cometAbi, functionName: 'borrowBalanceOf', args: [user] },
      { address: comet, abi: cometAbi, functionName: 'baseToken' },
      { address: comet, abi: cometAbi, functionName: 'baseTokenPriceFeed' },
      { address: comet, abi: cometAbi, functionName: 'numAssets' },
      { address: comet, abi: cometAbi, functionName: 'balanceOf', args: [user] },
    ],
    block,
  )
  const borrowRaw = unwrap(head[0], `${tag}: borrowBalanceOf()`) as bigint
  // Comet's base balance is signed: a supplier has no borrow, a borrower no supply.
  const supplyRaw = unwrap(head[4], `${tag}: balanceOf()`) as bigint
  const baseToken = unwrap(head[1], `${tag}: baseToken()`) as `0x${string}`
  const baseFeed = unwrap(head[2], `${tag}: baseTokenPriceFeed()`) as `0x${string}`
  const numAssets = Number(unwrap(head[3], `${tag}: numAssets()`))

  const infoCalls: Call[] = Array.from({ length: numAssets }, (_, i) => ({
    address: comet,
    abi: cometAbi,
    functionName: 'getAssetInfo',
    args: [i],
  }))
  const infoRes = await mc<AssetInfo>(client, infoCalls, block)
  const assets = infoRes.map((entry, i) => unwrap(entry, `${tag}: getAssetInfo(${i})`))

  // --- user collateral ------------------------------------------------------
  const collCalls: Call[] = assets.map((a) => ({
    address: comet,
    abi: cometAbi,
    functionName: 'userCollateral',
    args: [user, a.asset],
  }))
  const collRes = await mc<readonly bigint[]>(client, collCalls, block)
  const balances = assets.map((a, i) => unwrap(collRes[i], `${tag}: userCollateral(${a.asset})`)[0])

  // Nothing supplied and nothing borrowed → this Comet is simply not in use.
  if (borrowRaw === 0n && supplyRaw === 0n && balances.every((b) => b === 0n)) return null

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
  // The quote unit's USD price and its feed's decimals come last so the indices above stay put.
  if (market.quoteUsdFeed) {
    tailCalls.push({ address: comet, abi: cometAbi, functionName: 'getPrice', args: [market.quoteUsdFeed] })
    tailCalls.push({ address: market.quoteUsdFeed, abi: feedAbi, functionName: 'decimals' })
  }
  const tailRes = await mc<unknown>(client, tailCalls, block)
  let quoteUsd = 1
  if (market.quoteUsdFeed) {
    const what = `${tag}: ${market.quote}/USD feed ${market.quoteUsdFeed}`
    const raw = unwrap(tailRes[tailRes.length - 2], `${what} getPrice`) as bigint
    const feedDecimals = Number(unwrap(tailRes[tailRes.length - 1], `${what} decimals()`))
    if (feedDecimals !== PRICE_DECIMALS) throw new SanityCheckError(`${what} has ${feedDecimals} decimals, expected ${PRICE_DECIMALS}`)
    quoteUsd = toNumber(raw, PRICE_DECIMALS)
    if (!(quoteUsd > 0)) throw new SanityCheckError(`${what} returned 0`)
  }

  const basePriceRaw = unwrap(tailRes[0], `${tag}: getPrice(baseTokenPriceFeed ${baseFeed})`) as bigint
  if (basePriceRaw === 0n) throw new SanityCheckError(`base price feed ${baseFeed} returned 0`)
  const baseDecimals = Number(unwrap(tailRes[1], `${tag}: decimals() on base token ${baseToken}`))
  // A symbol is a label, not a number — an unreadable one (e.g. bytes32 symbols) may
  // fall back to the address without violating the no-invented-numbers rule.
  const baseSymbol = (optional(tailRes[2]) as string | null) ?? shortAddress(baseToken)
  // The base is worth about one quote unit (WETH in ETH, WBTC in BTC, USDC in USD); if not,
  // the quote unit above is wrong for this market, so stop rather than misprice.
  checkBaseInQuote(market, basePriceRaw)
  const basePriceUsd = cometPriceUsd(basePriceRaw, quoteUsd)

  // Borrow APR: per-second rate at 1e18, annualised. Optional — null if it fails.
  const utilization = optional(tailRes[3]) as bigint | null
  let borrowApr: number | null = null
  if (utilization !== null) {
    const rateRes = await mc<bigint>(
      client,
      [{ address: comet, abi: cometAbi, functionName: 'getBorrowRate', args: [utilization] }],
      block,
    )
    const perSecond = optional(rateRes[0])
    if (perSecond !== null) borrowApr = toNumber(perSecond, FACTOR_DECIMALS) * SECONDS_PER_YEAR
  }

  // --- a base supplier: the Comet's market state -----------------------------
  let supplied: SuppliedLeg[] = []
  let lendMarket: LendMarketState | null = null
  if (supplyRaw > 0n) {
    const lr = await mc<unknown>(
      client,
      [
        { address: comet, abi: cometAbi, functionName: 'totalSupply' },
        { address: comet, abi: cometAbi, functionName: 'totalBorrow' },
        { address: comet, abi: cometAbi, functionName: 'getReserves' },
        { address: comet, abi: cometAbi, functionName: 'totalsBasic' },
        { address: MULTICALL3, abi: multicall3TsAbi, functionName: 'getCurrentBlockTimestamp' },
        ...(utilization !== null ? [{ address: comet, abi: cometAbi, functionName: 'getSupplyRate', args: [utilization] }] : []),
      ],
      block,
    )
    const supplyPerSec = utilization !== null ? (optional(lr[5]) as bigint | null) : null
    const amount = toNumber(supplyRaw, baseDecimals)
    supplied = [{ symbol: baseSymbol, address: baseToken, decimals: baseDecimals, amount, priceUsd: basePriceUsd, valueUsd: amount * basePriceUsd }]
    const totals = unwrap(lr[3], `${tag}: totalsBasic()`) as { lastAccrualTime: number | bigint }
    lendMarket = cometLendMarket({
      name: market.name,
      symbol: baseSymbol,
      token: baseToken,
      decimals: baseDecimals,
      priceUsd: basePriceUsd,
      totalSupplyRaw: unwrap(lr[0], `${tag}: totalSupply()`) as bigint,
      totalBorrowRaw: unwrap(lr[1], `${tag}: totalBorrow()`) as bigint,
      supplyRatePerSec: supplyPerSec,
      borrowApr,
      reservesRaw: optional(lr[2]) as bigint | null,
      lastAccrualTime: Number(totals.lastAccrualTime),
      block,
      blockTs: optional(lr[4]) as bigint | null,
    })
  }

  // --- assemble legs --------------------------------------------------------
  const collateral: CollateralLeg[] = held.map((h, i) => {
    const priceRaw = unwrap(
      tailRes[4 + i * 2],
      `${tag}: getPrice(${h.info.priceFeed}) for collateral ${h.info.asset}`,
    ) as bigint
    if (priceRaw === 0n) {
      throw new SanityCheckError(`price feed ${h.info.priceFeed} returned 0 for collateral ${h.info.asset}`)
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
    label: supplyRaw > 0n ? `Compound V3 · ${baseSymbol} supply` : `Compound V3 · ${baseSymbol}`,
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
    provenance: {
      ...stamp(
        'onchain',
        `compound v3 · ${rpcLabel()}`,
        `Comet ${comet} (${market.name}), base token ${baseToken}. Prices from Comet.getPrice at 1e8${
          market.quote === 'USD' ? ' (USD feeds)' : `, quoted in ${market.quote} and converted at ${market.quote}/USD $${quoteUsd} (feed ${market.quoteUsdFeed})`
        }; collateral decimals from AssetInfo.scale; borrow/liquidate collateral factors at 1e18. Borrow APR annualised from getBorrowRate(getUtilization()) × ${SECONDS_PER_YEAR}s.${
          supplyRaw > 0n
            ? ` Base supplied (lent): ${supplied[0].amount} ${baseSymbol} from balanceOf; market totals from totalSupply / totalBorrow, supply APR from getSupplyRate(getUtilization()), reserves from getReserves.`
            : ''
        } Every call read block ${block}.`,
      ),
      block: Number(block),
    },
    ...(supplyRaw > 0n && borrowRaw === 0n ? { status: 'supply-only' as const } : {}),
    ...(supplied.length > 0 ? { supplied } : {}),
    ...(lendMarket ? { lendMarket } : {}),
  }
}

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export const compoundV3Adapter: LendingAdapter = {
  id: 'compound-v3',
  label: 'Compound V3',
  async read(user: `0x${string}`): Promise<ProtocolPosition[]> {
    // The Comets are independent contracts; read them concurrently, at one pinned block. A
    // revert in one is fatal for the whole adapter — a half-read Compound position would
    // under-report the user's real exposure, which is the failure mode we refuse. A Comet
    // a sanity check drops is NAMED instead (PartialReadError), and the rest still read.
    const client = getMainnetClient()
    const block = await pinBlock(client)
    const settled = await Promise.allSettled(COMET_MAINNET_MARKETS.map((m) => readComet(client, block, m, user)))
    const { positions, skipped } = collectComets(COMET_MAINNET_MARKETS, settled)
    if (skipped.length > 0) throw new PartialReadError(positions, skipped)
    return positions
  },
}

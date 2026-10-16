/**
 * Morpho Blue mainnet (singleton at 0xBBBB…FFCb).
 *
 * THREE STRUCTURAL PROBLEMS AND HOW THIS FILE HANDLES THEM:
 *
 * 1. NO ENUMERATION. Morpho Blue has no "markets this user is in" view — `position`
 *    is a mapping keyed by (marketId, user) and nothing indexes the reverse. The market
 *    LIST therefore comes from outside (morphoDiscovery.ts): the Morpho API for this
 *    address, or, when the API cannot be asked, the known-market list, which is a PARTIAL
 *    discovery and is reported so (PartialReadError → status 'incomplete' or 'ok' with
 *    `discovery`). The list carries no numbers: every figure below is read on-chain at
 *    the read's one pinned block.
 *
 * 2. ORACLES QUOTE IN LOAN-TOKEN UNITS, NOT USD. `oracle.price()` is scaled
 *    `1e36 + loanDecimals - collateralDecimals`, so
 *        collateralValueInLoanTokenRaw = collateralRaw * price / 1e36
 *    gives the collateral's value denominated in the LOAN token. Turning that into
 *    USD needs the loan token's own USD price, which Morpho does not provide.
 *      - USDC / USDT / DAI loan tokens: assumed $1.00, and that assumption is written
 *        into the position's provenance.detail so it reaches the screen.
 *      - anything else (WETH, USDS, RLUSD, PT-*): priced from the Aave V3 oracle. If
 *        Aave does not list it either, that MARKET is skipped with the reason named
 *        (the others stand). We do not invent a price.
 *
 * 3. INTEREST LIVES ON THE IRM AND ACCRUES LAZILY. `market()` stores totals as of the
 *    market's last touch. The borrow rate is the market IRM's
 *    `borrowRateView(marketParams, market)` (per second, WAD) at the pinned block; the
 *    debt is accrued from `lastUpdate` to the block's timestamp with it, exactly as
 *    Morpho's `_accrueInterest` does before any liquidation (MorphoBalancesLib
 *    expectedMarketBalances). When the rate cannot be read, the debt is the stored one,
 *    the APR is null and the provenance says so.
 *
 * SHARE MATH. `position` stores SHARES. Morpho converts with virtual assets and shares, so
 * an empty market cannot be priced by a donation:
 *     VIRTUAL_ASSETS = 1, VIRTUAL_SHARES = 1e6
 *     borrowed = ceil(shares * (totalBorrowAssets + 1) / (totalBorrowShares + 1e6))
 *     supplied = floor(shares * (totalSupplyAssets + 1) / (totalSupplyShares + 1e6))
 * Debt rounds UP and supply DOWN, in the protocol's favour — reproduced exactly.
 *
 * SUPPLY. An address that only LENDS into a market holds no collateral and owes nothing:
 * it is returned with status 'supply-only' and its `supplied` leg, so the page shows a
 * position with no line rather than "none found".
 */

import type { PublicClient } from 'viem'

import { accrueMarket, toAssetsDown } from '../../curatorFeed/exposure'
import { SECONDS_PER_YEAR } from '../../netApy/fixedPoint'
import { getMainnetClient, rpcLabel, toNumber } from '../rpc'
import {
  stamp,
  type CollateralLeg,
  type DebtLeg,
  type MarketDiscovery,
  type PositionStatus,
  type ProtocolPosition,
  type SuppliedLeg,
} from '../types'
import { aaveOracleUsdPrices } from './aaveV3'
import { createMorphoDiscovery, type DiscoveredMarket } from './morphoDiscovery'
import {
  mc,
  mulDivUp,
  optional,
  PartialReadError,
  pinBlock,
  ratio,
  unwrap,
  type Call,
  type LendingAdapter,
  type MulticallEntry,
} from './types'

// ----------------------------------------------------------------------- ABIs

const marketParamsTuple = {
  type: 'tuple',
  components: [
    { name: 'loanToken', type: 'address' },
    { name: 'collateralToken', type: 'address' },
    { name: 'oracle', type: 'address' },
    { name: 'irm', type: 'address' },
    { name: 'lltv', type: 'uint256' },
  ],
} as const

const marketTuple = {
  type: 'tuple',
  components: [
    { name: 'totalSupplyAssets', type: 'uint128' },
    { name: 'totalSupplyShares', type: 'uint128' },
    { name: 'totalBorrowAssets', type: 'uint128' },
    { name: 'totalBorrowShares', type: 'uint128' },
    { name: 'lastUpdate', type: 'uint128' },
    { name: 'fee', type: 'uint128' },
  ],
} as const

const morphoAbi = [
  {
    // public mapping Id => Position — a Solidity mapping getter returns the struct
    // members as separate values, not a tuple.
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'supplyShares', type: 'uint256' },
      { name: 'borrowShares', type: 'uint128' },
      { name: 'collateral', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: marketTuple.components,
  },
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: marketParamsTuple.components,
  },
] as const

/** IIrm: what Morpho calls to accrue. AdaptiveCurveIrm implements it; so must any IRM. */
const irmAbi = [
  {
    type: 'function',
    name: 'borrowRateView',
    stateMutability: 'view',
    inputs: [
      { name: 'marketParams', ...marketParamsTuple },
      { name: 'market', ...marketTuple },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

const morphoOracleAbi = [
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const erc20Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

const multicall3Abi = [
  {
    type: 'function',
    name: 'getCurrentBlockTimestamp',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'timestamp', type: 'uint256' }],
  },
] as const

// ----------------------------------------------------------------- deployments

export const MORPHO_BLUE_MAINNET = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const
/** Multicall3, the same address on every chain. Read for the pinned block's timestamp. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

/** Morpho oracle price scale, before the loan/collateral decimal adjustment. */
const ORACLE_PRICE_SCALE = 10n ** 36n
/** Morpho's SharesMathLib constants. */
const VIRTUAL_ASSETS = 1n
const VIRTUAL_SHARES = 10n ** 6n
/** lltv and IRM rates are WAD-scaled (1e18). */
const WAD_DECIMALS = 18
/** A market scan is hundreds of 68-byte `position` calls: a few large chunks, not dozens. */
const SCAN_BATCH_BYTES = 8_192

const ZERO = /^0x0{40}$/i

/**
 * Loan tokens we are willing to treat as $1.00. Keyed by ADDRESS, not symbol — symbols
 * from a token or an API could collide. Anything not on this list gets a real oracle read
 * or its market is skipped.
 */
const ASSUMED_ONE_DOLLAR: Record<string, string> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
}

// ------------------------------------------------------------------ helpers

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** An on-chain symbol() if it is a plain short string, else the discovery hint, else the address. */
function symbolOf(entry: MulticallEntry<unknown> | undefined, hint: string | undefined, address: string): string {
  const s = optional(entry)
  if (typeof s === 'string' && /^[\x20-\x7e]{1,32}$/.test(s.trim())) return s.trim()
  return hint ?? short(address)
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`

/** A market-scoped failure: that market is skipped with this reason; the read stands. */
class MarketSkip extends Error {}

// -------------------------------------------------------------------- adapter

export interface MorphoBlueDeps {
  client: () => PublicClient
  /** The fetch discovery uses (the Morpho API and the committed list). */
  fetch: typeof fetch
  now: () => number
  /** USD prices for non-stablecoin loan tokens at the read's block; a missing key = no price. */
  usdPrices: (tokens: `0x${string}`[], block: bigint) => Promise<Record<string, number>>
}

const DEFAULT_DEPS: MorphoBlueDeps = {
  client: getMainnetClient,
  // Called through a wrapper: a bare `window.fetch` reference throws "Illegal invocation".
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  usdPrices: (tokens, block) => aaveOracleUsdPrices(tokens, undefined, undefined, block),
}

export function createMorphoBlueAdapter(overrides: Partial<MorphoBlueDeps> = {}): LendingAdapter {
  const deps: MorphoBlueDeps = { ...DEFAULT_DEPS, ...overrides }
  const discover = createMorphoDiscovery({ fetch: deps.fetch, now: deps.now })

  return {
    id: 'morpho-blue',
    label: 'Morpho Blue',
    async read(user: `0x${string}`): Promise<ProtocolPosition[]> {
      const client = deps.client()
      // The market list carries no numbers, so it is found while the block is pinned. Every
      // call below, the Aave oracle's loan-token price included, reads this one block.
      const [found, block] = await Promise.all([discover(user), pinBlock(client)])
      const discovery: MarketDiscovery = {
        complete: found.complete,
        source: found.source,
        checked: found.markets.length,
        ...(found.reason ? { reason: found.reason } : {}),
      }
      const skipped: { market: string; reason: string }[] = []
      const finish = (positions: ProtocolPosition[]): ProtocolPosition[] => {
        if (skipped.length > 0 || !found.complete) throw new PartialReadError(positions, skipped, discovery)
        return positions
      }

      // --- 1. the address's position in every listed market -------------------
      const posRes = await mc<readonly bigint[]>(
        client,
        found.markets.map((m) => ({
          address: MORPHO_BLUE_MAINNET,
          abi: morphoAbi,
          functionName: 'position',
          args: [m.id, user],
        })),
        block,
        SCAN_BATCH_BYTES,
      )

      const hits: Hit[] = []
      found.markets.forEach((m, i) => {
        // A failed leg means this market was not checked: the scan cannot claim it.
        const p = unwrap(posRes[i], `morpho blue: position(${m.id})`)
        const [supplyShares, borrowShares, collateralRaw] = [p[0], p[1], p[2]]
        if (supplyShares === 0n && borrowShares === 0n && collateralRaw === 0n) return
        hits.push({ m, supplyShares, borrowShares, collateralRaw })
      })
      if (hits.length === 0) return finish([])

      // --- 2. market state + on-chain params for the hits, and the block's time --
      const stateCalls: Call[] = hits.flatMap((h) => [
        { address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'market', args: [h.m.id] },
        { address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'idToMarketParams', args: [h.m.id] },
      ])
      stateCalls.push({ address: MULTICALL3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' })
      const stateRes = await mc<readonly unknown[] | bigint>(client, stateCalls, block)
      const blockTs = optional(stateRes[stateRes.length - 1]) as bigint | null

      const resolved: Resolved[] = []
      hits.forEach((h, i) => {
        const market = optional(stateRes[i * 2]) as readonly bigint[] | null
        const params = optional(stateRes[i * 2 + 1]) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint] | null
        if (!market || !params) {
          const failed = (market ? stateRes[i * 2 + 1] : stateRes[i * 2]) as MulticallEntry<unknown>
          skipped.push({
            market: marketName(h.m, null),
            reason: `${market ? 'idToMarketParams' : 'market'}(${h.m.id}) failed: ${failed?.error?.message ?? 'no result'}`,
          })
          return
        }
        resolved.push({
          ...h,
          words: [market[0], market[1], market[2], market[3], market[4], market[5]],
          loanToken: params[0],
          collateralToken: params[1],
          oracle: params[2],
          irm: params[3],
          lltvRaw: params[4],
          // The on-chain lltv is authoritative; nothing from discovery enters the math.
          lltv: toNumber(params[4], WAD_DECIMALS),
        })
      })

      // --- 3. decimals, symbols, Morpho oracle prices, IRM borrow rates ----------
      const detailCalls: Call[] = []
      const push = (c: Call) => detailCalls.push(c) - 1
      const legs: Legs[] = resolved.map((r) => {
        const hasCollateralToken = !ZERO.test(r.collateralToken)
        // The oracle values collateral, and debt is only ever measured against collateral.
        const needsPrice = hasCollateralToken && (r.collateralRaw > 0n || r.borrowShares > 0n)
        return {
          loanDecimals: push({ address: r.loanToken, abi: erc20Abi, functionName: 'decimals' }),
          loanSymbol: push({ address: r.loanToken, abi: erc20Abi, functionName: 'symbol' }),
          collDecimals: needsPrice ? push({ address: r.collateralToken, abi: erc20Abi, functionName: 'decimals' }) : null,
          collSymbol: hasCollateralToken ? push({ address: r.collateralToken, abi: erc20Abi, functionName: 'symbol' }) : null,
          price: needsPrice ? push({ address: r.oracle, abi: morphoOracleAbi, functionName: 'price' }) : null,
          rate: ZERO.test(r.irm)
            ? null
            : push({
                address: r.irm,
                abi: irmAbi,
                functionName: 'borrowRateView',
                args: [
                  { loanToken: r.loanToken, collateralToken: r.collateralToken, oracle: r.oracle, irm: r.irm, lltv: r.lltvRaw },
                  {
                    totalSupplyAssets: r.words[0],
                    totalSupplyShares: r.words[1],
                    totalBorrowAssets: r.words[2],
                    totalBorrowShares: r.words[3],
                    lastUpdate: r.words[4],
                    fee: r.words[5],
                  },
                ],
              }),
        }
      })
      const detailRes = await mc<unknown>(client, detailCalls, block, SCAN_BATCH_BYTES)

      // --- 4. loan-token USD prices ----------------------------------------------
      // Every loan token we could not assume is $1 must come from a real oracle.
      const needOraclePrice = Array.from(
        new Set(resolved.map((r) => r.loanToken.toLowerCase()).filter((a) => ASSUMED_ONE_DOLLAR[a] === undefined)),
      ) as `0x${string}`[]
      let externalPrices: Record<string, number> = {}
      let externalError: string | null = null
      if (needOraclePrice.length > 0) {
        try {
          externalPrices = await deps.usdPrices(needOraclePrice, block)
        } catch (e) {
          externalError = (e as Error).message
        }
      }

      const positions: ProtocolPosition[] = []
      resolved.forEach((r, i) => {
        const l = legs[i]
        const loanSymbol = symbolOf(detailRes[l.loanSymbol], r.m.loanSymbol, r.loanToken)
        const collateralSymbol =
          l.collSymbol === null ? null : symbolOf(detailRes[l.collSymbol], r.m.collateralSymbol, r.collateralToken)
        const name = marketName(r.m, { loan: loanSymbol, collateral: collateralSymbol, lltv: r.lltv })
        try {
          positions.push(
            buildPosition(r, l, detailRes, {
              loanSymbol,
              collateralSymbol,
              name,
              blockTs,
              block,
              externalPrices,
              externalError,
              discoveryDetail: found.detail,
            }),
          )
        } catch (e) {
          if (!(e instanceof MarketSkip)) throw e
          skipped.push({ market: name, reason: e.message })
        }
      })
      return finish(positions)
    },
  }
}

// ------------------------------------------------------------------ one market

interface Hit {
  m: DiscoveredMarket
  supplyShares: bigint
  borrowShares: bigint
  collateralRaw: bigint
}

interface Resolved extends Hit {
  /** market() as stored: supply assets/shares, borrow assets/shares, lastUpdate, fee. */
  words: bigint[]
  loanToken: `0x${string}`
  collateralToken: `0x${string}`
  oracle: `0x${string}`
  irm: `0x${string}`
  lltvRaw: bigint
  lltv: number
}

/** Indexes into the detail multicall for one market; null where the call was not needed. */
interface Legs {
  loanDecimals: number
  loanSymbol: number
  collDecimals: number | null
  collSymbol: number | null
  price: number | null
  rate: number | null
}

interface BuildContext {
  loanSymbol: string
  collateralSymbol: string | null
  name: string
  blockTs: bigint | null
  block: bigint
  externalPrices: Record<string, number>
  externalError: string | null
  /** The discovery sentence for the provenance. */
  discoveryDetail: string
}

/** One market's position from its reads. Throws MarketSkip for a market-scoped failure. */
function buildPosition(r: Resolved, l: Legs, res: MulticallEntry<unknown>[], ctx: BuildContext): ProtocolPosition {
  const need = <T>(idx: number, what: string): T => {
    const entry = res[idx]
    if (!entry || entry.status === 'failure') {
      throw new MarketSkip(`${what} failed: ${entry?.error?.message ?? 'no result'}`)
    }
    return entry.result as T
  }
  const loanDecimals = Number(need<bigint | number>(l.loanDecimals, `decimals() on loan token ${r.loanToken}`))
  const collateralDecimals =
    l.collDecimals === null ? null : Number(need<bigint | number>(l.collDecimals, `decimals() on collateral token ${r.collateralToken}`))

  // --- borrow rate and accrual: Morpho's own _accrueInterest at this block --------
  const ratePerSec: bigint | null = ZERO.test(r.irm) ? 0n : (optional(res[l.rate as number]) as bigint | null)
  const rateError = l.rate === null ? null : res[l.rate]?.status === 'failure' ? res[l.rate]?.error?.message ?? 'reverted' : null
  const canAccrue = ratePerSec !== null && ctx.blockTs !== null
  const w = canAccrue ? accrueMarket(r.words, ratePerSec as bigint, Number(ctx.blockTs)) : r.words
  const elapsed = ctx.blockTs !== null ? Number(ctx.blockTs - r.words[4]) : null
  const borrowApr = ratePerSec === null ? null : toNumber(ratePerSec * SECONDS_PER_YEAR, WAD_DECIMALS)

  // Debt: shares → assets, rounded up; supply: rounded down. Both with the virtual offsets.
  const debtRaw = r.borrowShares === 0n ? 0n : mulDivUp(r.borrowShares, w[2] + VIRTUAL_ASSETS, w[3] + VIRTUAL_SHARES)
  const suppliedRaw = r.supplyShares === 0n ? 0n : toAssetsDown(r.supplyShares, w[0], w[1])

  // --- loan-token USD price: $1 for the three listed stablecoins, else Aave ---------
  const loanKey = r.loanToken.toLowerCase()
  const stableSymbol = ASSUMED_ONE_DOLLAR[loanKey]
  let loanPriceUsd: number
  if (stableSymbol !== undefined) {
    loanPriceUsd = 1
  } else {
    const p = ctx.externalPrices[loanKey]
    if (p === undefined || !(p > 0)) {
      throw new MarketSkip(
        ctx.externalError !== null
          ? `the Aave V3 oracle read for its loan token ${ctx.loanSymbol} failed: ${ctx.externalError}`
          : `no USD price for its loan token ${ctx.loanSymbol} (${r.loanToken}): Morpho's oracle quotes collateral in loan-token units and the Aave V3 oracle does not list this token. Refusing to assume a price.`,
      )
    }
    loanPriceUsd = p
  }

  // --- collateral, valued by the market's own oracle -------------------------------
  let collateralValueUsd = 0
  let priceRaw: bigint | null = null
  if (l.price !== null) {
    priceRaw = need<bigint>(l.price, `oracle.price() at ${r.oracle}`)
    if (priceRaw === 0n) throw new MarketSkip(`oracle ${r.oracle} returned price 0`)
  }
  const collateralAmount = collateralDecimals === null ? 0 : toNumber(r.collateralRaw, collateralDecimals)
  if (priceRaw !== null && r.collateralRaw > 0n) {
    // collateralRaw * price / 1e36 → collateral value in LOAN-TOKEN raw units.
    const collateralValueLoanRaw = (r.collateralRaw * priceRaw) / ORACLE_PRICE_SCALE
    collateralValueUsd = toNumber(collateralValueLoanRaw, loanDecimals) * loanPriceUsd
  }
  const debtAmount = toNumber(debtRaw, loanDecimals)
  const debtValueUsd = debtAmount * loanPriceUsd

  const collateral: CollateralLeg[] = []
  if (r.collateralRaw > 0n && collateralAmount > 0 && ctx.collateralSymbol !== null) {
    collateral.push({
      symbol: ctx.collateralSymbol,
      address: r.collateralToken,
      decimals: collateralDecimals as number,
      amount: collateralAmount,
      // Derived from the oracle quote, not from a separate price source, so it is
      // exactly the number Morpho itself liquidates against.
      priceUsd: collateralValueUsd / collateralAmount,
      valueUsd: collateralValueUsd,
      // Morpho has ONE line per market: lltv is both the borrow cap and the
      // liquidation line. There is no borrow/liquidation gap.
      liquidationThreshold: r.lltv,
      // Morpho's Liquidation Incentive Factor is a pure function of LLTV:
      //   LIF = min(MAX_LIF, 1 / (1 - CURSOR * (1 - LLTV)))
      // with MAX_LIF = 1.15 and CURSOR = 0.3 (immutable constants, recorded in
      // public/data/oct10-2025/protocols.json). The bonus is LIF - 1.
      liquidationBonus: Math.min(1.15, 1 / (1 - 0.3 * (1 - r.lltv))) - 1,
      maxLtv: r.lltv,
    })
  }

  const debt: DebtLeg[] = []
  if (debtRaw > 0n) {
    debt.push({
      symbol: ctx.loanSymbol,
      address: r.loanToken,
      decimals: loanDecimals,
      amount: debtAmount,
      priceUsd: loanPriceUsd,
      valueUsd: debtValueUsd,
      borrowApr,
    })
  }

  const supplied: SuppliedLeg[] = []
  if (suppliedRaw > 0n) {
    const amount = toNumber(suppliedRaw, loanDecimals)
    supplied.push({
      symbol: ctx.loanSymbol,
      address: r.loanToken,
      decimals: loanDecimals,
      amount,
      priceUsd: loanPriceUsd,
      valueUsd: amount * loanPriceUsd,
    })
  }

  const status: PositionStatus = debtRaw > 0n ? 'borrowing' : r.collateralRaw > 0n ? 'collateral-only' : 'supply-only'
  const rateLine = ZERO.test(r.irm)
    ? 'The market has no IRM (the zero address): Morpho accrues no interest on it, so the borrow rate is 0.'
    : ratePerSec === null
      ? `Borrow rate NOT read: borrowRateView on IRM ${r.irm} failed (${rateError ?? 'no result'}). Debt is as stored at the market's last update, without interest since; the page's accrual buffer uses its fallback rate instead.`
      : `Borrow rate ${pct(borrowApr as number)} APR from IRM ${r.irm} borrowRateView at this block (per-second rate × ${SECONDS_PER_YEAR.toLocaleString('en-US')} s; the average since the market's last update${elapsed !== null ? `, ${elapsed} s earlier` : ''}).`
  const accrualLine =
    ratePerSec === null || ZERO.test(r.irm)
      ? null
      : canAccrue
        ? `Debt and supply include the interest Morpho accrues from that update to this block's timestamp ${ctx.blockTs}, as it does before any liquidation.`
        : "Debt is as stored at the market's last update: the block timestamp was not read, so interest since then is not included."
  const details = [
    `Morpho singleton ${MORPHO_BLUE_MAINNET}, market ${r.m.id}.`,
    `${ctx.discoveryDetail} Every number is read on-chain; lltv ${r.lltv} from idToMarketParams (1e18).`,
    l.price !== null
      ? `Collateral valued via oracle ${r.oracle} (price scale 1e36 adjusted for ${collateralDecimals}/${loanDecimals} decimals), which quotes in ${ctx.loanSymbol}, not USD.`
      : null,
    stableSymbol !== undefined
      ? `ASSUMPTION: loan token ${stableSymbol} treated as exactly $1.00 — Morpho provides no USD price and we did not read one.`
      : `Loan token ${ctx.loanSymbol} priced at $${loanPriceUsd} from the Aave V3 oracle (no assumed peg).`,
    rateLine,
    accrualLine,
    supplied.length > 0
      ? `Supplied (lent, not collateral): ${supplied[0].amount} ${ctx.loanSymbol} from ${r.supplyShares} supply shares; no liquidation touches it.`
      : null,
    `Every call read block ${ctx.block}.`,
  ]
    .filter((x): x is string => x !== null)
    .join(' ')

  return {
    protocol: 'morpho-blue',
    label: `Morpho · ${ctx.name}`,
    marketId: r.m.id,
    collateral,
    debt,
    totalCollateralUsd: collateralValueUsd,
    totalDebtUsd: debtValueUsd,
    ltv: ratio(debtValueUsd, collateralValueUsd),
    liquidationLtv: r.lltv,
    // Morpho exposes no health factor. Derived the way isHealthy() decides:
    // maxBorrow = collateralValue * lltv, HF = maxBorrow / borrowed. No debt: unbounded.
    healthFactor: debtRaw > 0n ? ratio(collateralValueUsd * r.lltv, debtValueUsd) : Number.POSITIVE_INFINITY,
    provenance: { ...stamp('onchain', `morpho blue · ${rpcLabel()}`, details), block: Number(ctx.block) },
    status,
    ...(supplied.length > 0 ? { supplied } : {}),
  }
}

/** "wstETH/USDC 86%"; "USDC idle market" for a market with no collateral token. */
function marketName(
  m: DiscoveredMarket,
  read: { loan: string; collateral: string | null; lltv: number } | null,
): string {
  if (!read) {
    // Not read on-chain: the discovery symbols, if any, and the id.
    return m.collateralSymbol && m.loanSymbol ? `${m.collateralSymbol}/${m.loanSymbol} (${short(m.id)})` : short(m.id)
  }
  if (read.collateral === null) return `${read.loan} idle market`
  const lltvLabel = `${(read.lltv * 100).toFixed(1).replace(/\.0$/, '')}%`
  return `${read.collateral}/${read.loan} ${lltvLabel}`
}

export const morphoBlueAdapter: LendingAdapter = createMorphoBlueAdapter()

/** Exposed for tests / receipts: which pegs the last read leaned on is a fact the UI
 *  may want to summarise across positions. */
export const MORPHO_DOLLAR_ASSUMPTION_NOTE =
  'USDC, USDT and DAI loan tokens are valued at exactly $1.00. Morpho Blue oracles quote collateral in loan-token units only, so a USD figure requires an external price; for these three we assume the peg instead of reading one.'

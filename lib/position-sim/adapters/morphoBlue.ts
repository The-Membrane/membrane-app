/**
 * Morpho Blue mainnet (singleton at 0xBBBB…FFCb).
 *
 * TWO STRUCTURAL PROBLEMS AND HOW THIS FILE HANDLES THEM:
 *
 * 1. NO ENUMERATION. Morpho Blue has no "markets this user is in" view — `position`
 *    is a mapping keyed by (marketId, user) and nothing indexes the reverse. So the
 *    market set has to come from somewhere. We use the committed, measured market
 *    list at public/data/oct10-2025/protocols.json (`morphoBlue.markets`) purely as a
 *    DISCOVERY list, then read every number back on-chain. A market outside that file
 *    is invisible to us; that is a known coverage limit, not a silent zero.
 *
 * 2. ORACLES QUOTE IN LOAN-TOKEN UNITS, NOT USD. `oracle.price()` is scaled
 *    `1e36 + loanDecimals - collateralDecimals`, so
 *        collateralValueInLoanTokenRaw = collateralRaw * price / 1e36
 *    gives the collateral's value denominated in the LOAN token. Turning that into
 *    USD needs the loan token's own USD price, which Morpho does not provide.
 *      - USDC / USDT / DAI loan tokens: assumed $1.00, and that assumption is written
 *        into the position's provenance.detail so it reaches the screen.
 *      - anything else (WETH, USDS, EURCV, PT-*): priced from the Aave V3 oracle. If
 *        Aave does not list it either, we THROW. We do not invent a price.
 *
 * SHARE MATH. `position` stores borrow SHARES. Morpho converts with virtual assets
 * and shares to make the empty-market case safe:
 *     VIRTUAL_ASSETS = 1, VIRTUAL_SHARES = 1e6
 *     assets = ceil(shares * (totalBorrowAssets + 1) / (totalBorrowShares + 1e6))
 * Debt rounds UP, in the protocol's favour — reproduced exactly by `mulDivUp`.
 */

import { getMainnetClient, rpcLabel, toNumber } from '../rpc'
import { stamp, type CollateralLeg, type DebtLeg, type ProtocolPosition } from '../types'
import { aaveOracleUsdPrices } from './aaveV3'
import { mc, mulDivUp, ratio, unwrap, type Call, type LendingAdapter } from './types'

// ----------------------------------------------------------------------- ABIs

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
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'loanToken', type: 'address' },
      { name: 'collateralToken', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'irm', type: 'address' },
      { name: 'lltv', type: 'uint256' },
    ],
  },
] as const

const morphoOracleAbi = [
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const erc20Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

// ----------------------------------------------------------------- deployments

export const MORPHO_BLUE_MAINNET = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const

/** Discovery list. Served statically out of public/ — a plain fetch, no API. */
const MARKET_LIST_URL = '/data/oct10-2025/protocols.json'

/** Morpho oracle price scale, before the loan/collateral decimal adjustment. */
const ORACLE_PRICE_SCALE = 10n ** 36n
/** Morpho's SharesMathLib constants. */
const VIRTUAL_ASSETS = 1n
const VIRTUAL_SHARES = 10n ** 6n
/** lltv is WAD-scaled (1e18). */
const WAD_DECIMALS = 18

/**
 * Loan tokens we are willing to treat as $1.00. Keyed by ADDRESS, not symbol — the
 * symbols in the discovery file are dataset strings and could collide. Anything not
 * on this list gets a real oracle read or an error.
 */
const ASSUMED_ONE_DOLLAR: Record<string, string> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
}

// ------------------------------------------------------------ discovery list

interface MarketListEntry {
  loanSymbol: string
  collateralSymbol: string
  loanToken: string
  collateralToken: string
  oracle: string
  lltvPct: number
}

interface ProtocolsFile {
  morphoBlue?: { markets?: Record<string, MarketListEntry> }
}

async function loadMarketIds(): Promise<{ id: `0x${string}`; entry: MarketListEntry }[]> {
  let res: Response
  try {
    res = await fetch(MARKET_LIST_URL)
  } catch (e) {
    throw new Error(
      `morpho blue: could not fetch the market discovery list ${MARKET_LIST_URL}: ${(e as Error).message}`,
    )
  }
  if (!res.ok) {
    throw new Error(`morpho blue: ${MARKET_LIST_URL} returned HTTP ${res.status}`)
  }
  const json = (await res.json()) as ProtocolsFile
  const markets = json.morphoBlue?.markets
  if (!markets || Object.keys(markets).length === 0) {
    throw new Error(`morpho blue: ${MARKET_LIST_URL} has no morphoBlue.markets — nothing to scan`)
  }
  return Object.entries(markets).map(([id, entry]) => ({ id: id as `0x${string}`, entry }))
}

// -------------------------------------------------------------------- adapter

export const morphoBlueAdapter: LendingAdapter = {
  id: 'morpho-blue',
  label: 'Morpho Blue',
  async read(user: `0x${string}`): Promise<ProtocolPosition[]> {
    const client = getMainnetClient()
    const catalogue = await loadMarketIds()

    // --- scan every known market for this user -------------------------------
    const posCalls: Call[] = catalogue.map((m) => ({
      address: MORPHO_BLUE_MAINNET,
      abi: morphoAbi,
      functionName: 'position',
      args: [m.id, user],
    }))
    const posRes = await mc<readonly bigint[]>(client, posCalls)

    interface Hit {
      id: `0x${string}`
      entry: MarketListEntry
      borrowShares: bigint
      collateralRaw: bigint
    }
    const hits: Hit[] = []
    catalogue.forEach((m, i) => {
      const p = unwrap(posRes[i], `morpho blue: position(${m.id})`)
      const borrowShares = p[1]
      const collateralRaw = p[2]
      if (borrowShares === 0n && collateralRaw === 0n) return
      hits.push({ id: m.id, entry: m.entry, borrowShares, collateralRaw })
    })
    if (hits.length === 0) return []

    // --- market state + on-chain params for the hits --------------------------
    const stateCalls: Call[] = []
    for (const h of hits) {
      stateCalls.push({ address: MORPHO_BLUE_MAINNET, abi: morphoAbi, functionName: 'market', args: [h.id] })
      stateCalls.push({
        address: MORPHO_BLUE_MAINNET,
        abi: morphoAbi,
        functionName: 'idToMarketParams',
        args: [h.id],
      })
    }
    const stateRes = await mc<readonly unknown[]>(client, stateCalls)

    interface Resolved extends Hit {
      totalBorrowAssets: bigint
      totalBorrowShares: bigint
      loanToken: `0x${string}`
      collateralToken: `0x${string}`
      oracle: `0x${string}`
      lltv: number
    }
    const resolved: Resolved[] = hits.map((h, i) => {
      const market = unwrap(stateRes[i * 2], `morpho blue: market(${h.id})`)
      const params = unwrap(stateRes[i * 2 + 1], `morpho blue: idToMarketParams(${h.id})`)
      return {
        ...h,
        totalBorrowAssets: market[2] as bigint,
        totalBorrowShares: market[3] as bigint,
        loanToken: params[0] as `0x${string}`,
        collateralToken: params[1] as `0x${string}`,
        oracle: params[2] as `0x${string}`,
        // The on-chain lltv is authoritative. The file's `lltvPct` is only a
        // discovery hint and is deliberately not used for any math.
        lltv: toNumber(params[4] as bigint, WAD_DECIMALS),
      }
    })

    // --- decimals + Morpho oracle prices --------------------------------------
    const detailCalls: Call[] = []
    for (const r of resolved) {
      detailCalls.push({ address: r.loanToken, abi: erc20Abi, functionName: 'decimals' })
      detailCalls.push({ address: r.collateralToken, abi: erc20Abi, functionName: 'decimals' })
      detailCalls.push({ address: r.oracle, abi: morphoOracleAbi, functionName: 'price' })
    }
    const detailRes = await mc<bigint | number>(client, detailCalls)

    // --- loan-token USD prices ------------------------------------------------
    // Every loan token we could not assume is $1 must come from a real oracle.
    const needOraclePrice = Array.from(
      new Set(
        resolved
          .map((r) => r.loanToken.toLowerCase())
          .filter((addr) => ASSUMED_ONE_DOLLAR[addr] === undefined),
      ),
    ) as `0x${string}`[]
    let externalPrices: Record<string, number> = {}
    if (needOraclePrice.length > 0) {
      try {
        externalPrices = await aaveOracleUsdPrices(needOraclePrice)
      } catch (e) {
        throw new Error(
          `morpho blue: needed the Aave V3 oracle to price non-stablecoin loan tokens (${needOraclePrice.join(', ')}) and that read failed: ${(e as Error).message}`,
        )
      }
    }

    const usedDollarAssumptionFor = new Set<string>()
    const positions: ProtocolPosition[] = []

    resolved.forEach((r, i) => {
      const loanDecimals = Number(unwrap(detailRes[i * 3], `morpho blue: decimals() on loan token ${r.loanToken}`))
      const collateralDecimals = Number(
        unwrap(detailRes[i * 3 + 1], `morpho blue: decimals() on collateral token ${r.collateralToken}`),
      )
      const priceRaw = unwrap(detailRes[i * 3 + 2], `morpho blue: oracle.price() at ${r.oracle}`) as bigint
      if (priceRaw === 0n) {
        throw new Error(`morpho blue: oracle ${r.oracle} returned price 0 for market ${r.id}`)
      }

      // Loan-token USD price: assumed $1 for the three listed stablecoins, otherwise
      // read from Aave. No third branch — a missing price is fatal.
      const loanKey = r.loanToken.toLowerCase()
      const stableSymbol = ASSUMED_ONE_DOLLAR[loanKey]
      let loanPriceUsd: number
      if (stableSymbol !== undefined) {
        loanPriceUsd = 1
        usedDollarAssumptionFor.add(stableSymbol)
      } else {
        const p = externalPrices[loanKey]
        if (p === undefined || !(p > 0)) {
          throw new Error(
            `morpho blue: no USD price for loan token ${r.entry.loanSymbol} (${r.loanToken}) in market ${r.id} — Morpho's oracle only quotes collateral in loan-token units and the Aave V3 oracle does not list this token. Refusing to assume a price.`,
          )
        }
        loanPriceUsd = p
      }

      // collateralRaw * price / 1e36 → collateral value in LOAN-TOKEN raw units.
      const collateralValueLoanRaw = (r.collateralRaw * priceRaw) / ORACLE_PRICE_SCALE
      const collateralAmount = toNumber(r.collateralRaw, collateralDecimals)
      const collateralValueUsd = toNumber(collateralValueLoanRaw, loanDecimals) * loanPriceUsd

      // Debt: shares → assets, rounded up, with Morpho's virtual offsets.
      const debtRaw =
        r.borrowShares === 0n
          ? 0n
          : mulDivUp(
              r.borrowShares,
              r.totalBorrowAssets + VIRTUAL_ASSETS,
              r.totalBorrowShares + VIRTUAL_SHARES,
            )
      const debtAmount = toNumber(debtRaw, loanDecimals)
      const debtValueUsd = debtAmount * loanPriceUsd

      const collateral: CollateralLeg[] = []
      if (r.collateralRaw > 0n && collateralAmount > 0) {
        collateral.push({
          symbol: r.entry.collateralSymbol,
          address: r.collateralToken,
          decimals: collateralDecimals,
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
          symbol: r.entry.loanSymbol,
          address: r.loanToken,
          decimals: loanDecimals,
          amount: debtAmount,
          priceUsd: loanPriceUsd,
          valueUsd: debtValueUsd,
          // Morpho's rate lives on the market's external IRM (adaptive curve), which
          // needs the full MarketParams+Market structs re-encoded to read. Not wired
          // yet — null is the honest answer, a guessed APR is not.
          borrowApr: null,
        })
      }

      const lltvLabel = `${(r.lltv * 100).toFixed(1).replace(/\.0$/, '')}%`
      const details = [
        `Morpho singleton ${MORPHO_BLUE_MAINNET}, market ${r.id}. Market discovered from the committed list ${MARKET_LIST_URL}; every number re-read on-chain. lltv ${r.lltv} read from idToMarketParams (1e18), not from the file.`,
        `Collateral valued via oracle ${r.oracle} (price scale 1e36 adjusted for ${collateralDecimals}/${loanDecimals} decimals), which quotes in ${r.entry.loanSymbol}, not USD.`,
        stableSymbol !== undefined
          ? `ASSUMPTION: loan token ${stableSymbol} treated as exactly $1.00 — Morpho provides no USD price and we did not read one.`
          : `Loan token ${r.entry.loanSymbol} priced at $${loanPriceUsd} from the Aave V3 oracle (no assumed peg).`,
        'Borrow APR not read: it requires the market IRM, which is not wired up.',
      ].join(' ')

      positions.push({
        protocol: 'morpho-blue',
        label: `Morpho · ${r.entry.collateralSymbol}/${r.entry.loanSymbol} ${lltvLabel}`,
        marketId: r.id,
        collateral,
        debt,
        totalCollateralUsd: collateralValueUsd,
        totalDebtUsd: debtValueUsd,
        ltv: ratio(debtValueUsd, collateralValueUsd),
        liquidationLtv: r.lltv,
        // Morpho exposes no health factor. Derived the way isHealthy() decides:
        // maxBorrow = collateralValue * lltv, HF = maxBorrow / borrowed.
        healthFactor: ratio(collateralValueUsd * r.lltv, debtValueUsd),
        provenance: stamp('onchain', `morpho blue · ${rpcLabel()}`, details),
      })
    })

    return positions
  },
}

/** Exposed for tests / receipts: which pegs the last read leaned on is a fact the UI
 *  may want to summarise across positions. */
export const MORPHO_DOLLAR_ASSUMPTION_NOTE =
  'USDC, USDT and DAI loan tokens are valued at exactly $1.00. Morpho Blue oracles quote collateral in loan-token units only, so a USD figure requires an external price; for these three we assume the peg instead of reading one.'

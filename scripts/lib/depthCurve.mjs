// depthCurve.mjs — SLIPPAGE-BOUNDED EXIT CAPACITY for one venue depth market.
//
// Owner ask 2026-09-26: "Is swap-out depth 1:1?" It is not. params.depth_usd
// (venue-reads.mjs readDepthMarkets) is the raw reserve of the swap-INTO token
// at $1 — the ceiling of what a pool holds, not what exits at par. This module
// turns one market into a capacity-vs-cost curve built from ON-CHAIN quotes that
// include the venue's fees:
//
//   cost%(S) = 100 * (1 - valueReceived / valueGiven)
//     valueGiven    = S USD of the held venue token = shares * NAV, where NAV =
//                     ERC-4626 convertToAssets (underlying counted at $1)
//     valueReceived = swap-INTO token out, counted at $1
//
// Routes (market.kind + exitFrom):
//   curve-stableswap, exitFrom = venue token (sUSDe): sell shares directly —
//     get_dy(i, j, shares). No redemption step.
//   curve-stableswap, exitFrom = underlying (scrvUSD): redeem shares instantly
//     (ERC-4626 previewRedeem, which carries any withdraw fee) then sell the
//     underlying — get_dy(i, j, previewRedeem(shares)).
//   psm-buffer (sUSDS): redeem shares -> USDS, then the LitePSM buyGem path at
//     1:1 minus `tout` (WAD fee) up to the gem buffer. Cost is FLAT at the fee
//     up to the buffer; beyond it there is no more capacity.
//
// capacityUsd at level c = the LARGEST S whose cost <= c, found by bisection on
// S in [0, reserveUsd/(1-c)] (reserveUsd = the swap-INTO reserve at $1 — the
// raw depth, kept for reference; at cost c the seller receives S*(1-c), which
// can never exceed that reserve). Assumes cost is non-decreasing in S (true for a
// stableswap sell: each extra unit moves the pool further against the seller).
//
// TOLERANCE: at most MAX_QUOTES_PER_LEVEL (20) quotes per level: one at the
// upper bound, then up to 19 halvings, so the bracket closes to
// (hi - lo) / 2^19 — about $100 on a $50M pool. The reported capacity
// is the LOW (feasible, quoted) end of the bracket, so it is never overstated.
// MONOTONE BY CONSTRUCTION: level k's search starts at level k-1's capacity
// (a size feasible at a lower cost is feasible at a higher one).
// NULLS: a quote that reverts makes THAT level null — never 0 — and the next
// level restarts from the last non-null capacity.
//
// Pure math + read helpers only; no top-level I/O. Every read is pinned to the
// caller's blockNumber.

export const COST_LEVELS_PCT = Object.freeze([0.1, 0.25, 0.5, 1, 2, 5, 10])
export const MAX_QUOTES_PER_LEVEL = 20
const WAD = 10n ** 18n
const MAX_UINT256 = 2n ** 256n - 1n

// --- pure math --------------------------------------------------------------

/** cost in PERCENT; null when either side is not a finite read. Negative = the pool pays above NAV. */
export function costPct(valueGivenUsd, valueReceivedUsd) {
  const g = Number(valueGivenUsd)
  const r = Number(valueReceivedUsd)
  if (!Number.isFinite(g) || !Number.isFinite(r) || g <= 0) return null
  return (1 - r / g) * 100
}

/**
 * Largest S in [lo, hi] with quote(S) <= targetPct, by bisection.
 * quote(S) -> Promise<number|null> (cost %, null = the quote reverted).
 * lo must already be known feasible (0 trivially is).
 * Returns { capacityUsd: number|null, quotes } — null if any quote reverted.
 */
export async function capacityAtCost(
  quote,
  { targetPct, lo = 0, hi, maxQuotes = MAX_QUOTES_PER_LEVEL },
) {
  if (!(hi > 0)) return { capacityUsd: 0, quotes: 0 }
  let quotes = 0
  const atHi = await quote(hi)
  quotes++
  if (atHi === null) return { capacityUsd: null, quotes }
  if (atHi <= targetPct) return { capacityUsd: hi, quotes }
  let a = Math.min(Math.max(lo, 0), hi) // feasible
  let b = hi // infeasible
  while (quotes < maxQuotes) {
    const mid = (a + b) / 2
    const c = await quote(mid)
    quotes++
    if (c === null) return { capacityUsd: null, quotes }
    if (c <= targetPct) a = mid
    else b = mid
  }
  return { capacityUsd: a, quotes }
}

/**
 * The full curve: one point per cost level, each the largest feasible exit.
 * Quotes are memoised by S so shared bisection steps are not re-read.
 */
export async function buildCurve(quote, reserveUsd, levels = COST_LEVELS_PCT) {
  const memo = new Map()
  const q = async (s) => {
    if (!memo.has(s)) memo.set(s, await quote(s))
    return memo.get(s)
  }
  const points = []
  let lo = 0
  let quotes = 0
  for (const level of levels) {
    // At cost c the seller receives S*(1-c) <= reserveUsd, so S can never
    // exceed reserveUsd/(1-c): that is this level's upper bound.
    const hi = level < 100 ? reserveUsd / (1 - level / 100) : reserveUsd
    const r = await capacityAtCost(q, { targetPct: level, lo, hi })
    quotes += r.quotes
    points.push({ costPct: level, capacityUsd: r.capacityUsd })
    if (r.capacityUsd !== null) lo = r.capacityUsd
  }
  return { points, quotes, distinctQuotes: memo.size }
}

/** A flat-fee buffer (PSM): cost is the fee up to the buffer, no capacity beyond. */
export function flatFeeCurve(feePct, bufferUsd, levels = COST_LEVELS_PCT) {
  const ok = Number.isFinite(feePct) && Number.isFinite(bufferUsd)
  return levels.map((level) => ({
    costPct: level,
    capacityUsd: ok ? (feePct <= level ? bufferUsd : 0) : null,
  }))
}

// USD float -> token raw units (bigint), without float blow-up past 2^53.
export function usdToRaw(amount, decimals) {
  if (!Number.isFinite(amount) || amount <= 0) return 0n
  const micro = BigInt(Math.floor(amount * 1e6))
  return decimals >= 6 ? micro * 10n ** BigInt(decimals - 6) : micro / 10n ** BigInt(6 - decimals)
}
export const rawToNum = (raw, decimals) => Number(raw) / 10 ** decimals

// --- read helpers ------------------------------------------------------------

const fn = (name, inputs, outputs) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs: inputs.map((type) => ({ type })),
  outputs: outputs.map((type) => ({ type })),
})
const ABI = {
  coins: [fn('coins', ['uint256'], ['address'])],
  balances: [fn('balances', ['uint256'], ['uint256'])],
  fee: [fn('fee', [], ['uint256'])],
  getDy: [fn('get_dy', ['int128', 'int128', 'uint256'], ['uint256'])],
  decimals: [fn('decimals', [], ['uint8'])],
  symbol: [fn('symbol', [], ['string'])],
  balanceOf: [fn('balanceOf', ['address'], ['uint256'])],
  asset: [fn('asset', [], ['address'])],
  convertToAssets: [fn('convertToAssets', ['uint256'], ['uint256'])],
  previewRedeem: [fn('previewRedeem', ['uint256'], ['uint256'])],
  tout: [fn('tout', [], ['uint256'])],
  gem: [fn('gem', [], ['address'])],
  pocket: [fn('pocket', [], ['address'])],
  psm: [fn('psm', [], ['address'])],
  usds: [fn('usds', [], ['address'])],
}

async function read(client, address, key, args, blockNumber) {
  try {
    return await client.readContract({
      address,
      abi: ABI[key],
      functionName: ABI[key][0].name,
      args,
      blockNumber,
    })
  } catch {
    return undefined
  }
}

/**
 * The venue token's NAV and instant-redeem ratio at the block.
 * navUsd = convertToAssets(1 share) (underlying at $1). redeemRatio =
 * previewRedeem / convertToAssets (1 when the vault charges no withdraw fee).
 */
export async function readVenueNav(client, venue, blockNumber) {
  const shareDecimals = await read(client, venue.address, 'decimals', [], blockNumber)
  const asset = await read(client, venue.address, 'asset', [], blockNumber)
  const underlyingDecimals = await read(client, venue.underlying, 'decimals', [], blockNumber)
  const dec = Number(shareDecimals)
  const underlyingDec = Number(underlyingDecimals)
  if (
    shareDecimals === undefined ||
    underlyingDecimals === undefined ||
    !Number.isInteger(dec) ||
    !Number.isInteger(underlyingDec) ||
    dec < 0 ||
    dec > 36 ||
    underlyingDec < 0 ||
    underlyingDec > 36 ||
    asset === undefined ||
    lc(asset) !== lc(venue.underlying) ||
    dec !== venue.decimals
  )
    return null
  const one = 10n ** BigInt(dec)
  const assets = await read(client, venue.address, 'convertToAssets', [one], blockNumber)
  const preview = await read(client, venue.address, 'previewRedeem', [one], blockNumber)
  if (assets === undefined || assets <= 0n) return null
  const navUsd = rawToNum(assets, underlyingDec)
  const redeemRatio = preview !== undefined && assets > 0n ? Number(preview) / Number(assets) : null
  if (!Number.isFinite(navUsd) || navUsd <= 0) return null
  if (redeemRatio !== null && (!Number.isFinite(redeemRatio) || redeemRatio <= 0)) return null
  return { navUsd, redeemRatio, decimals: dec, underlyingDecimals: underlyingDec }
}

const lc = (a) => String(a ?? '').toLowerCase()

/**
 * Curve stableswap(-ng) market -> curve. Confirms coins(i) order ON-CHAIN (the
 * config's token0/token1 are not trusted for indices), reads decimals, and
 * quotes get_dy(int128 i, int128 j, dx) with i = exitFrom's index.
 */
export async function readCurveMarketCurve(client, venue, market, nav, blockNumber, symbols = {}) {
  const c0 = await read(client, market.address, 'coins', [0n], blockNumber)
  const c1 = await read(client, market.address, 'coins', [1n], blockNumber)
  if (c0 === undefined || c1 === undefined) return { error: 'coins() read failed' }
  if (lc(c0) !== lc(market.token0) || lc(c1) !== lc(market.token1))
    return { error: 'coins() differ from configured route tokens' }
  if (lc(market.exitFrom) !== lc(venue.address) && lc(market.exitFrom) !== lc(venue.underlying))
    return { error: 'exitFrom is not the vault share or underlying asset' }
  let i
  if (lc(c0) === lc(market.exitFrom)) i = 0
  else if (lc(c1) === lc(market.exitFrom)) i = 1
  else return { error: `exitFrom ${market.exitFrom} is neither coins(0) nor coins(1)` }
  const j = 1 - i
  const coinIn = i === 0 ? c0 : c1
  const coinOut = j === 0 ? c0 : c1
  const decInRaw = await read(client, coinIn, 'decimals', [], blockNumber)
  const decOutRaw = await read(client, coinOut, 'decimals', [], blockNumber)
  const decIn = Number(decInRaw)
  const decOut = Number(decOutRaw)
  if (
    decInRaw === undefined ||
    decOutRaw === undefined ||
    !Number.isInteger(decIn) ||
    !Number.isInteger(decOut) ||
    decIn < 0 ||
    decIn > 36 ||
    decOut < 0 ||
    decOut > 36
  )
    return { error: 'pool token decimals read failed' }
  const symIn =
    symbols[lc(coinIn)] ?? (await read(client, coinIn, 'symbol', [], blockNumber)) ?? 'in'
  const symOut =
    symbols[lc(coinOut)] ?? (await read(client, coinOut, 'symbol', [], blockNumber)) ?? 'out'
  const resOut = await read(client, market.address, 'balances', [BigInt(j)], blockNumber)
  const feeRaw = await read(client, market.address, 'fee', [], blockNumber)
  if (resOut === undefined) return { error: 'balances(j) read failed' }
  const reserveUsd = rawToNum(resOut, decOut)

  const sellsVenueToken = lc(market.exitFrom) === lc(venue.address)
  if (!nav || !Number.isFinite(nav.navUsd) || nav.navUsd <= 0)
    return { error: 'venue NAV (convertToAssets) invalid' }
  if (!sellsVenueToken && nav.redeemRatio === null) return { error: 'previewRedeem read failed' }
  if (!sellsVenueToken && (!Number.isFinite(nav.redeemRatio) || nav.redeemRatio <= 0))
    return { error: 'previewRedeem ratio invalid' }
  // S USD of the venue token -> units of coinIn handed to the pool.
  const unitsIn = (s) => (sellsVenueToken ? s / nav.navUsd : s * nav.redeemRatio)

  const quote = async (s) => {
    const dx = usdToRaw(unitsIn(s), decIn)
    if (dx === 0n) return s === 0 ? 0 : null
    const dy = await read(client, market.address, 'getDy', [BigInt(i), BigInt(j), dx], blockNumber)
    if (dy === undefined) return null
    return costPct(s, rawToNum(dy, decOut))
  }
  const curve = await buildCurve(quote, reserveUsd)
  const poolFeeBps = feeRaw !== undefined ? Number(feeRaw) / 1e6 : null // curve fee is 1e10-scaled
  const route = sellsVenueToken
    ? `sell ${venue.name} → ${symOut} in Curve ${market.name}; ${symOut} counted at $1`
    : `redeem ${venue.name} → ${symIn} instantly (ERC-4626), then sell ${symIn} → ${symOut} in Curve ${market.name}; ${symOut} counted at $1`
  return {
    points: curve.points,
    meta: {
      navUsd: nav.navUsd,
      redeemRatio: sellsVenueToken ? null : nav.redeemRatio,
      poolFee: feeRaw !== undefined ? feeRaw.toString() : null,
      poolFeeBps,
      reserveUsd,
      route,
      source: 'curve get_dy',
      pool: market.address,
      coinIndexIn: i,
      coinIndexOut: j,
      quotes: curve.quotes,
      distinctQuotes: curve.distinctQuotes,
      tolerance: `bisection ≤${MAX_QUOTES_PER_LEVEL} quotes/level; bracket ≤ (reserveUsd/(1-c))/2^${MAX_QUOTES_PER_LEVEL - 1}; capacity = feasible (low) end`,
    },
  }
}

/**
 * Sky LitePSM buffer -> flat-fee curve. tout is WAD-scaled; paying gemAmt out
 * costs gemAmt*(1+tout) of USDS, so cost = 1 - redeemRatio/(1+tout).
 * uint256.max is the LitePSM HALTED sentinel. A WAD fee is 100%, not the halt sentinel.
 */
export async function readPsmMarketCurve(client, venue, market, nav, blockNumber) {
  if (typeof market.wrapper !== 'string' || !market.wrapper)
    return { error: 'USDS PSM wrapper address missing' }
  const wrapperPsm = await read(client, market.wrapper, 'psm', [], blockNumber)
  const wrapperPocket = await read(client, market.wrapper, 'pocket', [], blockNumber)
  const wrapperUsds = await read(client, market.wrapper, 'usds', [], blockNumber)
  if (wrapperPsm === undefined || lc(wrapperPsm) !== lc(market.address))
    return { error: 'wrapper psm() missing or differs from configured PSM' }
  if (wrapperPocket === undefined || lc(wrapperPocket) !== lc(market.buffer))
    return { error: 'wrapper pocket() missing or differs from configured buffer' }
  if (
    wrapperUsds === undefined ||
    lc(wrapperUsds) !== lc(venue.underlying) ||
    lc(wrapperUsds) !== lc(market.exitFrom)
  )
    return { error: 'wrapper usds() missing or differs from vault underlying' }
  const tout = await read(client, market.address, 'tout', [], blockNumber)
  const gem = await read(client, market.address, 'gem', [], blockNumber)
  const pocket = await read(client, market.address, 'pocket', [], blockNumber)
  if (typeof tout !== 'bigint' || (tout > WAD && tout !== MAX_UINT256))
    return { error: 'tout() read failed or invalid fee' }
  if (gem === undefined || lc(gem) !== lc(market.bufferToken))
    return { error: 'gem() missing or differs from configured buffer token' }
  if (pocket === undefined || lc(pocket) !== lc(market.buffer))
    return { error: 'pocket() missing or differs from configured buffer' }
  if (lc(market.exitFrom) !== lc(venue.underlying))
    return { error: 'PSM exitFrom is not the vault underlying asset' }
  const decRaw = await read(client, market.bufferToken, 'decimals', [], blockNumber)
  const decB = Number(decRaw)
  if (decRaw === undefined || !Number.isInteger(decB) || decB < 0 || decB > 36)
    return { error: 'buffer token decimals read failed' }
  const bal = await read(client, market.bufferToken, 'balanceOf', [market.buffer], blockNumber)
  if (bal === undefined) return { error: 'buffer balanceOf read failed' }
  const bufferOutUsd = rawToNum(bal, decB)
  const halted = tout === MAX_UINT256
  const toutFrac = halted ? Infinity : Number(tout) / 1e18
  const redeemRatio = nav?.redeemRatio ?? null
  if (redeemRatio === null || !Number.isFinite(redeemRatio) || redeemRatio <= 0)
    return { error: 'previewRedeem ratio invalid' }
  const feePct = halted ? Infinity : (1 - redeemRatio / (1 + toutFrac)) * 100
  // Value given (venue USD) that drains the buffer exactly.
  const bufferGivenUsd = halted ? 0 : (bufferOutUsd * (1 + toutFrac)) / redeemRatio
  const points = halted
    ? COST_LEVELS_PCT.map((costPct) => ({ costPct, capacityUsd: 0 }))
    : flatFeeCurve(feePct, bufferGivenUsd)
  return {
    points,
    meta: {
      navUsd: nav.navUsd,
      redeemRatio,
      tout: tout.toString(),
      feeBps: halted ? null : toutFrac * 1e4,
      halted,
      reserveUsd: bufferOutUsd,
      route: `redeem ${venue.name} → USDS, then use the Sky USDS wrapper buyGem route through the shared DAI/USDC LitePSM to receive USDC; the USDC Pocket balance is shared and may change before execution`,
      source: 'psm tout',
      wrapper: market.wrapper,
      psm: market.address,
      buffer: market.buffer,
    },
  }
}

/** Dispatch one enabled market. Returns {points, meta} or {error}. */
export async function readMarketCurve(client, venue, market, blockNumber, nav) {
  const n = nav === undefined ? await readVenueNav(client, venue, blockNumber) : nav
  if (market.kind === 'curve-stableswap')
    return readCurveMarketCurve(client, venue, market, n, blockNumber)
  if (market.kind === 'psm-buffer') return readPsmMarketCurve(client, venue, market, n, blockNumber)
  return { error: `no curve reader for kind '${market.kind}'` }
}

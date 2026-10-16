/**
 * Morpho Blue market discovery: WHICH markets to read for an address. Nothing else.
 *
 * Morpho Blue cannot enumerate an address's markets on-chain (`position` is a mapping keyed
 * by market id and user, and nothing indexes the reverse), so the market LIST comes from
 * outside. Only the list does: morphoBlue.ts re-reads every number on-chain at the read's
 * one pinned block, and a market the list names but the address does not hold reads zero.
 *
 *   1. Morpho's keyless API (MORPHO_API_URL, `userByAddress(address, chainId: 1)
 *      { marketPositions { market { marketId } } }` — the live schema names it `marketId`,
 *      not `uniqueKey`): every market the address has touched, open ones first, up to
 *      MORPHO_MAX_MARKETS. Complete unless the cap cut an open market.
 *   2. When the API fails, times out or rate-limits: the KNOWN-MARKET LIST — the committed
 *      Oct 10 2025 list (public/data/oct10-2025/protocols.json) plus every market id in the
 *      curator exposure snapshot (morphoMarkets.generated.json, ids only — board rule N18).
 *      That is PARTIAL discovery, and it is named so: a position in any other market would
 *      not show, so the page never says "no position found" on it.
 *
 * RATE LIMIT. The API allows 750 requests a minute, then answers 429 and expects a
 * ten-minute pause. One read is one request. After a 429 the discoverer does not ask again
 * until the pause (or a longer Retry-After) has passed; every read meanwhile is a named
 * partial discovery.
 */

import generated from './morphoMarkets.generated.json'

/** Morpho's public GraphQL endpoint. Keyless; CORS allows any origin. */
export const MORPHO_API_URL = 'https://blue-api.morpho.org/graphql'
/** A discovery request that has not answered by then is a failure, not a wait. */
export const MORPHO_API_TIMEOUT_MS = 8_000
/** The API's own pause after a 429. A larger Retry-After wins. */
export const MORPHO_API_BACKOFF_MS = 10 * 60_000
/** At most this many markets are read per address. A cut OPEN market makes discovery partial. */
export const MORPHO_MAX_MARKETS = 64

/** The committed Oct 10 2025 market list. Served statically out of public/. */
export const COMMITTED_MARKET_LIST_URL = '/data/oct10-2025/protocols.json'

const MAINNET_CHAIN_ID = 1
/** The mainnet singleton (morphoBlue.ts MORPHO_BLUE_MAINNET), lowercased to compare. */
const MORPHO_SINGLETON = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'

const QUERY = `query MembraneMorphoMarkets($address: String!, $chainId: Int!) {
  userByAddress(address: $address, chainId: $chainId) {
    marketPositions {
      market { marketId morphoBlue { address } loanAsset { symbol } collateralAsset { symbol } }
      state { supplyShares borrowShares collateral }
    }
  }
}`

// ------------------------------------------------------------------ types

/** One market to read, with the display symbols discovery happened to carry (labels only). */
export interface DiscoveredMarket {
  id: `0x${string}`
  loanSymbol?: string
  collateralSymbol?: string
}

export interface Discovered {
  markets: DiscoveredMarket[]
  /** False when a market the address may hold was not listed: the read is partial. */
  complete: boolean
  /** "Morpho API" or "known-market list", for the status line and the provenance. */
  source: string
  /** Why discovery is partial, verbatim. Absent when complete. */
  reason?: string
  /** One sentence for the provenance detail: where the list came from, as of when. */
  detail: string
}

export interface DiscoveryDeps {
  fetch: typeof fetch
  now: () => number
  timeoutMs?: number
}

// ------------------------------------------------------------------ the generated list

interface GeneratedList {
  source: { path: string; block: number; ts: number }
  markets: string[]
}

const GENERATED = generated as GeneratedList

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/** The curator exposure snapshot's market ids, lowercased. */
export const EXPOSURE_MARKET_IDS: readonly `0x${string}`[] = GENERATED.markets
  .filter((id) => BYTES32.test(id))
  .map((id) => id.toLowerCase() as `0x${string}`)

/** "the curator exposure snapshot (block 26170792, 2026-10-11)" */
export const EXPOSURE_SNAPSHOT_LABEL = `the curator exposure snapshot (block ${GENERATED.source.block}, ${new Date(
  GENERATED.source.ts * 1000,
)
  .toISOString()
  .slice(0, 10)})`

// ------------------------------------------------------------------ the API

interface ApiMarketPosition {
  market?: {
    marketId?: string | null
    morphoBlue?: { address?: string | null } | null
    loanAsset?: { symbol?: string | null } | null
    collateralAsset?: { symbol?: string | null } | null
  } | null
  state?: {
    supplyShares?: string | number | null
    borrowShares?: string | number | null
    collateral?: string | number | null
  } | null
}

interface ApiResponse {
  data?: { userByAddress?: { marketPositions?: ApiMarketPosition[] | null } | null } | null
  errors?: { message?: string }[]
}

/** A BigInt scalar as the API sends it (0, or a decimal string). Unparseable → "maybe". */
function nonZero(v: string | number | null | undefined): boolean | null {
  if (v === null || v === undefined) return null
  try {
    return BigInt(String(v)) > 0n
  } catch {
    return null
  }
}

/** Open = the API's own state shows a share, a borrow or collateral (or cannot say). */
function isOpen(p: ApiMarketPosition): boolean {
  const s = p.state
  if (!s) return true
  const flags = [nonZero(s.supplyShares), nonZero(s.borrowShares), nonZero(s.collateral)]
  return flags.some((f) => f !== false)
}

const borrowing = (p: ApiMarketPosition) => nonZero(p.state?.borrowShares) !== false
const posted = (p: ApiMarketPosition) => nonZero(p.state?.collateral) !== false

export class MorphoApiError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'MorphoApiError'
  }
}

/** Rejects with a MorphoApiError when `run` has not settled in `ms`; aborts the request. */
function withTimeout<T>(run: (signal: AbortSignal | undefined) => Promise<T>, ms: number): Promise<T> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      controller?.abort()
      reject(new MorphoApiError(`no answer in ${ms / 1000} s`))
    }, ms)
    run(controller?.signal).then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** One request; a 429 carries its Retry-After. Throws MorphoApiError, else the parsed body. */
async function post(user: `0x${string}`, deps: DiscoveryDeps, signal: AbortSignal | undefined) {
  let res: Response
  try {
    res = await deps.fetch(MORPHO_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { address: user, chainId: MAINNET_CHAIN_ID } }),
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    throw new MorphoApiError(`request failed: ${(e as Error).message}`)
  }
  if (res.status === 429) {
    const header = Number(res.headers?.get?.('retry-after') ?? NaN)
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : null
    throw new MorphoApiError('HTTP 429, rate-limited', retryAfterMs)
  }
  if (!res.ok) throw new MorphoApiError(`HTTP ${res.status}`)
  try {
    return (await res.json()) as ApiResponse
  } catch (e) {
    throw new MorphoApiError(`unreadable response: ${(e as Error).message}`)
  }
}

/** Asks the API once. Throws MorphoApiError naming the failure; never returns a guess. */
export async function fetchApiMarkets(
  user: `0x${string}`,
  deps: DiscoveryDeps,
): Promise<{ markets: DiscoveredMarket[]; total: number; open: number; cutOpen: number; cutClosed: number }> {
  const body = await withTimeout((signal) => post(user, deps, signal), deps.timeoutMs ?? MORPHO_API_TIMEOUT_MS)
  // A GraphQL error, even beside some data, may mean missing positions: not a full list.
  if (body.errors && body.errors.length > 0) {
    throw new MorphoApiError(`GraphQL error: ${body.errors.map((x) => x.message ?? '?').join('; ')}`)
  }
  const list = body.data?.userByAddress?.marketPositions
  if (!Array.isArray(list)) throw new MorphoApiError('response has no userByAddress.marketPositions')

  // Mainnet singleton only; one entry per market id.
  const seen = new Set<string>()
  const usable: ApiMarketPosition[] = []
  for (const p of list) {
    const id = p.market?.marketId
    if (!id || !BYTES32.test(id)) continue
    const singleton = p.market?.morphoBlue?.address
    if (singleton && singleton.toLowerCase() !== MORPHO_SINGLETON) continue
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    usable.push(p)
  }
  // Open positions first, borrowers first among them, then collateral, then the rest.
  const rank = (p: ApiMarketPosition) => (!isOpen(p) ? 3 : borrowing(p) ? 0 : posted(p) ? 1 : 2)
  const ordered = usable
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p)
  const kept = ordered.slice(0, MORPHO_MAX_MARKETS)
  const cut = ordered.slice(MORPHO_MAX_MARKETS)
  return {
    markets: kept.map((p) => ({
      id: (p.market?.marketId as string).toLowerCase() as `0x${string}`,
      ...(p.market?.loanAsset?.symbol ? { loanSymbol: p.market.loanAsset.symbol } : {}),
      ...(p.market?.collateralAsset?.symbol ? { collateralSymbol: p.market.collateralAsset.symbol } : {}),
    })),
    total: usable.length,
    open: usable.filter(isOpen).length,
    cutOpen: cut.filter(isOpen).length,
    cutClosed: cut.filter((p) => !isOpen(p)).length,
  }
}

// ------------------------------------------------------------------ the fallback

interface ProtocolsFile {
  morphoBlue?: { markets?: Record<string, { loanSymbol?: string; collateralSymbol?: string }> }
}

/** The committed Oct 10 2025 list, or the reason it could not be read. */
async function committedMarkets(deps: DiscoveryDeps): Promise<{ markets: DiscoveredMarket[] } | { error: string }> {
  try {
    const res = await deps.fetch(COMMITTED_MARKET_LIST_URL)
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const json = (await res.json()) as ProtocolsFile
    const markets = json.morphoBlue?.markets
    if (!markets || Object.keys(markets).length === 0) return { error: 'no morphoBlue.markets in it' }
    return {
      markets: Object.entries(markets)
        .filter(([id]) => BYTES32.test(id))
        .map(([id, m]) => ({
          id: id.toLowerCase() as `0x${string}`,
          ...(m.loanSymbol ? { loanSymbol: m.loanSymbol } : {}),
          ...(m.collateralSymbol ? { collateralSymbol: m.collateralSymbol } : {}),
        })),
    }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** The known-market list: committed ∪ exposure snapshot, committed symbols kept. */
export async function knownMarkets(deps: DiscoveryDeps): Promise<{ markets: DiscoveredMarket[]; note: string }> {
  const committed = await committedMarkets(deps)
  const byId = new Map<string, DiscoveredMarket>()
  if ('markets' in committed) for (const m of committed.markets) byId.set(m.id, m)
  for (const id of EXPOSURE_MARKET_IDS) if (!byId.has(id)) byId.set(id, { id })
  const note =
    'markets' in committed
      ? `the committed Oct 10 2025 list (${committed.markets.length}) and ${EXPOSURE_SNAPSHOT_LABEL}`
      : `${EXPOSURE_SNAPSHOT_LABEL} only — the committed list ${COMMITTED_MARKET_LIST_URL} failed: ${committed.error}`
  return { markets: [...byId.values()], note }
}

// ------------------------------------------------------------------ the discoverer

/**
 * One discoverer per adapter instance: it remembers a 429 so the next read does not ask
 * again inside the API's pause.
 */
export function createMorphoDiscovery(deps: DiscoveryDeps) {
  let pausedUntil = 0

  const fallback = async (why: string): Promise<Discovered> => {
    const known = await knownMarkets(deps)
    return {
      markets: known.markets,
      complete: false,
      source: 'known-market list',
      reason: `Morpho API ${why}`,
      detail: `Markets from the known-market list — ${known.note}, ${known.markets.length} in all — because the Morpho API ${why}. Discovery is partial: a position in any other Morpho market would not show.`,
    }
  }

  return async function discover(user: `0x${string}`): Promise<Discovered> {
    const now = deps.now()
    if (now < pausedUntil) {
      const at = new Date(pausedUntil).toISOString().slice(11, 16)
      return fallback(`is paused after a rate limit until ${at} UTC`)
    }
    try {
      const api = await fetchApiMarkets(user, deps)
      const at = new Date(deps.now()).toISOString().slice(11, 16)
      const cutNote =
        api.cutOpen + api.cutClosed > 0
          ? ` The API lists ${api.total} markets; the ${api.markets.length} read are capped at ${MORPHO_MAX_MARKETS}, open positions first.`
          : ''
      if (api.cutOpen > 0) {
        return {
          markets: api.markets,
          complete: false,
          source: 'Morpho API',
          reason: `${api.cutOpen} more open markets past the cap of ${MORPHO_MAX_MARKETS}`,
          detail: `Markets from the Morpho API (${MORPHO_API_URL}) at ${at} UTC.${cutNote} Discovery is partial: ${api.cutOpen} open markets were not read.`,
        }
      }
      return {
        markets: api.markets,
        complete: true,
        source: 'Morpho API',
        detail: `Markets from the Morpho API (${MORPHO_API_URL}) at ${at} UTC: ${api.total} the address has touched, ${api.open} open by the API's index.${cutNote}`,
      }
    } catch (e) {
      const err = e instanceof MorphoApiError ? e : new MorphoApiError((e as Error).message)
      if (err.retryAfterMs !== null || /HTTP 429/.test(err.message)) {
        pausedUntil = deps.now() + Math.max(MORPHO_API_BACKOFF_MS, err.retryAfterMs ?? 0)
      }
      return fallback(`failed: ${err.message}`)
    }
  }
}

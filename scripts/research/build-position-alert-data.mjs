/**
 * build-position-alert-data.mjs — the measured inputs for the position-alert back-test.
 *
 *   node scripts/research/build-position-alert-data.mjs [--only=hourly,e2,e3,e4,depeg,e2stream,e1l2]
 *
 * Writes position-alerts/*.json and a manifest with each file's SHA-256 into the private
 * datasets repo ($MEMBRANE_DATASETS_DIR, default ../membrane-datasets; board rule N18). Every value
 * is copied from a public, keyless source. Nothing is smoothed or forward-filled: a gap is
 * stored as null (grid series) or simply absent (point series).
 *
 * Sources (all keyless):
 *   Binance public market-data mirror  data-api.binance.vision/api/v3/klines   ETH/BTC vs USDT
 *   DefiLlama coins API                coins.llama.fi/chart                     depeg series
 *   Morpho Blue API                    blue-api.morpho.org/graphql              liquidations + positions
 *   Keyless archive RPCs (rotated)     Tenderly / dRPC / Blast / MEV Blocker / Nodies   archive eth_call
 *
 * E1 (Oct 10 2025) is NOT fetched here: it is oct10-2025/ in the datasets repo, with its own
 * provenance (the app serves a copy at public/data/oct10-2025/). This script never reads .env.local and needs no key.
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { datasetPath } from '../lib/datasetsDir.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// Board rule N18: the data lives in the private datasets repo, never in this public repo.
const OUT = datasetPath(ROOT, 'position-alerts')

const BINANCE = 'https://data-api.binance.vision/api/v3/klines'
const LLAMA = 'https://coins.llama.fi/chart'
const MORPHO = 'https://blue-api.morpho.org/graphql'

const H = 3600
const iso = (s) => new Date(s * 1000).toISOString()
const ts = (isoStr) => Math.floor(Date.parse(isoStr) / 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url, init, tries = 8) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init)
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      return j
    } catch (e) {
      lastErr = e
      await sleep(Math.min(30_000, 1500 * 2 ** i))
    }
  }
  throw new Error(`fetch failed after ${tries} tries: ${url.split('?')[0]} — ${lastErr}`)
}

// ------------------------------------------------------------------ Binance klines

/**
 * Klines on a fixed grid [start, end). Returns columnar close/low (and high for hourly).
 * A bar Binance did not print (exchange outage) stays null.
 */
async function klines(symbol, interval, stepS, start, end, withHigh = false) {
  const count = Math.floor((end - start) / stepS)
  const close = new Array(count).fill(null)
  const low = new Array(count).fill(null)
  const high = withHigh ? new Array(count).fill(null) : null
  let cursor = start
  while (cursor < end) {
    const url = `${BINANCE}?symbol=${symbol}&interval=${interval}&startTime=${cursor * 1000}&endTime=${end * 1000 - 1}&limit=1000`
    const rows = await getJson(url)
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const k of rows) {
      const t = Math.floor(k[0] / 1000)
      const i = Math.round((t - start) / stepS)
      if (i < 0 || i >= count) continue
      close[i] = Number(k[4])
      low[i] = Number(k[3])
      if (high) high[i] = Number(k[2])
    }
    const last = Math.floor(rows[rows.length - 1][0] / 1000)
    if (last + stepS <= cursor) break
    cursor = last + stepS
    await sleep(120)
  }
  const gaps = close.filter((v) => v === null).length
  return { close, low, ...(high ? { high } : {}), gaps }
}

// ------------------------------------------------------------------ DefiLlama

/** Point series [[ts, price], ...] for one coin key, hourly, chunked under the 500-point cap. */
async function llamaSeries(coinKey, start, end, periodS = H) {
  const out = []
  const per = 450
  for (let t = start; t < end; t += per * periodS) {
    const span = Math.min(per, Math.ceil((end - t) / periodS))
    const url = `${LLAMA}/${coinKey}?start=${t}&span=${span}&period=${periodS / 3600}h`
    const j = await getJson(url)
    const pts = j?.coins?.[coinKey]?.prices ?? []
    for (const p of pts)
      if (p.timestamp >= start && p.timestamp < end) out.push([p.timestamp, p.price])
    await sleep(150)
  }
  out.sort((a, b) => a[0] - b[0])
  // drop duplicate timestamps that straddle chunk edges
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0])
}

// ------------------------------------------------------------------ JSON-RPC (archive)

// Keyless archive endpoints. A state read at a pinned block is deterministic, so any of
// them answers identically; the batch rotates on HTTP 429 / errors instead of hammering one.
const RPCS = [
  'https://mainnet.gateway.tenderly.co',
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
  'https://rpc.mevblocker.io',
  'https://eth-pokt.nodies.app',
]
let rpcCursor = 0
const rpcUsed = new Set()

async function rpcBatch(calls) {
  const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }))
  let lastErr
  for (let attempt = 0; attempt < RPCS.length * 4; attempt++) {
    const url = RPCS[rpcCursor % RPCS.length]
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      const res = await r.json()
      if (!Array.isArray(res)) throw new Error('non-array batch response')
      const byId = new Map(res.map((x) => [x.id, x]))
      const out = calls.map((_, id) => {
        const x = byId.get(id)
        if (!x || x.error) throw new Error(`rpc error: ${JSON.stringify(x?.error ?? 'missing')}`)
        return x.result
      })
      rpcUsed.add(url)
      return out
    } catch (e) {
      lastErr = e
      rpcCursor++
      await sleep(attempt < RPCS.length ? 300 : 3000)
    }
  }
  throw new Error(`rpc batch failed on every endpoint: ${lastErr}`)
}

const hex = (n) => '0x' + n.toString(16)

async function blockTs(n) {
  const [b] = await rpcBatch([{ method: 'eth_getBlockByNumber', params: [hex(n), false] }])
  return parseInt(b.timestamp, 16)
}

/** First block with timestamp >= t, by secant steps from an anchor (12s slots, some missed). */
async function blockAt(t, anchor) {
  let n = anchor.n + Math.round((t - anchor.t) / 12)
  for (let i = 0; i < 8; i++) {
    const bt = await blockTs(n)
    const d = t - bt
    if (Math.abs(d) < 24) {
      // walk to exact boundary
      let m = n
      let mt = bt
      while (mt < t) mt = await blockTs(++m)
      while (m > 0 && (await blockTs(m - 1)) >= t) m--
      return m
    }
    n += Math.round(d / 12.1)
  }
  return n
}

/**
 * Sample eth_call(to, data) every `stride` blocks over [fromBlock, toBlock], returning
 * [[blockTs, block, rawHex], ...]. Each sample carries its block's own timestamp — the
 * series is irregular in time and the consumer resamples with "last value in force".
 */
async function sampleCall(to, data, fromBlock, toBlock, stride) {
  const blocks = []
  for (let b = fromBlock; b <= toBlock; b += stride) blocks.push(b)
  const out = []
  const chunk = 5 // public gateways rate-limit larger batches (HTTP 429)
  for (let i = 0; i < blocks.length; i += chunk) {
    const part = blocks.slice(i, i + chunk)
    const calls = []
    for (const b of part) {
      calls.push({ method: 'eth_getBlockByNumber', params: [hex(b), false] })
      calls.push({ method: 'eth_call', params: [{ to, data }, hex(b)] })
    }
    const res = await rpcBatch(calls)
    part.forEach((b, j) => {
      const blk = res[2 * j]
      const ret = res[2 * j + 1]
      if (ret && ret !== '0x') out.push([parseInt(blk.timestamp, 16), b, ret])
    })
    await sleep(400)
  }
  return out
}

// ------------------------------------------------------------------ Morpho API

async function morpho(query) {
  const j = await getJson(MORPHO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (j.errors) throw new Error(`morpho: ${JSON.stringify(j.errors).slice(0, 300)}`)
  return j.data
}

async function morphoLiquidations(from, to) {
  const items = []
  for (let skip = 0; ; skip += 500) {
    const d =
      await morpho(`{ marketTransactions(first: 500, skip: ${skip}, orderBy: Timestamp, orderDirection: Asc,
      where: { type_in: [Liquidation], timestamp_gte: ${from}, timestamp_lte: ${to}, chainId_in: [1] }) {
      items { txHash timestamp blockNumber user { address }
        market { marketId lltv oracleAddress
          collateralAsset { symbol address decimals } loanAsset { symbol address decimals } }
        data { ... on MarketTransactionLiquidationData { seizedAssets repaidAssets badDebtAssets } } } } }`)
    const page = d.marketTransactions.items
    items.push(...page)
    if (page.length < 500) break
  }
  return items.map((i) => {
    const m = i.market
    const cd = m.collateralAsset.decimals
    const ld = m.loanAsset.decimals
    return {
      ts: Number(i.timestamp),
      block: Number(i.blockNumber),
      tx: i.txHash,
      user: i.user.address,
      marketId: m.marketId,
      lltv: Number(m.lltv) / 1e18,
      oracle: m.oracleAddress,
      collateral: m.collateralAsset.symbol,
      collateralAddress: m.collateralAsset.address,
      collateralDecimals: cd,
      loan: m.loanAsset.symbol,
      loanDecimals: ld,
      seized: Number(i.data.seizedAssets) / 10 ** cd,
      repaid: Number(i.data.repaidAssets) / 10 ** ld,
      badDebt: Number(i.data.badDebtAssets ?? 0) / 10 ** ld,
    }
  })
}

/** Hourly collateral + borrow history of one (user, market) — the real position path. */
async function morphoPositionHistory(user, marketId, from, to, cd, ld) {
  const opt = `options: { startTimestamp: ${from}, endTimestamp: ${to}, interval: HOUR }`
  const d =
    await morpho(`{ marketPosition(userAddress: "${user}", marketUniqueKey: "${marketId}", chainId: 1) {
    historicalState { collateral(${opt}) { x y } collateralUsd(${opt}) { x y } borrowAssets(${opt}) { x y } } } }`)
  const h = d.marketPosition?.historicalState
  if (!h) return []
  const byX = new Map()
  for (const p of h.collateral ?? [])
    byX.set(p.x, { ts: p.x, collateral: Number(p.y ?? 0) / 10 ** cd })
  for (const p of h.collateralUsd ?? [])
    if (byX.has(p.x)) byX.get(p.x).collateralUsd = Number(p.y ?? 0)
  for (const p of h.borrowAssets ?? [])
    if (byX.has(p.x)) byX.get(p.x).borrow = Number(p.y ?? 0) / 10 ** ld
  return [...byX.values()].sort((a, b) => a.ts - b.ts)
}

const STABLES = new Set([
  'USDC',
  'USDT',
  'DAI',
  'USDS',
  'PYUSD',
  'USDe',
  'AUSD',
  'USD0',
  'GHO',
  'FRAX',
  'RLUSD',
  'USDtb',
  'crvUSD',
])

async function positionsFor(liqs, lookbackS, keep) {
  const seen = new Map()
  for (const l of liqs) {
    if (!keep(l)) continue
    const key = `${l.user}:${l.marketId}`
    if (!seen.has(key)) seen.set(key, { ...l, liquidations: [] })
    seen.get(key).liquidations.push({
      ts: l.ts,
      block: l.block,
      tx: l.tx,
      seized: l.seized,
      repaid: l.repaid,
      badDebt: l.badDebt,
    })
  }
  const out = []
  for (const p of seen.values()) {
    const first = p.liquidations[0].ts
    const hist = await morphoPositionHistory(
      p.user,
      p.marketId,
      first - lookbackS,
      first + 6 * H,
      p.collateralDecimals,
      p.loanDecimals,
    )
    await sleep(150)
    out.push({
      user: p.user,
      marketId: p.marketId,
      collateral: p.collateral,
      loan: p.loan,
      lltv: p.lltv,
      oracle: p.oracle,
      liquidations: p.liquidations,
      history: hist,
    })
  }
  return out
}

// ------------------------------------------------------------------ builders

async function buildHourly() {
  const start = ts('2020-01-01T00:00:00Z')
  const end = ts('2026-10-07T00:00:00Z')
  const eth = await klines('ETHUSDT', '1h', H, start, end, true)
  const btc = await klines('BTCUSDT', '1h', H, start, end, true)
  return {
    file: 'hourly-eth-btc.json',
    body: {
      startTs: start,
      stepSeconds: H,
      count: eth.close.length,
      quote: 'USDT',
      source:
        'Binance spot 1h klines via data-api.binance.vision (public mirror). OHLC per hour; low/high are the intra-hour extremes.',
      gaps: { eth: eth.gaps, btc: btc.gaps },
      columns: {
        ethClose: eth.close,
        ethLow: eth.low,
        ethHigh: eth.high,
        btcClose: btc.close,
        btcLow: btc.low,
        btcHigh: btc.high,
      },
    },
  }
}

async function buildE2() {
  const start = ts('2025-11-01T00:00:00Z')
  const end = ts('2025-12-01T00:00:00Z')
  const eth = await klines('ETHUSDT', '1m', 60, start, end)
  const btc = await klines('BTCUSDT', '1m', 60, start, end)
  const deusd = await llamaSeries('coingecko:elixir-deusd', ts('2025-10-25T00:00:00Z'), end)
  const liqs = await morphoLiquidations(start, end)
  const positions = await positionsFor(
    liqs,
    7 * 24 * H,
    (l) => ['WBTC', 'cbBTC', 'wstETH'].includes(l.collateral) && STABLES.has(l.loan),
  )
  return {
    file: 'e2-nov-2025.json',
    body: {
      window: [iso(start), iso(end)],
      label:
        'Nov 2025 Morpho BTC/ETH-collateral liquidations + deUSD price. Not the Recall Coverage Dataset spec E2 (Stream xUSD freeze, Nov 2–12): no xUSD-collateral positions',
      spot1m: {
        startTs: start,
        stepSeconds: 60,
        count: eth.close.length,
        quote: 'USDT',
        source: 'Binance spot 1m klines via data-api.binance.vision',
        gaps: { eth: eth.gaps, btc: btc.gaps },
        columns: { ethClose: eth.close, ethLow: eth.low, btcClose: btc.close, btcLow: btc.low },
      },
      depeg: {
        deUSD: {
          source:
            'DefiLlama coins API, coingecko:elixir-deusd (the token-address key returns no history)',
          points: deusd,
        },
      },
      morpho: {
        source:
          'Morpho Blue API marketTransactions(type Liquidation) + marketPosition.historicalState (HOUR)',
        liquidationCount: liqs.length,
        positionFilter: 'collateral in {WBTC, cbBTC, wstETH}, loan asset a USD stable',
        positions,
      },
    },
  }
}

async function buildE3() {
  const start = ts('2026-04-10T00:00:00Z')
  const end = ts('2026-04-26T00:00:00Z')
  const eth = await klines('ETHUSDT', '1m', 60, start, end)
  const rseth = await llamaSeries('ethereum:0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7', start, end)
  const ethL = await llamaSeries('coingecko:ethereum', start, end)
  // Aave V3 USDe reserve cash = USDe.balanceOf(aEthUSDe): what a lender could withdraw.
  const USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3'
  const AUSDE = '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF'
  const anchor = { n: 25829868, t: await blockTs(25829868) }
  const b0 = await blockAt(start, anchor)
  const b1 = await blockAt(ts('2026-04-23T00:00:00Z'), anchor)
  const data = '0x70a08231' + AUSDE.slice(2).toLowerCase().padStart(64, '0')
  const cashRaw = await sampleCall(USDE, data, b0, b1, 75) // ~15 min
  const liqs = await morphoLiquidations(start, end)
  return {
    file: 'e3-apr-2026.json',
    body: {
      window: [iso(start), iso(end)],
      label: 'E3 — Apr 2026 Kelp rsETH incident (Aave rsETH freeze Apr 18 19:03:59 UTC)',
      spot1m: {
        startTs: start,
        stepSeconds: 60,
        count: eth.close.length,
        quote: 'USDT',
        source: 'Binance spot 1m klines via data-api.binance.vision',
        gaps: { eth: eth.gaps },
        columns: { ethClose: eth.close, ethLow: eth.low },
      },
      depeg: {
        rsETH: {
          source: 'DefiLlama ethereum:0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7',
          points: rseth,
        },
        ETH: { source: 'DefiLlama coingecko:ethereum (same source, for the ratio)', points: ethL },
      },
      usdeAaveCash: {
        source: 'USDe.balanceOf(aEthUSDe) via archive eth_call, every 75 blocks (~15 min)',
        token: USDE,
        aToken: AUSDE,
        points: cashRaw.map(([t, b, r]) => [t, b, Number(BigInt(r)) / 1e18]),
      },
      morpho: { liquidationCount: liqs.length, liquidations: liqs },
    },
  }
}

async function buildE4() {
  const ORACLE = '0x217d6DdCDB95112C51657F6270e8C079CFDB51f0' // Morpho oracle, PT-reUSD-10DEC2026 / USDC & USDT markets
  const anchorN = 25829868 // first PT-reUSD-10DEC2026 liquidation block (2026-08-25 04:37:47 UTC)
  const anchor = { n: anchorN, t: await blockTs(anchorN) }
  const from = await blockAt(ts('2026-08-11T00:00:00Z'), anchor)
  const to = await blockAt(ts('2026-08-27T00:00:00Z'), anchor)
  const hourly = await sampleCall(ORACLE, '0xa035b1fe', from, to, 300)
  const dFrom = await blockAt(ts('2026-08-25T01:00:00Z'), anchor)
  const dTo = await blockAt(ts('2026-08-25T07:00:00Z'), anchor)
  const dense = await sampleCall(ORACLE, '0xa035b1fe', dFrom, dTo, 5)
  const pts = new Map()
  for (const [t, b, r] of [...hourly, ...dense]) pts.set(b, [t, b, Number(BigInt(r)) / 1e36])
  const oracle = [...pts.values()].sort((a, b) => a[1] - b[1])
  const start = ts('2026-08-11T00:00:00Z')
  const end = ts('2026-08-27T00:00:00Z')
  const liqs = await morphoLiquidations(start, end)
  const positions = await positionsFor(liqs, 14 * 24 * H, (l) =>
    l.collateral.startsWith('PT-reUSD'),
  )
  return {
    file: 'e4-aug-2026.json',
    body: {
      window: [iso(start), iso(end)],
      label: 'E4 — Aug 25 2026 Morpho PT-reUSD-10DEC2026 cascade',
      oracle: {
        address: ORACLE,
        source:
          'Morpho oracle price() via archive eth_call; every 300 blocks Aug 11–27, every 5 blocks Aug 25 01:00–07:00 UTC',
        scale: 'price()/1e36 = USD per PT (PT and loan token both 6 decimals)',
        points: oracle,
      },
      morpho: {
        source:
          'Morpho Blue API marketTransactions(type Liquidation) + marketPosition.historicalState (HOUR)',
        liquidations: liqs.filter((l) => l.collateral.startsWith('PT-reUSD')),
        positions,
      },
    },
  }
}

async function buildDepegHistory() {
  const steth = await llamaSeries(
    'coingecko:staked-ether',
    ts('2021-06-01T00:00:00Z'),
    ts('2026-10-07T00:00:00Z'),
  )
  const eth = await llamaSeries(
    'coingecko:ethereum',
    ts('2021-06-01T00:00:00Z'),
    ts('2026-10-07T00:00:00Z'),
  )
  const usdc = await llamaSeries(
    'coingecko:usd-coin',
    ts('2023-01-01T00:00:00Z'),
    ts('2026-10-07T00:00:00Z'),
  )
  const usde = await llamaSeries(
    'coingecko:ethena-usde',
    ts('2024-03-01T00:00:00Z'),
    ts('2026-10-07T00:00:00Z'),
  )
  // stETH/ETH as an hourly ratio, joined on the hour bucket (both from the same source).
  const ethByHour = new Map(eth.map(([t, p]) => [Math.floor(t / H), p]))
  const stethEth = []
  for (const [t, p] of steth) {
    const e = ethByHour.get(Math.floor(t / H))
    if (e) stethEth.push([Math.floor(t / H) * H, +(p / e).toFixed(6)])
  }
  const round = (pts) => pts.map(([t, p]) => [t, +p.toFixed(6)])
  return {
    file: 'depeg-history.json',
    body: {
      source:
        'DefiLlama coins API (coingecko:* keys), ~hourly. stETH/ETH is joined on the hour bucket from the same source.',
      caveat:
        'Aggregated market prices, not any lending venue oracle. A venue pricing an LST by exchange rate never sees these moves.',
      series: { stethEth, usdc: round(usdc), usde: round(usde) },
    },
  }
}

// ------------------------------------------------------------------ E2 spec event: Stream xUSD / Elixir deUSD

/**
 * The spec's E2 (Recall Coverage Dataset §5: Stream xUSD collapse, Nov 2–12 2025) on Morpho:
 * every market whose collateral is xUSD, deUSD, sdeUSD or a PT on them, on every chain the
 * Morpho API serves. Per position, hourly: collateral, its value at the market's OWN oracle
 * (collateralValue, loan units), its USD value at Morpho's market price feed (collateralUsd),
 * and debt. Breach can then be read both ways: oracle HF < 1 and market HF < 1.
 */
const E2_COLLATERAL_RE = /^(xUSD|deUSD|sdeUSD|xBTC|PT-sw-xUSD.*|PT-sdeUSD.*|PT-xUSD.*|PT-deUSD.*)$/
const E2_SPEC = { fromTs: ts('2025-11-02T00:00:00Z'), toTs: ts('2025-11-12T23:59:00Z') }
const E2_HISTORY = { fromTs: ts('2025-10-26T00:00:00Z'), toTs: ts('2025-11-16T00:00:00Z') }
/** Market price keys per collateral; the token-address keys return no history for xUSD/deUSD. */
const E2_MARKET_KEYS = {
  xUSD: 'coingecko:staked-stream-usd',
  deUSD: 'coingecko:elixir-deusd',
  sdeUSD: 'coingecko:elixir-staked-deusd',
  'sdeUSD (DefiLlama on-chain)': 'ethereum:0x5C5b196aBE0d54485975D1Ec29617D42D9198326',
}

async function e2StreamMarkets() {
  const seen = new Map()
  for (const s of ['xUSD', 'deUSD', 'sdeUSD', 'xBTC']) {
    const d = await morpho(`{ markets(first: 500, where: { search: "${s}" }) { items { marketId
      morphoBlue { chain { id } } lltv oracleAddress oracle { type }
      collateralAsset { symbol address decimals } loanAsset { symbol address decimals } } } }`)
    for (const m of d.markets.items) {
      const c = m.collateralAsset
      if (!c || !E2_COLLATERAL_RE.test(c.symbol)) continue
      const chainId = m.morphoBlue.chain.id
      seen.set(`${chainId}:${m.marketId}`, {
        chainId,
        marketId: m.marketId,
        collateral: c.symbol,
        collateralAddress: c.address,
        collateralDecimals: c.decimals,
        loan: m.loanAsset.symbol,
        loanAddress: m.loanAsset.address,
        loanDecimals: m.loanAsset.decimals,
        lltv: Number(m.lltv) / 1e18,
        oracle: m.oracleAddress,
        oracleType: m.oracle?.type ?? null,
      })
    }
    await sleep(300)
  }
  return [...seen.values()].sort(
    (a, b) => a.chainId - b.chainId || a.marketId.localeCompare(b.marketId),
  )
}

async function e2Transactions(m, types, toTs) {
  const items = []
  for (let skip = 0; ; skip += 500) {
    const d =
      await morpho(`{ marketTransactions(first: 500, skip: ${skip}, orderBy: Timestamp, orderDirection: Asc,
      where: { marketUniqueKey_in: ["${m.marketId}"], chainId_in: [${m.chainId}], type_in: [${types.join(', ')}],
        timestamp_lte: ${toTs} }) {
      items { type txHash timestamp blockNumber user { address }
        data { ... on MarketTransactionLiquidationData { seizedAssets repaidAssets badDebtAssets } } } } }`)
    const page = d.marketTransactions.items
    items.push(...page)
    if (page.length < 500) break
    await sleep(300)
  }
  return items
}

async function e2PositionHistory(m, user) {
  const opt = `options: { startTimestamp: ${E2_HISTORY.fromTs}, endTimestamp: ${E2_HISTORY.toTs}, interval: HOUR }`
  const d =
    await morpho(`{ marketPosition(userAddress: "${user}", marketUniqueKey: "${m.marketId}", chainId: ${m.chainId}) {
    historicalState { collateral(${opt}) { x y } collateralValue(${opt}) { x y } collateralUsd(${opt}) { x y }
      borrowAssets(${opt}) { x y } borrowAssetsUsd(${opt}) { x y } } } }`)
  const h = d.marketPosition?.historicalState
  if (!h) return []
  const byX = new Map()
  const put = (series, key, scale) => {
    for (const p of series ?? []) {
      const row = byX.get(p.x) ?? { ts: p.x }
      row[key] = p.y === null || p.y === undefined ? null : Number(p.y) / scale
      byX.set(p.x, row)
    }
  }
  put(h.collateral, 'collateral', 10 ** m.collateralDecimals)
  put(h.collateralValue, 'collateralValue', 10 ** m.loanDecimals)
  put(h.collateralUsd, 'collateralUsd', 1)
  put(h.borrowAssets, 'borrow', 10 ** m.loanDecimals)
  put(h.borrowAssetsUsd, 'borrowUsd', 1)
  return [...byX.values()].sort((a, b) => a.ts - b.ts)
}

async function buildE2Stream() {
  const markets = await e2StreamMarkets()
  const positions = []
  const liquidations = []
  const now = Math.floor(Date.now() / 1000)
  for (const m of markets) {
    // Every account that ever borrowed or posted collateral up to the end of the spec window.
    const txs = await e2Transactions(m, ['Borrow', 'SupplyCollateral'], E2_SPEC.toTs)
    const users = [...new Set(txs.map((t) => t.user.address.toLowerCase()))]
    let kept = 0
    for (const u of users) {
      const hist = await e2PositionHistory(m, u)
      const inWindow = hist.filter((x) => x.ts >= E2_SPEC.fromTs && x.ts <= E2_SPEC.toTs)
      if (inWindow.some((x) => (x.borrow ?? 0) > 0 && (x.collateral ?? 0) > 0)) {
        positions.push({ chainId: m.chainId, marketId: m.marketId, user: u, history: hist })
        kept++
      }
      await sleep(150)
    }
    const liqs = await e2Transactions(m, ['Liquidation'], now)
    for (const l of liqs.filter((x) => Number(x.timestamp) >= E2_HISTORY.fromTs))
      liquidations.push({
        chainId: m.chainId,
        marketId: m.marketId,
        user: l.user.address.toLowerCase(),
        ts: Number(l.timestamp),
        block: Number(l.blockNumber),
        tx: l.txHash,
        seized: Number(l.data?.seizedAssets ?? 0) / 10 ** m.collateralDecimals,
        repaid: Number(l.data?.repaidAssets ?? 0) / 10 ** m.loanDecimals,
        badDebt: Number(l.data?.badDebtAssets ?? 0) / 10 ** m.loanDecimals,
      })
    m.accounts = users.length
    m.positionsInWindow = kept
    console.log(
      `  ${m.chainId} ${m.collateral}/${m.loan} ${m.marketId.slice(0, 10)}: ${users.length} accounts, ${kept} in window`,
    )
  }
  // Independent market prices (CoinGecko trades via DefiLlama). Morpho's own USD feed is kept
  // per position (collateralUsd) as a cross-check.
  const marketPrices = {}
  for (const [sym, key] of Object.entries(E2_MARKET_KEYS)) {
    marketPrices[sym] = { key, series: await llamaSeries(key, E2_HISTORY.fromTs, E2_HISTORY.toTs) }
  }
  return {
    file: 'e2-stream-nov-2025.json',
    body: {
      label:
        'Recall Coverage Dataset spec E2: Stream xUSD collapse (Nov 2–12 2025), Morpho markets on xUSD / deUSD / sdeUSD',
      specWindow: E2_SPEC,
      historyWindow: E2_HISTORY,
      source:
        "DefiLlama coins API for marketPrices (CoinGecko ids, hourly). Morpho Blue API: markets(search), marketTransactions (Borrow, SupplyCollateral up to the window end; Liquidation from the history start to the fetch), marketPosition.historicalState HOUR (collateral, collateralValue at the market oracle in loan units, collateralUsd at Morpho's USD price feed, borrowAssets, borrowAssetsUsd)",
      uncovered:
        'Euler, Silo, Gearbox, Fluid and other venues; chains the Morpho API does not serve (Plasma 9745, Avalanche 43114, Sonic 146 per spec §5). Positions closed before the window are excluded by construction.',
      markets,
      positions,
      liquidations,
      marketPrices,
    },
  }
}

// ------------------------------------------------------------------ E1 L2 governance tokens

/**
 * OP and ARB, 1-minute, Oct 10 → 12 2025: the only E1 census collateral with no mainnet
 * Chainlink round in the spec's E1 pull (recall-coverage data/chain/e1/chainlink_rounds).
 * Binance spot stands in for the L2 Chainlink feeds the venues read.
 */
async function buildE1L2() {
  const start = ts('2025-10-10T00:00:00Z')
  const end = ts('2025-10-12T00:00:00Z')
  const op = await klines('OPUSDT', '1m', 60, start, end)
  const arb = await klines('ARBUSDT', '1m', 60, start, end)
  return {
    file: 'e1-op-arb-1m.json',
    body: {
      label:
        'E1 census OP and ARB collateral, 1-minute spot (proxy for the L2 Chainlink OP/USD and ARB/USD feeds)',
      source:
        'Binance public market-data mirror data-api.binance.vision, OPUSDT and ARBUSDT 1m klines',
      startTs: start,
      stepS: 60,
      columns: { opClose: op.close, opLow: op.low, arbClose: arb.close, arbLow: arb.low },
      gaps: { op: op.gaps, arb: arb.gaps },
    },
  }
}

const BUILDERS = {
  hourly: buildHourly,
  e2: buildE2,
  e3: buildE3,
  e4: buildE4,
  depeg: buildDepegHistory,
  e2stream: buildE2Stream,
  e1l2: buildE1L2,
}

async function main() {
  const only = (
    process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? Object.keys(BUILDERS).join(',')
  ).split(',')
  await mkdir(OUT, { recursive: true })
  const manifestPath = join(OUT, 'manifest.json')
  let manifest = { files: {} }
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {}
  for (const k of only) {
    const t0 = Date.now()
    console.log(`building ${k} …`)
    const { file, body } = await BUILDERS[k]()
    const text = JSON.stringify({ ...body, fetchedAt: new Date().toISOString() })
    await writeFile(join(OUT, file), text)
    manifest.files[file] = {
      builder: k,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
      fetchedAt: new Date().toISOString(),
    }
    console.log(
      `  ${file}: ${(text.length / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    )
  }
  manifest.generator = 'scripts/research/build-position-alert-data.mjs'
  if (rpcUsed.size)
    manifest.archiveRpcsUsed = [...new Set([...(manifest.archiveRpcsUsed ?? []), ...rpcUsed])]
  manifest.e1 = 'oct10-2025/ in the datasets repo (its own README and PROVENANCE.md)'
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

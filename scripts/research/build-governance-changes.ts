/**
 * build-governance-changes.ts — governance-change events for the position-alert back-test
 * (memo §8b). Keyless archive reads only; never reads .env files.
 *
 *   pnpm tsx scripts/research/build-governance-changes.ts [--only=e2,aave]
 *
 *  e2    Euler v2 borrow-vault governance events (GovSetLTV, GovSetHookConfig, …) on every
 *        Euler market of position-alerts/e2-offmorpho-nov-2025.json, and Gearbox v3
 *        CreditConfigurator events of its credit managers, from May 1 2025 (calm) to Nov 16
 *        2025 (end of the E2 history window).
 *  aave  Aave v3 Ethereum Core PoolConfigurator events from its deployment to Oct 1 2026, with
 *        each reserve's symbol: the calm false-alarm series.
 *
 * Every log range is read on two endpoints and the counts must match: an endpoint can answer
 * eth_getLogs with a false or short result (board R33, R34). Output goes to the datasets clone
 * under governance-changes/ (board N18), with a manifest entry per file.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  decodeEventLog,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  toEventSelector,
  type Hex,
} from 'viem'

import {
  blockAtTime,
  blockTimestamp,
  LOG_SPAN,
  LOG_SPAN_BY_URL,
  RPC,
  rpc,
} from '../lib/archiveRpc.mjs'
import { datasetsDir } from '../lib/datasetsDir.mjs'
import {
  AAVE_CONFIGURATOR_EVENTS,
  COMPOUND_GOVERNANCE_EVENTS,
  EULER_GOVERNANCE_EVENTS,
  GEARBOX_CONFIGURATOR_EVENTS,
  VENUS_COMPTROLLER_EVENTS,
} from '../../lib/positionAlerts/governance'

const ROOT = process.cwd()
const DATA = datasetsDir(ROOT)
const OUT = join(DATA, 'governance-changes')
const ONLY = new Set(
  (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? 'e2,aave').split(','),
)
const ts = (s: string) => Math.floor(Date.parse(s) / 1000)
const CALM_FROM = ts('2025-05-01T00:00:00Z')
const E2_TO = ts('2025-11-16T00:00:00Z')
const AAVE_TO = ts('2026-10-01T00:00:00Z')
const AAVE_CORE = {
  configurator: '0x64b761d848206f447fe2dd461b0c635ec39ebb27',
  pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  deployBlock: 16_291_000,
}

const EULER_ABI = parseAbi(EULER_GOVERNANCE_EVENTS)
const COMPOUND_ABI = parseAbi(COMPOUND_GOVERNANCE_EVENTS)
const VENUS_ABI = parseAbi(VENUS_COMPTROLLER_EVENTS)
// Venus ResilientOracle: a new main / pivot / fallback oracle for an asset.
const RESILIENT_ABI = parseAbi([
  'event TokenConfigAdded(address indexed asset, address indexed mainOracle, address indexed pivotOracle, address fallbackOracle)',
])
/** Compound v3 Configurator on Ethereum (cometProxy is indexed in its events). */
const COMPOUND_CONFIGURATOR = '0x316f9708bb98af7da9c68c1c3b5e79039cd336e3'
const pad = (a: string) => ('0x' + '0'.repeat(24) + a.slice(2).toLowerCase()) as Hex
const GEARBOX_ABI = parseAbi(GEARBOX_CONFIGURATOR_EVENTS)
const AAVE_ABI = parseAbi(AAVE_CONFIGURATOR_EVENTS)
const VIEW_ABI = parseAbi([
  'function creditConfigurator() view returns (address)',
  'function getReservesList() view returns (address[])',
  'function symbol() view returns (string)',
])
const selectors = (abi: readonly { type: string }[]) =>
  abi.filter((x) => x.type === 'event').map((e) => toEventSelector(e as never))

interface RawLog {
  address: string
  topics: Hex[]
  data: Hex
  blockNumber: string
  transactionHash: string
  logIndex: string
}

/** One getLogs chunk on one endpoint, with retries. */
async function chunk(
  url: string,
  address: string | string[],
  topics: (Hex | Hex[])[],
  b: number,
  e: number,
): Promise<RawLog[]> {
  let last: unknown
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getLogs',
          params: [
            { address, topics, fromBlock: '0x' + b.toString(16), toBlock: '0x' + e.toString(16) },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      })
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      if (j.error) {
        const msg = JSON.stringify(j.error).slice(0, 160)
        // An endpoint with a smaller range cap: split the range rather than give up.
        if (/range|too many/i.test(msg) && !/rate/i.test(msg) && e - b >= 100) {
          const mid = Math.floor((b + e) / 2)
          return [
            ...(await chunk(url, address, topics, b, mid)),
            ...(await chunk(url, address, topics, mid + 1, e)),
          ]
        }
        throw new Error(msg)
      }
      return j.result
    } catch (err) {
      last = err
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)))
    }
  }
  throw new Error(`${url} getLogs ${b}-${e}: ${(last as Error).message}`)
}

/** One getLogs range on one endpoint, in that endpoint's span, 6 chunks at a time. */
async function logsOn(
  url: string,
  chainId: number,
  address: string | string[],
  topics: (Hex | Hex[])[],
  from: number,
  to: number,
): Promise<RawLog[]> {
  const span =
    LOG_SPAN_BY_URL[url as keyof typeof LOG_SPAN_BY_URL] ??
    LOG_SPAN[chainId as keyof typeof LOG_SPAN]
  const ranges: [number, number][] = []
  for (let b = from; b <= to; b += span) ranges.push([b, Math.min(to, b + span - 1)])
  const parts: RawLog[][] = new Array(ranges.length)
  let next = 0
  const worker = async () => {
    while (next < ranges.length) {
      const i = next++
      parts[i] = await chunk(url, address, topics, ranges[i][0], ranges[i][1])
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, ranges.length) }, worker))
  return parts.flat()
}

/** The same range on two endpoints; the counts must match. One endpoint: read twice. */
async function verifiedLogs(
  chainId: number,
  address: string | string[],
  topics: (Hex | Hex[])[],
  from: number,
  to: number,
): Promise<RawLog[]> {
  const urls = RPC[chainId as keyof typeof RPC]
  const [a, b] = await Promise.all([
    logsOn(urls[0], chainId, address, topics, from, to),
    logsOn(urls[1] ?? urls[0], chainId, address, topics, from, to),
  ])
  if (a.length !== b.length)
    throw new Error(
      `chain ${chainId}: ${urls[0]} gave ${a.length} logs, ${urls[1] ?? 're-read'} gave ${b.length}`,
    )
  return a
}

async function call<T>(
  chainId: number,
  to: string,
  fn: string,
  args: unknown[] = [],
  block?: number,
): Promise<T> {
  const data = encodeFunctionData({ abi: VIEW_ABI, functionName: fn as never, args: args as never })
  const raw = await rpc(chainId, 'eth_call', [
    { to, data },
    block ? '0x' + block.toString(16) : 'latest',
  ])
  return decodeFunctionResult({ abi: VIEW_ABI, functionName: fn as never, data: raw }) as T
}

const plain = (v: unknown): unknown =>
  typeof v === 'bigint'
    ? v.toString()
    : Array.isArray(v)
      ? v.map(plain)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
        : v

async function decodeAll(chainId: number, abi: ReturnType<typeof parseAbi>, logs: RawLog[]) {
  const rows = []
  for (const l of logs) {
    let ev
    try {
      ev = decodeEventLog({ abi, topics: l.topics as [Hex, ...Hex[]], data: l.data })
    } catch {
      continue
    }
    const block = Number(l.blockNumber)
    rows.push({
      chainId,
      address: l.address.toLowerCase(),
      block,
      ts: await blockTimestamp(chainId, block),
      tx: l.transactionHash,
      logIndex: Number(l.logIndex),
      name: ev.eventName,
      args: plain(ev.args),
    })
  }
  return rows.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
}

function write(file: string, body: object) {
  mkdirSync(OUT, { recursive: true })
  const text = JSON.stringify(body)
  writeFileSync(join(OUT, file), text)
  const mpath = join(OUT, 'manifest.json')
  let manifest: { files: Record<string, unknown> } = { files: {} }
  try {
    manifest = JSON.parse(readFileSync(mpath, 'utf8'))
  } catch {}
  manifest.files[file] = {
    builder: 'scripts/research/build-governance-changes.ts',
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    fetchedAt: (body as { fetchedAt: string }).fetchedAt,
  }
  writeFileSync(mpath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${file}: ${(Buffer.byteLength(text) / 1e3).toFixed(0)} kB`)
}

// ------------------------------------------------------------------ E2: Euler + Gearbox

interface E2Market {
  venue: string
  chainId: number
  marketId: string
  marketName: string
  collateral: string
  oracle?: string
  comptroller?: string
  collaterals?: { vault?: string; asset: string; sym: string }[]
}

async function e2() {
  const file = JSON.parse(
    readFileSync(join(DATA, 'position-alerts', 'e2-offmorpho-nov-2025.json'), 'utf8'),
  )
  const markets: E2Market[] = file.markets
  const events = []
  const scanned = []
  const symbols: Record<string, Record<string, string>> = {}
  for (const chainId of [...new Set(markets.map((m) => m.chainId))]) {
    const from = await blockAtTime(chainId, CALM_FROM)
    const to = await blockAtTime(chainId, E2_TO)
    const sym = (symbols[chainId] ??= {})
    const euler = markets.filter((m) => m.venue === 'euler' && m.chainId === chainId)
    if (euler.length) {
      for (const m of euler)
        for (const c of m.collaterals ?? []) if (c.vault) sym[c.vault.toLowerCase()] = c.sym
      const logs = await verifiedLogs(
        chainId,
        euler.map((m) => m.marketId),
        [selectors(EULER_ABI)],
        from,
        to,
      )
      const rows = await decodeAll(chainId, EULER_ABI, logs)
      events.push(...rows.map((r) => ({ ...r, venue: 'euler' })))
      scanned.push({
        venue: 'euler',
        chainId,
        markets: euler.length,
        fromBlock: from,
        toBlock: to,
        events: rows.length,
      })
      console.log(`  euler ${chainId}: ${euler.length} vaults, ${rows.length} governance events`)
    }
    for (const g of markets.filter((m) => m.venue === 'gearbox' && m.chainId === chainId)) {
      const cc = (
        await call<string>(chainId, g.marketId, 'creditConfigurator', [], to)
      ).toLowerCase()
      const logs = await verifiedLogs(chainId, cc, [selectors(GEARBOX_ABI)], from, to)
      const rows = await decodeAll(chainId, GEARBOX_ABI, logs)
      for (const r of rows) {
        const token = String((r.args as { token?: string }).token ?? '').toLowerCase()
        if (token && !sym[token]) sym[token] = await call<string>(chainId, token, 'symbol', [], to)
      }
      events.push(
        ...rows.map((r) => ({ ...r, venue: 'gearbox', market: g.marketId.toLowerCase() })),
      )
      scanned.push({
        venue: 'gearbox',
        chainId,
        market: g.marketId,
        configurator: cc,
        fromBlock: from,
        toBlock: to,
        events: rows.length,
      })
      console.log(`  gearbox ${chainId} ${g.marketName}: configurator ${cc}, ${rows.length} events`)
    }
    for (const c of markets.filter((m) => m.venue === 'compound' && m.chainId === chainId)) {
      const comet = c.marketId.toLowerCase()
      for (const x of c.collaterals ?? []) sym[x.asset.toLowerCase()] = x.sym
      const cfg = await verifiedLogs(
        chainId,
        COMPOUND_CONFIGURATOR,
        [selectors(COMPOUND_ABI).slice(0, 2), pad(comet)],
        from,
        to,
      )
      const own = await verifiedLogs(chainId, comet, [selectors(COMPOUND_ABI).slice(2)], from, to)
      const rows = await decodeAll(chainId, COMPOUND_ABI, [...cfg, ...own])
      events.push(...rows.map((r) => ({ ...r, venue: 'compound', market: comet })))
      scanned.push({
        venue: 'compound',
        chainId,
        market: comet,
        configurator: COMPOUND_CONFIGURATOR,
        fromBlock: from,
        toBlock: to,
        events: rows.length,
      })
      console.log(`  compound ${chainId} ${c.marketName}: ${rows.length} events`)
    }
    for (const e of markets.filter((m) => m.venue === 'enclabs' && m.chainId === chainId)) {
      const vToken = e.marketId.toLowerCase()
      sym[vToken] = e.collateral
      const comp = String(e.comptroller).toLowerCase()
      const rows = await decodeAll(
        chainId,
        VENUS_ABI,
        await verifiedLogs(chainId, comp, [selectors(VENUS_ABI)], from, to),
      )
      for (const r of rows) {
        const v = String((r.args as { vToken?: string }).vToken ?? '').toLowerCase()
        if (v && !sym[v]) sym[v] = await call<string>(chainId, v, 'symbol', [], to)
      }
      // The pool oracle's TokenConfigAdded events (any asset; the replay keeps the held ones).
      const oracleRows = e.oracle
        ? await decodeAll(
            chainId,
            RESILIENT_ABI,
            await verifiedLogs(
              chainId,
              e.oracle.toLowerCase(),
              [selectors(RESILIENT_ABI)],
              from,
              to,
            ),
          )
        : []
      for (const r of oracleRows) {
        const a = String((r.args as { asset?: string }).asset ?? '').toLowerCase()
        if (a && !sym[a]) sym[a] = await call<string>(chainId, a, 'symbol', [], to)
      }
      events.push(...rows.map((r) => ({ ...r, venue: 'enclabs', market: vToken })))
      events.push(...oracleRows.map((r) => ({ ...r, venue: 'enclabs-oracle', market: vToken })))
      scanned.push({
        venue: 'enclabs',
        chainId,
        market: vToken,
        comptroller: comp,
        oracle: e.oracle,
        fromBlock: from,
        toBlock: to,
        events: rows.length,
        oracleEvents: oracleRows.length,
      })
      console.log(
        `  enclabs ${chainId} ${e.marketName}: ${rows.length} comptroller events, ${oracleRows.length} oracle config events`,
      )
    }
  }
  write('e2-euler-gearbox.json', {
    label:
      'Governance events of the E2 Euler, Gearbox, Compound v3 and Enclabs markets, May 1 2025 to Nov 16 2025 (Morpho Blue, Silo v2 and Abracadabra cauldron risk parameters cannot change)',
    window: { fromTs: CALM_FROM, toTs: E2_TO },
    source:
      'eth_getLogs on keyless archive RPCs (scripts/lib/archiveRpc.mjs), every range read on two endpoints with equal counts. Euler: the borrow vaults. Gearbox: CreditManager.creditConfigurator() at the window end. Compound v3: the Configurator filtered by comet, and the comet (PauseAction, Upgraded). Enclabs: the pool Comptroller, and TokenConfigAdded on the pool oracle.',
    scanned,
    symbols,
    events,
    fetchedAt: new Date().toISOString(),
  })
}

// ------------------------------------------------------------------ Aave v3 Ethereum Core

async function aave() {
  const chainId = 1
  const to = await blockAtTime(chainId, AAVE_TO)
  const logs = await verifiedLogs(
    chainId,
    AAVE_CORE.configurator,
    [selectors(AAVE_ABI)],
    AAVE_CORE.deployBlock,
    to,
  )
  const events = await decodeAll(chainId, AAVE_ABI, logs)
  const reserves = await call<string[]>(chainId, AAVE_CORE.pool, 'getReservesList', [], to)
  const assets = [
    ...new Set([
      ...reserves.map((r) => r.toLowerCase()),
      ...events
        .map((e) => String((e.args as { asset?: string }).asset ?? '').toLowerCase())
        .filter(Boolean),
    ]),
  ]
  const symbols: Record<string, string> = {}
  for (const a of assets) {
    try {
      symbols[a] = await call<string>(chainId, a, 'symbol', [], to)
    } catch {
      symbols[a] = a
    }
  }
  console.log(`  aave v3 core: ${events.length} configurator events, ${assets.length} assets`)
  write('aave-v3-ethereum-core.json', {
    label: 'Aave v3 Ethereum Core PoolConfigurator events, deployment to Oct 1 2026',
    configurator: AAVE_CORE.configurator,
    fromBlock: AAVE_CORE.deployBlock,
    toBlock: to,
    toTs: AAVE_TO,
    source:
      'eth_getLogs on keyless archive RPCs, every range read on two endpoints with equal counts. Symbols: ERC20 symbol() at the end block.',
    symbols,
    events,
    fetchedAt: new Date().toISOString(),
  })
}

async function main() {
  if (ONLY.has('e2')) await e2()
  if (ONLY.has('aave')) await aave()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

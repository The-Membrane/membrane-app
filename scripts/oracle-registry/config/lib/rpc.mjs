// RPC plumbing for the config-card collector: Ethereum clients from RECORDER_RPC_URL, public
// clients for other chains (LayerZero metadata RPC lists), retry / pool / adaptive getLogs and a
// resumable chunk cache. Mirrors scripts/oracle-registry/collect.mjs (10k-block spans,
// concurrency 2, log scans only on the keyed Ankr endpoint with Infura as backup).
//
// URLs carry keys: nothing here ever prints one. Errors go through scrub().

import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createPublicClient, defineChain, fallback, http } from 'viem'
import { readEnv } from '../../../lib/venue-reads.mjs'
import { scrub } from '../../lib/readers.mjs'
import { decodeLog } from './abi.mjs'

export { scrub }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function retry(fn, tries = 3, base = 400) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await sleep(base * 2 ** i)
    }
  }
  throw last
}

export async function pool(items, n, worker) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await worker(items[k], k)
      }
    }),
  )
  return out
}

const hostOf = (u) => {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}

const chainDef = (id, urls) =>
  defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: urls } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  })

/** Ethereum clients: `state` (whole ring) and `logs` (keyed Ankr first, Infura backup). */
export function ethereumClients() {
  const urls = String(
    process.env.ORACLE_REGISTRY_RPC_URL || readEnv().get('RECORDER_RPC_URL') || '',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!urls.length) throw new Error('RECORDER_RPC_URL missing from .env.local')
  const logUrls = [
    ...urls.filter((u) => hostOf(u).includes('ankr')),
    ...urls.filter((u) => hostOf(u).includes('infura')),
  ]
  const mk = (list, timeout) =>
    createPublicClient({
      chain: chainDef(1, list),
      transport:
        list.length === 1
          ? http(list[0], { timeout, retryCount: 1 })
          : fallback(
              list.map((u) => http(u, { timeout, retryCount: 1 })),
              { rank: false },
            ),
      batch: { multicall: false },
    })
  // Archive reads go to the keyed endpoint first (the free tiers refuse old blocks).
  const ordered = [...logUrls, ...urls.filter((u) => !logUrls.includes(u))]
  // UQ-23: two INDEPENDENT log endpoints (no fallback between them), so an empty answer from
  // one can be asked again on the other (the shared ring can return false-empty chunks)
  const pair = logUrls.length >= 2 ? logUrls.slice(0, 2) : [...logUrls, ...urls].slice(0, 2)
  return {
    state: mk(ordered, 30_000),
    logs: mk(logUrls.length ? logUrls : urls, 45_000),
    logsPrimary: mk([pair[0]], 45_000),
    logsSecondary: pair[1] ? mk([pair[1]], 45_000) : null,
  }
}

/**
 * UQ-23 (2026-10-08): one getLogs range, CROSS-CHECKED. An empty answer is asked again on a
 * second, independent endpoint — the shared ring can return false-empty chunks, and a lost
 * chunk drops a log silently:
 *   primary non-empty                           → its logs
 *   primary empty or failed, secondary non-empty → the secondary's (a false-empty corrected)
 *   both answered empty                          → [] (confirmed)
 *   otherwise (a failure and no confirming empty) → throws: the caller marks the read UNREAD
 * `secondary` null: an empty primary answer cannot be confirmed — throws (fail closed).
 * Review round 10 (R-5): a primary that FAILS on the range (a result-size or range limit) is
 * split in halves, and each half is cross-checked on its own. Before, the split ran inside one
 * adaptive read and only the combined answer was checked: one false-empty half next to a
 * non-empty half was accepted, and its log lost.
 * Returns { logs, corrected } (`corrected`: a primary empty answer was false).
 */
export async function crossCheckedLogs(primary, secondary, q, depth = 0) {
  let a = null
  let aErr = null
  try {
    a = await getLogsOnce(primary, q)
  } catch (e) {
    aErr = e
  }
  if (a && a.length) return { logs: a, corrected: false }
  if (aErr) {
    const span = BigInt(q.toBlock) - BigInt(q.fromBlock)
    if (span >= 200n && depth <= 12) {
      const mid = BigInt(q.fromBlock) + span / 2n
      const x = await crossCheckedLogs(primary, secondary, { ...q, toBlock: mid }, depth + 1)
      const y = await crossCheckedLogs(primary, secondary, { ...q, fromBlock: mid + 1n }, depth + 1)
      return { logs: [...x.logs, ...y.logs], corrected: x.corrected || y.corrected }
    }
  }
  if (!secondary)
    throw aErr ?? new Error('empty getLogs answer not cross-checked (no second endpoint)')
  let b = null
  try {
    b = await getLogsAdaptive(secondary, q)
  } catch (e) {
    if (aErr) throw aErr
    throw e
  }
  if (b.length) return { logs: b, corrected: !aErr }
  if (aErr) throw aErr
  return { logs: [], corrected: false }
}

/** A public client for another chain from a list of public RPC URLs (LZ metadata / chainlist). */
export function publicClient(chainId, urls) {
  return createPublicClient({
    chain: chainDef(chainId, urls),
    transport: fallback(
      urls.map((u) => http(u, { timeout: 12_000, retryCount: 0 })),
      { rank: false },
    ),
  })
}

/** One raw eth_getLogs request (retried, never split). */
async function getLogsOnce(client, { address, topics0, fromBlock, toBlock }) {
  const hx = (n) => '0x' + BigInt(n).toString(16)
  return retry(
    () =>
      client.request({
        method: 'eth_getLogs',
        params: [{ address, topics: [topics0], fromBlock: hx(fromBlock), toBlock: hx(toBlock) }],
      }),
    2,
  )
}

/**
 * Raw eth_getLogs with a topic0 OR-list. (viem's getLogs has no raw `topics` parameter: passing
 * one is silently ignored and the node returns EVERY log of the addresses — measured
 * 2026-10-06, 9,372 unrelated logs for one 10k-block span of ReceiveUln302.) Splits the range
 * in half on any error (result-size limits) down to 200 blocks.
 */
export async function getLogsAdaptive(client, { address, topics0, fromBlock, toBlock }, depth = 0) {
  try {
    return await getLogsOnce(client, { address, topics0, fromBlock, toBlock })
  } catch (e) {
    const span = BigInt(toBlock) - BigInt(fromBlock)
    if (span < 200n || depth > 12) throw e
    const mid = BigInt(fromBlock) + span / 2n
    const a = await getLogsAdaptive(
      client,
      { address, topics0, fromBlock, toBlock: mid },
      depth + 1,
    )
    const b = await getLogsAdaptive(
      client,
      { address, topics0, fromBlock: mid + 1n, toBlock },
      depth + 1,
    )
    return [...a, ...b]
  }
}

/**
 * Scan [from, to] for `topics0` on `addresses` in `span`-block chunks, decode, filter with
 * `keep(row)`, and cache every completed chunk in `cacheDir` (resumable; a re-run only scans
 * what is missing). Returns decoded rows { chainId, block, logIndex, tx, emitter, event, args }.
 */
export async function scanLogs({
  client,
  chainId,
  addresses,
  topics0,
  from,
  to,
  span = 100_000,
  concurrency = 2,
  cacheDir,
  cacheKey,
  keep = () => true,
  onProgress,
}) {
  const key = createHash('sha1')
    .update(
      JSON.stringify([
        chainId,
        [...addresses].map((a) => a.toLowerCase()).sort(),
        [...topics0].sort(),
        cacheKey ?? '',
      ]),
    )
    .digest('hex')
    .slice(0, 12)
  mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, `scan-${chainId}-${key}.jsonl`)
  const done = new Map()
  if (existsSync(file))
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const c = JSON.parse(line)
        done.set(`${c.from}-${c.to}`, c.rows)
      } catch {
        /* a torn last line from a killed run: that chunk is re-scanned */
      }
    }
  const chunks = []
  for (let a = from; a <= to; a += span) chunks.push([a, Math.min(to, a + span - 1)])
  const todo = chunks.filter(([a, b]) => !done.has(`${a}-${b}`))
  let n = 0
  await pool(todo, concurrency, async ([a, b]) => {
    // Ankr caps the block range at 10k once a filter is too wide — addresses × topics (measured
    // 2026-10-06: 24 addresses × 43 topics × 250k blocks fine, 47 → "range exceeds limit of
    // 10000"; 2026-10-07: 20 × 72 fails, 10 × 72 and 20 × 43 pass), so wide address lists go out
    // in groups that keep addresses × topics under ~1,000.
    const per = Math.max(1, Math.min(20, Math.floor(1000 / Math.max(1, topics0.length))))
    const raw = []
    for (let g = 0; g < addresses.length; g += per)
      raw.push(
        ...(await getLogsAdaptive(client, {
          address: addresses.slice(g, g + per),
          topics0,
          fromBlock: a,
          toBlock: b,
        })),
      )
    const rows = []
    for (const l of raw) {
      if (l.removed) continue
      const d = decodeLog(l)
      if (!d) continue
      const row = {
        chainId,
        block: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)),
        tx: l.transactionHash,
        emitter: l.address.toLowerCase(),
        event: d.event,
        args: d.args,
      }
      if (keep(row)) rows.push(row)
    }
    appendFileSync(file, JSON.stringify({ from: a, to: b, rows }) + '\n')
    done.set(`${a}-${b}`, rows)
    if (onProgress && ++n % 50 === 0) onProgress(n, todo.length)
  })
  return chunks
    .flatMap(([a, b]) => done.get(`${a}-${b}`) ?? [])
    .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
}

/** Block timestamps for a set of blocks (cached in a JSON map under cacheDir). */
export async function blockTimestamps(client, blocks, cacheFile) {
  let cache = {}
  if (cacheFile && existsSync(cacheFile)) cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  const missing = [...new Set(blocks)].filter((b) => cache[b] === undefined)
  await pool(missing, 4, async (b) => {
    const blk = await retry(() => client.getBlock({ blockNumber: BigInt(b) }))
    cache[b] = Number(blk.timestamp)
  })
  if (cacheFile && missing.length) {
    const { writeFileSync } = await import('fs')
    writeFileSync(cacheFile, JSON.stringify(cache))
  }
  return cache
}

/**
 * True when a viem error is the CALL reverting (the contract answered "no"), false when the
 * read itself failed (transport, timeout, rate limit) — a failed read must never be taken as
 * a revert (fail closed: "not read", not "reverted").
 */
export function isRevertError(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    const name = String(x.name ?? '')
    if (/ContractFunctionRevertedError|ExecutionRevertedError|RawContractError/.test(name))
      return true
    if (/HttpRequestError|TimeoutError|WebSocketRequestError|LimitExceeded/.test(name)) return false
    if (/execution reverted/i.test(String(x.details ?? x.shortMessage ?? ''))) return true
  }
  return false
}

/** eth_call helper that never throws: { ok, value } | { ok: false, error, reverted }. */
export async function tryRead(client, address, abi, functionName, args = [], blockNumber) {
  try {
    const value = await retry(
      () =>
        client.readContract({
          address,
          abi,
          functionName,
          args,
          blockNumber: blockNumber === undefined ? undefined : BigInt(blockNumber),
        }),
      2,
      300,
    )
    return { ok: true, value }
  } catch (e) {
    return {
      ok: false,
      error: scrub(e?.shortMessage || e?.message || e),
      reverted: isRevertError(e),
    }
  }
}

export async function codeAt(client, address, blockNumber) {
  const c = await retry(
    () =>
      client.getCode({
        address,
        blockNumber: blockNumber === undefined ? undefined : BigInt(blockNumber),
      }),
    3,
    300,
  )
  return c && c !== '0x' ? c : null
}

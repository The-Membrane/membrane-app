// Holder concentration of a voting token (owner ruling 2026-10-08, UQ-17): a token vote ranks by
// how many of its token's largest holders can pass a vote alone. This module rebuilds the
// holder set at any number of blocks in ONE streaming pass over the token's Transfer logs, and
// keeps only the top holders of each requested block (disk is tight: no raw logs and no full
// balance map are ever written).
//
//   holderSnapshots(...) → Map(block → { supply, holderCount, top: [[address, balance], …] }
//                                     | { error })
//
// Fail closed, at every step:
//   - every empty log chunk is asked again on a second endpoint (`crossCheckedLogs`; the shared
//     ring can return false-empty chunks); a chunk that cannot be read ends the stream, and every
//     snapshot at or after it is an error (a read gap: the vote ranks as a plain contract);
//   - every snapshot is VERIFIED on chain at its block (archive eth_call): the rebuilt total
//     supply must equal totalSupply() and EVERY kept (top-50) rebuilt balance must equal
//     balanceOf() — a lost chunk changes them. A mismatch, or a read that fails, is an error.
// Only verified snapshots are cached (top-50 per token per block), written atomically; a cache
// file that cannot be parsed is rebuilt, not a stop (fail-closed audit TV-15: one torn write
// stopped every later run).

import { existsSync, readFileSync } from 'fs'
import { keccak256, parseAbi, toHex } from 'viem'
import { writeJsonAtomic } from './files.mjs'
import { crossCheckedLogs, retry } from './rpc.mjs'

export const TOP_HOLDERS = 50
/**
 * Balances re-read on chain at each snapshot block (the cross-check of the rebuilt set).
 * Fail-closed audit (TV-16 / ST-09, 2026-10-10): every kept holder — the rules decide k and the
 * passing set from ranks up to 50, and only the ten largest were checked, so a lost transfer could
 * leave a wrong rank-11+ balance cached for good.
 */
export const VERIFY_TOP = TOP_HOLDERS
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'))
const ZERO = '0x0000000000000000000000000000000000000000'
const ERC20 = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

/** The `n` largest positive balances of a map, largest first (ties by address, for stability). */
export function topBalances(balances, n = TOP_HOLDERS) {
  const top = [] // ascending by balance; top[0] is the smallest kept
  for (const [a, b] of balances) {
    if (b <= 0n) continue
    if (top.length === n && b < top[0][1]) continue
    // insertion into a small sorted array
    let i = 0
    while (i < top.length && (top[i][1] < b || (top[i][1] === b && top[i][0] > a))) i++
    top.splice(i, 0, [a, b])
    if (top.length > n) top.shift()
  }
  return top.reverse()
}

/** Apply one Transfer log to the balance map; returns the supply delta (mint +, burn −). */
export function applyTransfer(balances, log) {
  if (!log.topics || log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER) return 0n
  const from = ('0x' + log.topics[1].slice(-40)).toLowerCase()
  const to = ('0x' + log.topics[2].slice(-40)).toLowerCase()
  const v = BigInt(log.data === '0x' ? 0 : log.data)
  if (v === 0n || from === to) return 0n
  let d = 0n
  if (from === ZERO) d += v
  else balances.set(from, (balances.get(from) ?? 0n) - v)
  if (to === ZERO) d -= v
  else balances.set(to, (balances.get(to) ?? 0n) + v)
  return d
}

/**
 * Verify one rebuilt snapshot at its block: totalSupply() and the VERIFY_TOP largest balances.
 * Returns null when every value matches, else why not (fail closed: a failed read is a mismatch).
 */
export async function verifySnapshot(state, token, block, snap) {
  try {
    const top = snap.top.slice(0, VERIFY_TOP)
    // one eth_call each (not Multicall3: it does not exist before block 14,353,601, and a voting
    // token's history starts earlier — LDO in 2020)
    const read = (functionName, args = []) =>
      retry(() =>
        state.readContract({
          address: token,
          abi: ERC20,
          functionName,
          args,
          blockNumber: BigInt(block),
        }),
      )
    const [supply, ...bals] = await Promise.all([
      read('totalSupply'),
      ...top.map(([a]) => read('balanceOf', [a])),
    ])
    if (BigInt(supply) !== BigInt(snap.supply))
      return `rebuilt supply ${snap.supply} ≠ totalSupply() ${supply}`
    for (const [i, [a, b]] of top.entries())
      if (BigInt(bals[i]) !== BigInt(b)) return `rebuilt balance of ${a} ≠ balanceOf() at the block`
    return null
  } catch (e) {
    return `verification read failed (${String(e?.shortMessage ?? e?.message ?? e).slice(0, 80)})`
  }
}

/**
 * Snapshots of `token`'s holders at each of `blocks` (state AFTER the block), rebuilt from its
 * Transfer logs from `from` (its first block with code). Cached snapshots are reused; the stream
 * runs only when a block is missing, and covers every missing block in one pass.
 *   logClients  { primary, secondary }  two independent log endpoints (cross-checked chunks)
 *   state       an archive client (verification)
 */
export async function holderSnapshots({
  logClients,
  state,
  token,
  from,
  blocks,
  cacheFile = null,
  span = 20_000,
  concurrency = 4,
  log = () => {},
}) {
  const t = token.toLowerCase()
  let cache = {}
  if (cacheFile && existsSync(cacheFile))
    try {
      cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
    } catch (e) {
      log(`  holder cache unreadable (${String(e?.message ?? e).slice(0, 60)}): rebuilt`)
      cache = {}
    }
  const out = new Map()
  const want = [...new Set(blocks.map(Number))].sort((a, b) => a - b)
  for (const b of want) {
    const c = cache[`${t}@${b}`]
    if (!c) continue
    // a snapshot cached under a shallower check (VERIFY_TOP was 10) is verified again
    if ((c.verifiedTop ?? 0) >= Math.min(VERIFY_TOP, c.top?.length ?? 0)) out.set(b, c)
    else if (state && !(await verifySnapshot(state, t, b, c))) {
      const v = { ...c, verifiedTop: Math.min(VERIFY_TOP, c.top?.length ?? 0) }
      cache[`${t}@${b}`] = v
      out.set(b, v)
    } else delete cache[`${t}@${b}`]
  }
  const todo = want.filter((b) => !out.has(b))
  if (!todo.length) return out
  const last = todo.at(-1)
  const chunks = []
  for (let a = from; a <= last; a += span) chunks.push([a, Math.min(last, a + span - 1)])
  const balances = new Map()
  let supply = 0n
  let next = 0 // index into todo
  let corrected = 0
  const fetchChunk = ([a, b]) =>
    crossCheckedLogs(logClients.primary, logClients.secondary, {
      address: t,
      topics0: [TRANSFER],
      fromBlock: a,
      toBlock: b,
    })
  const snapshotUpTo = (block) => {
    while (next < todo.length && todo[next] <= block) {
      const top = topBalances(balances)
      let holderCount = 0
      for (const v of balances.values()) if (v > 0n) holderCount++
      out.set(todo[next], {
        supply: supply.toString(),
        holderCount,
        top: top.map(([a, v]) => [a, v.toString()]),
      })
      next++
    }
  }
  const t0 = Date.now()
  const inflight = new Map()
  let failedAt = null
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i; j < Math.min(chunks.length, i + concurrency); j++)
      if (!inflight.has(j))
        inflight.set(
          j,
          fetchChunk(chunks[j]).catch((e) => ({ error: e })),
        )
    const r = await inflight.get(i)
    inflight.delete(i)
    if (r.error) {
      failedAt = chunks[i][0]
      break
    }
    if (r.corrected) corrected++
    const [a, b] = chunks[i]
    const logs = r.logs
      .filter((l) => !l.removed)
      .sort(
        (x, y) =>
          Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) ||
          Number(BigInt(x.logIndex) - BigInt(y.logIndex)),
      )
    // snapshots strictly before this chunk's first log block
    snapshotUpTo(a - 1)
    for (const l of logs) {
      const lb = Number(BigInt(l.blockNumber))
      snapshotUpTo(lb - 1)
      supply += applyTransfer(balances, l)
    }
    snapshotUpTo(b)
    if (i % 100 === 99)
      log(
        `  holders of ${t.slice(0, 10)}…: ${i + 1}/${chunks.length} chunks, ${balances.size} accounts, ${Math.round((Date.now() - t0) / 1000)} s`,
      )
  }
  // drain (a failure leaves requests in flight)
  await Promise.allSettled([...inflight.values()])
  if (corrected) log(`  holders of ${t.slice(0, 10)}…: ${corrected} false-empty chunk(s) corrected`)
  for (const b of todo) {
    if (failedAt !== null && b >= failedAt) {
      out.set(b, { error: `Transfer logs not read from block ${failedAt}` })
      continue
    }
    const snap = out.get(b)
    if (!snap) {
      out.set(b, { error: 'snapshot not rebuilt' })
      continue
    }
    const bad = state ? await verifySnapshot(state, t, b, snap) : 'not verified (no archive client)'
    if (bad) out.set(b, { error: `holder set not verified at block ${b}: ${bad}` })
    else cache[`${t}@${b}`] = { ...snap, verifiedTop: Math.min(VERIFY_TOP, snap.top.length) }
  }
  if (cacheFile) writeJsonAtomic(cacheFile, cache)
  return out
}

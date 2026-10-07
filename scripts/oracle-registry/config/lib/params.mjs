// Mint/redeem getters on an archive grid, bisected to the exact block of every change.
//
// Several issuers change caps without an event (Ethena's setGlobalMaxRedeemPerBlock emits
// none), so the getters themselves are the history: a weekly grid over the look-back window,
// then bisection between the two grid points that differ (log2(50,400) ≈ 16 multicalls per
// change). A change between grid points that is reverted before the next point (A→B→A within a
// week) is invisible to this method — events are the only way to see those (documented gap).

import { fnAbi } from './abi.mjs'
import { pool, retry } from './rpc.mjs'

const norm = (v) => {
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase()
  return v
}

/** Read every spec at one block with Multicall3. Returns key → value (undefined on failure). */
export async function readParams(client, specs, block) {
  const live = specs.filter((s) => !s.eventsOnly && s.sig)
  const res = await retry(() =>
    client.multicall({
      contracts: live.map((s) => {
        const abi = fnAbi(s.sig)
        return { address: s.contract, abi, functionName: abi[0].name, args: s.args ?? [] }
      }),
      allowFailure: true,
      blockNumber: block === undefined ? undefined : BigInt(block),
    }),
  )
  const out = {}
  live.forEach((s, i) => {
    const r = res[i]
    if (r.status !== 'success') return
    const v = Array.isArray(r.result) ? r.result[s.outputIndex ?? 0] : r.result
    if (s.count) {
      // `count`: a getter returning a list (HashConsensus getMembers()) is judged on its length
      // (a single-list output arrives as the list itself, several outputs as a tuple)
      const list = fnAbi(s.sig)[0].outputs.length > 1 ? v : r.result
      out[s.key] = Array.isArray(list) ? list.length : undefined
    } else out[s.key] = norm(v)
  })
  return out
}

const same = (a, b) => (a === undefined || b === undefined ? true : String(a) === String(b))

/**
 * Every value change of a getter between two reads (`lo` reads `before`, `hi` reads `last`),
 * each bisected to its exact block and carrying the value read THERE — a pair of changes
 * between two grid points (A → B → C) stays two changes, never one merged A → C row.
 * `read(block)` returns the value (undefined when unreadable: never counted as a change).
 */
export async function bisectChanges(read, { lo, before, hi, last }) {
  const out = []
  let from = lo
  let prev = before
  let guard = 0
  while (!same(prev, last) && guard++ < 64) {
    let a = from
    let b = hi
    let atB = last
    while (b - a > 1) {
      const m = Math.floor((a + b) / 2)
      const x = await read(m)
      if (x === undefined || same(x, prev)) a = m
      else {
        b = m
        atB = x
      }
    }
    out.push({ block: b, blockFrom: a, before: prev, after: atB })
    from = b
    prev = atB
  }
  return out
}

/**
 * Transitions of every spec over [from, head] on a `step`-block grid, each bisected to the
 * first block that reads the new value. Unreadable points never count as a change.
 */
export async function paramTransitions(
  client,
  specs,
  { from, head, step = 50_400, log = () => {} },
) {
  const grid = []
  for (let b = from; b < head; b += step) grid.push(b)
  grid.push(head)
  const reads = await pool(grid, 3, (b) => readParams(client, specs, b))
  log(`  params: ${grid.length} grid reads`)
  const out = []
  for (const s of specs.filter((x) => !x.eventsOnly && x.sig)) {
    let lastIdx = -1
    for (let i = 0; i < grid.length; i++) {
      const v = reads[i][s.key]
      if (v === undefined) continue
      if (lastIdx >= 0 && !same(reads[lastIdx][s.key], v)) {
        const steps = await bisectChanges(async (m) => (await readParams(client, [s], m))[s.key], {
          lo: grid[lastIdx],
          before: reads[lastIdx][s.key],
          hi: grid[i],
          last: v,
        })
        for (const t of steps) out.push({ key: s.key, contract: s.contract, ...t })
      }
      lastIdx = i
    }
  }
  return { transitions: out, head: reads[reads.length - 1] }
}

/**
 * The transaction at `block` that set `contract`'s getter to `value`: among the transactions
 * whose logs from the contract name the value (an address topic / word, or the number), the
 * only one; else the only transaction that touched the contract; else none (never a guess —
 * the FIRST log of the block can be an unrelated change of another getter).
 */
export function pickTx(logs, value) {
  const txs = [...new Set(logs.map((l) => l.transactionHash))]
  if (value !== undefined && value !== null) {
    const v = String(value).toLowerCase()
    const word = /^0x[0-9a-f]{40}$/.test(v)
      ? v.slice(2).padStart(64, '0')
      : /^\d+$/.test(v)
        ? BigInt(v).toString(16).padStart(64, '0')
        : null
    if (word) {
      const hit = [
        ...new Set(
          logs
            .filter((l) =>
              [
                ...(l.topics ?? []).slice(1),
                ...(String(l.data ?? '')
                  .slice(2)
                  .match(/.{64}/g) ?? []),
              ]
                .map((x) => String(x).toLowerCase().replace(/^0x/, ''))
                .includes(word),
            )
            .map((l) => l.transactionHash),
        ),
      ]
      if (hit.length === 1) return hit[0]
      if (hit.length > 1) return null
    }
  }
  return txs.length === 1 ? txs[0] : null
}

export async function txAtBlock(client, contract, block, value) {
  const hx = '0x' + block.toString(16)
  const logs = await retry(() =>
    client.request({
      method: 'eth_getLogs',
      params: [{ address: contract, fromBlock: hx, toBlock: hx }],
    }),
  )
  return pickTx(logs ?? [], value)
}

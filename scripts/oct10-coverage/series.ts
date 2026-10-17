/**
 * A verified per-minute eth_call series (one call per minute block), shared by the Aave and
 * Morpho oracle paths. Phases:
 *   1. fetch   every minute not yet in the checkpoint (bounded concurrency; the pool spreads load);
 *   2. verify  a deterministic >= 4% sample + every anomaly (revert, zero / null value, >20%
 *              one-minute jump in any column) on another backend group, byte-equal; repeat until
 *              no new anomaly appears (a replaced value can create or clear a jump);
 *   3. requery every minute answered by a host that was quarantined during the run.
 */
import type { Hex } from 'viem'
import { callParams, ethCall, load, save, type Ctx, type SavedAnswer } from './ctx'
import type { ChainKey } from './rpc'
import { JsonlStore, pmap, progress } from './store'
import { inSample, type Stored } from './verify'

export interface MinuteRow {
  mode: string
  a: SavedAnswer
  /** When the primary mode reverted and a fallback answered: the primary's revert, kept for verification. */
  primaryRevert?: SavedAnswer
}

export interface SeriesSpec {
  output: string
  chain: ChainKey
  blocks: number[]
  storePath: string
  /** The call for a mode. Mode 'primary' first; on a revert, `fallbackMode` if given. */
  call(mode: string): { to: string; data: Hex }
  fallbackMode?: string
  /** Column values (decimal strings or null) and per-column error notes for one minute. */
  decode(row: MinuteRow): { values: (string | null)[]; errors: (string | null)[] }
  columns: number
  concurrency?: number
}

export interface SeriesResult {
  values: (string | null)[][] // [column][minute]
  errors: Map<number, Map<number, string>> // column -> minute -> error
  hosts: string[]
  minuteHost: number[]
  modes: Record<string, number>
}

const JUMP = 0.2

export async function runSeries(ctx: Ctx, spec: SeriesSpec): Promise<SeriesResult> {
  const store = new JsonlStore<MinuteRow>(spec.storePath)
  const n = spec.blocks.length
  const key = (i: number) => `${spec.chain}:${i}`

  const fetchRow = async (i: number): Promise<MinuteRow> => {
    const b = spec.blocks[i]
    const p = spec.call('primary')
    const s = await ethCall(ctx, spec.chain, p.to, p.data, b)
    if (s.ans.revert && spec.fallbackMode) {
      const f = spec.call(spec.fallbackMode)
      const s2 = await ethCall(ctx, spec.chain, f.to, f.data, b)
      return { mode: spec.fallbackMode, a: save(s2), primaryRevert: save(s) }
    }
    return { mode: 'primary', a: save(s) }
  }

  // 1. fetch
  const todo = [...Array(n).keys()].filter((i) => !store.has(key(i)))
  const prog = progress(`${spec.output} ${spec.chain}`)
  let done = n - todo.length
  await pmap(todo, spec.concurrency ?? 8, async (i) => {
    store.put(key(i), await fetchRow(i))
    prog(++done, n)
  })

  // 2. verify
  const rowOf = (i: number) => store.get(key(i))!
  const checkOne = async (i: number, reason: 'sample' | 'anomaly' | 'requery') => {
    const row = rowOf(i)
    const b = spec.blocks[i]
    const c = spec.call(row.mode)
    const prim: Stored = load(row.a)
    const { keep, record } = await ctx.verifier.check(
      spec.output,
      spec.chain,
      `${key(i)}:${row.mode}`,
      'eth_call',
      callParams(c.to, c.data, b),
      prim,
      reason,
    )
    if (record.resolution === 'check') store.put(key(i), { ...row, a: save(keep) })
    if (row.primaryRevert) {
      // The primary call's revert is itself an anomaly: confirm it on another backend.
      const p = spec.call('primary')
      const pr = load(row.primaryRevert)
      const r2 = await ctx.verifier.check(
        spec.output,
        spec.chain,
        `${key(i)}:primary-revert`,
        'eth_call',
        callParams(p.to, p.data, b),
        pr,
        'anomaly',
      )
      if (r2.record.resolution === 'check') {
        // Another backend answers the batch call: refetch the minute from scratch.
        store.put(key(i), await fetchRow(i))
      }
    }
  }
  const decodeAll = () => [...Array(n).keys()].map((i) => spec.decode(rowOf(i)))
  const checkedKey = (i: number) => ctx.verifier.checked(spec.output, `${key(i)}:${rowOf(i).mode}`)
  for (let round = 0; round < 4; round++) {
    const dec = decodeAll()
    const anomalies = new Set<number>()
    for (let i = 0; i < n; i++) {
      const row = rowOf(i)
      if (row.a.rev !== undefined || row.primaryRevert) anomalies.add(i)
      for (let c = 0; c < spec.columns; c++) {
        const v = dec[i].values[c]
        if (v === null || v === '0') anomalies.add(i)
        if (i > 0) {
          const p = dec[i - 1].values[c]
          if (v !== null && p !== null && p !== '0') {
            const rel = Math.abs(Number(BigInt(v) - BigInt(p))) / Number(BigInt(p))
            if (rel > JUMP) {
              anomalies.add(i)
              anomalies.add(i - 1)
            }
          }
        }
      }
    }
    const picks = [...Array(n).keys()].filter(
      (i) => (inSample(key(i)) || anomalies.has(i)) && !checkedKey(i),
    )
    process.stderr.write(
      `[${spec.output} ${spec.chain}] verify round ${round}: ${picks.length} to check (${anomalies.size} anomalous minutes)\n`,
    )
    if (!picks.length) break
    await pmap(picks, 6, (i) => checkOne(i, anomalies.has(i) ? 'anomaly' : 'sample'))
  }

  // 3. requery answers from quarantined hosts
  const tainted = [...Array(n).keys()].filter((i) =>
    ctx.pool.isQuarantined(spec.chain, rowOf(i).a.host),
  )
  if (tainted.length) {
    process.stderr.write(
      `[${spec.output} ${spec.chain}] requery ${tainted.length} minutes from quarantined hosts\n`,
    )
    await pmap(tainted, 6, async (i) => {
      const row = rowOf(i)
      const c = spec.call(row.mode)
      const fresh = await ethCall(ctx, spec.chain, c.to, c.data, spec.blocks[i])
      const agree = fresh.norm === load(row.a).norm
      ctx.verifier.log.put(`${spec.output}|${key(i)}:${row.mode}:requery`, {
        output: spec.output,
        chain: spec.chain,
        reason: 'requery',
        primaryHost: row.a.host,
        primaryGroup: row.a.group,
        checkHost: fresh.host,
        checkGroup: fresh.group,
        agree,
        resolution: agree ? 'agree' : 'check',
      })
      if (!agree) store.put(key(i), { ...row, a: save(fresh) })
    })
  }

  const dec = decodeAll()
  const hosts: string[] = []
  const minuteHost = [...Array(n).keys()].map((i) => {
    const h = rowOf(i).a.host
    let k = hosts.indexOf(h)
    if (k < 0) k = hosts.push(h) - 1
    return k
  })
  const errors = new Map<number, Map<number, string>>()
  const values = [...Array(spec.columns).keys()].map((c) =>
    dec.map((d, i) => {
      if (d.errors[c]) {
        if (!errors.has(c)) errors.set(c, new Map())
        errors.get(c)!.set(i, d.errors[c]!)
      }
      return d.values[c]
    }),
  )
  const modes: Record<string, number> = {}
  for (let i = 0; i < n; i++) modes[rowOf(i).mode] = (modes[rowOf(i).mode] ?? 0) + 1
  return { values, errors, hosts, minuteHost, modes }
}

/** Run-length summary of errors per column: [{from, to, reason}]. */
export function errorRuns(m: Map<number, string> | undefined) {
  if (!m) return []
  const out: { from: number; to: number; reason: string }[] = []
  for (const [i, r] of [...m].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1]
    if (last && last.to === i - 1 && last.reason === r) last.to = i
    else out.push({ from: i, to: i, reason: r })
  }
  return out
}

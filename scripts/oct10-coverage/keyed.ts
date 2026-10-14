/**
 * Keyed eth_call cache with verification, for the per-event reads (per-(chain, block) and
 * per-(chain, user, block) multicalls). Same rules as the minute series: a deterministic >= 4%
 * sample plus every anomaly the caller flags is re-asked on another backend group; answers from a
 * host quarantined later in the run are re-asked.
 */
import type { Hex } from 'viem'
import { callParams, ethCall, load, save, type Ctx, type SavedAnswer } from './ctx'
import type { ChainKey } from './rpc'
import { JsonlStore, pmap } from './store'
import { inSample, type Stored } from './verify'

export interface KeyedCall {
  key: string
  chain: ChainKey
  to: string
  data: Hex
  block: number
}

export class KeyedCalls {
  readonly store: JsonlStore<
    SavedAnswer & { to: string; data: string; block: number; chain: ChainKey }
  >
  constructor(
    readonly ctx: Ctx,
    readonly output: string,
    path: string,
  ) {
    this.store = new JsonlStore(path)
  }

  get(key: string): Stored | undefined {
    const s = this.store.get(key)
    return s ? load(s) : undefined
  }

  async fetch(c: KeyedCall): Promise<Stored> {
    const got = this.store.get(c.key)
    if (got) return load(got)
    const s = await ethCall(this.ctx, c.chain, c.to, c.data, c.block)
    this.store.put(c.key, { ...save(s), to: c.to, data: c.data, block: c.block, chain: c.chain })
    return s
  }

  async fetchAll(calls: KeyedCall[], conc = 8, onDone?: (n: number) => void) {
    let n = 0
    await pmap(calls, conc, async (c) => {
      await this.fetch(c)
      onDone?.(++n)
    })
  }

  /** Verify a key on another backend group; returns true when the stored answer changed. */
  async verify(key: string, reason: 'sample' | 'anomaly'): Promise<boolean> {
    const row = this.store.get(key)
    if (!row) throw new Error(`verify: no ${key}`)
    const { keep, record } = await this.ctx.verifier.check(
      this.output,
      row.chain,
      key,
      'eth_call',
      callParams(row.to, row.data as Hex, row.block),
      load(row),
      reason,
    )
    if (record.resolution === 'check') {
      this.store.put(key, { ...row, ...save(keep) })
      return true
    }
    return false
  }

  /** Sample + anomalies; returns keys whose answer changed. */
  async verifyAll(
    keys: string[],
    anomalous: Set<string>,
    conc = 6,
    every = false,
  ): Promise<string[]> {
    // `every`: re-ask every key (small sets, where a 4% hash sample could pick none).
    const picks = keys.filter(
      (k) =>
        (every || inSample(k) || anomalous.has(k)) && !this.ctx.verifier.checked(this.output, k),
    )
    const changed: string[] = []
    await pmap(picks, conc, async (k) => {
      if (await this.verify(k, anomalous.has(k) ? 'anomaly' : 'sample')) changed.push(k)
    })
    return changed
  }

  /** Re-ask everything a quarantined host answered. Returns keys whose answer changed. */
  async requeryTainted(keys: string[], conc = 6): Promise<string[]> {
    const tainted = keys.filter((k) => {
      const r = this.store.get(k)
      return r && this.ctx.pool.isQuarantined(r.chain, r.host)
    })
    const changed: string[] = []
    await pmap(tainted, conc, async (k) => {
      const row = this.store.get(k)!
      const fresh = await ethCall(this.ctx, row.chain, row.to, row.data as Hex, row.block)
      const agree = fresh.norm === load(row).norm
      this.ctx.verifier.log.put(`${this.output}|${k}:requery`, {
        output: this.output,
        chain: row.chain,
        reason: 'requery',
        primaryHost: row.host,
        primaryGroup: row.group,
        checkHost: fresh.host,
        checkGroup: fresh.group,
        agree,
        resolution: agree ? 'agree' : 'check',
      })
      if (!agree) {
        this.store.put(k, { ...row, ...save(fresh) })
        changed.push(k)
      }
    })
    return changed
  }
}

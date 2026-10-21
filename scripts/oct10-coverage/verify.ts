/**
 * Cross-verification of stored RPC answers.
 *
 * A primary answer is believed only after a deterministic sample (and every anomalous value) has
 * been re-asked on a DIFFERENT backend group and come back byte-equal. On disagreement a third
 * group decides: the host that loses the 2-of-3 vote is quarantined for the rest of the run, and
 * the caller re-asks everything that host answered. Every check is appended to a JSONL ledger so
 * the statistics survive restarts and land in the outputs.
 */
import { JsonlStore, sampleFrac } from './store'
import { NoBackendError, normalizeAnswer, type ChainKey, type RpcAnswer, type RpcPool } from './rpc'

export type CheckReason = 'sample' | 'anomaly' | 'requery'

export interface CheckRecord {
  output: string
  chain: ChainKey
  reason: CheckReason
  primaryHost: string
  primaryGroup: string
  checkHost?: string
  checkGroup?: string
  agree: boolean
  thirdHost?: string
  /** primary = primary kept, check = replaced by the checker's answer, unresolved = no majority / no backend. */
  resolution: 'agree' | 'primary' | 'check' | 'unresolved'
  note?: string
}

export interface Stored {
  /** Normalized answer (lower-case hex, or 'REVERT'). */
  norm: string
  host: string
  group: string
  /** Raw answer, for decoding. */
  ans: RpcAnswer
}

export const SAMPLE_RATE = 0.04

export function inSample(key: string, rate = SAMPLE_RATE) {
  return sampleFrac(key) < rate
}

export class Verifier {
  readonly log: JsonlStore<CheckRecord>
  constructor(
    readonly pool: RpcPool,
    path: string,
  ) {
    this.log = new JsonlStore<CheckRecord>(path)
  }

  checked(output: string, key: string) {
    return this.log.get(`${output}|${key}`)
  }

  /**
   * Re-ask `method(params)` on another group than `primary`'s and compare. Returns the answer to
   * keep (which is the primary unless a third backend sided with the checker).
   */
  async check(
    output: string,
    chain: ChainKey,
    key: string,
    method: string,
    params: unknown[],
    primary: Stored,
    reason: CheckReason,
    normalize: (a: RpcAnswer) => string = normalizeAnswer,
    kind: 'call' | 'logs' = 'call',
  ): Promise<{ keep: Stored; record: CheckRecord }> {
    const lk = `${output}|${key}`
    const prev = this.log.get(lk)
    // Already decided in an earlier run, and the caller stored the winner. (A 'check' record whose
    // primary is still the stored answer means the run died before the caller saved the
    // replacement: decide again.)
    if (
      prev &&
      prev.resolution !== 'unresolved' &&
      !(prev.resolution === 'check' && prev.primaryHost === primary.host)
    ) {
      return { keep: primary, record: prev }
    }
    const rec: CheckRecord = {
      output,
      chain,
      reason,
      primaryHost: primary.host,
      primaryGroup: primary.group,
      agree: false,
      resolution: 'unresolved',
    }
    let second: RpcAnswer
    try {
      second = await this.pool.request(chain, method, params, {
        excludeGroups: [primary.group],
        excludeHosts: [primary.host],
        kind,
      })
    } catch (e) {
      rec.note =
        e instanceof NoBackendError
          ? 'no independent backend'
          : String((e as Error).message).slice(0, 200)
      this.log.put(lk, rec)
      return { keep: primary, record: rec }
    }
    rec.checkHost = second.host
    rec.checkGroup = second.group
    const n2 = normalize(second)
    if (n2 === primary.norm) {
      rec.agree = true
      rec.resolution = 'agree'
      this.log.put(lk, rec)
      return { keep: primary, record: rec }
    }
    // Disagreement: a third, independent backend decides.
    let third: RpcAnswer | null = null
    try {
      third = await this.pool.request(chain, method, params, {
        excludeGroups: [primary.group, second.group],
        kind,
      })
    } catch (e) {
      rec.note = `disagree; third: ${e instanceof NoBackendError ? 'no third backend' : String((e as Error).message).slice(0, 160)}`
    }
    if (third) {
      rec.thirdHost = third.host
      const n3 = normalize(third)
      if (n3 === primary.norm) {
        rec.resolution = 'primary'
        this.pool.quarantine(
          chain,
          second.host,
          `${output} ${key}: disagreed with ${primary.host} and ${third.host}`,
        )
      } else if (n3 === n2) {
        rec.resolution = 'check'
        this.pool.quarantine(
          chain,
          primary.host,
          `${output} ${key}: disagreed with ${second.host} and ${third.host}`,
        )
        this.log.put(lk, rec)
        return {
          keep: { norm: n2, host: second.host, group: second.group, ans: second },
          record: rec,
        }
      } else {
        rec.note = 'three-way disagreement'
      }
    }
    this.log.put(lk, rec)
    return { keep: primary, record: rec }
  }

  stats(output: string, chain?: ChainKey) {
    const rows = [...this.log.map.values()].filter(
      (r) => r.output === output && (!chain || r.chain === chain),
    )
    const by = (f: (r: CheckRecord) => boolean) => rows.filter(f).length
    return {
      checked: rows.length,
      sample: by((r) => r.reason === 'sample'),
      anomaly: by((r) => r.reason === 'anomaly'),
      requery: by((r) => r.reason === 'requery'),
      agree: by((r) => r.resolution === 'agree'),
      disagree: by((r) => !r.agree && !!r.checkHost),
      keptPrimary: by((r) => r.resolution === 'primary'),
      replacedByCheck: by((r) => r.resolution === 'check'),
      unresolved: by((r) => r.resolution === 'unresolved'),
      unresolvedNotes: [
        ...new Set(rows.filter((r) => r.resolution === 'unresolved').map((r) => r.note ?? '')),
      ].slice(0, 10),
      checkHosts: countBy(rows.map((r) => r.checkHost ?? 'none')),
    }
  }
}

function countBy(xs: string[]) {
  const m: Record<string, number> = {}
  for (const x of xs) m[x] = (m[x] ?? 0) + 1
  return m
}

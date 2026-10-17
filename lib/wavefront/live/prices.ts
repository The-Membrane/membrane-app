/**
 * Minute prices of one chain: ONE Multicall3 at the block in force at the minute start —
 * AaveOracle.getAssetsPrices for the reserves the open Aave positions hold (one sub-call per
 * pool oracle; a Morpho loan token is priced from the Core market's oracle), and price() of every
 * open Morpho oracle. The same values the Oct 10 pull's minute paths hold:
 * getAssetsPrices(list)[i] is getAssetPrice(list[i]); when one source reverts the batch reverts,
 * and the assets are re-read one by one (the pull's rule).
 *
 * Keys: `aave:<oracle>:<asset>` and `morpho:<oracle>`. Values are the raw decimal strings the pull
 * stored (null = missing, zero or reverting), and a ratio is Number(price(m)) / Number(price(N)) —
 * bit for bit the census's column arithmetic.
 *
 * NO SILENT CARRY-FORWARD. A key that comes back missing is re-read once on another backend group
 * (`retryMissing`); what is still missing is reported to the engine, which does not step the
 * position that minute (a `gap`, counted and flagged on the next tick).
 */
import { morphoOracleAbi, oracleAbi, type SubCall } from '../../../scripts/oct10-coverage/abi'
import type { ChainKey } from '../../../scripts/oct10-coverage/rpc'
import { multicall } from './calls'
import type { LiveRpc } from './rpc'

export const aaveKey = (oracle: string, asset: string) =>
  `aave:${oracle.toLowerCase()}:${asset.toLowerCase()}`
export const morphoKey = (oracle: string) => `morpho:${oracle.toLowerCase()}`

interface MinuteRow {
  block: number
  values: Map<string, string | null>
  /** Backend group that answered each key's read. */
  group: Map<string, string>
}

export class MinutePrices {
  private rows = new Map<number, MinuteRow>()
  multicalls = 0
  retries = 0

  constructor(
    readonly rpc: LiveRpc,
    readonly chain: ChainKey,
  ) {}

  private async read(row: MinuteRow, keys: string[], excludeGroups?: string[]) {
    const aave = new Map<string, string[]>()
    const morpho: string[] = []
    for (const k of keys) {
      const [kind, oracle, asset] = k.split(':')
      if (kind === 'aave') aave.set(oracle, [...(aave.get(oracle) ?? []), asset])
      else morpho.push(oracle)
    }
    const calls: SubCall[] = [
      ...[...aave].map(([oracle, assets]) => ({
        target: oracle,
        abi: oracleAbi,
        fn: 'getAssetsPrices',
        args: [assets],
      })),
      ...morpho.map((o) => ({ target: o, abi: morphoOracleAbi, fn: 'price' })),
    ]
    this.multicalls++
    const meta: { group?: string } = {}
    const opts = excludeGroups ? { excludeGroups } : undefined
    const res = await multicall(this.rpc, this.chain, calls, row.block, opts, meta)
    const set = (k: string, v: bigint | null) => {
      row.values.set(k, v != null && v > 0n ? v.toString() : null)
      row.group.set(k, meta.group ?? '')
    }
    let i = 0
    for (const [oracle, assets] of aave) {
      const r = res[i++]
      if (r.ok) {
        const v = r.value as readonly bigint[]
        if (v.length !== assets.length) throw new Error(`${this.chain}: getAssetsPrices length mismatch`)
        assets.forEach((a, j) => set(aaveKey(oracle, a), v[j]))
      } else {
        // One reverting source reverts the batch: every asset on its own.
        this.multicalls++
        const per = await multicall(
          this.rpc,
          this.chain,
          assets.map((a) => ({ target: oracle, abi: oracleAbi, fn: 'getAssetPrice', args: [a] })),
          row.block,
          opts,
          meta,
        )
        assets.forEach((a, j) => set(aaveKey(oracle, a), per[j].ok ? (per[j].value as bigint) : null))
      }
    }
    for (const o of morpho) {
      const r = res[i++]
      set(morphoKey(o), r.ok ? (r.value as bigint) : null)
    }
  }

  /** Read every key not yet known for `minute` at `block`. */
  async ensure(minute: number, block: number, keys: Iterable<string>) {
    let row = this.rows.get(minute)
    if (row && row.block !== block) throw new Error(`${this.chain} minute ${minute}: block changed`)
    if (!row) {
      row = { block, values: new Map(), group: new Map() }
      this.rows.set(minute, row)
    }
    const missing = [...new Set([...keys].map((k) => k.toLowerCase()))].filter((k) => !row!.values.has(k))
    if (missing.length) await this.read(row, missing)
  }

  /**
   * Re-read the keys that are missing (null) at `minute` on another backend group. Returns the
   * keys still missing afterwards.
   */
  async retryMissing(minute: number, keys: Iterable<string>): Promise<string[]> {
    const row = this.rows.get(minute)
    if (!row) throw new Error(`${this.chain} minute ${minute}: not read`)
    const missing = [...new Set(keys)].filter((k) => row.values.get(k) == null)
    if (!missing.length) return []
    this.retries++
    const groups = [...new Set(missing.map((k) => row.group.get(k) ?? ''))].filter(Boolean)
    try {
      await this.read(row, missing, groups)
    } catch {
      // No other backend (or it failed too): the keys stay missing.
    }
    return missing.filter((k) => row.values.get(k) == null)
  }

  block(minute: number): number | undefined {
    return this.rows.get(minute)?.block
  }

  /** Raw price at a minute; null = missing; undefined = not read. */
  get(minute: number, key: string): string | null | undefined {
    return this.rows.get(minute)?.values.get(key.toLowerCase())
  }

  /** Drop minutes before `minute`. */
  prune(minute: number) {
    for (const m of this.rows.keys()) if (m < minute) this.rows.delete(m)
  }
}

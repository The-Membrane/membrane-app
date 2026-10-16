/**
 * RELATIONS: how a viewer is tied to each market, from an ExposureReport (resolve.ts) and
 * a chosen curator. Pure.
 *
 *   direct        the address has a Morpho Blue position in the market (supply, borrow
 *                 or collateral), read on chain
 *   via-vault     the address holds shares in a vault the exposure data lists for the
 *                 market, read on chain
 *   same-curator  the chosen curator runs a vault the exposure data lists for the market
 *
 * A market carries its strongest kind (direct, then via-vault, then same-curator) and
 * every role that applies. `usd`:
 *   via-vault     the address's pro-rata part of those vaults' allocations at the last
 *                 exposure read: convertToAssets(shares) / totalAssets() × allocation USD.
 *                 Undefined when an asset read failed. The allocation is not live (it is
 *                 as of the exposure read), and in a supply-locked market it is book value
 *                 (`book`), never live supply.
 *   same-curator  the curator's vaults' allocations at the last exposure read.
 *   direct        undefined: no live loan-token price is read here.
 *
 * A market whose read failed, or that no resolver checked, is `unchecked`, never "none".
 */

import type { ExposureReport, ExposureTargets, Holding } from './resolve'

export type RelationKind = 'direct' | 'via-vault' | 'same-curator'
export type RelationRole = 'supply' | 'borrow' | 'collateral' | 'vault' | 'curator'

export interface Relation {
  kind: RelationKind
  roles: RelationRole[]
  /** 'morpho-blue' for a direct position, then the vault addresses (lowercase). */
  path: string[]
  vaultNames: string[]
  curatorName?: string
  usd?: number
  /** `usd` is book value: the market's supply is locked. */
  book: boolean
}

/** The slice of a market view (lib/curatorFeed/service.ts OracleGapMarketView) used here. */
export interface RelationMarket {
  market: string
  locked: boolean
  vaults: { vault: string; vaultName: string; curatorName: string; usd?: number }[]
}

/** Every vault and market id the markets list, lowercase and deduplicated. */
export function exposureTargets(markets: readonly RelationMarket[]): ExposureTargets {
  return {
    vaults: [...new Set(markets.flatMap((m) => m.vaults.map((v) => v.vault.toLowerCase())))],
    markets: [...new Set(markets.map((m) => m.market.toLowerCase()))],
  }
}

/** Curator names across the markets' vaults, named ones first, then addresses. */
export function curatorsOf(markets: readonly RelationMarket[]): string[] {
  const names = [...new Set(markets.flatMap((m) => m.vaults.map((v) => v.curatorName)))]
  const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)
  return names.sort(
    (a, b) =>
      Number(isAddr(a)) - Number(isAddr(b)) || a.localeCompare(b, 'en', { sensitivity: 'base' }),
  )
}

const KIND_ORDER: RelationKind[] = ['direct', 'via-vault', 'same-curator']

export function relationsOf(
  markets: readonly RelationMarket[],
  report: ExposureReport | undefined,
  curator: string | undefined,
): Map<string, Relation> {
  const vaultHeld = new Map<string, Extract<Holding, { kind: 'vault' }>>()
  const direct = new Map<string, Extract<Holding, { kind: 'market' }>>()
  for (const r of report?.results ?? [])
    for (const h of r.holdings)
      if (h.kind === 'vault') vaultHeld.set(h.vault, h)
      else direct.set(h.market, h)

  const out = new Map<string, Relation>()
  for (const m of markets) {
    const id = m.market.toLowerCase()
    const roles: RelationRole[] = []
    const kinds: RelationKind[] = []
    const path: string[] = []
    const vaultNames: string[] = []
    let usd: number | undefined
    const p = direct.get(id)
    if (p) {
      kinds.push('direct')
      path.push('morpho-blue')
      if (p.supplyShares > 0n) roles.push('supply')
      if (p.borrowShares > 0n) roles.push('borrow')
      if (p.collateral > 0n) roles.push('collateral')
    }
    const mine = m.vaults.filter((v) => vaultHeld.has(v.vault.toLowerCase()))
    if (mine.length) {
      kinds.push('via-vault')
      roles.push('vault')
      let sum: number | undefined = 0
      for (const v of mine) {
        const h = vaultHeld.get(v.vault.toLowerCase())!
        path.push(h.vault)
        vaultNames.push(v.vaultName)
        if (sum === undefined) continue
        if (h.assets === undefined || h.totalAssets === undefined || v.usd === undefined)
          sum = undefined
        else if (h.totalAssets > 0n) sum += ratio(h.assets, h.totalAssets) * v.usd
      }
      usd = sum
    }
    const curated = curator ? m.vaults.filter((v) => v.curatorName === curator) : []
    if (curated.length) {
      kinds.push('same-curator')
      roles.push('curator')
      if (!mine.length) {
        for (const v of curated) path.push(v.vault.toLowerCase())
        vaultNames.push(...curated.map((v) => v.vaultName))
        usd = curated.every((v) => v.usd !== undefined)
          ? curated.reduce((s, v) => s + (v.usd ?? 0), 0)
          : undefined
      }
    }
    if (!kinds.length) continue
    const kind = KIND_ORDER.find((k) => kinds.includes(k))!
    out.set(id, {
      kind,
      roles,
      path,
      vaultNames,
      ...(curated.length ? { curatorName: curator } : {}),
      ...(kind === 'direct' ? {} : usd !== undefined ? { usd } : {}),
      book: m.locked,
    })
  }
  return out
}

/** Each market with its relation attached (`relation` absent: no tie found or checked). */
export function withRelations<T extends RelationMarket>(
  markets: readonly T[],
  relations: ReadonlyMap<string, Relation>,
): (T & { relation?: Relation })[] {
  return markets.map((m) => {
    const relation = relations.get(m.market.toLowerCase())
    return relation ? { ...m, relation } : m
  })
}

/** assets / total as a float, exact enough for a display share (both bigint). */
function ratio(assets: bigint, total: bigint): number {
  const SCALE = 10n ** 12n
  return Number((assets * SCALE) / total) / 1e12
}

/**
 * Markets whose tie to the address is unknown: a resolver errored or was not run, or the
 * read of the market (position) or of one of its vaults (balanceOf) failed.
 */
export function uncheckedMarkets(
  markets: readonly RelationMarket[],
  report: ExposureReport | undefined,
): string[] {
  if (!report) return []
  const checked = new Set<string>()
  const fully: Record<string, boolean> = {}
  for (const r of report.results) {
    fully[r.id] = r.status === 'ok' || r.status === 'empty'
    for (const c of r.checked) checked.add(`${r.id}:${c}`)
  }
  return markets
    .filter((m) => {
      const id = m.market.toLowerCase()
      if (!fully['morpho-blue'] || !checked.has(`morpho-blue:${id}`)) return true
      if (!m.vaults.length) return false
      return (
        !fully['vault-shares'] ||
        m.vaults.some((v) => !checked.has(`vault-shares:${v.vault.toLowerCase()}`))
      )
    })
    .map((m) => m.market.toLowerCase())
}

/** The tag a related card carries: "you supply · your vault", "curated by Gauntlet". */
export function relationTag(r: Relation): string {
  const parts: string[] = []
  if (r.roles.includes('supply')) parts.push('you supply')
  if (r.roles.includes('borrow')) parts.push('you borrow')
  else if (r.roles.includes('collateral')) parts.push('your collateral')
  if (r.roles.includes('vault'))
    parts.push(
      r.vaultNames.length === 1
        ? `your vault ${r.vaultNames[0]}`
        : `your ${r.vaultNames.length} vaults`,
    )
  if (r.roles.includes('curator') && r.curatorName)
    parts.push(`curated by ${shortName(r.curatorName)}`)
  return parts.join(' · ')
}

/** An unnamed curator is its address: "0x1239…ecf6". */
export const shortName = (s: string): string =>
  /^0x[0-9a-fA-F]{40}$/.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s

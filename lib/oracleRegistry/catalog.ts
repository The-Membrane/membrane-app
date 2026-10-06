// Typed loader for the oracle registry catalog (data/oracle-registry/catalog.json).
//
// One entry per (asset, oracle): the same contract can appear under two assets when a
// market prices one asset with another's feed (Aave prices cbBTC with BTC/USD), because
// the CLASS and CONSENSUS ROLE differ per asset. Every address was verified on-chain by
// scripts/oracle-registry/verify-catalog.mjs, which also rewrites the `status*` fields —
// so the JSON's inferred type is NOT trusted here: the shapes are pinned below and the
// file is validated at load time (a bad enum throws instead of rendering a wrong card).

import catalogJson from '@/data/oracle-registry/catalog.json'

export const ORACLE_CLASSES = [
  'market',
  'exchange_rate',
  'capped_exchange_rate',
  'fixed',
  'composite',
  'twap',
] as const
export const QUOTE_UNITS = ['USD', 'ETH', 'BTC', 'underlying', 'rate'] as const
export const HISTORY_SOURCES = [
  'chainlink_rounds',
  'events',
  'archive_sampling',
  'none_public',
] as const
export const PROVIDERS = [
  'chainlink',
  'chronicle',
  'redstone',
  'pyth',
  'aave',
  'spark',
  'morpho',
  'liquity',
  'uniswap_v3',
  'pendle',
] as const
export const CONSENSUS_ROLES = ['member', 'alternate', 'derived', 'basis'] as const
export const UPDATE_MODELS = [
  'push_deviation_heartbeat',
  'pull',
  'on_read_view',
  'on_interaction',
  'twap',
] as const

export type OracleClass = (typeof ORACLE_CLASSES)[number]
export type QuoteUnit = (typeof QUOTE_UNITS)[number]
export type HistorySource = (typeof HISTORY_SOURCES)[number]
export type OracleProvider = (typeof PROVIDERS)[number]
/**
 * member    — counted in the asset's consensus median (one per provider family).
 * alternate — another market feed from a family that already has a member.
 * derived   — computed only from member feeds (a median-of or product-of members).
 * basis     — exchange-rate / capped / fixed / peg-assumed: legitimately differs from
 *             market; shown with a basis bar, never coloured as an outlier naively.
 */
export type ConsensusRole = (typeof CONSENSUS_ROLES)[number]
export type UpdateModel = (typeof UPDATE_MODELS)[number]
export type Address = `0x${string}`

export type OracleComponent = {
  role: string
  address: Address
  label: string
  /** Zero-arg getter on the entry contract that returns this component (checked on-chain). */
  getter?: string
  /** 'struct0' = the getter returns a struct whose first field is the address. */
  getterKind?: 'struct0'
  /** Catalog id of the component when it is itself an entry. */
  ref?: string
  /**
   * A nested leg: the getter is called on the component with this role, not on the entry
   * (e.g. the USDT/USD feed behind a capped adapter the entry reads). Lets a view whose
   * direct inputs carry no clock still inherit the age of the feed underneath.
   */
  via?: string
  /**
   * The leg's own heartbeat when it is NOT a catalog entry (a ref'd leg uses its entry's).
   * Without it a leg would be judged against the entry's heartbeat, which for a multi-leg
   * view is the slowest leg's — a 1 h feed 20 h stale would pass as fresh.
   */
  heartbeatSeconds?: number
  /** The leg's updatedAt is the read time (block.timestamp), not an update: no clock. */
  timestampIsReadTime?: boolean
}

export type GovernanceParam = {
  param: string
  steeredBy: string
  setter?: string
  /** Event to index for config-change alerts, e.g. CapParametersUpdated(...). */
  event?: string
  note?: string
}

export type ParamCheck = { getter: string; expected: string; kind?: 'address' }

export type OracleMechanism = {
  source: string
  aggregation: string
  updateModel: UpdateModel
  heartbeatSeconds: number | null
  deviationThresholdBps: number | null
  twapWindowSeconds?: number
  fallback?: string
  pegAssumption?: string
  cap?: Record<string, string | number>
  discount?: Record<string, string | number>
  governance: GovernanceParam[]
  components: OracleComponent[]
  paramChecks?: ParamCheck[]
  twap?: {
    factory: Address
    fee: number
    baseToken: Address
    quoteToken: Address
    baseDecimals: number
    quoteDecimals: number
  }
  dataFeedId?: string
  access?: string
  publicRead?: 'open' | 'zero_address_only'
  offchainLatestUrl?: string
  /**
   * The timestamp this contract returns is the READ time (block.timestamp), not the time
   * of an update (Spark's median oracles). Its age is then its components' ages instead.
   */
  timestampIsReadTime?: boolean
  notes?: string
}

export type UsedByCheck =
  | { type: 'aave_source'; oracle: Address; asset: Address }
  | { type: 'morpho_market'; morpho: Address; marketId: `0x${string}` }
  | { type: 'liquity_registry'; registry: Address }

export type UsedBy = {
  protocol: string
  market: string
  /** direct = the market reads this contract; component = it feeds an oracle the market reads. */
  kind: 'direct' | 'component'
  marketId?: string
  /** Morpho borrow snapshot on catalog generation day. */
  borrowUsd?: number
  check?: UsedByCheck
}

export type OracleEntry = {
  id: string
  asset: string
  provider: OracleProvider
  label: string
  address: Address
  chainId: 1
  readMethod: string
  readArgs?: string[]
  /** Raw answer decimals; null for Uniswap TWAPs (price derives from ticks). */
  decimals: number | null
  quoteUnit: QuoteUnit
  quoteAsset?: string
  class: OracleClass
  consensus: { role: ConsensusRole; note: string }
  mechanism: OracleMechanism
  usedBy: UsedBy[]
  historySource: HistorySource
  historyNote?: string
  docsUrl: string
  expect?: { description?: string; wat?: string }
  status: 'verified' | 'unverified'
  statusReason?: string
  verifiedAt?: string
  verifiedBlock?: number
}

export type CatalogAsset = {
  key: string
  symbol: string
  token: Address | null
  tokenDecimals: number | null
  kind: 'mvp' | 'reference'
  /** Accepted price range per quote unit — the verifier's sanity gate. */
  sanity: Partial<Record<QuoteUnit, [number, number]>>
  maturity?: number
  note?: string
}

export type OracleCatalog = {
  version: number
  chainId: 1
  generatedAt: string
  sources: string[]
  consensusPolicy: string
  stalenessPolicy: string
  assets: CatalogAsset[]
  entries: OracleEntry[]
  excluded: { asset: string; provider: string; reason: string }[]
}

// ---- validation ---------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function oneOf<T extends string>(list: readonly T[], value: unknown, where: string): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) {
    throw new Error(
      `oracle catalog: ${where} = ${JSON.stringify(value)} is not one of ${list.join(', ')}`,
    )
  }
  return value as T
}

function address(value: unknown, where: string): Address {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value))
    throw new Error(`oracle catalog: ${where} is not an address`)
  return value as Address
}

/** Validates the enums, addresses and cross-references; returns the typed catalog. */
export function parseCatalog(raw: unknown): OracleCatalog {
  const c = raw as OracleCatalog
  if (!c || c.chainId !== 1 || !Array.isArray(c.entries) || !Array.isArray(c.assets)) {
    throw new Error('oracle catalog: missing chainId 1 / entries / assets')
  }
  const assetKeys = new Set(c.assets.map((a) => a.key))
  const ids = new Set<string>()
  for (const e of c.entries) {
    const at = `entry ${e?.id}`
    if (!e.id || ids.has(e.id)) throw new Error(`oracle catalog: duplicate or empty id ${e?.id}`)
    ids.add(e.id)
    if (!assetKeys.has(e.asset))
      throw new Error(`oracle catalog: ${at} has unknown asset ${e.asset}`)
    if (e.chainId !== 1) throw new Error(`oracle catalog: ${at} chainId must be 1`)
    oneOf(PROVIDERS, e.provider, `${at}.provider`)
    oneOf(ORACLE_CLASSES, e.class, `${at}.class`)
    oneOf(QUOTE_UNITS, e.quoteUnit, `${at}.quoteUnit`)
    oneOf(HISTORY_SOURCES, e.historySource, `${at}.historySource`)
    oneOf(CONSENSUS_ROLES, e.consensus?.role, `${at}.consensus.role`)
    oneOf(UPDATE_MODELS, e.mechanism?.updateModel, `${at}.mechanism.updateModel`)
    oneOf(['verified', 'unverified'] as const, e.status, `${at}.status`)
    address(e.address, `${at}.address`)
    if (e.decimals !== null && !Number.isInteger(e.decimals))
      throw new Error(`oracle catalog: ${at}.decimals`)
    for (const comp of e.mechanism.components) address(comp.address, `${at} component ${comp.role}`)
  }
  for (const e of c.entries) {
    const roles = new Set(e.mechanism.components.map((k) => k.role))
    for (const comp of e.mechanism.components) {
      if (comp.ref && !ids.has(comp.ref))
        throw new Error(`oracle catalog: entry ${e.id} references unknown ${comp.ref}`)
      if (comp.via && (comp.via === comp.role || !roles.has(comp.via)))
        throw new Error(
          `oracle catalog: entry ${e.id} component ${comp.role} via unknown ${comp.via}`,
        )
    }
  }
  return c
}

let cached: OracleCatalog | null = null

export function getOracleCatalog(): OracleCatalog {
  if (!cached) cached = parseCatalog(catalogJson as unknown)
  return cached
}

// ---- queries --------------------------------------------------------------------

export type EntryFilter = { includeUnverified?: boolean }

/** All cards for one asset, in catalog order (member → alternate → derived → basis is the UI's job). */
export function entriesForAsset(
  asset: string,
  filter: EntryFilter = {},
  catalog = getOracleCatalog(),
): OracleEntry[] {
  return catalog.entries.filter(
    (e) => e.asset === asset && (filter.includeUnverified || e.status === 'verified'),
  )
}

/** The entries whose fresh prices form the asset's consensus median. */
export function consensusMembers(asset: string, catalog = getOracleCatalog()): OracleEntry[] {
  return entriesForAsset(asset, {}, catalog).filter((e) => e.consensus.role === 'member')
}

export function entryById(id: string, catalog = getOracleCatalog()): OracleEntry | undefined {
  return catalog.entries.find((e) => e.id === id)
}

export function catalogAssets(
  kind?: CatalogAsset['kind'],
  catalog = getOracleCatalog(),
): CatalogAsset[] {
  return kind ? catalog.assets.filter((a) => a.kind === kind) : catalog.assets
}

/**
 * Governance-steered parameters with an indexable event — the seed list for config-change
 * alerts. AssetSourceUpdated is emitted by the lending market's oracle (AaveOracle / Spark
 * oracle), not by the adapter, so it is attributed to the oracles named in usedBy checks.
 * `event` may list several events separated by " / ".
 */
export function governanceEvents(
  catalog = getOracleCatalog(),
): { entryId: string; emitter: Address; param: string; event: string }[] {
  const out: { entryId: string; emitter: Address; param: string; event: string }[] = []
  for (const e of catalog.entries) {
    for (const g of e.mechanism.governance) {
      if (!g.event) continue
      if (g.event.startsWith('AssetSourceUpdated')) {
        const oracles = new Set<Address>()
        for (const u of e.usedBy) if (u.check?.type === 'aave_source') oracles.add(u.check.oracle)
        for (const emitter of oracles)
          out.push({ entryId: e.id, emitter, param: g.param, event: g.event })
      } else {
        out.push({ entryId: e.id, emitter: e.address, param: g.param, event: g.event })
      }
    }
  }
  return out
}

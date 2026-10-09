// Shared shapes for the oracle registry's CONFIG CARDS (docs/research/CONFIG-CARDS-DESIGN.md).
//
// A config card shows an asset's full trust configuration — bridge verification, oracle,
// admin control, mint/redeem — and every change to it, coloured by state:
//   pending    (amber) — queued in a timelock / armed, not yet live
//   proposed   (blue)  — queued off-chain (Safe Tx Service) or in governance discussion
//   historical (grey)  — already executed
// Any security downgrade is RED in every state, and so is any live route under the absolute
// floor (fewer than 2 effective, distinct, known DVN operators) — including at creation.
//
// Everything here is pure data. The engine (uln.ts, lzReplay.ts, rules.ts, queue.ts,
// engine.ts) takes these shapes plus an explicit block/clock and never touches the network;
// the collector (scripts/oracle-registry/config/collect-config.mjs) produces the inputs.
// Addresses are lower-case hex everywhere in this module so comparisons are plain `===`.

export type Hex = string
export type Address = string

/** USD value behind a bridge route (lib/oracleRegistry/config/value.ts). */
export type ValueAtRisk = {
  /** max(lockedUsd, remoteSupplyUsd) over what was read and priced; null = nothing was. */
  usd: number | null
  /** The Ethereum adapter's locked balance in USD (a forged inbound message releases it). */
  lockedUsd: number | null
  /** The remote chain's bridged supply in USD (a forged message on the remote side mints there). */
  remoteSupplyUsd: number | null
  basis: 'locked' | 'remote_supply' | null
  priceUsd: number | null
  /** e.g. "ETH registry consensus × rsETH/ETH (LRTOracle.rsETHPrice)". */
  priceBasis: string
  /** What could not be read or priced (shown; the value is then a lower bound or unknown). */
  unread: string[]
}

export type Dimension = 'bridge' | 'oracle' | 'admin' | 'mint_redeem'

export type ControllerKind =
  | 'immutable'
  | 'zero'
  | 'precompile'
  | 'oz_timelock'
  | 'ds_pause'
  | 'aragon_dg'
  | 'aragon_voting'
  | 'safe'
  | 'legacy_multisig'
  | 'contract'
  | 'eoa'
  | 'eoa_7702'

/** One account that holds a power, classified at a block. */
export type Controller = {
  kind: ControllerKind
  address: Address
  threshold?: number
  signers?: number
  delaySec?: number
  /** Safe extras (read through Safe.getStorageAt so delegatecall edits are caught at head). */
  modules?: Address[]
  /**
   * The Safe's module list could not be read (review round 8): never "no modules" — it ranks
   * as a plain contract (a module would execute without signatures) and is a read gap.
   */
  modulesUnread?: boolean
  guard?: Address
  moduleGuard?: Address
  fallbackHandler?: Address
  singleton?: Address
  version?: string
  /**
   * Safe / multisig owner list (lower-case) when read (review round 6: a delegatecall can swap
   * owners at the same count without an event — the run-to-run diff compares the sets).
   */
  owners?: Address[]
  /** For a ProxyAdmin-like contract: the account it defers to (already classified). */
  ownedBy?: Controller
  /**
   * An Aragon Agent: every account holding its RUN_SCRIPT / EXECUTE / SAFE_EXECUTE permission at
   * the block (the Agent acts only for them; it ranks as the weakest). One executor is also
   * `ownedBy`.
   */
  executors?: Controller[]
  /**
   * A timelock with a path around its own delay (read from the bytecode at the block):
   *   scope 'any'        — an unrestricted bypass (Chainlink RBACTimelock bypasserExecuteBatch,
   *                        held by `holders`); the delay protects nothing
   *   scope 'whitelist'  — function-scoped (Ethena executeWhitelisted): `targets` maps each
   *                        contract to the selectors that execute with no delay
   */
  bypass?: {
    fn: string
    scope: 'any' | 'whitelist'
    holders?: Address[]
    targets?: Record<Address, string[]>
    /** The whitelist could not be read this run: ranked as an unrestricted bypass (fail closed). */
    unread?: boolean
  }
  /**
   * Lido Dual Governance EmergencyProtectedTimelock (kind 'aragon_dg'). `delaySec` is the
   * shortest path to execution: the proposers' Aragon vote (when every proposer is one) + the
   * after-submit delay (the emergency execution committee skips the after-schedule delay).
   */
  dg?: {
    proposers?: Address[]
    proposerVoteSec?: number
    afterSubmitDelaySec: number | null
    afterScheduleDelaySec: number | null
    governance: Address | null
    adminExecutor: Address | null
    emergencyGovernance: Address | null
    activationCommittee: Address | null
    executionCommittee: Address | null
    emergencyModeActive: boolean | null
    /** Unix seconds after which the emergency committees lose their powers. */
    emergencyProtectionEndsAfter: number | null
    /**
     * Read on the governance (DualGovernance) contract: the Reseal Committee (extends a seal of
     * the withdrawal queue / exit bus), the Tiebreaker committee (executes when governance is
     * deadlocked), who may cancel every pending proposal, and the effective state (Normal,
     * VetoSignalling, …, RageQuit). undefined = not read by this collector version; null = the
     * read failed.
     */
    resealCommittee?: Address | null
    tiebreakerCommittee?: Address | null
    proposalsCanceller?: Address | null
    state?: string | null
  }
  /** Aragon Voting app (kind 'aragon_voting'): a vote lasts voteTime (delaySec). */
  voting?: { voteTimeSec: number | null; objectionPhaseSec: number | null }
  /**
   * Owner ruling 2026-10-08 (#12): who can put an operation INTO a timelock, classified at the
   * same block. A timelock ranks as its WEAKEST scheduler; its delay adds strength only at
   * 24 h or more (rules.ts `controllerRank`).
   *   oz_timelock    PROPOSER_ROLE holders, plus the holders of PROPOSER_ROLE's admin role
   *                  (TIMELOCK_ADMIN_ROLE / DEFAULT_ADMIN_ROLE / ADMIN_ROLE): they can grant it.
   *                  The timelock itself (its self-administration) is not listed.
   *   ds_pause       its owner and its authority (DSAuth: either may plot).
   *   aragon_dg      the governance contract's declared proposers (getProposers()).
   * undefined on a timelock kind = not read by this collector version; with `schedulersUnread`
   * the read failed. Either way the timelock ranks as a plain contract and is a read gap (fail
   * closed). An Aragon Voting app needs none: the token-holder vote is its own controller.
   */
  schedulers?: Controller[]
  /** The scheduler set could not be read (or enumerated completely): a read gap. */
  schedulersUnread?: boolean
  /**
   * Review round 9: schedulers (lower-case addresses) that can change this timelock's delay
   * WITHOUT waiting for it — a Chainlink RBACTimelock gates `updateDelay` with ADMIN_ROLE, not
   * self-only as in OZ (measured: `updateDelay(0)` succeeds as an eth_call from the holder, or
   * the call failed for another reason: fail closed). Such a scheduler gets no delay credit: it
   * can cut the delay to 0, grant itself PROPOSER and EXECUTOR, then schedule and execute.
   */
  delaySetters?: string[]
}

// ---- subjects (data/oracle-registry/config/subjects.json) ---------------------------------

export type GovChannel = { kind: 'snapshot'; space: string } | { kind: 'discourse'; base: string }

export type ContractRole =
  | 'token'
  | 'oft'
  | 'oft_adapter'
  | 'lz_oapp'
  | 'ccip_pool'
  | 'proxy'
  | 'config'
  | 'oracle'
  | 'minting'
  | 'timelock'
  | 'safe'
  | 'multisig'
  | 'proxy_admin'
  | 'controller'
  | 'other'

export type ConfigContract = {
  role: ContractRole
  dimension: Dimension
  chainId: number
  address: Address
  label: string
  /** First block with code (found by bisection; history scans start here, see scanFloor). */
  deployBlock: number
  oracleEntryIds?: string[]
}

/**
 * How a power's holders are found from a contract. Steps, applied left to right:
 *   'owner'            owner()
 *   'eip1967_admin'    the EIP-1967 admin slot
 *   'zos_admin'        the zeppelinos admin slot (FiatToken / cbBTC)
 *   'lz_delegate'      EndpointV2.delegates(contract)
 *   'call:<fn>'        <fn>() returning an address
 *   'role:<NAME>'      every holder of role NAME (events + hasRole at head; AccessControlEnumerable
 *                      members; an Aragon app's holders are checked with its ACL)
 *   'role_admin:<NAME>' every holder of getRoleAdmin(NAME)
 *   'acl_manager:<NAME>' Aragon: the ACL permission MANAGER of (contract, NAME) — it can grant
 *                      itself the role at will (Lido revokes APP_MANAGER_ROLE between upgrades).
 *                      An Aragon Agent holder is classified through its executor (classify)
 */
export type PowerSpec = {
  power: 'upgrade' | 'mint' | 'bridge_config' | 'oracle' | 'pause' | 'caps' | 'roles'
  contract: Address
  path: string[]
  label: string
  /**
   * Functions (signatures or 4-byte selectors) a timelock's whitelist bypass may let through
   * WITHOUT exercising this power — pure restrictions, or another power's functions. Every
   * other whitelisted function on the contract the holder acts on lowers this power's delay
   * to INSTANT (fail closed: an unknown function counts).
   */
  bypassExclude?: string[]
}

export type ParamRule =
  | 'pauser'
  | 'rate_provider'
  | 'minter'
  | 'price_oracle'
  | 'bound_upper'
  | 'quorum'
  | 'quorum_members'
  | 'cap'
  | 'whitelist_gate'
  | 'cooldown'
  | 'info'

/** A mint/redeem getter read on the archive grid (and bisected to the exact block on change). */
export type ParamSpec = {
  key: string
  contract: Address
  /** Human-readable ABI, e.g. 'function pricePercentageLimit() view returns (uint256)'. */
  sig: string
  args?: (string | number)[]
  /** For a getter returning a tuple: which output to take. */
  outputIndex?: number
  rule: ParamRule
  label: string
  /** For rule 'cap': what 0 means for THIS asset (Kelp: 0 = deposits closed). */
  zero?: 'closed' | 'unlimited'
  /** For rule 'cap': the value that means unlimited (decimal string), if any. */
  unlimited?: string
  /** The getter returns a list (e.g. HashConsensus getMembers()): the value is its LENGTH. */
  count?: boolean
  /** Not polled on the grid: judged from events only (FiatToken MinterConfigured). */
  eventsOnly?: boolean
  /**
   * The setter a QUEUED call uses to change this parameter (review round 6: an armed
   * `setMinter(EOA)` read "call not decoded"). `sig` is a human-readable function ABI; `value` the
   * setter argument holding the new value; `match[i]` the setter argument that must equal
   * `args[i]` (e.g. updatePriceOracleFor(asset, oracle): value 1, match [0]).
   */
  setter?: { sig: string; value: number; match?: number[] }
  /**
   * How the raw getter output is decoded before it is stored and compared: 'trimmed_amount' = a
   * Wormhole NTT TrimmedAmount (uint72: amount << 8 | decimals) rescaled to the base units of a
   * token with `decimals` decimals (the NTT rate limits).
   */
  decode?: 'trimmed_amount'
  /** Token decimals for `decode` 'trimmed_amount'. */
  decimals?: number
  /** Display only: the value is an amount in base units of `symbol` with `decimals` decimals. */
  unit?: { decimals: number; symbol: string }
}

export type ConfigSubject = {
  key: string
  label: string
  /** catalog.json asset key; null ⇒ config-only tab (asset not in the oracle catalog). */
  oracleAssetKey: string | null
  class: 'lrt' | 'bridged' | 'pt' | 'custodial'
  contracts: ConfigContract[]
  /** LayerZero OApps (OFT / OFT adapters / L1 sync pools) on Ethereum. */
  lzOApps: Address[]
  ccipPools: Address[]
  powers: PowerSpec[]
  params: ParamSpec[]
  /** OZ timelocks whose CallScheduled queue is read (pending / armed ops). */
  timelocks: Address[]
  /** Safes whose off-chain queue is read from the Safe Tx Service (proposed). */
  safes: Address[]
  /** [] ⇒ NO-GOV-CHANNEL (no forum / Snapshot found). */
  govChannels: GovChannel[]
  notes?: string[]
  /**
   * Wormhole NTT managers on Ethereum (declared contracts): threshold, transceivers, peers and
   * the balance they lock are read at head; their events are replayed (BR-1 / BR-2 / BR-6).
   */
  nttManagers?: Address[]
  /**
   * Canonical rollup token bridges, L1 side (declared contracts): the token they lock, the
   * deposit / withdrawal switches and the proxy admin are read at head. `operator` says who runs
   * the bridge's verification (a rollup-run bridge is not the subject issuer's).
   */
  canonicalBridges?: { address: Address; chain: string; token: Address; operator: string }[]
  /**
   * An Aragon DAO's ACL (declared contract): its permission events are scanned from its
   * deployment (the ACL cannot list holders) — replayed for state, filed from the scan window.
   */
  aragonAcl?: Address
  /**
   * How the bridged token is priced for the floor-breach severity rank (owner ruling #9): a
   * catalog asset's registry consensus (USD), times an optional on-chain rate (rsETH/ETH).
   */
  valuation?: { asset: string; rate?: { contract: Address; sig: string; decimals: number } }
}

export type SubjectsFile = {
  version: 1
  generatedAt: string
  /** History before this block is not scanned (documented gap for pre-2023 contracts). */
  scanFloor: number
  subjects: ConfigSubject[]
}

// ---- LayerZero ------------------------------------------------------------------------------

/** UlnConfig exactly as stored / emitted (counts are raw: 0 = inherit, 255 = explicitly none). */
export type UlnConfigRaw = {
  confirmations: string
  requiredDVNCount: number
  optionalDVNCount: number
  optionalDVNThreshold: number
  requiredDVNs: Address[]
  optionalDVNs: Address[]
}

/** The merged (effective) ULN config of one (oapp, eid, library). */
export type DvnConfig = {
  required: Address[]
  optional: Address[]
  optionalThreshold: number
  /** Decimal block confirmations after merging; '0' also when explicitly NIL (uint64 max). */
  confirmations: string
  zeroConfirmations: boolean
  source: 'override' | 'default' | 'mixed'
  /** getUlnConfig would revert (no DVN at all): the route cannot verify anything. */
  noDvn: boolean
}

export type DvnInfo = {
  address: Address
  /** Normalised operator id (LZ metadata id with sponsor/variant suffixes folded). */
  operator: string | null
  name: string | null
  deprecated: boolean
  dead: boolean
  /** Code on the LOCAL chain at the evaluation block; null = not checked. */
  hasCode: boolean | null
}

export type BlockedReason = 'no_dvn' | 'dead_dvn' | 'blocked_library' | 'threshold_unreachable'

export type Security = {
  /** Minimum number of distinct KNOWN operators an attacker must compromise to forge a packet. */
  E: number
  operators: string[]
  /** Operators run by the token's own issuer (counted, but labelled 'issuer-run'). */
  issuerRun?: string[]
  required: number
  optional: number
  threshold: number
  unknown: Address[]
  noCode: Address[]
  duplicateOperator: Address[]
  deprecated: Address[]
  dead: Address[]
  blocked: boolean
  blockedReason?: BlockedReason
  confirmations: string
  zeroConfirmations: boolean
}

export type Direction = 'send' | 'receive'

export type LibraryKind = 'uln' | 'blocked' | 'read' | 'unknown'

export type RouteState = {
  chainId: number
  oapp: Address
  eid: number
  direction: Direction
  lib: Address
  libKind: LibraryKind
  /** Library is in the LZ deployment allowlist for this chain. */
  libAllowed: boolean
  libIsDefault: boolean
  peer: Hex
  /** peer ≠ 0, library not blocked, config verifies (not dead / not empty). */
  live: boolean
  config: DvnConfig
  security: Security
  /** Receive only: the previous library still verifies until `expiry` (block). */
  grace?: { lib: Address; expiry: number; security: Security }
  /** min(E over every library that can verify right now). */
  Eeff: number
  /** Confirmations of the library DEFAULT for this eid (LZ finality guidance), when known. */
  defaultConfirmations?: string
}

// ---- changes & state -------------------------------------------------------------------------

export type ChangeState = 'pending' | 'proposed' | 'historical'
export type Severity = 'downgrade' | 'upgrade' | 'neutral'
export type Stage =
  | 'forum'
  | 'snapshot'
  | 'safe_queued'
  | 'scheduled'
  | 'armed'
  /** a legacy MultiSigWallet transaction submitted on-chain, not yet confirmed by enough owners */
  | 'submitted'
  /** past its ETA but not executable now (predecessor missing or execute reverts) */
  | 'stale'
  | 'executed'

export type ChangeTag =
  | 'large_raise'
  | 'rotation'
  | 'run_risk'
  | 'deprecated_dvn'
  | 'flash'
  | 'logic_change'
  | 'default_change'
  | 'route_created'
  | 'route_removed'
  | 'stale_rollback'
  | 'send_side'
  | 'grace_period'
  | 'blocked'
  | 'unblocked'
  | 'inactive_route'
  | 'initialization'
  | 'undecoded'
  | 'not_executable'
  /** a ready op whose executability could not be checked (salt not recovered / RPC error) */
  | 'not_simulated'
  /** the op's on-chain state (getTimestamp) could not be read */
  | 'state_unread'
  /** new implementation / provider source checked: NOT verified on Sourcify or Blockscout */
  | 'unverified'
  /** the source-verification lookup FAILED (fail closed, but not "checked, not verified") */
  | 'verification_unread'
  /** a wider DVN set at the same effective threshold (amber, owner ruling 2026-10-06 #6) */
  | 'wider_dvn_set'
  | 'bracketed'
  /** a role grant that follows the protocol's established bot pattern (amber, not red) */
  | 'operational'
  /** a role grant outside an established bot pattern (stays red; the notes say why) */
  | 'anomaly'
  /** a queued call that runs through a timelock's no-delay bypass (executeWhitelisted / bypasser) */
  | 'timelock_bypass'
  /** a Safe transaction that DELEGATECALLs code other than a MultiSend library (AD-6) */
  | 'delegatecall'

/**
 * v1 ingests no governance post source, so `unannounced` is never true or false yet:
 *   not_checked     — the asset has a governance channel but it is not ingested in v1
 *   no_gov_channel  — NO-GOV-CHANNEL (Kelp, Pendle, Strata, Coinbase, BiT Global)
 * Never claim "announced" without a matched post.
 */
export type AnnouncementStatus = 'not_checked' | 'no_gov_channel'

export type ConfigChange = {
  /** `${chainId}:${tx}:${logIndex}[:suffix]` | `${queue}:${opId}:${i}` | `safe:${safe}:${nonce}:${i}` */
  id: string
  subject: string
  dimension: Dimension
  key: string
  title: string
  before?: unknown
  after?: unknown
  beforeDisplay?: string
  afterDisplay?: string
  state: ChangeState
  stage?: Stage
  severity: Severity
  floorBreach: boolean
  /** red ⇔ severity === 'downgrade' || floorBreach — in ANY state. */
  red: boolean
  ruleIds: string[]
  tags: ChangeTag[]
  unannounced: boolean | null
  announcement: AnnouncementStatus
  chainId: number
  block?: number
  /** For a getter change found on the archive grid: the change lies in (blockFrom, block]. */
  blockFrom?: number
  ts?: number
  tx?: Hex
  actor?: Address
  eta?: number
  queue?: {
    kind: 'oz_timelock' | 'safe' | 'legacy_multisig' | 'dg_timelock'
    address: Address
    opId: string
  }
  /** Historical red change whose `after` is still the live value at head. */
  stillInEffect?: boolean
  route?: { chainId: number; oapp: Address; eid: number; direction: Direction }
  notes?: string[]
}

export type StateItem = {
  subject: string
  dimension: Dimension
  key: string
  display: string
  value?: unknown
  chainId: number
  block: number
  /** State rules that currently fail (red banner — persists without any new change). */
  breaches: { ruleId: string; message: string }[]
  tags?: ChangeTag[]
  warnings?: string[]
  /** Bridge routes: USD value behind the route (owner ruling 2026-10-06 #9: the severity rank). */
  valueAtRisk?: ValueAtRisk
}

export type PowerState = {
  power: PowerSpec['power']
  label: string
  contract: Address
  holders: Controller[]
  /** Shortest delay over every holder path (seconds). 0 ⇒ INSTANT. */
  effectiveDelaySec: number
  /** Weakest holder (the one an attacker would target). */
  weakest: Controller | null
  /** Zero-delay Safe/EOA holder ⇒ a change can land with no on-chain pending window. */
  pendingObservable: boolean
  /** How a pending change of this power is observed (or why it is not). */
  pendingNote?: string
}

export type SubjectState = {
  version: 1
  subject: string
  label: string
  oracleAssetKey: string | null
  chainId: 1
  asOf: { block: number; ts: number }
  scan: { from: number; to: number }
  govChannels: GovChannel[]
  announcement: AnnouncementStatus
  proposedSources: {
    kind: 'safe_tx_service' | 'snapshot' | 'discourse'
    status: 'ok' | 'unavailable' | 'not_ingested'
    note?: string
  }[]
  powers: PowerState[]
  /** Head classification of every Safe in the power graph (the next run diffs it: AD-6). */
  safeSnapshot?: Controller[]
  /** Remote route states as evaluated at this run (the next run diffs them: remote history). */
  remoteSnapshot?: Record<string, RouteState>
  /** Ethereum block each remoteSnapshot route was last read at (a route unread this run is carried). */
  remoteReadAt?: Record<string, number>
  /** Last NON-ZERO peer of each remote route over the runs (the next run: a re-point through 0). */
  remoteLastPeer?: Record<string, string>
  /**
   * Last state of each remote route that could VERIFY, over the runs (review round 6: a remote
   * side weakened while closed and reopened is compared with the config it last ran with).
   */
  remoteLastVerifying?: Record<string, RouteState>
  /** The oracle governance events this card covers (absent: not collected for this subject). */
  oracleWindow?: { startBlock: number; endBlock: number; days: number }
  items: StateItem[]
  counts: {
    red: number
    pending: number
    proposed: number
    historical: number
    floorBreaches: number
  }
  /**
   * Reads that FAILED this run in a way that can hide a red flag (an unresolved power holder, a
   * Safe Tx Service or multisig submission queue not read). Route sides are counted apart.
   */
  readGaps?: string[]
  warnings: string[]
}

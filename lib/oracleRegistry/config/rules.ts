// Config-card rules: the registry of rule IDs, controller ranking, and the pure classifiers for
// the admin, mint/redeem, CCIP, DVN-signer and oracle dimensions. Bridge (LayerZero route)
// rules live in bridgeRules.ts because they compare evaluated RouteStates.
//
// Owner ruling (2026-10-05): any security downgrade is RED in every state (pending, proposed,
// historical). A classifier returns a Verdict; `red` is derived, never set by hand:
//   red ⇔ severity === 'downgrade' || floorBreach
// Every rule is generic: no rule knows a subject, a date or an exploit.

import type { ChangeTag, Controller, ControllerKind, ParamSpec, Severity } from './types'

export type RuleId =
  | 'BR-1'
  | 'BR-2'
  | 'BR-3'
  | 'BR-4'
  | 'BR-5'
  | 'BR-6'
  | 'BR-7'
  | 'BR-8'
  | 'BR-9'
  | 'DV-1'
  | 'DV-2'
  | 'CC-1'
  | 'CC-2'
  | 'CC-3'
  | 'AD-1'
  | 'AD-2'
  | 'AD-3'
  | 'AD-4'
  | 'AD-5'
  | 'AD-6'
  | 'AD-7'
  | 'AD-8'
  | 'AD-9'
  | 'MR-1'
  | 'MR-2'
  | 'MR-3'
  | 'MR-4'
  | 'MR-5'
  | 'OR-1'

export const RULES: Record<RuleId, string> = {
  'BR-1':
    'Effective verifier count E dropped on a route (incl. an override replacing an inherited default, a default change, a library switch, and the old library during a receive grace period)',
  'BR-2':
    'FLOOR: a live route has fewer than 2 effective, distinct, known DVN operators (checked at creation and on every head read)',
  'BR-3': 'Block confirmations lowered (an explicit NIL = type(uint64).max counts as ZERO)',
  'BR-4': 'A DVN in the config has no code on the local chain',
  'BR-5': 'Message library outside the LayerZero deployment allowlist for the chain',
  'BR-6': 'Peer moved from one non-zero address to another',
  'BR-7': 'Unknown DVN (not in LZ metadata for the chain) or two DVNs run by one operator',
  'BR-8':
    'AMBER (owner ruling 2026-10-06 #6): a wider DVN set at the same effective threshold (more DVNs for an attacker to pick from); an unknown added DVN stays red under BR-7',
  'BR-9':
    'Flash flip: a weaker config reverted within 7,200 blocks, or a dip inside one transaction',
  'DV-1': 'A DVN multisig lowered its signer quorum',
  'DV-2': 'A DVN multisig added a signer at an unchanged quorum',
  'CC-1':
    'CCIP token pool or remote pool replaced, or a second remote pool added for an already-served chain (strict, like BR-6)',
  'CC-2': 'CCIP rate limiter disabled',
  'CC-3': 'CCIP rebalancer (can withdraw locked liquidity) moved to an EOA or a weaker controller',
  'AD-1':
    'Multisig threshold lowered, a signer added at an unchanged threshold, or signers added so that the added signers alone meet the new threshold',
  'AD-2': 'Timelock / pause delay shortened, or a timelock removed from the authority path',
  'AD-3':
    'Owner / admin / LZ delegate / role admin moved to a weaker controller, or a first owner set from address(0) more than 7,200 blocks after deployment (front-run initialize())',
  'AD-4':
    'Privileged role (incl. any role not recognised) granted to an EOA, a 7702 EOA, or an account weaker than the current holders',
  'AD-5':
    'Upgrade or admin change with no CallExecuted from the timelock that holds upgrade power (timelock bypass)',
  'AD-6': 'Safe module enabled, or guard / module guard / fallback handler / singleton changed',
  'AD-7':
    'Timelock admin role (TIMELOCK_ADMIN_ROLE, or DEFAULT_ADMIN_ROLE on OZ v5) held by an account other than the timelock',
  'AD-8':
    'An executable (armed) queued operation would break a rule, incl. a stale rollback upgrade',
  'AD-9':
    'Logic change (Upgraded / BeaconUpgraded, a rate provider or an oracle source replaced) to code whose source is not verified (Sourcify / Blockscout), or whose verification could not be read',
  'MR-1': 'Pauser removed and not replaced',
  'MR-2':
    'Rate provider, minter or price oracle moved to an EOA, a 7702 EOA or a no-code address, or a new minter appeared',
  'MR-3': 'Rate bound loosened (sanity limit raised, quorum lowered, quorum/members ratio lowered)',
  'MR-4':
    "Cap set to the asset's own unlimited sentinel (a raise of 2x or more is tagged large_raise)",
  'MR-5': 'Whitelist gate removed (a shorter cooldown is tagged run_risk)',
  'OR-1':
    'Oracle mechanism loosened (heartbeat up, deviation up, TWAP window down, quorum bar down, CAPO growth up, source to EOA)',
}

export type Verdict = {
  severity: Severity
  floorBreach: boolean
  ruleIds: string[]
  tags: ChangeTag[]
  notes: string[]
}

export const neutral = (): Verdict => ({
  severity: 'neutral',
  floorBreach: false,
  ruleIds: [],
  tags: [],
  notes: [],
})

export function down(v: Verdict, rule: RuleId, note?: string): Verdict {
  v.severity = 'downgrade'
  if (!v.ruleIds.includes(rule)) v.ruleIds.push(rule)
  if (note) v.notes.push(note)
  return v
}

export function up(v: Verdict, note?: string): Verdict {
  if (v.severity !== 'downgrade') v.severity = 'upgrade'
  if (note) v.notes.push(note)
  return v
}

export function tag(v: Verdict, t: ChangeTag): Verdict {
  if (!v.tags.includes(t)) v.tags.push(t)
  return v
}

export const isRed = (v: { severity: Severity; floorBreach: boolean }) =>
  v.severity === 'downgrade' || v.floorBreach

// ---- controller rank ----------------------------------------------------------------------------

/**
 * Strongest first: immutable / renounced > timelock (by delay) > multisig (by threshold, then
 * FEWER signers — a signer added at the same threshold widens the attack surface) > contract >
 * EOA = 7702 EOA. Returned as a tuple compared lexicographically (higher = stronger).
 *
 * A timelock is only as strong as its delay: with no delay, or with an unrestricted bypass
 * (bypasserExecuteBatch), it ranks as a plain contract. A contract that defers to an owner is
 * at most as strong as that owner and strictly weaker (its own code may hold other paths): a
 * move from a timelock to a contract the timelock owns is a downgrade.
 */
export function controllerRank(c: Controller | null | undefined): number[] {
  if (!c) return [0]
  switch (c.kind) {
    case 'immutable':
    case 'zero':
    case 'precompile':
      return [6]
    case 'oz_timelock':
    case 'ds_pause':
    case 'aragon_dg':
    case 'aragon_voting':
      if ((c.delaySec ?? 0) <= 0 || c.bypass?.scope === 'any') return [2]
      return [5, c.delaySec ?? 0]
    case 'safe':
    case 'legacy_multisig':
      // A threshold-1 multisig: ANY one signer acts alone — it ranks with an EOA (review round
      // 7: a 1-of-N Safe outranked a plain contract and an EOA, so a MANAGER grant to a 1-of-2
      // Safe read neutral and EOA → Safe 1-of-5 read as an upgrade).
      if (c.threshold !== undefined && c.threshold !== null && c.threshold <= 1) return [1]
      // A Safe module executes without signatures: the Safe is no stronger than an
      // unclassified contract while one is enabled (critique: min over module controllers).
      // Review round 8: a module list that could not be read is not "no modules" (fail closed).
      if (c.modules?.length || c.modulesUnread) return [2]
      return [4, c.threshold ?? 0, -(c.signers ?? 0)]
    case 'contract': {
      // An Aragon Agent acts only for its executors (enumerated from the ACL at the block): it
      // is exactly as strong as the weakest one — no other code path of its own to discount.
      if (c.executors?.length)
        return c.executors.map(controllerRank).reduce((m, r) => (compareRank(r, m) < 0 ? r : m))
      if (!c.ownedBy) return [2]
      const r = controllerRank(c.ownedBy)
      return r[0] >= 3 ? [...r, -1] : r
    }
    case 'eoa':
    case 'eoa_7702':
      return [1]
  }
}

export function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const EOA_KINDS: ControllerKind[] = ['eoa', 'eoa_7702']
export const isEoa = (c: Controller | null | undefined) => !!c && EOA_KINDS.includes(c.kind)
/**
 * An EOA, or a contract whose deferral chain ends at one (it ranks with the EOA): whoever holds
 * that key controls it (review round 5: a rate provider moved to a verified contract owned by an
 * EOA read amber).
 */
export const isEoaControlled = (c: Controller | null | undefined) =>
  !!c && (isEoa(c) || controllerRank(c)[0] <= 1)

export function describeController(c: Controller | null | undefined): string {
  if (!c) return 'unknown'
  const a = `${c.address.slice(0, 6)}…${c.address.slice(-4)}`
  switch (c.kind) {
    case 'safe':
      return `Safe ${c.threshold}-of-${c.signers} ${a}`
    case 'legacy_multisig':
      return `MultiSig ${c.threshold}-of-${c.signers} ${a}`
    case 'oz_timelock':
      return `Timelock ${formatDelay(c.delaySec ?? 0)}${c.bypass ? ` (bypass: ${c.bypass.fn}${c.bypass.unread ? ', whitelist UNREAD' : ''})` : ''} ${a}`
    case 'ds_pause':
      return `DSPause ${formatDelay(c.delaySec ?? 0)} ${a}`
    case 'aragon_dg': {
      const d = c.dg
      const parts = [
        d?.proposerVoteSec ? `${formatDelay(d.proposerVoteSec)} Aragon vote` : null,
        d?.afterSubmitDelaySec != null
          ? `${formatDelay(d.afterSubmitDelaySec)} after submit`
          : null,
      ].filter(Boolean)
      return `Dual Governance timelock ${formatDelay(c.delaySec ?? 0)}${parts.length ? ` (${parts.join(' + ')}${d?.afterScheduleDelaySec ? `; +${formatDelay(d.afterScheduleDelaySec)} after schedule unless the emergency committee executes` : ''}${d?.emergencyModeActive ? '; EMERGENCY MODE ACTIVE' : ''})` : ''} ${a}`
    }
    case 'aragon_voting':
      return `Aragon Voting ${formatDelay(c.delaySec ?? 0)} vote ${a}`
    case 'eoa':
      return `EOA ${a}`
    case 'eoa_7702':
      return `7702 EOA ${a}`
    case 'zero':
      return 'renounced (address 0)'
    case 'precompile':
      return `precompile ${a} (inert)`
    case 'contract': {
      // an Aragon Agent says so (its controllers are the executors it acts for)
      const name = c.version?.startsWith('Aragon Agent') ? 'Aragon Agent' : 'contract'
      if ((c.executors?.length ?? 0) > 1)
        return `${name} ${a} → ${c.executors!.map(describeController).join(' | ')} (ranked as the weakest)`
      return c.ownedBy ? `${name} ${a} → ${describeController(c.ownedBy)}` : `${name} ${a}`
    }
    default:
      return `${c.kind} ${a}`
  }
}

export function formatDelay(sec: number): string {
  if (!sec) return 'INSTANT'
  if (sec % 86400 === 0) return `${sec / 86400}d`
  if (sec % 3600 === 0) return `${sec / 3600}h`
  if (sec % 60 === 0) return `${sec / 60}m`
  return `${sec}s`
}

// ---- admin --------------------------------------------------------------------------------------

/**
 * A FIRST owner set from address(0) within this many blocks (≈ 1 day) of the contract's deploy
 * block is initialization; later it is RED AD-3 — the initialize() call could have been
 * front-run (owner ruling 2026-10-06, round 2 #7).
 */
export const OWNER_INIT_WINDOW_BLOCKS = 7_200

/**
 * AD-3: an owner / admin / delegate / role-admin moved from `prev` to `next`.
 *
 * `prev` null = the previous holder was not read / not classified. That is never a baseline an
 * EOA can rank above (fail closed): a move to an EOA (the weakest kind) from an unread holder is
 * red, a move to an unread holder is red, and a move to anything else is neutral with a note —
 * never an "upgrade" judged against a missing read.
 */
export function classifyControllerChange(
  prev: Controller | null,
  next: Controller | null,
): Verdict {
  const v = neutral()
  if (!prev) {
    if (!next) return down(v, 'AD-3', 'neither the previous nor the new holder could be classified')
    // an EOA, or anything that ranks with one (a 1-of-N multisig, a contract an EOA owns)
    if (isEoaControlled(next))
      return down(v, 'AD-3', `previous holder not read → ${describeController(next)}`)
    v.notes.push(
      `previous holder not read → ${describeController(next)} (not judged as an upgrade)`,
    )
    return v
  }
  const c = compareRank(controllerRank(next), controllerRank(prev))
  if (isEoa(prev) && isEoa(next)) return tag(v, 'rotation')
  if (c < 0) return down(v, 'AD-3', `${describeController(prev)} → ${describeController(next)}`)
  if (c > 0) return up(v, `${describeController(prev)} → ${describeController(next)}`)
  if (prev && next && prev.address !== next.address) tag(v, 'rotation')
  return v
}

/**
 * AD-1: a multisig's threshold / signer set changed (before and after read at the blocks).
 *   - the threshold drops, or
 *   - a signer is added at an unchanged threshold, or
 *   - (review round 5) signers are added so that the ADDED signers alone meet the new threshold:
 *     a 2-of-3 → 3-of-10 lets any three of the seven new signers act without one old signer —
 *     the raised threshold is not a strengthening. `added` = signers added in the change (an
 *     owner swap adds one and removes one); default: the net growth of the signer set. Review
 *     round 6: this holds for SWAPS too (the set size unchanged): three owners swapped in on a
 *     3-of-5 act alone, and a 2-of-4 → 3-of-4 with three swaps is no upgrade.
 */
export function classifyMultisigChange(
  prev: Controller | null,
  next: Controller | null,
  /** Signers added in the change (a swap adds one and removes one); default the net growth. */
  added?: number,
): Verdict {
  const v = neutral()
  const pt = prev?.threshold ?? 0
  const nt = next?.threshold ?? 0
  const ps = prev?.signers ?? 0
  const ns = next?.signers ?? 0
  const newSigners = Math.max(added ?? 0, ns - ps, 0)
  if (nt < pt) return down(v, 'AD-1', `threshold ${pt} → ${nt}`)
  if (nt === pt && ns > ps)
    return down(v, 'AD-1', `signer added at threshold ${nt} (${ps} → ${ns} signers)`)
  // Review round 6: also when the signer set did not grow — owners SWAPPED in at the same count
  // (3-of-5 with three owners replaced) act alone just the same.
  if (nt > 0 && newSigners >= nt)
    return down(
      v,
      'AD-1',
      `${pt}-of-${ps} → ${nt}-of-${ns}: the ${newSigners} ${ns > ps ? 'added' : 'swapped-in'} signers alone meet the new threshold ${nt}`,
    )
  if (nt > pt || ns < ps) return up(v, `${pt}-of-${ps} → ${nt}-of-${ns}`)
  return v
}

/** AD-2: timelock delay changed. */
export function classifyDelayChange(prevSec: number, nextSec: number): Verdict {
  const v = neutral()
  if (nextSec < prevSec)
    return down(v, 'AD-2', `delay ${formatDelay(prevSec)} → ${formatDelay(nextSec)}`)
  if (nextSec > prevSec) return up(v, `delay ${formatDelay(prevSec)} → ${formatDelay(nextSec)}`)
  return v
}

/**
 * Roles this module RECOGNISES (it knows what they can do). Any other role — a hash the
 * collector could not name, or a name with no known powers (e.g. GUARDIAN) — is judged
 * PRIVILEGED (owner ruling 2026-10-06, #8): a grant of it to a wallet is red. Every name here is
 * also in the collector's naming table (scripts/oracle-registry/config/lib/abi.mjs, tested).
 */
export const ROLE_NAMES = [
  'DEFAULT_ADMIN_ROLE',
  'TIMELOCK_ADMIN_ROLE',
  'PROPOSER_ROLE',
  'EXECUTOR_ROLE',
  'CANCELLER_ROLE',
  'MINTER_ROLE',
  'BURNER_ROLE',
  'MANAGER',
  'MANAGER_ROLE',
  'UPGRADER_ROLE',
  'PAUSER_ROLE',
  'UNPAUSER_ROLE',
  'OPERATOR_ROLE',
  'GATEKEEPER_ROLE',
  'COLLATERAL_MANAGER_ROLE',
  'REDEEMER_ROLE',
  // Chainlink RBACTimelock (WBTC's CCIP pool owner): ADMIN administers every role, BYPASSER
  // executes with no delay (bypasserExecuteBatch)
  'ADMIN_ROLE',
  'BYPASSER_ROLE',
  // Ethena timelock: may call executeWhitelisted (no delay)
  'WHITELISTED_EXECUTOR_ROLE',
  // StakedUSDe: restrictions (granting one RESTRICTS the grantee) and the rewards transferer
  'FULL_RESTRICTED_STAKER_ROLE',
  'SOFT_RESTRICTED_STAKER_ROLE',
  'BLACKLIST_MANAGER_ROLE',
  'REWARDER_ROLE',
  // Aragon (Lido DAO): Kernel upgrades, ACL permissions, the Agent's execution
  'APP_MANAGER_ROLE',
  'CREATE_PERMISSIONS_ROLE',
  'RUN_SCRIPT_ROLE',
  'EXECUTE_ROLE',
  // Lido stETH and PausableUntil contracts
  'PAUSE_ROLE',
  'RESUME_ROLE',
  'STAKING_PAUSE_ROLE',
  'STAKING_CONTROL_ROLE',
  'UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE',
  // Lido canonical L2 bridges: the switches (a disabler only stops; an enabler only resumes)
  'DEPOSITS_ENABLER_ROLE',
  'DEPOSITS_DISABLER_ROLE',
  'WITHDRAWALS_ENABLER_ROLE',
  'WITHDRAWALS_DISABLER_ROLE',
  // Lido oracle path
  'MANAGE_MEMBERS_AND_QUORUM_ROLE',
  'DISABLE_CONSENSUS_ROLE',
  'MANAGE_FRAME_CONFIG_ROLE',
  'MANAGE_FAST_LANE_CONFIG_ROLE',
  'MANAGE_REPORT_PROCESSOR_ROLE',
  'MANAGE_CONSENSUS_CONTRACT_ROLE',
  'MANAGE_CONSENSUS_VERSION_ROLE',
  'ALL_LIMITS_MANAGER_ROLE',
  'ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE',
  'APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE',
  'EXTERNAL_PENDING_BALANCE_CAP_MANAGER_ROLE',
  'MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE',
  'MAX_CL_BALANCE_DECREASE_MANAGER_ROLE',
  'MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE',
  'MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE',
  'MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE',
  'MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE',
  'REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE',
  'SECOND_OPINION_MANAGER_ROLE',
  'SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE',
  // Linea TokenBridge PauseManager: pause / unpause switches only
  'PAUSE_ALL_ROLE',
  'UNPAUSE_ALL_ROLE',
  'PAUSE_INITIATE_TOKEN_BRIDGING_ROLE',
  'UNPAUSE_INITIATE_TOKEN_BRIDGING_ROLE',
  'PAUSE_COMPLETE_TOKEN_BRIDGING_ROLE',
  'UNPAUSE_COMPLETE_TOKEN_BRIDGING_ROLE',
] as const
const RECOGNISED_ROLES = new Set<string>(ROLE_NAMES)

/**
 * Admin-level roles (always red when granted to a wallet; never "operational"): who controls
 * roles, the timelock and upgrades, and — owner ruling 2026-10-06, #11 — ANY role that can change
 * config, oracles, supported assets or limits (rsETH MANAGER on LRTConfig sets deposit limits,
 * supported assets and price oracles). Also any role that is another role's admin (replayed
 * from RoleAdminChanged).
 */
export const ADMIN_LEVEL_ROLES = new Set<string>([
  'DEFAULT_ADMIN_ROLE',
  'TIMELOCK_ADMIN_ROLE',
  'PROPOSER_ROLE',
  'EXECUTOR_ROLE',
  'CANCELLER_ROLE',
  'UPGRADER_ROLE',
  'MANAGER',
  'MANAGER_ROLE',
  'ADMIN_ROLE',
  'BYPASSER_ROLE',
  'WHITELISTED_EXECUTOR_ROLE',
  // Aragon: upgrades every app, creates any permission, makes the Agent call anything
  'APP_MANAGER_ROLE',
  'CREATE_PERMISSIONS_ROLE',
  'RUN_SCRIPT_ROLE',
  'EXECUTE_ROLE',
  // ruling #11 — Lido roles that change config, oracles or limits
  'STAKING_CONTROL_ROLE',
  'UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE',
  'MANAGE_MEMBERS_AND_QUORUM_ROLE',
  'DISABLE_CONSENSUS_ROLE',
  'MANAGE_FRAME_CONFIG_ROLE',
  'MANAGE_FAST_LANE_CONFIG_ROLE',
  'MANAGE_REPORT_PROCESSOR_ROLE',
  'MANAGE_CONSENSUS_CONTRACT_ROLE',
  'MANAGE_CONSENSUS_VERSION_ROLE',
  'ALL_LIMITS_MANAGER_ROLE',
  'ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE',
  'APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE',
  'EXTERNAL_PENDING_BALANCE_CAP_MANAGER_ROLE',
  'MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE',
  'MAX_CL_BALANCE_DECREASE_MANAGER_ROLE',
  'MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE',
  'MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE',
  'MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE',
  'MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE',
  'REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE',
  'SECOND_OPINION_MANAGER_ROLE',
  'SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE',
])
/**
 * Recognised privileged roles (AD-4 on a grant to a wallet / a weaker account): every admin-level
 * role (review round 5: CANCELLER_ROLE was admin-level but not privileged, so a grant of it to an
 * EOA read neutral — a canceller can block a pending fix) plus the mint role.
 */
export const PRIVILEGED_ROLES = new Set<string>([
  ...ADMIN_LEVEL_ROLES,
  'MINTER_ROLE',
  // review round 7: a burner burns ANY holder's balance with no allowance (Kelp RSETH.burnFrom,
  // role checked on LRTConfig) — the OFT adapter's lockbox included: privileged, not admin-level
  'BURNER_ROLE',
])
export const MINT_ROLES = new Set<string>(['MINTER_ROLE'])
export const PAUSE_ROLES = new Set<string>([
  'PAUSER_ROLE',
  'PAUSE_ROLE',
  'STAKING_PAUSE_ROLE',
  'DEPOSITS_DISABLER_ROLE',
  'WITHDRAWALS_DISABLER_ROLE',
  'PAUSE_ALL_ROLE',
  'PAUSE_INITIATE_TOKEN_BRIDGING_ROLE',
  'PAUSE_COMPLETE_TOKEN_BRIDGING_ROLE',
])

export const isRecognisedRole = (role: string): boolean => RECOGNISED_ROLES.has(role)
/** Privileged: a recognised privileged role, or ANY role this module does not recognise (#8). */
export const isPrivilegedRole = (role: string): boolean =>
  PRIVILEGED_ROLES.has(role) || !RECOGNISED_ROLES.has(role)

/**
 * AD-4 / MR-2: role `role` granted to `account`. `holders` = the role's holders just before.
 * EXECUTOR_ROLE to address(0) is standard open execution (critique Q4) ⇒ neutral.
 */
export function classifyRoleGrant(
  role: string,
  account: Controller | null,
  holders: Controller[],
  everHeldMintRole: boolean,
  opts: {
    /** The role administers another role (a RoleAdminChanged target): judged privileged. */
    administersRoles?: boolean
    /** Current holders that could not be classified (not ranked against: noted). */
    unclassifiedHolders?: number
  } = {},
): Verdict {
  const v = neutral()
  if (role === 'EXECUTOR_ROLE' && account?.kind === 'zero') return tag(v, 'initialization')
  if (MINT_ROLES.has(role) && !everHeldMintRole) down(v, 'MR-2', 'new minter')
  // Review round 6: a role that is another role's admin grants that role — whatever its name
  // says, it is privileged (an admin moved to an empty OPERATOR_ROLE, then OPERATOR_ROLE to an EOA).
  if (!isPrivilegedRole(role) && !opts.administersRoles) return v
  if (!isRecognisedRole(role)) v.notes.push(`${role} is not a recognised role: judged privileged`)
  else if (opts.administersRoles && !PRIVILEGED_ROLES.has(role))
    v.notes.push(`${role} administers another role: judged privileged`)
  // A privileged grantee that could not be classified is never judged calm (fail closed).
  if (!account) return down(v, 'AD-4', `${role} → an account that could not be classified`)
  // Review round 6: a contract whose deferral chain ends at an EOA ranks with that EOA (an MCMS
  // owned by a key) — AD-4 needs no holder to rank against.
  if (isEoaControlled(account)) return down(v, 'AD-4', `${role} → ${describeController(account)}`)
  if (opts.unclassifiedHolders)
    v.notes.push(
      `${opts.unclassifiedHolders} current holder(s) of ${role} could not be classified: not ranked against`,
    )
  const weakest = holders.reduce<number[] | null>((m, h) => {
    const r = controllerRank(h)
    return m === null || compareRank(r, m) < 0 ? r : m
  }, null)
  if (weakest && compareRank(controllerRank(account), weakest) < 0)
    return down(v, 'AD-4', `${role} → ${describeController(account)}, weaker than current holders`)
  return v
}

// ---- operational role grants (owner rulings 2026-10-06, #4; round 2 #8 / #10 / #11) ---------------
//
// Grants to bot wallets that follow the protocol's own established pattern (EthenaMinting
// MINTER_ROLE to keyed EOAs) are routine operations, not control changes: AMBER `operational`.
// They are RED as before on any anomaly. The numbers are the owner's (round 2, #8 / #10).

/** Pattern: at least this many EARLIER grants of the same role on the same contract to wallets with no code. */
export const OPERATIONAL_PATTERN_MIN_GRANTS = 3
/** One day = one batch: grants of the role on the contract inside this many blocks. */
export const GRANT_BURST_WINDOW_BLOCKS = 7_200
/**
 * Burst (owner ruling #10, revised): a one-day batch is RED only if it is LARGER than the largest
 * earlier one-day batch of the role on the contract. With no earlier batch (no history), the
 * fallback: more than GRANT_BURST_MAX grants in one day.
 */
export const GRANT_BURST_MAX = 3
/** Rate anomaly: the trailing GRANT_RATE_WINDOW_BLOCKS (≈ 30 days) count exceeds this factor × the largest earlier one. */
export const GRANT_RATE_WINDOW_BLOCKS = 216_000
export const GRANT_RATE_SPIKE_FACTOR = 2

/** One earlier grant of a role on a contract (block order; `noCode` = classified as a plain EOA at its block). */
export type GrantRecord = { block: number; account: string; noCode: boolean }

export type GrantPattern = {
  /** ≥ OPERATIONAL_PATTERN_MIN_GRANTS earlier grants of this role here went to wallets with no code. */
  established: boolean
  earlierBotGrants: number
  /** Why this grant is outside the pattern (empty ⇒ operational when established). */
  anomalies: string[]
}

/**
 * Does a grant of `role` to `grantee` at `block` follow the established bot pattern?
 * `earlier` = every earlier grant of the same role on the same contract (strictly before this
 * one); `roleAdmins` = roles that are the admin of some role on this contract.
 *
 *   pattern   — ≥ OPERATIONAL_PATTERN_MIN_GRANTS earlier grants to wallets with no code
 *   anomaly   — the grantee has code (a contract, a Safe, a 7702 EOA) or was not classified;
 *               the role is admin-level (ADMIN_LEVEL_ROLES, or a role-admin role), or not a
 *               recognised role (judged privileged, #8);
 *               BURST (#10): this grant's one-day batch (the trailing GRANT_BURST_WINDOW_BLOCKS,
 *               this one included) is larger than the largest earlier one-day batch (the
 *               trailing-window count at any earlier grant whose window ends before this one
 *               starts); with no earlier batch, more than GRANT_BURST_MAX in the day;
 *               RATE: the trailing GRANT_RATE_WINDOW_BLOCKS count (this one included) is more
 *               than GRANT_RATE_SPIKE_FACTOR × the largest count of any earlier window that ends
 *               before the current one starts (no earlier window ⇒ no rate baseline).
 */
export function grantPattern(
  role: string,
  grantee: Controller | null,
  block: number,
  executed: readonly GrantRecord[],
  roleAdmins: ReadonlySet<string> = new Set(),
  /**
   * Grants earlier in the SAME pending op / proposal (review round 6: a batch of four MINTER
   * grants was judged one by one against executed history). They count in the burst and rate
   * windows, never towards the established pattern.
   */
  sameBatch: readonly GrantRecord[] = [],
): GrantPattern {
  const bots = executed.filter((g) => g.noCode).length
  const earlier = [...executed, ...sameBatch]
  const anomalies: string[] = []
  if (!grantee) anomalies.push('grantee not classified')
  else if (grantee.kind !== 'eoa')
    anomalies.push(`grantee has code (${describeController(grantee)})`)
  if (ADMIN_LEVEL_ROLES.has(role)) anomalies.push(`${role} is an admin-level role`)
  else if (roleAdmins.has(role)) anomalies.push(`${role} administers other roles`)
  else if (!isRecognisedRole(role))
    anomalies.push(`${role} is not a recognised role (judged privileged)`)
  const inWindow = (end: number, w: number) =>
    earlier.filter((g) => g.block > end - w && g.block <= end).length
  /** Largest trailing-window count at an earlier grant whose window ends before this one starts. */
  const largestEarlier = (w: number): number | null => {
    const prior = earlier.filter((g) => g.block <= block - w)
    return prior.length ? Math.max(...prior.map((g) => inWindow(g.block, w))) : null
  }
  const batch = inWindow(block, GRANT_BURST_WINDOW_BLOCKS) + 1
  const largestBatch = largestEarlier(GRANT_BURST_WINDOW_BLOCKS)
  if (largestBatch === null) {
    if (batch > GRANT_BURST_MAX)
      anomalies.push(
        `grant spike: ${batch} grants within ${GRANT_BURST_WINDOW_BLOCKS} blocks and no earlier one-day batch: more than ${GRANT_BURST_MAX}`,
      )
  } else if (batch > largestBatch)
    anomalies.push(
      `grant spike: this one-day batch of ${batch} grants is larger than the largest earlier one-day batch (${largestBatch})`,
    )
  const rate = inWindow(block, GRANT_RATE_WINDOW_BLOCKS) + 1
  const baseline = largestEarlier(GRANT_RATE_WINDOW_BLOCKS) ?? 0
  if (baseline > 0 && rate > GRANT_RATE_SPIKE_FACTOR * baseline)
    anomalies.push(
      `grant rate: ${rate} in ${GRANT_RATE_WINDOW_BLOCKS} blocks vs at most ${baseline} in any earlier window (> ${GRANT_RATE_SPIKE_FACTOR}×)`,
    )
  return {
    established: bots >= OPERATIONAL_PATTERN_MIN_GRANTS,
    earlierBotGrants: bots,
    anomalies,
  }
}

/**
 * Apply the operational split to a red role-grant verdict: an established pattern with no
 * anomaly is AMBER `operational` (not red); an anomaly keeps it red and says why. A verdict
 * that is not red is left alone (the split never adds red where the rules did not).
 */
export function applyGrantPattern(v: Verdict, role: string, p: GrantPattern): Verdict {
  if (!isRed(v)) return v
  if (!p.established) {
    if (ADMIN_LEVEL_ROLES.has(role)) return v
    // Review round 8: a grant an established pattern would NOT clear (the grantee has code, the
    // role is unrecognised, a spike…) leads with that anomaly — "no pattern yet" read as if the
    // row would turn amber once three earlier bot grants exist.
    if (p.anomalies.length) {
      tag(v, 'anomaly')
      v.notes.unshift(
        `red whatever the ${role} bot pattern (owner ruling #8): ${p.anomalies.join('; ')}`,
      )
      return v
    }
    // say why a bot-like grant is red (review round 7: the first USDe MINTER grants read only
    // "new minter" — the reason sat in the chip tooltips)
    v.notes.unshift(
      `no established ${role} bot pattern yet: ${p.earlierBotGrants} of the ${OPERATIONAL_PATTERN_MIN_GRANTS} earlier grants to wallets with no code it needs`,
    )
    return v
  }
  // The pattern verdict is the row's reason: it leads the notes (review round 5 — the timeline
  // showed only the first notes, so the reason was cut off).
  if (p.anomalies.length) {
    tag(v, 'anomaly')
    v.notes.unshift(
      `outside the established ${role} bot pattern (${p.earlierBotGrants} earlier grants to wallets with no code): ${p.anomalies.join('; ')}`,
    )
    return v
  }
  v.severity = 'neutral'
  v.ruleIds = []
  tag(v, 'operational')
  v.notes.unshift(
    `operational: matches the established ${role} bot pattern (${p.earlierBotGrants} earlier grants to wallets with no code; no anomaly)`,
  )
  return v
}

/**
 * AD-3 on a role's ADMIN role (RoleAdminChanged): who can grant `role` moved from the holders
 * of one admin role to the holders of another. Ranked on the weakest holder of each side. A
 * PREVIOUS admin role with no holder ranks like immutable; a NEW admin role with no holder is
 * noted, never an upgrade (review round 6: its first grant is the change of control).
 */
export function classifyRoleAdminChange(
  role: string,
  prevAdmin: { name: string; holders: (Controller | null)[] },
  nextAdmin: { name: string; holders: (Controller | null)[] },
): Verdict {
  const v = neutral()
  const weakest = (hs: (Controller | null)[]) =>
    hs.length
      ? hs.reduce<number[]>((m, h) => {
          const r = controllerRank(h)
          return compareRank(r, m) < 0 ? r : m
        }, controllerRank(hs[0]))
      : [6]
  const desc = (a: { name: string; holders: (Controller | null)[] }) =>
    `${a.name} (${a.holders.length ? a.holders.map((h) => describeController(h)).join(' | ') : 'no holder'})`
  const msg = `admin of ${role}: ${desc(prevAdmin)} → ${desc(nextAdmin)}`
  // Review round 6: an admin role with NO holder is not "nobody can grant": whoever is granted it
  // later can grant `role` (its grants are judged privileged). Never an upgrade.
  if (!nextAdmin.holders.length) {
    v.notes.push(
      `${msg}: ${nextAdmin.name} has no holder yet — whoever is granted it can grant ${role} (judged when granted)`,
    )
    return v
  }
  const c = compareRank(weakest(nextAdmin.holders), weakest(prevAdmin.holders))
  if (c < 0) return down(v, 'AD-3', msg)
  if (c > 0) return up(v, msg)
  v.notes.push(msg)
  return v
}

/** MR-1: a pause-role revocation / pauser change that leaves nobody able to pause. */
export function classifyPauserChange(remaining: number): Verdict {
  const v = neutral()
  if (remaining === 0) return down(v, 'MR-1', 'no pauser left')
  return v
}

// ---- Wormhole NTT (and any threshold-of-transceivers bridge) ------------------------------------
//
// An NTT manager accepts a message once `threshold` of its transceivers attest it. The LayerZero
// rules carry over (design §2 BR-2: "the same floor applies to NTT getThreshold() < 2"): the
// threshold is E, a transceiver's verifier network (getTransceiverType(): wormhole, axelar, …) is
// its operator, and two transceivers on one network count once.

/** Distinct verifier networks among the transceivers (null type = unknown, never counted). */
export function nttEffective(
  threshold: number | null,
  types: (string | null)[],
): { E: number; distinct: number; unknown: number; duplicate: number } {
  const known = types.filter((t): t is string => !!t)
  const distinct = new Set(known.map((t) => t.toLowerCase())).size
  return {
    E: threshold === null ? 0 : Math.min(threshold, distinct),
    distinct,
    unknown: types.length - known.length,
    duplicate: known.length - distinct,
  }
}

/**
 * BR-1 / BR-2 on an NTT threshold change (`types` = the transceivers after the change,
 * `prevTypes` = before). Review round 8: with both given, BR-1 compares the EFFECTIVE verifier
 * count (distinct networks the threshold reaches), not only the raw threshold — removing the one
 * axelar transceiver from {wormhole, axelar, ccip, wormhole} at threshold 3 drops E from 3 to 2.
 */
export function classifyNttThreshold(
  prev: number | null,
  next: number,
  types?: (string | null)[],
  prevTypes?: (string | null)[],
): Verdict {
  const v = neutral()
  const E = types ? nttEffective(next, types).E : next
  const prevE = prev !== null && prevTypes ? nttEffective(prev, prevTypes).E : null
  if (prev !== null && next < prev) down(v, 'BR-1', `NTT threshold ${prev} → ${next}`)
  else if (prevE !== null && E < prevE)
    down(
      v,
      'BR-1',
      `NTT effective verifier networks ${prevE} → ${E} (threshold ${next}${prev !== next ? `, was ${prev}` : ' unchanged'})`,
    )
  else if (prev !== null && next > prev) up(v, `NTT threshold ${prev} → ${next}`)
  if (E < 2) {
    v.floorBreach = true
    if (!v.ruleIds.includes('BR-2')) v.ruleIds.push('BR-2')
    v.notes.push(
      `FLOOR: ${E} effective verifier network(s) attest a message (threshold ${next}${types ? ` over ${nttEffective(next, types).distinct} distinct network(s)` : ''})`,
    )
  }
  return v
}

/**
 * A transceiver added: at an unchanged threshold it widens the set an attacker picks from (AMBER
 * `wider_dvn_set`, ruling #6); an unknown network, or a second transceiver on a network already
 * present, is BR-7 (red). `threshold` after; `prevThreshold` / `prevTypes` before.
 */
export function classifyNttTransceiverAdded(
  type: string | null,
  prevTypes: (string | null)[],
  prevThreshold: number | null,
  threshold: number,
): Verdict {
  const v = classifyNttThreshold(prevThreshold, threshold, [...prevTypes, type], prevTypes)
  if (!type)
    down(v, 'BR-7', 'transceiver of an unknown verifier network (getTransceiverType unread)')
  else if (prevTypes.some((t) => t && t.toLowerCase() === type.toLowerCase()))
    down(v, 'BR-7', `a second ${type} transceiver: one verifier network counts once`)
  else if (prevThreshold !== null && threshold === prevThreshold && prevTypes.length > 0) {
    tag(v, 'wider_dvn_set')
    v.notes.push(
      `WIDER SET: ${prevTypes.length + 1} transceivers at threshold ${threshold} (amber, ruling #6)`,
    )
  }
  return v
}

/**
 * BR-6 on any bridge peer (NTT manager peer, transceiver peer): a move from one non-zero peer to
 * another is red, also through a zeroed peer (`lastNonZero`); zeroing is neutral (route removed);
 * a first peer is neutral (route created).
 */
export function classifyPeerChange(
  prev: string | null,
  next: string,
  lastNonZero?: string | null,
): Verdict {
  const v = neutral()
  const zero = (x?: string | null) => !x || /^0x0*$/i.test(x)
  if (zero(next)) return tag(v, 'route_removed')
  const was = !zero(prev) ? prev! : !zero(lastNonZero) ? lastNonZero! : null
  if (!was) return tag(v, 'route_created')
  if (was.toLowerCase() === next.toLowerCase()) return v
  return down(
    v,
    'BR-6',
    `peer ${was} → ${next}${zero(prev) ? ' (re-pointed through a zeroed peer)' : ''}`,
  )
}

/** AD-6: Safe guard / module / fallback handler / singleton changed. */
export function classifySafeModuleChange(
  field:
    | 'module_enabled'
    | 'module_disabled'
    | 'guard'
    | 'module_guard'
    | 'fallback_handler'
    | 'singleton',
  from?: string,
  to?: string,
): Verdict {
  const v = neutral()
  const zero = (a?: string) => !a || /^0x0*$/i.test(a)
  if (field === 'module_disabled') return up(v, `module ${from ?? ''} disabled`)
  // A guard only checks transactions: adding one (from none) restricts, removing or replacing
  // one is the downgrade (critique: "a guard that is replaced, not only one set to zero").
  if ((field === 'guard' || field === 'module_guard') && zero(from) && !zero(to))
    return up(v, `${field.replace('_', ' ')} added ${to}`)
  return down(v, 'AD-6', `${field.replace('_', ' ')} ${from ?? '?'} → ${to ?? '?'}`)
}

/**
 * Does a (target, selector) on a timelock's no-delay whitelist exercise a declared power?
 *   reaches  — a power on the target (or the endpoint, for a bridge power) is exercised by it
 *   outside  — the target is a power's contract, and no power on it is exercised
 *   unknown  — the target is one of the subject's contracts that no power is declared on (fail
 *              closed: judged as reaching one)
 *   foreign  — not one of the subject's contracts (a shared timelock's other assets): not this card's
 */
export type WhitelistReach = 'reaches' | 'outside' | 'unknown' | 'foreign'

/**
 * AD-2 (review round 6): a (target, selector) put on / taken off a timelock's no-delay whitelist
 * (Ethena executeWhitelisted). Put on: the timelock leaves that path — red unless the function
 * reaches no declared power ('outside'); an unmatched one fails closed. Taken off: an upgrade.
 */
export function classifyWhitelistChange(
  added: boolean,
  target: string,
  selector: string,
  reach: WhitelistReach,
): Verdict {
  const v = neutral()
  const what = `${selector} on ${target.slice(0, 10)}…`
  if (reach === 'foreign') {
    v.notes.push(`${what}: not one of this subject's contracts`)
    return v
  }
  if (!added) return up(v, `${what} removed from the no-delay whitelist`)
  if (reach === 'outside') {
    v.notes.push(`${what} whitelisted (no delay): outside every declared power`)
    return v
  }
  return down(
    v,
    'AD-2',
    `${what} whitelisted for executeWhitelisted: executes with NO delay${reach === 'unknown' ? ' (not matched to a declared power: fail closed)' : ''}`,
  )
}

/** AD-7 (state): who holds the admin role of a timelock. */
export function timelockAdminBreach(timelock: string, holders: Controller[]): string[] {
  return holders
    .filter(
      (h) => h.address !== timelock.toLowerCase() && h.kind !== 'precompile' && h.kind !== 'zero',
    )
    .map((h) => describeController(h))
}

// ---- DVN signer sets ------------------------------------------------------------------------------

/** DV-1 / DV-2: a DVN's multisig quorum / signer count changed inside one transaction. */
export function classifyDvnSignerChange(
  prev: { quorum: number; signers: number },
  next: { quorum: number; signers: number },
  addedAndRemoved: boolean,
): Verdict {
  const v = neutral()
  if (next.quorum < prev.quorum) return down(v, 'DV-1', `quorum ${prev.quorum} → ${next.quorum}`)
  if (next.quorum === prev.quorum && next.signers > prev.signers)
    return down(
      v,
      'DV-2',
      `signer added at quorum ${next.quorum} (${prev.signers} → ${next.signers})`,
    )
  if (addedAndRemoved) tag(v, 'rotation')
  if (next.quorum > prev.quorum || next.signers < prev.signers) up(v)
  return v
}

// ---- CCIP -------------------------------------------------------------------------------------------

export function classifyCcip(
  kind: 'pool_set' | 'remote_pool_set' | 'remote_pool_added' | 'rate_limiter' | 'rebalancer',
  args: {
    prev?: string
    next?: string
    enabled?: boolean
    prevCtl?: Controller | null
    nextCtl?: Controller | null
  },
): Verdict {
  const v = neutral()
  const zero = (a?: string) => !a || /^0x0*$/i.test(a)
  if (kind === 'pool_set' || kind === 'remote_pool_set') {
    if (
      !zero(args.prev) &&
      !zero(args.next) &&
      args.prev!.toLowerCase() !== args.next!.toLowerCase()
    )
      return down(v, 'CC-1', `${args.prev} → ${args.next}`)
    if (zero(args.next)) return tag(v, 'route_removed')
    return tag(v, 'route_created')
  }
  if (kind === 'remote_pool_added') return tag(v, 'route_created')
  if (kind === 'rate_limiter')
    return args.enabled === false ? down(v, 'CC-2', 'rate limiter disabled') : v
  // rebalancer — review round 8: ranked with whoever controls it (a contract an EOA owns, a
  // 1-of-N Safe), as the head check does; `isEoa` alone let a first rebalancer, or one whose
  // previous holder was unread, read calm
  if (isEoaControlled(args.nextCtl))
    return down(v, 'CC-3', `rebalancer → ${describeController(args.nextCtl)}`)
  if (args.prevCtl && compareRank(controllerRank(args.nextCtl), controllerRank(args.prevCtl)) < 0)
    return down(
      v,
      'CC-3',
      `${describeController(args.prevCtl)} → ${describeController(args.nextCtl)}`,
    )
  return v
}

/**
 * AD-9: a new implementation is red unless its source is verified. Verification that could
 * not be read is not a pass (fail closed).
 */
export function verificationRule(v: Verdict, impl: string, verified: boolean | null) {
  if (verified === true) {
    v.notes.push(`new implementation ${impl} has verified source`)
    return v
  }
  // fail closed either way, but a lookup that FAILED is not "checked, not verified" (default)
  tag(v, verified === false ? 'unverified' : 'verification_unread')
  return down(
    v,
    'AD-9',
    `new implementation ${impl}: ${verified === false ? 'source not verified on Sourcify or Blockscout (Etherscan not checked)' : 'source verification could not be read'}`,
  )
}

// ---- mint / redeem ----------------------------------------------------------------------------------

const asBig = (x: unknown): bigint | null => {
  try {
    if (x === null || x === undefined || x === '') return null
    if (typeof x === 'boolean') return x ? 1n : 0n
    return BigInt(x as string)
  } catch {
    return null
  }
}
const ZERO_ADDR = /^0x0{40}$/i
/**
 * Values that mean "no limit" whatever the parameter (review round 6: no ParamSpec declared its
 * sentinel, so EthenaMinting's cap set to type(uint128).max read as a large raise).
 */
export const UNLIMITED_SENTINELS: readonly bigint[] = [2n ** 256n - 1n, 2n ** 128n - 1n]

/**
 * A mint/redeem parameter moved from `prev` to `next` (values as read: decimal strings,
 * addresses, booleans). `nextCtl` classifies an address-valued param at the change block,
 * `prevCtl` the old value just before it; `nextVerified` is the source verification of a new
 * rate provider / price oracle (true verified, false not verified, null/undefined not read).
 */
export function classifyParamChange(
  spec: ParamSpec,
  prev: unknown,
  next: unknown,
  nextCtl?: Controller | null,
  extra: {
    prevCtl?: Controller | null
    nextVerified?: boolean | null
    /**
     * The last NON-ZERO value this address param had (review round 6): A → 0 → B is the same
     * replacement as A → B (a new minter, a new price source), never "set from nothing".
     */
    lastNonZero?: string | null
  } = {},
): Verdict {
  const v = neutral()
  switch (spec.rule) {
    case 'pauser': {
      if (typeof next === 'string' && ZERO_ADDR.test(next))
        return down(v, 'MR-1', 'pauser set to address(0)')
      if (
        typeof prev === 'string' &&
        typeof next === 'string' &&
        prev.toLowerCase() !== next.toLowerCase()
      )
        tag(v, 'rotation')
      return v
    }
    case 'rate_provider':
    case 'price_oracle':
    case 'minter': {
      if (typeof next !== 'string') return v
      if (ZERO_ADDR.test(next))
        return spec.rule === 'minter'
          ? tag(v, 'route_removed')
          : down(v, 'MR-2', `${spec.label} → address(0)`)
      const viaZero =
        !(typeof prev === 'string' && !ZERO_ADDR.test(prev)) &&
        typeof extra.lastNonZero === 'string' &&
        !ZERO_ADDR.test(extra.lastNonZero)
      const was = viaZero ? extra.lastNonZero! : prev
      const replaced =
        typeof was === 'string' && !ZERO_ADDR.test(was) && was.toLowerCase() !== next.toLowerCase()
      if (viaZero && replaced) v.notes.push(`re-pointed through address(0): ${was} → 0 → ${next}`)
      // EOA → EOA is a key rotation (AD-3's ruling; design §8 "cbBTC EOA→EOA → neutral").
      if (isEoa(nextCtl) && isEoa(extra.prevCtl) && replaced) return tag(v, 'rotation')
      // An EOA classification also covers a no-code address (nothing to execute there); a
      // contract an EOA controls ranks with that EOA (verified or not).
      if (isEoaControlled(nextCtl))
        return down(v, 'MR-2', `${spec.label} → ${describeController(nextCtl)}`)
      if (spec.rule === 'minter' && replaced) return down(v, 'MR-2', `new minter ${next}`)
      // A rate provider / oracle replaced by another contract is a logic change of the price
      // source: amber when its source is verified, red when it is not (or cannot be read).
      if (replaced) {
        tag(v, 'logic_change')
        if (extra.nextVerified === true)
          v.notes.push(`${spec.label} replaced by a verified contract`)
        else {
          tag(v, extra.nextVerified === false ? 'unverified' : 'verification_unread')
          down(
            v,
            'AD-9',
            `${spec.label} replaced by ${next}: ${extra.nextVerified === false ? 'source not verified on Sourcify or Blockscout (Etherscan not checked)' : 'source verification could not be read'}`,
          )
        }
      }
      return v
    }
    case 'bound_upper': {
      const a = asBig(prev)
      const b = asBig(next)
      if (a === null || b === null) return v
      if (b > a) return down(v, 'MR-3', `${spec.label} ${a} → ${b} (looser)`)
      if (b < a) return up(v, `${spec.label} ${a} → ${b} (tighter)`)
      return v
    }
    case 'quorum':
    case 'quorum_members': {
      const a = asBig(prev)
      const b = asBig(next)
      if (a === null || b === null) return v
      // quorum lowered = looser; for 'quorum_members' (committee size) MORE members at a fixed
      // quorum lowers the quorum/members ratio = looser.
      if (spec.rule === 'quorum' ? b < a : b > a)
        return down(v, 'MR-3', `${spec.label} ${a} → ${b}`)
      if (a !== b) up(v)
      return v
    }
    case 'cap': {
      const a = asBig(prev)
      const b = asBig(next)
      if (b === null) return v
      // judged on the NEW value alone: a previous value that was not read never hides it
      if (b === 0n)
        return spec.zero === 'unlimited'
          ? down(v, 'MR-4', `${spec.label} → 0 (unlimited for this asset)`)
          : tag(v, 'route_removed')
      if ((spec.unlimited && b === BigInt(spec.unlimited)) || UNLIMITED_SENTINELS.includes(b))
        return down(v, 'MR-4', `${spec.label} → unlimited sentinel`)
      if (a === null) return v
      if (a === 0n && spec.zero === 'unlimited') return up(v, `${spec.label} capped`)
      if (a > 0n && b >= 2n * a) return tag(v, 'large_raise')
      return v
    }
    case 'whitelist_gate': {
      if ((prev === true || prev === 'true') && (next === false || next === 'false'))
        return down(v, 'MR-5', `${spec.label} removed`)
      return v
    }
    case 'cooldown': {
      const a = asBig(prev)
      const b = asBig(next)
      if (a !== null && b !== null && b < a) tag(v, 'run_risk')
      return v
    }
    default:
      return v
  }
}

// ---- oracle -----------------------------------------------------------------------------------------

/** OR-1 on the existing oracle ChangeKind vocabulary (lib/oracleRegistry/changes.ts). */
export function classifyOracleParam(
  kind: string,
  param: string,
  from: unknown,
  to: unknown,
  toCtl?: Controller | null,
): Verdict {
  const v = neutral()
  const a = typeof from === 'number' ? from : Number(from)
  const b = typeof to === 'number' ? to : Number(to)
  const nums = Number.isFinite(a) && Number.isFinite(b)
  const p = param.toLowerCase()
  if (kind === 'heartbeat' && nums && b > a) return down(v, 'OR-1', `heartbeat ${a} → ${b}`)
  if (kind === 'deviation_threshold' && nums && b > a)
    return down(v, 'OR-1', `deviation ${a} → ${b}`)
  if (kind === 'twap_window' && nums && b < a) return down(v, 'OR-1', `TWAP window ${a} → ${b}`)
  if (kind === 'quorum' && nums && b < a) return down(v, 'OR-1', `bar ${a} → ${b}`)
  if (
    kind === 'cap' &&
    nums &&
    (p.includes('growth') || p.includes('ratechange') || p.includes('maxyearly')) &&
    b > a
  )
    return down(v, 'OR-1', `${param} ${a} → ${b}`)
  // review round 7: a source moved to a contract an EOA controls ranks with that EOA (MR-2 does)
  if (
    (kind === 'market_source' || kind === 'aggregator' || kind === 'wiring') &&
    isEoaControlled(toCtl)
  )
    return down(v, 'OR-1', `${param} → ${describeController(toCtl)}`)
  if (p.includes('fallback') && (to === null || (typeof to === 'string' && ZERO_ADDR.test(to))))
    return down(v, 'OR-1', 'fallback removed')
  return v
}

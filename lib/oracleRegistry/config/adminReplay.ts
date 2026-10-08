// Admin / mint / CCIP / DVN-signer history: decoded events (collector) → ConfigChanges.
//
// Every event that names an account is judged on the CONTROLLERS involved, classified at the
// event's block by the collector (archive reads: code, Safe threshold/owners, timelock delay,
// multisig `required`). Events of one emitter inside one transaction are grouped, so a Safe
// `addOwnerWithThreshold` (AddedOwner + ChangedThreshold) is judged once on before/after.

import type {
  AnnouncementStatus,
  ChangeTag,
  ConfigChange,
  Controller,
  Dimension,
  Hex,
  ParamSpec,
} from './types'
import {
  MINT_ROLES,
  OWNER_INIT_WINDOW_BLOCKS,
  PAUSE_ROLES,
  applyGrantPattern,
  classifyCcip,
  classifyControllerChange,
  classifyDelayChange,
  classifyDvnSignerChange,
  classifyMultisigChange,
  classifyNttThreshold,
  classifyNttTransceiverAdded,
  classifyParamChange,
  classifyPauserChange,
  classifyPeerChange,
  formatDelay,
  nttEffective,
  classifyRoleAdminChange,
  classifyRoleGrant,
  classifySafeModuleChange,
  classifyWhitelistChange,
  describeController,
  down,
  grantPattern,
  isRed,
  neutral,
  tag,
  verificationRule,
  type GrantRecord,
  type Verdict,
  type WhitelistReach,
} from './rules'
import { formatParamAmount } from './value'

export type AdminEventRow = {
  chainId: number
  block: number
  logIndex: number
  tx: Hex
  ts?: number
  emitter: string
  event: string
  args: Record<string, unknown>
  /** Collector enrichment for events that do not carry the previous value (FiatToken roles…). */
  prev?: string | null
}

/** Controller of `address` at `block` (collector archive read); null = not classified. */
export type ControllerLookup = (address: string, block: number) => Controller | null

export type AdminCtx = {
  subject: string
  ctl: ControllerLookup
  /** proxy (lower) → timelocks that hold its upgrade power at head (AD-5). */
  upgradeTimelocks: Record<string, string[]>
  /** timelock → first block it held a power (fallback when holders-at-block are unknown). */
  timelockSince?: Record<string, number>
  /**
   * `${proxy}@${block}` → the upgrade power's holders resolved at block − 1 (archive). AD-5
   * judges an upgrade only against the timelock that actually held the power at that time.
   */
  upgradeHoldersAt?: Record<string, Controller[]>
  /** Exact classification at a block (no fallback to head): `null` when not read. */
  ctlExact?: ControllerLookup
  /** contract (lower) → first block with code (an Upgraded in the deploy tx is initialization). */
  deployBlocks: Record<string, number>
  /** Subject tokens (lower) — TokenAdminRegistry events are kept only for these. */
  tokens: string[]
  announcement: AnnouncementStatus
  /** Contracts whose minter allowance / config the subject tracks (FiatToken MinterConfigured). */
  minterCapSpec?: ParamSpec
  /** Source verification of an implementation: true, false, or null / undefined (not read). */
  verified?: (address: string) => boolean | null | undefined
  /**
   * Power-graph controllers that are NOT declared subject contracts (a shared timelock, a Safe
   * found through a holder path) → the first block an event on ANOTHER contract named them as a
   * holder (owner, admin, role grantee, CCIP administrator, LZ delegate). Their OWN events
   * before that block are another protocol's history: replayed for state, never filed here
   * (review round 5: WBTC was charged with the CCIP RBACTimelock's 2023–24 delay cuts). A
   * controller with no such event is filed throughout (fail closed).
   */
  scopeSince?: Record<string, number>
  /** First block of the admin event scan: a Safe deployed before it has an incomplete history. */
  scanFrom?: number
  /**
   * Rows before this block are replayed for state (role holders, managers) but never filed: an
   * Aragon ACL is scanned from its deployment so the permission holders are complete, while the
   * card's history window stays the subject's scan window.
   */
  fileFrom?: number
  /**
   * Does a (target, selector) whitelisted for a timelock's no-delay bypass exercise a declared
   * power (review round 6, AD-2)? 'outside' only when the target is a power's contract and no
   * power on it is reached; anything else is judged as reaching one (fail closed).
   */
  whitelistReach?: (target: string, selector: string) => WhitelistReach
}

const lcs = (x: unknown) => String(x ?? '').toLowerCase()
const MS_EVENTS = new Set([
  'AddedOwner',
  'RemovedOwner',
  'ChangedThreshold',
  'OwnerAddition',
  'OwnerRemoval',
  'RequirementChange',
])
const isEoaLike = (c: Controller | null) => !!c && (c.kind === 'eoa' || c.kind === 'eoa_7702')
const ZERO = '0x0000000000000000000000000000000000000000'
const isZero = (a: unknown) => /^0x0*$/i.test(String(a ?? ''))

function mk(
  ctx: AdminCtx,
  row: AdminEventRow,
  dimension: Dimension,
  key: string,
  title: string,
  v: Verdict,
  extra: Partial<ConfigChange> = {},
): ConfigChange {
  return {
    id: `${row.chainId}:${row.tx}:${row.logIndex}`,
    subject: ctx.subject,
    dimension,
    key,
    title,
    state: 'historical',
    stage: 'executed',
    severity: v.severity,
    floorBreach: v.floorBreach,
    red: isRed(v),
    ruleIds: v.ruleIds,
    tags: v.tags as ChangeTag[],
    unannounced: null,
    announcement: ctx.announcement,
    chainId: row.chainId,
    block: row.block,
    ts: row.ts,
    tx: row.tx,
    notes: v.notes.length ? v.notes : undefined,
    ...extra,
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
/** The owners a multisig transaction's Added / Removed events name, shortened. */
const ownersOf = (rows: AdminEventRow[], re: RegExp) =>
  rows
    .filter((x) => re.test(x.event))
    .map((x) => short(lcs(x.args.owner)))
    .join(', ')

export function classifyAdminEvents(rows: AdminEventRow[], ctx: AdminCtx): ConfigChange[] {
  const out: ConfigChange[] = []
  const sorted = [...rows].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  const byTx = new Map<string, AdminEventRow[]>()
  for (const r of sorted) byTx.set(r.tx, [...(byTx.get(r.tx) ?? []), r])
  // role holders per (emitter, role), replayed from the events themselves
  const holders = new Map<string, Set<string>>()
  const everMint = new Map<string, Set<string>>()
  // every earlier grant per (emitter, role) and the roles that administer others (ruling #4)
  const grants = new Map<string, GrantRecord[]>()
  const roleAdmins = new Map<string, Set<string>>()
  const minters = new Map<string, Set<string>>()
  const everMinters = new Map<string, Set<string>>()
  // last guard / module guard / fallback handler per Safe (the events carry only the new one)
  const lastGuard = new Map<string, { value: string; block: number }>()
  const rateLimit = new Map<string, boolean>()
  // CCIP remote pools per (pool, chain selector): current, every one the chain ever had, and the
  // set it accepted the last time it served any (review round 8: a roll-back to an OLDER pool
  // after a removal is a re-point; only the pools it had last are a plain re-open)
  const remotePools = new Map<string, Set<string>>()
  const everRemote = new Map<string, Set<string>>()
  const lastServed = new Map<string, Set<string>>()
  // last non-zero CCIP pool per token (TokenAdminRegistry PoolSet): A → 0 → B is a re-point
  const lastPool = new Map<string, string>()
  const done = new Set<string>()
  // Last known holder per (what, emitter): a later "set from address(0)" is judged against it.
  const lastOwner = new Map<string, string>()
  // Multisig threshold / signers replayed from the events, anchored at exact archive reads.
  const msState = new Map<string, { threshold: number; signers: number; block: number }>()
  // Dual Governance: the last value each config event set (the events carry only the new one)
  const lastSet = new Map<string, string>()
  const dgProposers = new Map<string, Set<string>>()
  // Wormhole NTT: threshold, transceivers (verifier network of each) and peers per manager
  const ntt = new Map<
    string,
    { threshold: number | null; tx: Map<string, string | null>; peers: Map<string, string> }
  >()
  const nttOf = (m: string) => {
    if (!ntt.has(m)) ntt.set(m, { threshold: null, tx: new Map(), peers: new Map() })
    return ntt.get(m)!
  }
  // last non-zero peer per (manager or transceiver, chain): a re-point through 0 is BR-6
  const lastPeer = new Map<string, string>()
  const peerNow = new Map<string, string>()
  // Initialization = an event in the emitter's deploy block (the collector bisects the first
  // block with code for every emitter). An unknown deploy block is never assumed.
  const isInit = (em: string, block: number) => ctx.deployBlocks[em] === block
  const exact = ctx.ctlExact ?? (() => null)

  for (const r of sorted) {
    const a = r.args
    const em = r.emitter
    const before = (addr: string) => ctx.ctl(addr, r.block - 1)
    const at = (addr: string) => ctx.ctl(addr, r.block)
    const txRows = byTx.get(r.tx) ?? []
    // A power-graph controller's own events before it held any power over the subject: the
    // state is replayed (role holders, multisig counts), the rows are not filed (scopeSince).
    const since = ctx.scopeSince?.[em]
    const filed = out.length
    switch (r.event) {
      case 'OwnershipTransferred':
      case 'AdminChanged': {
        const prev = lcs(a.previousOwner ?? a.previousAdmin)
        const next = lcs(a.newOwner ?? a.newAdmin)
        const what = r.event === 'AdminChanged' ? 'proxy admin' : 'owner'
        const lk = `${what}|${em}`
        const known = lastOwner.get(lk)
        lastOwner.set(lk, next)
        if (isZero(prev)) {
          // From address(0): initialization at deployment, or the first owner of a contract still
          // running the code it was deployed with (a deferred initialize()) — but only within
          // OWNER_INIT_WINDOW_BLOCKS of the deploy block: later, the initialize() call could have
          // been front-run, so it is RED (owner ruling 2026-10-06, round 2 #7). After an upgrade
          // (OZ v5 re-initialisation moves the owner to namespaced storage) or after an earlier
          // owner, it is a change of control, judged against the last owner the events showed.
          const deployed = ctx.deployBlocks[em]
          const upgradedSince = sorted.some(
            (x) =>
              x.emitter === em &&
              (x.event === 'Upgraded' || x.event === 'BeaconUpgraded') &&
              (deployed === undefined || x.block > deployed) &&
              (x.block < r.block || (x.block === r.block && x.logIndex <= r.logIndex)),
          )
          const key = `admin/${what.replace(' ', '_')}/${em}`
          const firstOwner = !known && !upgradedSince
          const late = deployed !== undefined && r.block - deployed > OWNER_INIT_WINDOW_BLOCKS
          if (isInit(em, r.block) || (firstOwner && deployed !== undefined && !late)) {
            out.push(
              mk(
                ctx,
                r,
                'admin',
                key,
                `${what} of ${short(em)} set to ${short(next)}`,
                tag(neutral(), 'initialization'),
              ),
            )
            break
          }
          if (firstOwner) {
            // the first owner, set late (or with the deploy block unknown: fail closed)
            const v = down(
              neutral(),
              'AD-3',
              deployed === undefined
                ? `${what} set from address(0) with the contract's deploy block unknown: initialization cannot be confirmed (fail closed)`
                : `first ${what} set from address(0) ${(r.block - deployed).toLocaleString('en-US')} blocks after deployment (> ${OWNER_INIT_WINDOW_BLOCKS.toLocaleString('en-US')}): initialize() could have been front-run`,
            )
            out.push(
              mk(
                ctx,
                r,
                'admin',
                key,
                `${what} of ${short(em)}: address(0) → ${describeController(at(next))}`,
                v,
                { before: prev, after: next },
              ),
            )
            break
          }
          // Judged against the last owner the events showed (review round 5):
          //   a real earlier owner        → AD-3 on that owner vs the new one;
          //   a RENOUNCED owner (0)        → nothing could act; any new owner is a downgrade;
          //   none seen (after an upgrade) → the previous holder is unread: fail closed (an EOA
          //                                  or an unclassified owner is red, never
          //                                  "initialization").
          const renounced = !!known && isZero(known)
          const v =
            known && !renounced
              ? classifyControllerChange(before(known), at(next))
              : renounced
                ? classifyControllerChange({ kind: 'zero', address: ZERO }, at(next))
                : classifyControllerChange(null, at(next))
          v.notes.push(
            renounced
              ? `${what} taken back from address(0) after it was renounced`
              : `${what} set from address(0) ${upgradedSince ? 'after an upgrade (re-initialisation)' : 'after an earlier owner'}`,
          )
          out.push(
            mk(
              ctx,
              r,
              'admin',
              key,
              `${what} of ${short(em)}: ${known ? describeController(before(known)) : 'address(0)'} → ${describeController(at(next))}`,
              v,
              { before: known ?? prev, after: next },
            ),
          )
          break
        }
        const v = classifyControllerChange(before(prev), at(next))
        if (r.event === 'AdminChanged') ad5(v, r, txRows, ctx)
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/${what.replace(' ', '_')}/${em}`,
            `${what} of ${short(em)}: ${describeController(before(prev))} → ${describeController(at(next))}`,
            v,
            { before: prev, after: next },
          ),
        )
        break
      }
      case 'Upgraded':
      case 'BeaconUpgraded': {
        const impl = lcs(a.implementation ?? a.beacon)
        const v = tag(neutral(), 'logic_change')
        if ((ctx.deployBlocks[em] ?? -1) === r.block) {
          tag(v, 'initialization')
        } else {
          ad5(v, r, txRows, ctx)
          // AD-9: red unless the new implementation's source is verified (fail closed).
          verificationRule(v, impl, ctx.verified?.(impl) ?? null)
        }
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/implementation/${em}`,
            `${r.event === 'BeaconUpgraded' ? 'beacon' : 'implementation'} of ${short(em)} → ${short(impl)}`,
            v,
            { after: impl },
          ),
        )
        break
      }
      case 'RoleGranted': {
        const role = lcs(a.role)
        const name = String(a.roleName ?? role)
        const k = `${em}|${role}`
        const acct = lcs(a.account)
        const read = [...(holders.get(k) ?? [])].map((h) => at(h))
        const cur = read.filter((c): c is Controller => !!c)
        const ever = everMint.get(em) ?? new Set()
        // A new minter is any account that never held the mint role — also the first one after
        // deployment (the grant in the deploy block is initialization, below). A role that is
        // another role's admin is privileged whatever its name (review round 6).
        const v = classifyRoleGrant(
          name,
          at(acct),
          cur,
          MINT_ROLES.has(name) ? ever.has(acct) : true,
          {
            administersRoles: roleAdmins.get(em)?.has(name) ?? false,
            unclassifiedHolders: read.length - cur.length,
          },
        )
        const earlier = grants.get(k) ?? []
        // A grant inside the deploy transaction is initialization, not a change of control.
        if (isInit(em, r.block)) {
          v.severity = 'neutral'
          v.ruleIds = []
          tag(v, 'initialization')
        } else
          applyGrantPattern(
            v,
            name,
            grantPattern(name, at(acct), r.block, earlier, roleAdmins.get(em) ?? new Set()),
          )
        grants.set(k, [
          ...earlier,
          { block: r.block, account: acct, noCode: at(acct)?.kind === 'eoa' },
        ])
        holders.set(k, new Set([...(holders.get(k) ?? []), acct]))
        if (MINT_ROLES.has(name)) everMint.set(em, new Set([...ever, acct]))
        out.push(
          mk(
            ctx,
            r,
            MINT_ROLES.has(name) ? 'mint_redeem' : 'admin',
            `admin/role/${em}/${name}`,
            `${name} granted to ${describeController(at(acct))} on ${short(em)}`,
            v,
            { after: acct },
          ),
        )
        break
      }
      case 'RoleRevoked': {
        const role = lcs(a.role)
        const name = String(a.roleName ?? role)
        const k = `${em}|${role}`
        const set = holders.get(k) ?? new Set()
        set.delete(lcs(a.account))
        holders.set(k, set)
        const v = PAUSE_ROLES.has(name) ? classifyPauserChange(set.size) : neutral()
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/role/${em}/${name}`,
            `${name} revoked from ${short(lcs(a.account))} on ${short(em)}`,
            v,
            { before: lcs(a.account) },
          ),
        )
        break
      }
      case 'RoleAdminChanged': {
        const name = String(a.roleName ?? lcs(a.role))
        const side = (hash: unknown, label: unknown) => {
          const h = lcs(hash)
          return {
            name: String(label ?? (isZero(h) ? 'DEFAULT_ADMIN_ROLE' : short(h))),
            holders: [...(holders.get(`${em}|${h}`) ?? [])].map((x) => at(x)),
          }
        }
        const prevAdmin = side(a.previousAdminRole, a.previousAdminRoleName)
        const nextAdmin = side(a.newAdminRole, a.newAdminRoleName)
        roleAdmins.set(em, new Set([...(roleAdmins.get(em) ?? []), nextAdmin.name]))
        const v = isInit(em, r.block)
          ? tag(neutral(), 'initialization')
          : classifyRoleAdminChange(name, prevAdmin, nextAdmin)
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/role_admin/${em}/${name}`,
            `admin of ${name} on ${short(em)}: ${prevAdmin.name} → ${nextAdmin.name}`,
            v,
            { before: lcs(a.previousAdminRole), after: lcs(a.newAdminRole) },
          ),
        )
        break
      }
      case 'MinDelayChange': {
        const v = classifyDelayChange(Number(a.oldDuration), Number(a.newDuration))
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/timelock_delay/${em}`,
            `timelock ${short(em)} delay ${a.oldDuration}s → ${a.newDuration}s`,
            v,
            { before: Number(a.oldDuration), after: Number(a.newDuration) },
          ),
        )
        break
      }
      case 'AddedOwner':
      case 'RemovedOwner':
      case 'ChangedThreshold':
      case 'OwnerAddition':
      case 'OwnerRemoval':
      case 'RequirementChange': {
        const gk = `${r.tx}|${em}|ms`
        if (done.has(gk)) break
        done.add(gk)
        // Replayed from the events of THIS transaction on top of the state just before it: an
        // exact archive read at block − 1, or the state an earlier transaction in the same block
        // left (two transactions in one block share block − 1). Never the head classification.
        const mine = txRows.filter((x) => x.emitter === em)
        const known = msState.get(em)
        const exactPrev = exact(em, r.block - 1)
        const prevS =
          known && known.block === r.block
            ? known
            : exactPrev && exactPrev.threshold !== undefined
              ? { threshold: exactPrev.threshold, signers: exactPrev.signers ?? 0 }
              : (known ?? null)
        const added = mine.filter((x) => /Added|Addition/.test(x.event)).length
        const removed = mine.filter((x) => /Removed|Removal/.test(x.event)).length
        const thr = mine
          .filter((x) => x.event === 'ChangedThreshold' || x.event === 'RequirementChange')
          .map((x) => Number(x.args.threshold ?? x.args.required))
          .filter((x) => Number.isFinite(x))
        const otherTxSameBlock = sorted.some(
          (x) => x.emitter === em && x.block === r.block && x.tx !== r.tx && MS_EVENTS.has(x.event),
        )
        const exactNext = otherTxSameBlock ? null : exact(em, r.block)
        const nextS = prevS
          ? {
              threshold: thr.length ? thr[thr.length - 1] : prevS.threshold,
              signers: prevS.signers + added - removed,
            }
          : exactNext && exactNext.threshold !== undefined
            ? { threshold: exactNext.threshold, signers: exactNext.signers ?? 0 }
            : null
        if (nextS) msState.set(em, { ...nextS, block: r.block })
        const kind = exactPrev?.kind ?? exactNext?.kind ?? 'safe'
        const asCtl = (x: { threshold: number; signers: number } | null): Controller | null =>
          x ? { kind, address: em, threshold: x.threshold, signers: x.signers } : null
        const prev = asCtl(prevS)
        const next = asCtl(nextS)
        const v =
          prev && next
            ? classifyMultisigChange(prev, next, added)
            : // the state before (or after) could not be read: never judged calm
              down(
                neutral(),
                'AD-1',
                `multisig threshold / signers ${prev ? 'after' : 'before'} this transaction not read`,
              )
        // a swap is a rotation only when it is not a downgrade (review round 6: three owners
        // swapped in on a 3-of-5 act alone — never a calm "rotation")
        if (added && removed && !isRed(v)) tag(v, 'rotation')
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/multisig/${em}`,
            `multisig ${short(em)}: ${prev ? `${prev.threshold}-of-${prev.signers}` : '?'} → ${next ? `${next.threshold}-of-${next.signers}` : '?'}`,
            v,
            {
              before: prev ? `${prev.threshold}/${prev.signers}` : undefined,
              after: next ? `${next.threshold}/${next.signers}` : undefined,
              // the owners that moved (review round 7: a swap read "3/6 → 3/6")
              ...(added || removed
                ? {
                    beforeDisplay: `${prev ? `${prev.threshold}/${prev.signers}` : '?'}${removed ? ` · owner ${ownersOf(mine, /Removed|Removal/)} removed` : ''}`,
                    afterDisplay: `${next ? `${next.threshold}/${next.signers}` : '?'}${added ? ` · owner ${ownersOf(mine, /Added|Addition/)} added` : ''}`,
                  }
                : {}),
            },
          ),
        )
        break
      }
      case 'ChangedGuard':
      case 'ChangedModuleGuard':
      case 'EnabledModule':
      case 'DisabledModule':
      case 'ChangedFallbackHandler': {
        const field = (
          {
            ChangedGuard: 'guard',
            ChangedModuleGuard: 'module_guard',
            EnabledModule: 'module_enabled',
            DisabledModule: 'module_disabled',
            ChangedFallbackHandler: 'fallback_handler',
          } as const
        )[r.event]
        const to = lcs(a.guard ?? a.moduleGuard ?? a.module ?? a.handler)
        // The fallback handler set at Safe setup is initialization.
        const exactBefore = ctx.ctlExact?.(em, r.block - 1) ?? null
        const init = (ctx.deployBlocks[em] ?? -1) === r.block || exactBefore?.kind === 'eoa'
        // ChangedGuard / ChangedModuleGuard / ChangedFallbackHandler carry only the NEW value.
        // The previous one (review round 5): the last one the events set in this block, else
        // the exact archive read at block − 1 (a guard set before the scan, or by a
        // delegatecall), else the last one the events set, else none — but only when the
        // Safe's whole history was scanned; otherwise it is unread and never read as "added".
        const gk = `${em}|${field}`
        const prop = (
          {
            guard: 'guard',
            module_guard: 'moduleGuard',
            fallback_handler: 'fallbackHandler',
          } as const
        )[field as 'guard' | 'module_guard' | 'fallback_handler']
        const last = lastGuard.get(gk)
        // a classification without the field did not read it (not a Safe read): not a value
        const read = prop && exactBefore ? exactBefore[prop] : undefined
        const complete =
          ctx.scanFrom === undefined ||
          (ctx.deployBlocks[em] !== undefined && ctx.deployBlocks[em] >= ctx.scanFrom)
        const from: string | undefined =
          r.prev ??
          (last && last.block === r.block ? last.value : undefined) ??
          (read !== undefined ? lcs(read) : undefined) ??
          last?.value ??
          (prop && complete ? ZERO : undefined)
        if (prop) lastGuard.set(gk, { value: to, block: r.block })
        let v: Verdict
        if (init) v = tag(neutral(), 'initialization')
        else if (prop && from === undefined)
          v = down(
            neutral(),
            'AD-6',
            `${field.replace('_', ' ')} → ${to}; previous ${field.replace('_', ' ')} not read (the Safe predates the scan): a replacement cannot be ruled out (fail closed)`,
          )
        else v = classifySafeModuleChange(field, from, to)
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/safe/${em}/${field}`,
            `Safe ${short(em)}: ${field.replace('_', ' ')} → ${short(to)}`,
            v,
            { ...(prop && from !== undefined ? { before: from } : {}), after: to },
          ),
        )
        break
      }
      case 'FunctionWhitelisted':
      case 'FunctionRemovedFromWhitelist': {
        // Ethena timelock (review round 6, AD-2): a whitelisted (target, selector) executes through
        // executeWhitelisted with NO delay — the timelock is removed from that path. Whitelisting
        // one that exercises a power is red; removing one is an upgrade.
        const target = lcs(a.target)
        const sel = lcs(a.selector).slice(0, 10)
        const added = r.event === 'FunctionWhitelisted'
        const reach = ctx.whitelistReach?.(target, sel) ?? 'unknown'
        // a shared timelock's whitelist for another asset's contracts is not this card's
        if (reach === 'foreign') break
        const v = classifyWhitelistChange(added, target, sel, reach)
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/timelock_whitelist/${em}/${target}/${sel}`,
            `timelock ${short(em)}: ${sel} on ${short(target)} ${added ? 'whitelisted (no delay)' : 'removed from the whitelist'}`,
            v,
            added ? { after: `${target}:${sel}` } : { before: `${target}:${sel}` },
          ),
        )
        break
      }
      case 'MasterMinterChanged':
      case 'PauserChanged':
      case 'BlacklisterChanged': {
        const next = lcs(a.newMasterMinter ?? a.newAddress ?? a.newBlacklister)
        const prev = r.prev ? lcs(r.prev) : null
        const role = r.event.replace('Changed', '')
        // previous holder unread: judged against null (an EOA successor is red, never calm)
        let v = classifyControllerChange(prev ? before(prev) : null, at(next))
        if (r.event === 'PauserChanged' && isZero(next))
          v = down(v, 'MR-1', 'pauser set to address(0)')
        out.push(
          mk(
            ctx,
            r,
            r.event === 'MasterMinterChanged' ? 'mint_redeem' : 'admin',
            `admin/${role.toLowerCase()}/${em}`,
            `${role} of ${short(em)}: ${prev ? describeController(before(prev)) : '?'} → ${describeController(at(next))}`,
            v,
            { before: prev ?? undefined, after: next },
          ),
        )
        break
      }
      case 'MinterConfigured': {
        const m = lcs(a.minter)
        const set = minters.get(em) ?? new Set()
        const ever = everMinters.get(em) ?? new Set()
        let v = neutral()
        // A minter that never minted here is new — the FIRST one after deployment too (the
        // RoleGranted rule); configuring one in the deploy block is initialization.
        if (!ever.has(m))
          v = isInit(em, r.block) ? tag(v, 'initialization') : down(v, 'MR-2', `new minter ${m}`)
        if (ctx.minterCapSpec) {
          const pv = classifyParamChange(
            ctx.minterCapSpec,
            r.prev ?? null,
            String(a.minterAllowedAmount),
          )
          for (const id of pv.ruleIds) down(v, id as never)
          for (const t of pv.tags) tag(v, t)
        }
        set.add(m)
        minters.set(em, set)
        everMinters.set(em, new Set([...ever, m]))
        out.push(
          mk(
            ctx,
            r,
            'mint_redeem',
            `mint/minter/${em}/${m}`,
            `minter ${short(m)} allowance → ${a.minterAllowedAmount}`,
            v,
            { after: String(a.minterAllowedAmount) },
          ),
        )
        break
      }
      case 'MinterRemoved':
        out.push(
          mk(
            ctx,
            r,
            'mint_redeem',
            `mint/minter/${em}/${lcs(a.oldMinter)}`,
            `minter ${short(lcs(a.oldMinter))} removed`,
            // ends a red "new minter" on the same key (STILL IN EFFECT)
            tag(neutral(), 'route_removed'),
            { before: lcs(a.oldMinter) },
          ),
        )
        minters.get(em)?.delete(lcs(a.oldMinter))
        break
      case 'PoolSet': {
        if (!ctx.tokens.includes(lcs(a.token))) break
        // Review round 7: through address(0) (A → 0 → B) is a re-point like A → B — CC-1, the
        // through-zero rule BR-6 peers, params and remote pools already follow.
        const pk = `ccip_pool|${lcs(a.token)}`
        const prevPool = lcs(a.previousPool)
        const nextPool = lcs(a.newPool)
        const lastNonZero = lastPool.get(pk)
        const v = classifyCcip('pool_set', {
          prev: isZero(prevPool) && lastNonZero ? lastNonZero : prevPool,
          next: nextPool,
        })
        if (isZero(prevPool) && lastNonZero && isRed(v))
          v.notes.push(`re-pointed through address(0): the last pool was ${lastNonZero}`)
        if (!isZero(prevPool)) lastPool.set(pk, prevPool)
        if (!isZero(nextPool)) lastPool.set(pk, nextPool)
        out.push(
          mk(
            ctx,
            r,
            'bridge',
            `bridge/ccip/pool/${lcs(a.token)}`,
            `CCIP pool for ${short(lcs(a.token))}: ${short(lcs(a.previousPool))} → ${short(lcs(a.newPool))}`,
            v,
          ),
        )
        break
      }
      case 'AdministratorTransferred': {
        if (!ctx.tokens.includes(lcs(a.token))) break
        const next = lcs(a.newAdmin)
        // the previous administrator: the collector's read, else the last one the events set
        const ak = `ccip_admin|${lcs(a.token)}`
        const prevAdmin = r.prev ? lcs(r.prev) : (lastOwner.get(ak) ?? null)
        lastOwner.set(ak, next)
        const v = classifyControllerChange(prevAdmin ? before(prevAdmin) : null, at(next))
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/ccip_token_admin/${lcs(a.token)}`,
            `CCIP token administrator → ${describeController(at(next))}`,
            v,
            { before: prevAdmin ?? undefined, after: next },
          ),
        )
        break
      }
      case 'RemotePoolSet':
      case 'RemotePoolAdded':
      case 'RemotePoolRemoved': {
        // Remote pools per (pool, chain), replayed: a second remote pool for a chain that is
        // already served — or a new one after the old was removed (a re-point) — is RED CC-1,
        // the CCIP twin of the strict BR-6 (default the owner did not object to, 2026-10-06).
        const sel = String(a.remoteChainSelector)
        const pk = `${em}|${sel}`
        const cur = remotePools.get(pk) ?? new Set<string>()
        const ever = everRemote.get(pk) ?? new Set<string>()
        // the pools the chain accepted the last time it served any (empty = never served)
        const last = lastServed.get(pk) ?? new Set<string>()
        const addr = lcs(a.remotePoolAddress)
        let v: Verdict
        if (r.event === 'RemotePoolRemoved') {
          cur.delete(addr)
          v = tag(neutral(), 'route_removed')
        } else if (r.event === 'RemotePoolSet') {
          // through address(0) (review round 7): the pool the chain had LAST counts — not the
          // first-inserted one of every pool it ever had (review round 8: 0→A, A→B, B→A, A→0,
          // 0→B read "route created")
          const pp = lcs(a.previousPoolAddress)
          const lastPool = isZero(pp) && last.size && !last.has(addr) ? [...last].join(', ') : null
          v = classifyCcip('remote_pool_set', {
            prev: isZero(pp) ? (lastPool ?? (last.has(addr) ? addr : pp)) : pp,
            next: addr,
          })
          if (lastPool && isRed(v))
            v.notes.push(`re-pointed through address(0): the last remote pool was ${lastPool}`)
          cur.clear()
          if (!isZero(addr)) cur.add(addr)
        } else if (cur.has(addr)) {
          v = neutral()
        } else if (cur.size > 0) {
          v = down(
            neutral(),
            'CC-1',
            `second remote pool for an already-served chain ${sel}: ${[...cur].join(', ')} + ${addr} (both accepted)`,
          )
          cur.add(addr)
        } else if (last.size > 0 && !last.has(addr)) {
          // review round 8: compared with the pools it had LAST, not every pool it ever had (add
          // A, remove A, add B, remove B, add A read neutral)
          v = down(
            neutral(),
            'CC-1',
            `remote pool for chain ${sel} re-pointed after a removal: ${[...last].join(', ')} → ${addr}`,
          )
          cur.add(addr)
        } else {
          v = tag(neutral(), 'route_created')
          cur.add(addr)
        }
        if (r.event !== 'RemotePoolRemoved' && !isZero(addr)) ever.add(addr)
        remotePools.set(pk, cur)
        everRemote.set(pk, ever)
        if (cur.size) lastServed.set(pk, new Set(cur))
        out.push(
          mk(
            ctx,
            r,
            'bridge',
            `bridge/ccip/${em}/${sel}`,
            `CCIP remote pool (${sel}) ${r.event.replace('RemotePool', '').toLowerCase()}`,
            v,
            { after: r.event === 'RemotePoolRemoved' ? undefined : addr },
          ),
        )
        break
      }
      case 'ChainRemoved': {
        // the chain's remote pools go with it; re-adding a different pool later is a re-point
        remotePools.delete(`${em}|${String(a.remoteChainSelector)}`)
        out.push(
          mk(
            ctx,
            r,
            'bridge',
            `bridge/ccip/${em}/${a.remoteChainSelector}`,
            `CCIP chain ${a.remoteChainSelector} removed`,
            tag(neutral(), 'route_removed'),
          ),
        )
        break
      }
      case 'ChainAdded':
      case 'ChainConfigured': {
        const sel = String(a.remoteChainSelector)
        const inb = (a.inboundRateLimiterConfig as { isEnabled?: boolean } | undefined)?.isEnabled
        const outb = (a.outboundRateLimiterConfig as { isEnabled?: boolean } | undefined)?.isEnabled
        const enabled = inb !== false && outb !== false
        const k = `${em}|${sel}`
        const prevEnabled = rateLimit.get(k)
        rateLimit.set(k, enabled)
        // Review round 8: a chain removed and re-added with its limiter off switches it off as
        // surely as ChainConfigured does (the limiter state survives ChainRemoved here).
        const v =
          r.event === 'ChainAdded'
            ? !enabled && prevEnabled === true
              ? tag(classifyCcip('rate_limiter', { enabled: false }), 'route_created')
              : tag(neutral(), 'route_created')
            : !enabled && prevEnabled !== false
              ? classifyCcip('rate_limiter', { enabled: false })
              : neutral()
        if (r.event === 'ChainAdded' && isRed(v))
          v.notes.push('re-added with its rate limiter OFF: it was on before the chain was removed')
        out.push(
          mk(
            ctx,
            r,
            'bridge',
            `bridge/ccip/${em}/${sel}/rate_limit`,
            `CCIP chain ${sel} ${r.event === 'ChainAdded' ? 'added' : 'configured'} (rate limiter ${enabled ? 'on' : 'OFF'})`,
            v,
          ),
        )
        break
      }
      case 'RebalancerSet':
      case 'UnsiloedRebalancerSet':
      case 'SiloRebalancerSet':
      case 'ChainSiloed': {
        // CCIP 1.6 SiloedLockReleaseTokenPool (review round 5): every siloed chain has its own
        // rebalancer (SiloRebalancerSet / ChainSiloed), the unsiloed chains share one
        // (UnsiloedRebalancerSet). Each can withdraw the liquidity locked for its chains.
        const sel = a.remoteChainSelector === undefined ? null : String(a.remoteChainSelector)
        const rk = `ccip_rebalancer|${em}|${sel ?? 'unsiloed'}`
        const prev =
          a.oldRebalancer !== undefined ? lcs(a.oldRebalancer) : (lastOwner.get(rk) ?? '')
        const prevKnown = !!prev && !isZero(prev)
        const next = lcs(a.newRebalancer ?? a.rebalancer)
        lastOwner.set(rk, next)
        const v = classifyCcip('rebalancer', {
          prevCtl: prevKnown ? before(prev) : null,
          nextCtl: at(next),
        })
        out.push(
          mk(
            ctx,
            r,
            'bridge',
            `bridge/ccip/${em}/rebalancer${sel ? `/${sel}` : ''}`,
            `CCIP ${sel ? `silo rebalancer for chain ${sel}` : 'rebalancer'} (can withdraw locked liquidity) → ${describeController(at(next))}`,
            v,
            { before: prevKnown ? prev : undefined, after: next },
          ),
        )
        break
      }
      case 'PermissionManagerChanged': {
        // Aragon: the manager of (app, role) grants and revokes that permission at will — AD-3
        // on who it is. The event names only the new manager: the previous one is the last the
        // events set, else the collector's archive read at block − 1 (r.prev).
        const role = lcs(a.role)
        const name = String(a.roleName ?? role)
        const next = lcs(a.manager)
        const lk = `pmgr|${em}|${role}`
        const known = lastSet.get(lk) ?? (r.prev ? lcs(r.prev) : undefined)
        lastSet.set(lk, next)
        const v = isInit(em, r.block)
          ? tag(neutral(), 'initialization')
          : known === undefined
            ? classifyControllerChange(null, at(next))
            : isZero(known)
              ? tag(neutral(), 'initialization')
              : classifyControllerChange(before(known), at(next))
        if (!isInit(em, r.block) && known !== undefined && isZero(known))
          v.notes.push(
            `${name} created on ${short(em)} with manager ${describeController(at(next))}`,
          )
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/permission_manager/${em}/${name}`,
            `permission manager of ${name} on ${short(em)}: ${known && !isZero(known) ? describeController(before(known)) : '—'} → ${describeController(at(next))}`,
            v,
            { before: known, after: next },
          ),
        )
        break
      }
      case 'AppAddressSet': {
        // Aragon Kernel: a default app address re-pointed (the ACL the Kernel consults is one)
        const app = lcs(a.app)
        const v = tag(neutral(), 'logic_change')
        if (isInit(em, r.block)) tag(v, 'initialization')
        else verificationRule(v, app, ctx.verified?.(app) ?? null)
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/app_address/${em}/${lcs(a.appId)}`,
            `Kernel ${short(em)}: app ${short(lcs(a.appId))} address → ${short(app)}`,
            v,
            { after: app },
          ),
        )
        break
      }
      case 'GovernanceSet':
      case 'AdminExecutorSet':
      case 'EmergencyGovernanceSet':
      case 'EmergencyActivationCommitteeSet':
      case 'EmergencyExecutionCommitteeSet':
      case 'ProposalsCancellerSet':
      case 'ResealCommitteeSet':
      case 'TiebreakerCommitteeSet':
      case 'ConfigProviderSet': {
        // Lido Dual Governance: who governs the timelock, who executes for it, the emergency
        // committees, the canceller / reseal / tiebreaker committees and the config provider.
        // AD-3 on the holder; a governance or config-provider CONTRACT replaced is also a logic
        // change (AD-9 unless its source is verified).
        const next = lcs(Object.values(a).find((x) => /^0x[0-9a-f]{40}$/i.test(String(x))))
        const lk = `dg|${em}|${r.event}`
        const known = lastSet.get(lk) ?? (r.prev ? lcs(r.prev) : undefined)
        lastSet.set(lk, next)
        const what = r.event
          .replace(/Set$/, '')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
        let v: Verdict
        if (isInit(em, r.block)) v = tag(neutral(), 'initialization')
        else if (known === undefined || isZero(known)) {
          v = classifyControllerChange(null, at(next))
          if (known !== undefined) v.notes.push(`${what} set for the first time`)
        } else v = classifyControllerChange(before(known), at(next))
        if (
          !isInit(em, r.block) &&
          (r.event === 'GovernanceSet' || r.event === 'ConfigProviderSet') &&
          known !== next
        ) {
          tag(v, 'logic_change')
          verificationRule(v, next, ctx.verified?.(next) ?? null)
        }
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/dg/${em}/${r.event}`,
            `${what} of ${short(em)}: ${known && !isZero(known) ? describeController(before(known)) : '—'} → ${describeController(at(next))}`,
            v,
            { before: known, after: next },
          ),
        )
        break
      }
      case 'AfterSubmitDelaySet':
      case 'AfterScheduleDelaySet': {
        const next = Number(Object.values(a)[0])
        const lk = `dg|${em}|${r.event}`
        const known = lastSet.get(lk) ?? (r.prev != null ? String(r.prev) : undefined)
        lastSet.set(lk, String(next))
        const what =
          r.event === 'AfterSubmitDelaySet' ? 'after-submit delay' : 'after-schedule delay'
        let v: Verdict
        if (isInit(em, r.block)) v = tag(neutral(), 'initialization')
        else if (known === undefined)
          v = down(
            neutral(),
            'AD-2',
            `${what} set to ${formatDelay(next)}; the previous value was not read (fail closed)`,
          )
        else v = classifyDelayChange(Number(known), next)
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/timelock_delay/${em}/${r.event}`,
            `Dual Governance ${what} of ${short(em)}: ${known === undefined ? '?' : formatDelay(Number(known))} → ${formatDelay(next)}`,
            v,
            { before: known === undefined ? undefined : Number(known), after: next },
          ),
        )
        break
      }
      case 'EmergencyModeDurationSet':
      case 'EmergencyProtectionEndDateSet':
      case 'EmergencyModeActivated':
      case 'EmergencyModeDeactivated': {
        const v = isInit(em, r.block) ? tag(neutral(), 'initialization') : neutral()
        const val = Object.values(a)[0]
        const title =
          r.event === 'EmergencyModeActivated'
            ? `EMERGENCY MODE activated on ${short(em)}`
            : r.event === 'EmergencyModeDeactivated'
              ? `emergency mode deactivated on ${short(em)}`
              : r.event === 'EmergencyModeDurationSet'
                ? `emergency mode duration of ${short(em)} → ${formatDelay(Number(val))}`
                : `emergency protection of ${short(em)} ends after ${new Date(Number(val) * 1000).toISOString().slice(0, 10)}`
        if (r.event === 'EmergencyModeActivated')
          v.notes.push(
            'in emergency mode only the Emergency Execution Committee executes, without the after-schedule delay, and it can reset governance to the emergency governance',
          )
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/dg/${em}/emergency`,
            title,
            v,
            val === undefined ? {} : { after: String(val) },
          ),
        )
        break
      }
      case 'ProposerRegistered':
      case 'ProposerExecutorSet':
      case 'ProposerUnregistered': {
        // Dual Governance proposers submit proposals (Lido: the Aragon Voting only): a new
        // proposer is a PROPOSER_ROLE grant (AD-4 on its controller)
        const who = lcs(a.proposer)
        const set = dgProposers.get(em) ?? new Set<string>()
        let v = neutral()
        if (r.event === 'ProposerRegistered') {
          const cur = [...set].map((h) => at(h)).filter((c): c is Controller => !!c)
          v = isInit(em, r.block)
            ? tag(neutral(), 'initialization')
            : classifyRoleGrant('PROPOSER_ROLE', at(who), cur, true)
          set.add(who)
        } else if (r.event === 'ProposerUnregistered') set.delete(who)
        dgProposers.set(em, set)
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/dg/${em}/proposer/${who}`,
            r.event === 'ProposerUnregistered'
              ? `Dual Governance proposer ${short(who)} removed`
              : `Dual Governance proposer ${describeController(at(who))}${a.executor ? ` (executor ${short(lcs(a.executor))})` : ''}${r.event === 'ProposerExecutorSet' ? ' re-assigned' : ''}`,
            v,
            r.event === 'ProposerUnregistered' ? { before: who } : { after: who },
          ),
        )
        break
      }
      case 'TransceiverAdded':
      case 'TransceiverRemoved':
      case 'ThresholdChanged': {
        // Wormhole NTT: `threshold` transceivers must attest a message (design §2 BR-2: the
        // floor applies to the threshold). Liveness = some peer is set.
        const st = nttOf(em)
        const prevThreshold = st.threshold
        const prevTypes = [...st.tx.values()]
        const live = [...st.peers.values()].some((p) => !isZero(p))
        let v: Verdict
        let title: string
        let key: string
        if (r.event === 'TransceiverAdded') {
          const t = lcs(a.transceiver)
          const type = a.transceiverType == null ? null : String(a.transceiverType)
          const next = Number(a.threshold)
          v = classifyNttTransceiverAdded(type, prevTypes, prevThreshold, next)
          st.tx.set(t, type)
          st.threshold = next
          title = `NTT ${short(em)}: transceiver ${short(t)}${type ? ` (${type})` : ''} added · threshold ${next} of ${st.tx.size}`
          key = `bridge/ntt/${em}/verification`
        } else if (r.event === 'TransceiverRemoved') {
          const t = lcs(a.transceiver)
          st.tx.delete(t)
          const next = Number(a.threshold)
          // review round 8: judged on the effective verifier count before and after (a network
          // removed at an unchanged threshold lowers E)
          v = classifyNttThreshold(prevThreshold, next, [...st.tx.values()], prevTypes)
          st.threshold = next
          title = `NTT ${short(em)}: transceiver ${short(t)} removed · threshold ${next} of ${st.tx.size}`
          key = `bridge/ntt/${em}/verification`
        } else {
          const prev = a.oldThreshold === undefined ? prevThreshold : Number(a.oldThreshold)
          const next = Number(a.threshold)
          v = classifyNttThreshold(prev, next, [...st.tx.values()], prevTypes)
          st.threshold = next
          title = `NTT ${short(em)}: threshold ${prev ?? '?'} → ${next} (${st.tx.size} transceivers)`
          // one key for everything that sets how many verifiers attest a message: a later raise
          // (an upgrade) ends a floor breach opened by a transceiver or a peer (STILL IN EFFECT)
          key = `bridge/ntt/${em}/verification`
        }
        // the floor binds a LIVE route only (no peer yet: set-up, judged when the peer is set)
        if (!live && v.floorBreach) {
          v.floorBreach = false
          v.ruleIds = v.ruleIds.filter((x) => x !== 'BR-2')
          v.notes = v.notes.filter((n) => !n.startsWith('FLOOR'))
          v.notes.push('no peer set yet: the route is not live (the floor is judged when it opens)')
        }
        out.push(mk(ctx, r, 'bridge', key, title, v, { after: st.threshold ?? undefined }))
        break
      }
      case 'PeerUpdated':
      case 'SetWormholePeer':
      case 'AxelarChainIdSet': {
        // BR-6 on an NTT manager peer or a transceiver peer (strict: every re-point is red, also
        // through a zeroed peer); a peer that opens a route under the floor is BR-2.
        const chain = String(a.chainId_ ?? a.chainId)
        const pk = `${em}|${chain}`
        const next =
          r.event === 'AxelarChainIdSet'
            ? `${String(a.axelarChainId)}:${String(a.transceiverAddress).toLowerCase()}`
            : lcs(a.peerContract)
        const prev = r.event === 'PeerUpdated' ? lcs(a.oldPeerContract) : (peerNow.get(pk) ?? null)
        const v = classifyPeerChange(prev, next, lastPeer.get(pk))
        peerNow.set(pk, next)
        if (!/^0x0*$/i.test(next)) lastPeer.set(pk, next)
        if (r.event === 'PeerUpdated') {
          const st = nttOf(em)
          st.peers.set(chain, next)
          const eff = nttEffective(st.threshold, [...st.tx.values()])
          if (!isZero(next) && eff.E < 2) {
            v.floorBreach = true
            if (!v.ruleIds.includes('BR-2')) v.ruleIds.push('BR-2')
            v.notes.push(
              `FLOOR: the route opens with ${eff.E} effective verifier network(s) (threshold ${st.threshold ?? '?'} over ${eff.distinct} distinct)`,
            )
          }
        }
        // a route opened under the floor is a verification red (ended by a later threshold
        // raise); a re-point stays on the peer's own key
        const peerKey =
          v.floorBreach && !v.ruleIds.includes('BR-6')
            ? `bridge/ntt/${em}/verification`
            : `bridge/ntt/${em}/peer/${chain}`
        out.push(
          mk(
            ctx,
            r,
            'bridge',
            peerKey,
            `${r.event === 'PeerUpdated' ? 'NTT manager' : r.event === 'SetWormholePeer' ? 'Wormhole transceiver' : 'Axelar transceiver'} ${short(em)}: peer for chain ${chain} → ${next.length > 42 && next.startsWith('0x') ? `0x…${next.slice(-40)}` : next}`,
            v,
            { before: prev ?? undefined, after: next },
          ),
        )
        break
      }
      case 'PauserTransferred': {
        const prev = lcs(a.oldPauser)
        const next = lcs(a.newPauser)
        let v = isZero(prev)
          ? tag(neutral(), 'initialization')
          : classifyControllerChange(before(prev), at(next))
        if (isZero(next)) v = down(v, 'MR-1', 'pauser set to address(0)')
        out.push(
          mk(
            ctx,
            r,
            'admin',
            `admin/pauser/${em}`,
            `pauser of ${short(em)}: ${isZero(prev) ? '—' : describeController(before(prev))} → ${describeController(at(next))}`,
            v,
            { before: prev, after: next },
          ),
        )
        break
      }
      default:
        break
    }
    if (since !== undefined && r.block < since) out.length = filed
    if (ctx.fileFrom !== undefined && r.block < ctx.fileFrom) out.length = filed
  }
  return out
}

/** AD-5: an upgrade / admin change of a timelocked proxy with no CallExecuted from that timelock in the tx. */
function ad5(v: Verdict, r: AdminEventRow, txRows: AdminEventRow[], ctx: AdminCtx) {
  const at = ctx.upgradeHoldersAt?.[`${r.emitter}@${r.block}`]
  const tlOf = (c: Controller): string[] =>
    c.kind === 'oz_timelock' || c.kind === 'aragon_dg'
      ? [c.address]
      : c.ownedBy
        ? tlOf(c.ownedBy)
        : []
  // With holders resolved at the block, judge against them; otherwise never guess.
  const tls = at
    ? at.flatMap(tlOf)
    : ctx.upgradeHoldersAt
      ? []
      : (ctx.upgradeTimelocks[r.emitter] ?? []).filter(
          (t) => r.block >= (ctx.timelockSince?.[t] ?? 0),
        )
  if (!tls.length) return
  // an OZ timelock emits CallExecuted, a Dual Governance timelock ProposalExecuted
  const executed = txRows.some(
    (x) =>
      (x.event === 'CallExecuted' || x.event === 'ProposalExecuted') && tls.includes(x.emitter),
  )
  if (!executed)
    down(
      v,
      'AD-5',
      `no CallExecuted / ProposalExecuted from ${tls.map(short).join('/')} in this transaction`,
    )
}

// ---- DVN signer sets ------------------------------------------------------------------------------

export type DvnSignerChange = {
  chainId: number
  dvn: string
  block: number
  tx: Hex
  logIndex: number
  ts?: number
  /** State before the transaction (archive read, or the previous transaction's result); null = not read. */
  prev: { quorum: number; signers: number } | null
  next: { quorum: number; signers: number } | null
  /** The lowest-quorum state the transaction passed through, when below `prev` (a flip). */
  dip?: { quorum: number; signers: number }
  addedAndRemoved: boolean
  /** The DVN's own setup: it had no code one block before these events. */
  init?: boolean
}

export function classifyDvnSignerChanges(
  rows: DvnSignerChange[],
  subject: string,
  dvnName: (dvn: string) => string,
  announcement: AnnouncementStatus,
): ConfigChange[] {
  return rows.map((r) => {
    // the state before (hence after) could not be read: never judged calm
    const v = r.init
      ? tag(neutral(), 'initialization')
      : r.prev && r.next
        ? classifyDvnSignerChange(r.prev, r.next, r.addedAndRemoved)
        : down(neutral(), 'DV-1', 'DVN quorum / signers before this transaction not read')
    // a quorum lowered and restored inside the transaction is still a window in which fewer
    // signatures verify a packet
    if (r.prev && r.dip && r.dip.quorum < r.prev.quorum && !isRed(v)) {
      down(v, 'DV-1')
      tag(v, 'flash')
      v.notes.push(
        `inside the transaction: ${r.prev.quorum}-of-${r.prev.signers} → ${r.dip.quorum}-of-${r.dip.signers} → ${r.next?.quorum}-of-${r.next?.signers}`,
      )
    }
    const fmt = (x: { quorum: number; signers: number } | null) =>
      x ? `${x.quorum}-of-${x.signers}` : '?'
    return {
      id: `${r.chainId}:${r.tx}:${r.logIndex}:${r.dvn}`,
      subject,
      dimension: 'bridge' as const,
      key: `bridge/dvn/${r.chainId}/${r.dvn}`,
      title: `DVN ${dvnName(r.dvn)} signers ${fmt(r.prev)} → ${fmt(r.next)}`,
      before: r.prev,
      after: r.next,
      state: 'historical' as const,
      stage: 'executed' as const,
      severity: v.severity,
      floorBreach: false,
      red: isRed(v),
      ruleIds: v.ruleIds,
      tags: v.tags as ChangeTag[],
      unannounced: null,
      announcement,
      chainId: r.chainId,
      block: r.block,
      ts: r.ts,
      tx: r.tx,
      notes: v.notes.length ? v.notes : undefined,
    }
  })
}

// ---- mint / redeem getters (archive grid, bisected) --------------------------------------------------

export type ParamTransition = {
  key: string
  block: number
  /** Last grid/bisection block that still read `before` (the change is in (blockFrom, block]). */
  blockFrom: number
  ts?: number
  tx?: Hex
  before: unknown
  after: unknown
}

export function classifyParamTransitions(
  rows: ParamTransition[],
  specs: ParamSpec[],
  ctx: {
    subject: string
    ctl: ControllerLookup
    announcement: AnnouncementStatus
    verified?: (address: string) => boolean | null | undefined
  },
): ConfigChange[] {
  const byKey = new Map(specs.map((s) => [s.key, s]))
  const isAddr = (x: unknown): x is string =>
    typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x) && lcs(x) !== ZERO
  // The last NON-ZERO value of each address param (review round 6): A → 0 → B is judged as the
  // replacement of A by B (a new minter, a new price source), never as a first value.
  const lastNonZero = new Map<string, { value: string; block: number }>()
  const order = rows.map((t, i) => ({ t, i })).sort((x, y) => x.t.block - y.t.block || x.i - y.i)
  const out: ConfigChange[] = new Array(rows.length)
  for (const { t, i } of order) {
    const spec = byKey.get(t.key)
    if (!spec) continue
    const nextCtl = isAddr(t.after) ? ctx.ctl(t.after, t.block) : null
    const last = !isAddr(t.before) ? lastNonZero.get(t.key) : undefined
    if (isAddr(t.before)) lastNonZero.set(t.key, { value: lcs(t.before), block: t.blockFrom })
    if (isAddr(t.after)) lastNonZero.set(t.key, { value: lcs(t.after), block: t.block })
    // the old value as it stood just before the change (EOA → EOA is a rotation)
    const prevCtl = isAddr(t.before)
      ? ctx.ctl(t.before, t.blockFrom)
      : last
        ? ctx.ctl(last.value, last.block)
        : null
    const v = classifyParamChange(spec, t.before, t.after, nextCtl, {
      prevCtl,
      nextVerified: isAddr(t.after) ? (ctx.verified?.(lcs(t.after)) ?? null) : null,
      lastNonZero: last?.value ?? null,
    })
    if (t.blockFrom < t.block - 1) tag(v, 'bracketed')
    const c: ConfigChange = {
      id: `1:param:${t.key}:${t.block}`,
      subject: ctx.subject,
      dimension: 'mint_redeem',
      key: `mint/${t.key}`,
      title: `${spec.label}: ${formatParamAmount(t.before, spec.unit) ?? fmt(t.before)} → ${formatParamAmount(t.after, spec.unit) ?? fmt(t.after)}`,
      before: t.before,
      after: t.after,
      state: 'historical',
      stage: 'executed',
      severity: v.severity,
      floorBreach: false,
      red: isRed(v),
      ruleIds: v.ruleIds,
      tags: v.tags as ChangeTag[],
      unannounced: null,
      announcement: ctx.announcement,
      chainId: 1,
      block: t.block,
      blockFrom: t.blockFrom,
      ts: t.ts,
      tx: t.tx,
      notes: v.notes.length ? v.notes : undefined,
    }
    out[i] = c
  }
  return out.filter((c): c is ConfigChange => !!c)
}

const fmt = (x: unknown) =>
  typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x) ? short(x.toLowerCase()) : String(x)

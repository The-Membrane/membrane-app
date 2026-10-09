// Config-card engine: one subject's raw observation (collector output) → card state + changes.
//
//   state    — every route / power / parameter as it stands at head, with the STATE rules that
//              fail right now (BR-2 floor, BR-4/5/7, AD-7, CC-2/3) as persistent breaches
//   changes  — historical (event replay, archive-grid transitions), pending (timelock ops),
//              proposed (Safe Tx Service); red in any state when the rules say downgrade/floor
//
// Pure: the clock is `raw.head`, the network was read by the collector.

import { toFunctionSelector } from 'viem'
import type {
  AnnouncementStatus,
  ConfigChange,
  ConfigSubject,
  Controller,
  PowerSpec,
  PowerState,
  RouteState,
  StateItem,
  SubjectState,
  UlnConfigRaw,
} from './types'
import {
  classifyAdminEvents,
  classifyDvnSignerChanges,
  classifyParamTransitions,
  COMMITTEE_EVENTS,
  type AdminEventRow,
  type DvnSignerChange,
  type ParamTransition,
} from './adminReplay'
import {
  compareRoute,
  floorBreachRoutes,
  routeBreaches,
  routeDiffers,
  routeTags,
} from './bridgeRules'
import { compactRoute, replayLz, routeChangeDisplays, routeKey, type LzEvent } from './lzReplay'
import {
  multisigSubmissionChanges,
  safeProposalChanges,
  timelockChanges,
  type MultisigSubmission,
  type QueueCtx,
  type SafeProposal,
  type TimelockOp,
} from './queue'
import {
  type GrantRecord,
  type WhitelistReach,
  classifyMultisigChange,
  classifyOracleParam,
  classifyRoleGrant,
  classifySafeModuleChange,
  classifyControllerChange,
  isPrivilegedRole,
  controllerRank,
  controllerTree,
  nodeReadGaps,
  rankHasReadGap,
  compareRank,
  isTimelockKind,
  schedulersUnreadOf,
  describeController,
  formatDelay,
  OWNER_INIT_WINDOW_BLOCKS,
  down,
  isEoa,
  isEoaControlled,
  isRed,
  neutral,
  nttEffective,
  tag,
  timelockAdminBreach,
  verificationRule,
} from './rules'
import {
  codeOracleFrom,
  displayRoute,
  evaluateRoute,
  lc,
  mergeUln,
  routeVerifies,
  type CodeProbe,
  type DvnRegistry,
  type EvalCtx,
  type RouteInputs,
} from './uln'
import { amountToNumber, formatParamAmount, valueAtRisk, type Amount } from './value'

/** Lido Dual Governance committee fields of a timelock's `dg` (card order). */
const DG_COMMITTEE_FIELDS = [
  ['activationCommittee', 'Emergency Activation Committee'],
  ['executionCommittee', 'Emergency Execution Committee'],
  ['resealCommittee', 'Reseal Committee'],
  ['tiebreakerCommittee', 'Tiebreaker Committee'],
  ['proposalsCanceller', 'Proposals canceller'],
] as const

export type HeadRouteRead = {
  oapp: string
  eid: number
  direction: 'send' | 'receive'
  lib: string
  libIsDefault: boolean | null
  merged: UlnConfigRaw | null
  /** getConfig failed: `mergedReverted` = the library reverted (no DVN at all → the route
   *  verifies nothing); otherwise the READ failed and the route is UNREAD, never "blocked". */
  mergedError?: string
  mergedReverted?: boolean
  app: UlnConfigRaw | null
  grace?: { lib: string; expiry: number; config: UlnConfigRaw | null }
  peer: string
}

export type RemoteRouteRead = {
  oapp: string
  eid: number
  chainKey: string
  chainId: number | null
  status: 'ok' | 'remote_unread'
  reason?: string
  peer?: string
  /** The remote OApp's peer for Ethereum; null = the read FAILED (liveness assumed). */
  peerBack?: string | null
  /** null for a direction = the read failed (REMOTE UNREAD for that side). */
  directions?: Partial<
    Record<
      'send' | 'receive',
      {
        lib: string
        merged: UlnConfigRaw | null
        mergedError?: string
        mergedReverted?: boolean
        /** Receive: the old library in its grace period (expiry = REMOTE block); config null = unread. */
        grace?: { lib: string; expiry: number; config: UlnConfigRaw | null }
      } | null
    >
  >
  dvnCode?: Record<string, boolean | null>
  /** Remote chain block the reads were made at (when known). */
  block?: number
}

/** A Wormhole NTT manager as the collector read it at head (admin.mjs readNtt). */
export type NttHead = {
  manager: string
  token: string | null
  mode: 'locking' | 'burning' | null
  threshold: number | null
  /** null = getTransceivers() not read; `type` = getTransceiverType() (the verifier network). */
  transceivers:
    | { address: string; type: string | null; peers: Record<string, string | null> }[]
    | null
  /** chain id (Wormhole) → the manager's peer there; null = not read. */
  peers: Record<string, { peer: string; decimals: number } | null>
  owner: string | null
  pauser: string | null
  paused: boolean | null
  locked: Amount | null
  /**
   * The remote side of each live peer (admin.mjs readNttRemote), read at head on THAT chain.
   * undefined = not read (--no-remote, or a raw file from before 2026-10-07): a read gap.
   */
  remote?: NttRemoteHead[]
}

/** The remote side of a Wormhole NTT route (the peer manager on another chain), read at head there. */
export type NttRemoteHead = {
  wormholeChainId: number
  /** EVM chain id; null = a Wormhole chain the collector does not map (not read) */
  chainId: number | null
  chainKey: string | null
  status: 'ok' | 'remote_unread'
  reason?: string
  manager?: string
  token?: string | null
  mode?: 'locking' | 'burning' | null
  threshold?: number | null
  transceivers?: NttHead['transceivers']
  /** the remote manager's peer for Ethereum (Wormhole chain 2); null = not read / not set */
  peerBack?: { peer: string; decimals: number } | null
  /** classified ON THE REMOTE CHAIN (never looked up in the Ethereum controller map) */
  owner?: Controller | null
  pauser?: Controller | null
  paused?: boolean | null
  /** burning mode: the token's total supply there = the bridged supply */
  supply?: Amount | null
  supplyNote?: string
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const remoteName = (r: Pick<NttRemoteHead, 'chainKey' | 'chainId' | 'wormholeChainId'>) =>
  r.chainKey ?? (r.chainId ? `chain ${r.chainId}` : `Wormhole chain ${r.wormholeChainId}`)

/**
 * The remote sides of a Wormhole NTT manager's live routes, judged at head (pure): BR-2 floor /
 * BR-7 on the remote threshold and transceivers, AD-3 when the remote owner is EOA-controlled
 * (classified on that chain), a peer back to Ethereum that is not this manager (warning), the
 * largest bridged supply (severity rank), and the display parts. An unread side is a warning
 * and an `unread` entry (the value is then a lower bound), never silence.
 */
export function nttRemoteLines(n: NttHead): {
  breaches: StateItem['breaches']
  warnings: string[]
  unread: string[]
  supply: Amount | null
  parts: string[]
} {
  const breaches: StateItem['breaches'] = []
  const warnings: string[] = []
  const unread: string[] = []
  const parts: string[] = []
  let supply: Amount | null = null
  const sides = nttRemoteSides(n)
  if (sides === null) {
    unread.push('remote bridged supply not read')
    warnings.push(
      'the remote side of the route was not read: its threshold and owner are not judged',
    )
    return { breaches, warnings, unread, supply, parts }
  }
  const amount = (a: Amount | null | undefined) => {
    const x = amountToNumber(a ?? null)
    return x === null ? 'not read' : x.toLocaleString('en-US', { maximumFractionDigits: 1 })
  }
  for (const r of sides) {
    const where = remoteName(r)
    if (r.status !== 'ok') {
      warnings.push(
        `${where} side not read (${r.reason ?? 'no reason given'}): its threshold and owner are not judged`,
      )
      unread.push(`${where} bridged supply not read`)
      parts.push(`${where} side NOT READ`)
      continue
    }
    const mgr = r.manager ? shortAddr(r.manager) : 'manager ?'
    const types = r.transceivers?.map((t) => t.type) ?? null
    const eff = types ? nttEffective(r.threshold ?? null, types) : null
    // the remote peer for Ethereum unread: assume it still points here (fail closed, as LZ routes)
    const rLive = !r.peerBack || !/^0x0*$/i.test(r.peerBack.peer)
    if (eff && r.threshold !== null && r.threshold !== undefined) {
      if (rLive && eff.E < 2)
        breaches.push({
          ruleId: 'BR-2',
          message: `NTT ${mgr} on ${where}: ${eff.E} effective verifier network(s) attest a message (threshold ${r.threshold} over ${eff.distinct} distinct)`,
        })
      if (eff.unknown)
        breaches.push({
          ruleId: 'BR-7',
          message: `${where}: ${eff.unknown} transceiver(s) of an unknown verifier network`,
        })
      if (eff.duplicate)
        breaches.push({
          ruleId: 'BR-7',
          message: `${where}: ${eff.duplicate} transceiver(s) on a network already counted`,
        })
    } else
      warnings.push(
        `${where} side: threshold / transceivers not read — the floor is not judged there (read gap)`,
      )
    if (r.peerBack === null || r.peerBack === undefined)
      warnings.push(`${where} side: its peer for Ethereum was not read`)
    else if (
      rLive &&
      r.peerBack.peer.slice(-40).toLowerCase() !== n.manager.slice(-40).toLowerCase()
    )
      warnings.push(`${where} manager's peer for Ethereum is ${r.peerBack.peer}, not this manager`)
    if (r.owner && isEoaControlled(r.owner))
      breaches.push({
        ruleId: 'AD-3',
        message: `NTT owner on ${where} is ${describeController(r.owner)}`,
      })
    if (r.owner && r.owner.kind === 'contract')
      warnings.push(
        `${where} owner ${shortAddr(r.owner.address)} is a contract classified on ${where} only: its own governance there (e.g. a cross-chain executor) is not followed`,
      )
    if (r.supply) {
      if (!supply || (amountToNumber(r.supply) ?? 0) > (amountToNumber(supply) ?? 0))
        supply = r.supply
    } else
      unread.push(`${where} bridged supply not read${r.supplyNote ? ` (${r.supplyNote})` : ''}`)
    const pauser =
      r.pauser === null || r.pauser === undefined
        ? 'NOT READ'
        : r.pauser.kind === 'zero'
          ? 'none'
          : describeController(r.pauser)
    parts.push(
      `${where} side ${mgr} (${r.mode ?? 'mode not read'}): threshold ${r.threshold ?? '?'} of ${r.transceivers?.length ?? '?'} (${(r.transceivers ?? []).map((t) => t.type ?? 'unknown').join(' + ') || 'none'}) · ${amount(r.supply)} bridged · owner ${r.owner ? describeController(r.owner) : 'NOT READ'} · pauser ${pauser}${r.paused ? ' · PAUSED' : ''}`,
    )
  }
  return { breaches, warnings, unread, supply, parts }
}

/**
 * The remote side of every LIVE Ethereum peer (fail closed): a live peer with no remote entry is
 * an unread side. null = the remote sides were not read at all while a route is live; [] = no
 * live route. Remote entries for chains Ethereum no longer peers with are ignored.
 */
function nttRemoteSides(n: NttHead): NttRemoteHead[] | null {
  // review round 8: a peer that could not be read may be live — its remote side is unread, never
  // dropped (fail closed)
  const liveChains = Object.entries(n.peers)
    .filter(([, p]) => !p || !/^0x0*$/i.test(p.peer))
    .map(([wc]) => Number(wc))
  if (!liveChains.length) return []
  if (!n.remote) return null
  return liveChains.map(
    (wc) =>
      n.remote!.find((r) => r.wormholeChainId === wc) ?? {
        wormholeChainId: wc,
        chainId: null,
        chainKey: null,
        status: 'remote_unread',
        reason: n.peers[wc]
          ? 'no remote read recorded for this peer'
          : "the Ethereum manager's peer for this chain was not read",
      },
  )
}

/** Read gaps of an NTT manager's remote sides (the card never says "no red flags" over them). */
export function nttRemoteGaps(n: NttHead): string[] {
  const sides = nttRemoteSides(n)
  if (sides === null) return [`NTT manager ${shortAddr(n.manager)}: remote side not read`]
  return sides.flatMap((r) =>
    r.status !== 'ok'
      ? [
          `NTT manager ${shortAddr(n.manager)}: ${remoteName(r)} side not read (${r.reason ?? 'no reason given'})`,
        ]
      : r.threshold === null || r.threshold === undefined || !r.transceivers
        ? [
            `NTT manager ${shortAddr(n.manager)}: ${remoteName(r)} threshold / transceivers not read`,
          ]
        : !r.owner
          ? [`NTT manager ${shortAddr(n.manager)}: ${remoteName(r)} owner not read`]
          : [],
  )
}

/** A canonical rollup bridge's L1 side as the collector read it at head (admin.mjs readCanonicalBridge). */
export type CanonicalHead = {
  bridge: string
  token: string
  locked: Amount | null
  /** undefined = the bridge has no such switch (reverted); null = the read failed. */
  depositsEnabled?: boolean | null
  withdrawalsEnabled?: boolean | null
  ossified?: boolean | null
  admin: string | null
}

export type PowerRead = {
  power: PowerState['power']
  label: string
  contract: string
  holders: string[]
  /**
   * Intermediate hops of the power path (review round 7): the ProxyAdmin of an `eip1967_admin`
   * step, a registry of a `call:` step… Each holds the power for the next one — its own events
   * (ownership) and the calls queued on it are the subject's.
   */
  via?: string[]
  error?: string
}

export type RawSubject = {
  version: 1
  subjectKey: string
  head: { block: number; ts: number }
  scan: { from: number; to: number }
  lz: {
    events: LzEvent[]
    headRoutes: HeadRouteRead[]
    headDefaults: Record<string, UlnConfigRaw>
    remote: RemoteRouteRead[]
    codeProbes: Record<string, CodeProbe>
    dvnSigner: DvnSignerChange[]
    dvnHead: Record<string, { quorum: number | null; signers: number | null }>
    /**
     * Remote route states as evaluated by the PREVIOUS run (state/<subject>.json remoteSnapshot),
     * with the Ethereum block each was last READ at (a route unread in a run is carried).
     */
    previousRemote?: {
      block: number
      routes: Record<string, RouteState>
      readAt?: Record<string, number>
      /** Last NON-ZERO peer each remote route had over the earlier runs (BR-6 through zero). */
      lastPeer?: Record<string, string>
      /** Last state each remote route could VERIFY in, over the earlier runs (BR-1 / BR-3 on reopen). */
      lastVerifying?: Record<string, RouteState>
    }
    /**
     * Severity rank of floor breaches (owner ruling #9): the token price (registry consensus ×
     * an optional on-chain rate), each Ethereum OApp's locked balance (an adapter's underlying
     * balanceOf; null for a native OFT / unread) and each route's remote bridged supply.
     */
    value?: {
      priceUsd: number | null
      priceBasis: string
      locked: Record<string, { amount: Amount | null; note?: string }>
      /** `${oapp}|${eid}` → the remote peer's totalSupply on its chain. */
      remoteSupply: Record<string, { amount: Amount | null; note?: string }>
    }
  }
  admin: {
    events: AdminEventRow[]
    /** `${address}@${block}` and `${address}@head` → classified controller. */
    controllers: Record<string, Controller>
    powers: PowerRead[]
    timelockAdmins: { timelock: string; role: string; holders: string[] }[]
    implHistory: QueueCtx['implHistory']
    owners: Record<string, string>
    delegates: Record<string, string>
    minDelays: Record<string, number>
    /** `${proxy}@${block}` → upgrade holders resolved at block − 1 (AD-5). */
    upgradeHoldersAt?: Record<string, string[]>
    /** Safe controllers as classified by the PREVIOUS run (state/<subject>.json safeSnapshot). */
    previousSafes?: { block: number; controllers: Record<string, Controller> }
    /** First block with code of every admin-event emitter (initialization = its deploy block). */
    deployBlocks?: Record<string, number>
    /** Source verification of implementations / providers / oracle sources (Sourcify, Blockscout). */
    verification?: Record<string, boolean | null>
    /** Rows before this block are replayed for state only (an Aragon ACL scanned from deployment). */
    fileFrom?: number
    /** Aragon appId → the subject's app proxies with it (Kernel SetApp / queued setApp). */
    aragonApps?: Record<string, string[]>
    /**
     * Review round 9: the recipient (`to`) of every transaction carrying an oracle committee
     * member event; null = not read. Proves a member change was made BY the declared path.
     */
    txTo?: Record<string, string | null>
    /**
     * Review round 10 (O-4): `${address}@${block}` keys the collector tried to classify at a
     * past block and FAILED. Such a lookup is null (not read: fail closed), never the head
     * classification — that mixes eras (the 2023 Voting path judged on the 2026 controller).
     */
    classifyFailed?: string[]
  }
  params: { head: Record<string, unknown>; transitions: ParamTransition[] }
  queues: {
    ops: TimelockOp[]
    safe: SafeProposal[]
    safeStatus: { safe: string; status: 'ok' | 'unavailable'; note?: string }[]
    /** Legacy MultiSigWallet transactions submitted on-chain and not executed (pending). */
    multisig?: MultisigSubmission[]
    /** Whether each legacy multisig's submissions were read (else its pending is unobservable). */
    multisigStatus?: { multisig: string; status: 'ok' | 'unavailable'; note?: string }[]
    /** Whether each Dual Governance timelock's proposals were read (its ops are in `ops`). */
    dgStatus?: { timelock: string; status: 'ok' | 'unavailable'; note?: string }[]
  }
  /** Wormhole NTT managers (subject.nttManagers) read at head. */
  ntt?: NttHead[]
  /** Canonical rollup bridges (subject.canonicalBridges) read at head. */
  canonical?: CanonicalHead[]
  ccip: {
    pools: {
      pool: string
      owner: string | null
      rebalancer: string | null
      chains: {
        selector: string
        inboundEnabled: boolean | null
        outboundEnabled: boolean | null
        /** Remote pools the chain accepts at head (getRemotePools); null = not read. */
        remotePools?: string[] | null
        /** CCIP 1.6 siloed pool: the chain is siloed (isSiloed); null / absent = not read. */
        siloed?: boolean | null
        /** getChainRebalancer(selector) of a siloed chain (can withdraw its locked liquidity). */
        rebalancer?: string | null
      }[]
    }[]
  }
  /**
   * Oracle dimension: the governance events the oracle collector already wrote to
   * data/oracle-registry/changes.json for this asset's catalog entries (no second collector).
   */
  oracle?: {
    events: OracleGovEvent[]
    window?: { startBlock: number; endBlock: number; days: number }
  }
  warnings: string[]
}

export type OracleGovEvent = {
  block: number
  ts?: number
  tx: string
  logIndex: number
  emitter: string
  event: string
  args: Record<string, unknown>
  entryIds: string[]
}

export type BuildOptions = {
  registry: DvnRegistry
  eidName: (eid: number) => string
  roleName: (hash: string) => string
  endpoint: string
}

/** 4-byte selector of a signature ('setPeer(uint32,bytes32)') or of a hex selector as stored. */
export function selectorOf(x: string): string {
  if (/^0x[0-9a-f]{8}$/i.test(x)) return x.toLowerCase()
  try {
    return toFunctionSelector(`function ${x}`).toLowerCase()
  } catch {
    return x.toLowerCase()
  }
}

/** Roles on a declared timelock whose holders are in the subject's scope (admin.mjs TIMELOCK_SCOPE_ROLES). */
export const TIMELOCK_SCOPE_ROLE_NAMES = [
  'PROPOSER_ROLE',
  'EXECUTOR_ROLE',
  'CANCELLER_ROLE',
  'TIMELOCK_ADMIN_ROLE',
  'DEFAULT_ADMIN_ROLE',
]

/** What an LZ delegate can change on the endpoint (the DVN / library config of its OApp). */
export const ENDPOINT_CONFIG_FNS = [
  'setConfig(address,address,(uint32,uint32,bytes)[])',
  'setSendLibrary(address,uint32,address)',
  'setReceiveLibrary(address,uint32,address,uint256)',
  'setReceiveLibraryTimeout(address,uint32,address,uint256)',
]

/**
 * Which whitelisted (target, selector) pairs of a timelock bypass EXERCISE a power, i.e. lower
 * its effective delay to INSTANT (review fix: the bypass was matched per contract, so a single
 * whitelisted restriction made every power on that contract instant).
 *   lz_delegate power — the delegate acts on the endpoint only: its config functions;
 *   any other power   — every function of the contract acted on (fail closed), minus the
 *                       subject's `bypassExclude` list (functions that only restrict, or belong
 *                       to another power); a bridge power also reaches the endpoint config.
 */
export function bypassReach(
  spec: Pick<PowerSpec, 'power' | 'path' | 'bypassExclude'> | undefined,
  power: PowerState['power'],
  endpoint: string,
): { delegate: boolean; reaches: (target: string, actsOn: string, selector: string) => boolean } {
  const ep = lc(endpoint)
  const cfg = new Set(ENDPOINT_CONFIG_FNS.map(selectorOf))
  const exclude = new Set((spec?.bypassExclude ?? []).map(selectorOf))
  const delegate = (spec?.path ?? []).at(-1) === 'lz_delegate'
  return {
    delegate,
    reaches: (target, actsOn, selector) => {
      const t = lc(target)
      const sel = selectorOf(selector)
      if (t === ep) return (power === 'bridge_config' || actsOn === ep) && cfg.has(sel)
      return t === lc(actsOn) && !exclude.has(sel)
    },
  }
}

export function announcementOf(s: ConfigSubject): AnnouncementStatus {
  return s.govChannels.length ? 'not_checked' : 'no_gov_channel'
}

export function buildSubject(subject: ConfigSubject, raw: RawSubject, opt: BuildOptions) {
  const announcement = announcementOf(subject)
  const probes = {
    1: Object.fromEntries(Object.entries(raw.lz.codeProbes).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const histCtx: EvalCtx = {
    registry: opt.registry,
    code: codeOracleFrom(probes),
    useDeprecated: false,
  }
  const headCtx: EvalCtx = {
    registry: opt.registry,
    code: (chainId, a, b) => (chainId === 1 ? codeOracleFrom(probes)(chainId, a, b) : null),
    useDeprecated: true,
  }
  // Review round 10 (O-4): a classification attempted at the block that FAILED is not read —
  // never replaced by the head one (fail closed); a key never requested still falls back to head
  const classifyFailed = new Set((raw.admin.classifyFailed ?? []).map(lc))
  const failedAt = (addr: string, block: number) => classifyFailed.has(`${lc(addr)}@${block}`)
  const ctl = (addr: string, block: number): Controller | null =>
    raw.admin.controllers[`${lc(addr)}@${block}`] ??
    (failedAt(addr, block) ? null : (raw.admin.controllers[`${lc(addr)}@head`] ?? null))
  const ctlHead = (addr: string) => raw.admin.controllers[`${lc(addr)}@head`] ?? null
  // Source verification of an implementation / provider / oracle source; null = not read.
  const verified = (addr: string): boolean | null => raw.admin.verification?.[lc(addr)] ?? null
  const warnings = [...raw.warnings]
  const head = raw.head.block
  // Value at risk behind a route (owner ruling #9): the adapter's locked balance on Ethereum vs
  // the remote chain's bridged supply, priced with the registry consensus. Unread ⇒ undefined.
  const val = raw.lz.value
  const routeValue = (oapp: string, eid: number) => {
    if (!val) return undefined
    const locked = val.locked[lc(oapp)]
    const remote = val.remoteSupply[`${lc(oapp)}|${eid}`]
    const unread: string[] = []
    if (!locked?.amount) unread.push(locked?.note ?? 'Ethereum locked balance not read')
    if (!remote?.amount) unread.push(remote?.note ?? 'remote bridged supply not read')
    return valueAtRisk({
      locked: locked?.amount ?? null,
      remoteSupply: remote?.amount ?? null,
      priceUsd: val.priceUsd,
      priceBasis: val.priceBasis,
      unread,
    })
  }

  // ---- bridge: replay -------------------------------------------------------------------------------
  const oapps = subject.lzOApps.map(lc)
  const rep = replayLz(raw.lz.events, {
    announcement,
    subject: subject.key,
    oapps,
    ctx: histCtx,
    eidName: opt.eidName,
  })
  const changes: ConfigChange[] = [...rep.changes]
  const contractDeploy = (a: string): number | undefined =>
    subject.contracts.find((c) => lc(c.address) === lc(a))?.deployBlock ??
    Object.entries(raw.admin.deployBlocks ?? {}).find(([k]) => lc(k) === lc(a))?.[1]
  for (const d of rep.delegateChanges) {
    // A FIRST delegate is initialization only within OWNER_INIT_WINDOW_BLOCKS of the OApp's
    // deployment (owner ruling #7, applied to the LZ delegate in review round 5): later, its
    // initialize() could have been front-run; an unknown deploy block fails closed.
    const dep = contractDeploy(d.oapp)
    const v = d.prev
      ? classifyControllerChange(ctl(d.prev, d.block - 1), ctl(d.next, d.block))
      : dep !== undefined && d.block - dep <= OWNER_INIT_WINDOW_BLOCKS
        ? tag(neutral(), 'initialization')
        : down(
            neutral(),
            'AD-3',
            dep === undefined
              ? "first LZ delegate set with the OApp's deploy block unknown: initialization cannot be confirmed (fail closed)"
              : `first LZ delegate set ${(d.block - dep).toLocaleString('en-US')} blocks after deployment (> ${OWNER_INIT_WINDOW_BLOCKS.toLocaleString('en-US')}): initialize() could have been front-run`,
          )
    changes.push({
      id: `1:${d.tx}:${d.logIndex}`,
      subject: subject.key,
      dimension: 'admin',
      key: `admin/lz-delegate/${d.oapp}`,
      title: `LZ delegate of ${d.oapp.slice(0, 10)}… → ${describeController(ctl(d.next, d.block))}`,
      before: d.prev ?? undefined,
      after: d.next,
      state: 'historical',
      stage: 'executed',
      severity: v.severity,
      floorBreach: false,
      red: isRed(v),
      ruleIds: v.ruleIds,
      tags: v.tags,
      unannounced: null,
      announcement,
      chainId: 1,
      block: d.block,
      ts: d.ts,
      tx: d.tx,
      notes: v.notes.length ? v.notes : undefined,
    })
  }

  // ---- bridge: head (authoritative reads; the replay is cross-checked against them) ------------------
  const items: StateItem[] = []
  const headRoutes: QueueCtx['routes'] = {}
  const headInputs: Record<string, RouteInputs> = {}
  const headOverrides: Record<string, UlnConfigRaw> = {}
  const unreadLocal = new Set<string>()
  for (const h of raw.lz.headRoutes) {
    // A getConfig that failed for any reason but a library revert is a failed READ: the route
    // is UNREAD (amber), never "blocked (no_dvn)" with no breach.
    if (!h.merged && !h.mergedReverted) {
      const k = routeKey({ chainId: 1, oapp: h.oapp, eid: h.eid, direction: h.direction })
      unreadLocal.add(`${lc(h.oapp)}|${h.eid}`)
      items.push({
        subject: subject.key,
        dimension: 'bridge',
        key: k,
        chainId: 1,
        block: head,
        display: `eid ${h.eid} (${opt.eidName(h.eid)}) ${h.direction}: config UNREAD — ${h.mergedError ?? 'getConfig not read'}`,
        breaches: [],
        warnings: ['UNREAD'],
      })
      warnings.push(`${k}: getConfig read failed (${h.mergedError ?? 'no value'}) — route UNREAD`)
      continue
    }
    const cfg = h.merged ? mergeUln(h.merged, undefined) : mergeUln(undefined, undefined)
    const g =
      h.grace && h.grace.config
        ? { lib: h.grace.lib, expiry: h.grace.expiry, config: mergeUln(h.grace.config, undefined) }
        : undefined
    // The old library still verifies until its expiry, but its config could not be read: the
    // route's E is unknown (it can only be LOWER than the current library's) — UNREAD, never a
    // calm route that drops the grace library (review round 5).
    const graceUnread =
      h.direction === 'receive' &&
      !!h.grace &&
      !h.grace.config &&
      h.grace.expiry > head &&
      lc(h.grace.lib) !== lc(h.lib)
    const def = raw.lz.headDefaults[`${lc(h.lib)}|${h.eid}`]
    const inputs: RouteInputs = {
      chainId: 1,
      oapp: h.oapp,
      eid: h.eid,
      direction: h.direction,
      block: head,
      peer: h.peer,
      lib: h.lib,
      libIsDefault: !!h.libIsDefault,
      config: cfg,
      grace: g,
      defaultConfirmations: def ? mergeUln(undefined, def).confirmations : undefined,
    }
    const r = evaluateRoute(inputs, headCtx)
    headRoutes[`${r.oapp}|${r.eid}|${r.direction}`] = r
    headInputs[`${r.oapp}|${r.eid}|${r.direction}`] = inputs
    if (h.app) headOverrides[`${lc(h.lib)}|${r.oapp}|${r.eid}`] = h.app
    const replayed = rep.routes.find(
      (x) => x.oapp === r.oapp && x.eid === r.eid && x.direction === r.direction,
    )
    const w: string[] = []
    if (
      replayed &&
      (replayed.config.required.join() !== r.config.required.join() ||
        replayed.config.optional.join() !== r.config.optional.join() ||
        replayed.lib !== r.lib)
    )
      w.push(`replay ≠ head read (replay: ${displayRoute(replayed)})`)
    if (!r.live && !r.peer.match(/^0x0*$/) && r.security.blocked) w.push('route closed')
    if (graceUnread) {
      w.unshift('UNREAD')
      unreadLocal.add(`${lc(h.oapp)}|${h.eid}`)
      warnings.push(
        `${routeKey(r)}: grace library ${lc(h.grace!.lib)} config read failed — route UNREAD`,
      )
    }
    items.push({
      subject: subject.key,
      dimension: 'bridge',
      key: routeKey(r),
      chainId: 1,
      block: head,
      display: graceUnread
        ? `eid ${r.eid} (${opt.eidName(r.eid)}) ${r.direction}: UNREAD — grace library ${lc(h.grace!.lib)} (verifies until block ${h.grace!.expiry}) config not read; current library: ${displayRoute(r)}`
        : `eid ${r.eid} (${opt.eidName(r.eid)}) ${r.direction}: ${displayRoute(r)}`,
      value: {
        E: r.Eeff,
        live: r.live,
        required: r.config.required,
        optional: r.config.optional,
        threshold: r.config.optionalThreshold,
        operators: r.security.operators,
        issuerRun: r.security.issuerRun ?? [],
        confirmations: r.config.confirmations,
        lib: r.lib,
      },
      breaches: routeBreaches(r),
      tags: routeTags(r),
      warnings: w.length ? w : undefined,
      valueAtRisk: routeValue(r.oapp, r.eid),
    })
    if (w.some((x) => x.startsWith('replay'))) warnings.push(`${routeKey(r)}: ${w[0]}`)
  }
  // Remote side of every live route (critique fix #3), or REMOTE UNREAD. A failed read never
  // makes a side look closed: an unread direction is UNREAD, an unread peer is assumed live.
  const remoteNow: Record<string, RouteState> = {}
  for (const rr of raw.lz.remote) {
    // Every remote side that was read is judged (review round 6): a forged packet minted on the
    // remote chain does not need Ethereum to be live — with both Ethereum directions closed, or
    // the Ethereum peer zeroed, a remote OApp that still points back is still exposed.
    const unread = (dir: 'send' | 'receive' | null, reason: string, chainId: number) =>
      items.push({
        subject: subject.key,
        dimension: 'bridge',
        key:
          dir && rr.peer
            ? `bridge/lz/${chainId}/${lc(rr.peer)}/30101/${dir}`
            : `bridge/lz/remote/${rr.eid}/${lc(rr.oapp)}`,
        chainId,
        block: rr.block ?? 0,
        display: `eid ${rr.eid} (${rr.chainKey}) remote${dir ? ` ${dir}` : ' side'}: REMOTE UNREAD — ${reason}`,
        // the Ethereum OApp it belongs to (its local route may not exist at head)
        value: { localOApp: lc(rr.oapp) },
        breaches: [],
        warnings: ['REMOTE UNREAD'],
      })
    if (rr.status !== 'ok' || !rr.chainId || !rr.directions) {
      unread(null, rr.reason ?? 'not read', rr.chainId ?? 0)
      continue
    }
    for (const dir of ['receive', 'send'] as const) {
      const d = rr.directions[dir]
      if (!d) {
        unread(dir, `${dir} config read failed`, rr.chainId)
        continue
      }
      if (!d.merged && !d.mergedReverted) {
        unread(
          dir,
          `getConfig read failed${d.mergedError ? ` (${d.mergedError})` : ''}`,
          rr.chainId,
        )
        continue
      }
      const rctx: EvalCtx = {
        registry: opt.registry,
        code: (chainId, a) => (chainId === rr.chainId ? (rr.dvnCode?.[lc(a)] ?? null) : null),
        useDeprecated: true,
      }
      const w: string[] = []
      // peerBack null = the read failed: assume the remote OApp still points at Ethereum.
      const peerBack =
        rr.peerBack === null || rr.peerBack === undefined
          ? (w.push('remote peer for Ethereum not read: liveness assumed'),
            '0x' + lc(rr.oapp).replace(/^0x/, '').padStart(64, '0'))
          : rr.peerBack
      // The remote receive library's grace period (review round 5: it was read, then dropped).
      // Its expiry is a REMOTE block: with the remote block unknown it counts as active (fail
      // closed); a grace library whose config was not read leaves the side REMOTE UNREAD.
      const rb = rr.block ?? 0
      const gr = dir === 'receive' ? d.grace : undefined
      const graceActive = !!gr && gr.expiry > rb && lc(gr.lib) !== lc(d.lib)
      const graceUnread = graceActive && !gr!.config
      const r = evaluateRoute(
        {
          chainId: rr.chainId,
          oapp: rr.peer ?? '',
          eid: 30101,
          direction: dir,
          block: rb,
          peer: peerBack,
          lib: d.lib,
          libIsDefault: false,
          config: d.merged ? mergeUln(d.merged, undefined) : mergeUln(undefined, undefined),
          grace:
            graceActive && gr!.config
              ? { lib: gr!.lib, expiry: gr!.expiry, config: mergeUln(gr!.config, undefined) }
              : undefined,
        },
        rctx,
      )
      if (graceUnread) w.unshift('REMOTE UNREAD')
      if (rr.peerBack && rr.peerBack.slice(-40) !== lc(rr.oapp).slice(-40))
        w.push(`remote peer for Ethereum is ${rr.peerBack}, not this OApp`)
      const key = `bridge/lz/${rr.chainId}/${lc(rr.peer ?? '')}/30101/${dir}`
      remoteNow[key] = r
      items.push({
        subject: subject.key,
        dimension: 'bridge',
        key,
        chainId: rr.chainId,
        block: rr.block ?? 0,
        display: graceUnread
          ? `eid ${rr.eid} (${rr.chainKey}) remote ${dir}: REMOTE UNREAD — grace library ${lc(gr!.lib)} (verifies until remote block ${gr!.expiry}) config not read; current library: ${displayRoute(r)}`
          : `eid ${rr.eid} (${rr.chainKey}) remote ${dir}: ${displayRoute(r)}`,
        value: {
          E: r.Eeff,
          live: r.live,
          required: r.config.required,
          optional: r.config.optional,
          operators: r.security.operators,
          issuerRun: r.security.issuerRun ?? [],
          // the Ethereum OApp this remote side belongs to (its local route may not exist at
          // head: a zeroed Ethereum peer)
          localOApp: lc(rr.oapp),
        },
        breaches: routeBreaches(r),
        tags: routeTags(r),
        warnings: w.length ? w : undefined,
        valueAtRisk: routeValue(rr.oapp, rr.eid),
      })
    }
  }
  // Remote history: the remote side is read at head only, so it is diffed run to run (like the
  // Safe fields below) — a remote downgrade between two runs is a bracketed change. A route
  // that could not be read this run keeps its last read in the snapshot (with the block it was
  // read at), so a downgrade across an unread run is still bracketed against it.
  const prevRemote = raw.lz.previousRemote
  // Last NON-ZERO peer of every remote route over the runs (a re-point through 0 is BR-6).
  const remoteLastPeer: Record<string, string> = { ...(prevRemote?.lastPeer ?? {}) }
  if (prevRemote)
    for (const [k, r] of Object.entries(prevRemote.routes))
      if (!/^0x0*$/i.test(r.peer)) remoteLastPeer[k] = r.peer
  const lastPeerBefore = { ...remoteLastPeer }
  for (const [k, r] of Object.entries(remoteNow))
    if (!/^0x0*$/i.test(r.peer)) remoteLastPeer[k] = r.peer
  // Last state each remote route could VERIFY in over the runs (review round 6): a remote side
  // weakened while it was closed and then reopened is compared with the config it last ran with.
  const remoteLastVerifying: Record<string, RouteState> = { ...(prevRemote?.lastVerifying ?? {}) }
  if (prevRemote)
    for (const [k, r] of Object.entries(prevRemote.routes))
      if (routeVerifies(r)) remoteLastVerifying[k] = r
  const lastVerifyingBefore = { ...remoteLastVerifying }
  for (const [k, r] of Object.entries(remoteNow)) if (routeVerifies(r)) remoteLastVerifying[k] = r
  const remoteReadAt: Record<string, number> = {}
  for (const k of Object.keys(remoteNow)) remoteReadAt[k] = head
  const remoteCarried: Record<string, RouteState> = {}
  if (prevRemote)
    for (const [k, r] of Object.entries(prevRemote.routes))
      if (!remoteNow[k]) {
        remoteCarried[k] = r
        remoteReadAt[k] = prevRemote.readAt?.[k] ?? prevRemote.block
      }
  if (prevRemote)
    for (const [key, now] of Object.entries(remoteNow)) {
      const prev = prevRemote.routes[key]
      if (!prev || !routeDiffers(prev, now)) continue
      const since = prevRemote.readAt?.[key] ?? prevRemote.block
      const v = compareRoute(prev, now, lastVerifyingBefore[key], lastPeerBefore[key])
      tag(v, 'bracketed')
      const disp = routeChangeDisplays(
        prev,
        now,
        (x) => opt.registry.byChain[now.chainId]?.[lc(x)]?.id,
      )
      v.notes.push(...disp.notes)
      if (disp.dvnRotation && !isRed(v)) tag(v, 'rotation')
      changes.push({
        id: `${now.chainId}:remote-head:${key}:${head}`,
        subject: subject.key,
        dimension: 'bridge',
        key,
        title: `Remote ${now.direction} config on chain ${now.chainId} (${now.oapp.slice(0, 10)}…), between runs: E=${prev.Eeff} → E=${now.Eeff}`,
        before: compactRoute(prev),
        after: compactRoute(now),
        beforeDisplay: disp.before,
        afterDisplay: disp.after,
        state: 'historical',
        stage: 'executed',
        severity: v.severity,
        floorBreach: v.floorBreach,
        red: isRed(v),
        ruleIds: v.ruleIds,
        tags: v.tags,
        unannounced: null,
        announcement,
        chainId: now.chainId,
        block: head,
        blockFrom: since,
        route: { chainId: now.chainId, oapp: now.oapp, eid: 30101, direction: now.direction },
        notes: [
          ...v.notes,
          `remote side read at Ethereum blocks ${since} and ${head} (no remote event scan)`,
        ],
      })
    }
  // DVN signer sets: only DVNs this subject's routes have used.
  const usedDvns = new Set<string>()
  for (const r of [...rep.routes, ...Object.values(headRoutes)])
    for (const a of [...r.config.required, ...r.config.optional]) usedDvns.add(a)
  for (const c of rep.changes)
    for (const a of [
      ...((c.after as { required?: string[] })?.required ?? []),
      ...((c.after as { optional?: string[] })?.optional ?? []),
    ])
      usedDvns.add(a)
  const dvnName = (a: string) => opt.registry.byChain[1]?.[a]?.name ?? a.slice(0, 10)
  changes.push(
    ...classifyDvnSignerChanges(
      raw.lz.dvnSigner.filter((d) => usedDvns.has(lc(d.dvn))),
      subject.key,
      dvnName,
      announcement,
    ),
  )
  const deadDvns = new Set((opt.registry.dead[1] ?? []).map(lc))
  for (const [dvn, h] of Object.entries(raw.lz.dvnHead)) {
    if (!usedDvns.has(lc(dvn)) || deadDvns.has(lc(dvn))) continue
    items.push({
      subject: subject.key,
      dimension: 'bridge',
      key: `bridge/dvn/1/${lc(dvn)}`,
      chainId: 1,
      block: head,
      display: `DVN ${dvnName(lc(dvn))}: ${h.quorum ?? '?'}-of-${h.signers ?? '?'} signers`,
      value: h,
      breaches: [],
    })
  }

  // ---- admin ------------------------------------------------------------------------------------------
  const endpoint = lc(opt.endpoint)
  // The controller at the end of a deferral chain (contract → its owner → …).
  const leaf = (c: Controller): Controller =>
    c.kind === 'contract' && c.ownedBy ? leaf(c.ownedBy) : c
  /**
   * Delay of one holder path for a power on `target`. A timelock with a bypass path does not
   * delay what the bypass reaches: an unrestricted bypasser reaches everything, a function
   * whitelist reaches the whitelisted functions of the contract it calls (`actsOn`; for a
   * bridge power also the LZ endpoint, where the delegate's config calls land).
   */
  type Reach = ReturnType<typeof bypassReach>
  /** The whitelisted functions of `c`'s bypass that exercise the power acting on `actsOn`. */
  const reached = (c: Controller, actsOn: string, r: Reach) =>
    Object.entries(c.bypass?.targets ?? {}).flatMap(([t, sels]) =>
      sels.filter((x) => r.reaches(t, actsOn, x)).map((x) => ({ t: lc(t), x })),
    )
  const delayOf = (c: Controller, actsOn: string, r: Reach): number => {
    if (c.kind === 'oz_timelock' || c.kind === 'ds_pause') {
      const b = c.bypass
      if (b?.scope === 'any') return 0
      if (b?.scope === 'whitelist' && reached(c, actsOn, r).length > 0) return 0
      return c.delaySec ?? 0
    }
    // Lido: a Dual Governance timelock (proposer vote + after-submit delay), an Aragon vote
    if (c.kind === 'aragon_dg' || c.kind === 'aragon_voting') return c.delaySec ?? 0
    // an Aragon Agent with several executors: the shortest of their delays
    if (c.kind === 'contract' && (c.executors?.length ?? 0) > 1)
      return Math.min(...c.executors!.map((x) => delayOf(x, c.address, r)))
    if (c.kind === 'contract' && c.ownedBy) return delayOf(c.ownedBy, c.address, r)
    if (c.kind === 'immutable' || c.kind === 'zero' || c.kind === 'precompile') return Infinity
    return 0
  }
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
  /** The holder's zero delay comes from a timelock bypass (any scope, or a reached whitelist). */
  const viaBypass = (c: Controller, actsOn: string, r: Reach): boolean => {
    if (c.kind === 'contract' && c.ownedBy) return viaBypass(c.ownedBy, c.address, r)
    if (c.kind !== 'oz_timelock' && c.kind !== 'ds_pause') return false
    return c.bypass?.scope === 'any' || reached(c, actsOn, r).length > 0
  }
  const bypassNotes = (c: Controller, actsOn: string, r: Reach): string[] => {
    if (c.kind === 'contract' && c.ownedBy) return bypassNotes(c.ownedBy, c.address, r)
    const b = c.bypass
    if (!b || (c.kind !== 'oz_timelock' && c.kind !== 'ds_pause')) return []
    if (b.unread)
      return [
        `${describeController(c)}: the ${b.fn} whitelist could not be read — this run ranks the timelock as a plain contract with no delay (fail closed)`,
      ]
    if (b.scope === 'any')
      return [
        `${describeController(c)}: ${b.fn} executes any call with no delay${b.holders?.length ? ` (held by ${b.holders.map(short).join(', ')})` : ''}`,
      ]
    const hit = reached(c, actsOn, r)
    const byT = (xs: { t: string; x: string }[]) =>
      [...new Set(xs.map((h) => h.t))].map(
        (t) =>
          `${xs
            .filter((h) => h.t === t)
            .map((h) => h.x)
            .join(', ')} on ${t.slice(0, 10)}…`,
      )
    const out = byT(hit).map(
      (x) => `${describeController(c)}: ${x} whitelisted for ${b.fn} (no delay)`,
    )
    // whitelisted functions on the same contract that do NOT exercise this power: listed, the
    // delay is kept
    const other = Object.entries(b.targets ?? {})
      .filter(([t]) => lc(t) === lc(actsOn))
      .flatMap(([t, sels]) =>
        sels.filter((x) => !r.reaches(t, actsOn, x)).map((x) => ({ t: lc(t), x })),
      )
    for (const x of byT(other))
      out.push(
        `${describeController(c)}: ${x} whitelisted for ${b.fn} (no delay) — outside this power, its delay is kept`,
      )
    return out
  }
  const specOf = (p: (typeof raw.admin.powers)[number]) =>
    subject.powers.find(
      (s) => s.power === p.power && lc(s.contract) === lc(p.contract) && s.label === p.label,
    )
  const reachOfPower = raw.admin.powers.map((p) => bypassReach(specOf(p), p.power, endpoint))
  // The account an LZ delegate power's holder acts on is the endpoint, not the OApp.
  const firstTarget = (pi: number) =>
    reachOfPower[pi].delegate ? endpoint : lc(raw.admin.powers[pi].contract)
  const multisigRead = new Set(
    (raw.queues.multisigStatus ?? []).filter((m) => m.status === 'ok').map((m) => lc(m.multisig)),
  )
  const powers: PowerState[] = raw.admin.powers.map((p, pi) => {
    // A holder the collector could not classify is never dropped (that would let the delay of
    // the others stand): it counts as an unclassified contract with no delay.
    const holders = p.holders.map(
      (h): Controller =>
        ctlHead(h) ?? { kind: 'contract', address: lc(h), version: 'not classified at head' },
    )
    const delays = holders.map((h) => delayOf(h, firstTarget(pi), reachOfPower[pi]))
    const weakest = holders.reduce<Controller | null>(
      (m, h) => (m === null || compareRank(controllerRank(h), controllerRank(m)) < 0 ? h : m),
      null,
    )
    const eff = delays.length ? Math.min(...delays) : 0
    // Who can act with no delay, and can a change of theirs be seen before it lands? A legacy
    // MultiSigWallet stores each submission on-chain until enough owners confirm it: observable
    // when its submissions were read (default 2026-10-06), never when they were not. A Safe, an
    // EOA, a timelock bypass and any contract with no delay of its own (BitGo WalletSimple, an
    // unclassified holder) act at once: no pending window, INSTANT.
    const instant = holders.filter((h, i) => delays[i] === 0)
    const why = instant.map((h): { observable: boolean; note: string } => {
      const l = leaf(h)
      if (l.kind === 'legacy_multisig')
        return multisigRead.has(l.address)
          ? {
              observable: true,
              note: `pending = submitted, unexecuted multisig transactions of ${short(l.address)} (on-chain; no minimum delay)`,
            }
          : {
              observable: false,
              note: `no pending window · INSTANT (the submissions of multisig ${short(l.address)} were not read)`,
            }
      if (l.kind === 'safe')
        return {
          observable: false,
          note: 'no pending window · INSTANT (a Safe signs off-chain; only proposals sent to the Safe Tx Service are visible)',
        }
      if (isEoa(l))
        return { observable: false, note: 'no pending window · INSTANT (an EOA acts at once)' }
      if (viaBypass(h, firstTarget(pi), reachOfPower[pi]))
        return { observable: false, note: 'no pending window · INSTANT (timelock bypass)' }
      if (
        l.kind === 'oz_timelock' ||
        l.kind === 'ds_pause' ||
        l.kind === 'aragon_dg' ||
        l.kind === 'aragon_voting'
      )
        return {
          observable: false,
          note: `no pending window · INSTANT (a timelock with no delay: ${short(l.address)})`,
        }
      return {
        observable: false,
        note: `no pending window · INSTANT (a contract with no delay acts at once: ${short(l.address)})`,
      }
    })
    const blind = why.find((w) => !w.observable)
    return {
      power: p.power,
      label: p.label,
      contract: lc(p.contract),
      holders,
      effectiveDelaySec: Number.isFinite(eff) ? eff : -1,
      weakest,
      pendingObservable: !(eff === 0 && blind),
      pendingNote: eff === 0 ? (blind ?? why[0])?.note : undefined,
    }
  })
  const powerNotes = new Map(
    raw.admin.powers.map((p, i) => [
      i,
      [
        ...powers[i].holders.flatMap((h) => bypassNotes(h, firstTarget(i), reachOfPower[i])),
        ...powers[i].holders
          .filter((h) => h.version === 'not classified at head')
          .map((h) => `${short(h.address)} could not be classified at head: counted with no delay`),
      ],
    ]),
  )
  for (const [pi, p] of powers.entries()) {
    const breaches: StateItem['breaches'] = []
    const bypass = powerNotes.get(pi) ?? []
    for (const h of p.holders) {
      // an EOA, or a holder that ranks with one (review round 7: a 1-of-N multisig — any one
      // signer acts alone; a contract an EOA owns)
      if (isEoaControlled(h))
        breaches.push({ ruleId: 'AD-3', message: `${p.label} held by ${describeController(h)}` })
      // AD-6 at head through the whole controller tree (UQ-22): a Safe with a module anywhere in
      // the holder's tree — a timelock's proposer, an Agent's executor, an owner — executes
      // without signatures, exactly as if it held the power directly (the timelock ranks as
      // that Safe: a plain contract)
      for (const x of controllerTree(h))
        if (x.kind === 'safe' && x.modules?.length)
          breaches.push({
            ruleId: 'AD-6',
            message:
              x === h
                ? `${describeController(h)} has ${h.modules!.length} module(s) that execute without signatures`
                : `${p.label}: ${describeController(x, { nested: true })} (in the tree of ${short(h.address)}) has ${x.modules!.length} module(s) that execute without signatures`,
          })
      // A Dual Governance timelock in EMERGENCY MODE: the execution committee executes without
      // the after-schedule delay and can reset governance (the stETH-holder veto) — AD-2 at head
      if (leaf(h).kind === 'aragon_dg' && leaf(h).dg?.emergencyModeActive)
        breaches.push({
          ruleId: 'AD-2',
          message: `${p.label}: ${describeController(leaf(h))} — emergency mode is active`,
        })
      // AD-2 at head (review round 6): a timelock whose no-delay bypass reaches this power is
      // not in its authority path — the head-state twin of a Safe module (above). A whitelist
      // that could not be read is a read gap, not a breach.
      const tl = leaf(h)
      if (
        (tl.kind === 'oz_timelock' || tl.kind === 'ds_pause') &&
        !tl.bypass?.unread &&
        viaBypass(h, firstTarget(pi), reachOfPower[pi])
      )
        breaches.push({
          ruleId: 'AD-2',
          message: `${p.label}: ${describeController(tl)} is bypassed — ${tl.bypass?.scope === 'any' ? `${tl.bypass.fn} executes any call` : `whitelisted functions reach this power through ${tl.bypass?.fn}`} with NO delay`,
        })
    }
    items.push({
      subject: subject.key,
      dimension: 'admin',
      key: `admin/power/${p.power}/${p.contract}`,
      chainId: 1,
      block: head,
      display: `${p.label}: ${p.holders.map(describeController).join(' | ') || 'unresolved'} · effective delay ${p.effectiveDelaySec < 0 ? 'none (immutable)' : formatDelay(p.effectiveDelaySec)}${p.effectiveDelaySec === 0 && p.holders.some((h) => viaBypass(h, firstTarget(pi), reachOfPower[pi])) ? ' (timelock bypass)' : ''}${p.pendingObservable ? '' : ` · pending changes not observable${p.pendingNote ? `: ${p.pendingNote}` : ''}`}`,
      value: { holders: p.holders.map((h) => h.address), delaySec: p.effectiveDelaySec },
      breaches,
      warnings: bypass.length ? bypass : undefined,
    })
  }
  for (const t of raw.admin.timelockAdmins) {
    const hs = t.holders.map((h) => ctlHead(h) ?? { kind: 'contract' as const, address: lc(h) })
    const bad = timelockAdminBreach(t.timelock, hs)
    items.push({
      subject: subject.key,
      dimension: 'admin',
      key: `admin/timelock_admin/${lc(t.timelock)}`,
      chainId: 1,
      block: head,
      display: `timelock ${lc(t.timelock).slice(0, 10)}… ${t.role} holders: ${hs.map(describeController).join(' | ') || 'none'}`,
      breaches: bad.map((b) => ({ ruleId: 'AD-7', message: `${t.role} held by ${b}` })),
    })
  }
  const upgradeTimelocks: Record<string, string[]> = {}
  for (const p of powers.filter((x) => x.power === 'upgrade')) {
    const tls = p.holders.flatMap((h) =>
      h.kind === 'oz_timelock'
        ? [h.address]
        : h.ownedBy?.kind === 'oz_timelock'
          ? [h.ownedBy.address]
          : [],
    )
    if (tls.length) upgradeTimelocks[p.contract] = tls
  }
  // A timelock judges upgrades only from the first block it held any power (ownership,
  // proxy admin or role) — upgrades before it existed were not bypassing it.
  const timelockSince: Record<string, number> = {}
  for (const t of Object.values(upgradeTimelocks).flat()) {
    const hits = raw.admin.events
      .filter((e) =>
        [e.args.newOwner, e.args.newAdmin, e.args.account].some((x) => lc(String(x ?? '')) === t),
      )
      .map((e) => e.block)
    const dep = subject.contracts.find((c) => lc(c.address) === t)?.deployBlock ?? 0
    timelockSince[t] = hits.length ? Math.min(...hits) : dep
  }
  const tokens = subject.contracts.filter((c) => c.role === 'token').map((c) => lc(c.address))
  // Power-graph controllers that are not declared subject contracts are charged only from the
  // first block an event on ANOTHER contract named them as a holder (review round 5: WBTC was
  // charged with the CCIP RBACTimelock's delay cuts from before it held any WBTC power). No such
  // event ⇒ not scoped (fail closed: the whole history stays).
  const declared = new Set(subject.contracts.map((c) => lc(c.address)))
  const scopeSince: Record<string, number> = {}
  for (const em of new Set(raw.admin.events.map((e) => lc(e.emitter)))) {
    if (declared.has(em)) continue
    const hits = [
      ...raw.admin.events
        .filter(
          (e) =>
            lc(e.emitter) !== em &&
            // the shared TokenAdminRegistry: only this subject's tokens confer a power here
            (e.event !== 'AdministratorTransferred' || tokens.includes(lc(String(e.args.token)))) &&
            [
              e.args.newOwner,
              e.args.newAdmin,
              e.args.account,
              e.args.newMasterMinter,
              e.args.newAddress,
              e.args.newRebalancer,
            ].some((x) => lc(String(x ?? '')) === em),
        )
        .map((e) => e.block),
      ...rep.delegateChanges.filter((d) => lc(d.next) === em).map((d) => d.block),
    ]
    if (hits.length) scopeSince[em] = Math.min(...hits)
  }
  const capSpec = subject.params.find(
    (p) => p.rule === 'cap' && p.key.startsWith('minterAllowance'),
  )
  /**
   * AD-2 (review round 6): does a (target, selector) on a timelock's no-delay whitelist exercise a
   * declared power? 'outside' only when the target is a power's contract (or the endpoint, for a
   * bridge power) and no such power is reached; a subject contract no power is about is
   * 'unknown' (fail closed: judged as reaching one); a contract that is not the subject's is
   * 'foreign' (a shared timelock's whitelist for another asset — not this card's).
   */
  const ownContracts = new Set([
    ...subject.contracts.map((c) => lc(c.address)),
    ...subject.lzOApps.map(lc),
    ...subject.ccipPools.map(lc),
    ...subject.timelocks.map(lc),
    endpoint,
  ])
  // Review round 7: the contracts each power is exercised THROUGH — a holder that is a contract
  // its owner (a timelock) calls: EthenaMinting for "USDe minter contract". The head bypass
  // check (delayOf) already follows these chains; the history / queue matcher looked only at
  // powers declared on the whitelisted target, so the two gave opposite answers.
  const chainActs = new Map<PowerSpec, Set<string>>()
  raw.admin.powers.forEach((p, pi) => {
    const sp = specOf(p)
    if (!sp) return
    const set = chainActs.get(sp) ?? new Set<string>()
    for (const h of powers[pi].holders) {
      let c: Controller | undefined = h
      while (c && c.kind === 'contract' && c.ownedBy) {
        set.add(lc(c.address))
        c = c.ownedBy
      }
    }
    chainActs.set(sp, set)
  })
  const whitelistReach = (target: string, selector: string): WhitelistReach => {
    const t = lc(target)
    const viaChain = subject.powers.filter((sp) => chainActs.get(sp)?.has(t))
    // a contract in one of the subject's holder chains is the subject's (never 'foreign')
    if (!ownContracts.has(t) && !viaChain.length) return 'foreign'
    const about = [
      ...subject.powers
        .map((sp) => ({ sp, r: bypassReach(sp, sp.power, endpoint) }))
        .filter(({ sp, r }) =>
          t === endpoint ? sp.power === 'bridge_config' || r.delegate : lc(sp.contract) === t,
        )
        .map(({ sp, r }) => ({ r, actsOn: r.delegate ? endpoint : lc(sp.contract) })),
      // the same reach test the head uses: the chain contract is the one acted on
      ...viaChain.map((sp) => ({ r: bypassReach(sp, sp.power, endpoint), actsOn: t })),
    ]
    if (!about.length) return 'unknown'
    return about.some(({ r, actsOn }) => r.reaches(t, actsOn, selector)) ? 'reaches' : 'outside'
  }
  // Owner ruling 2026-10-08 (#13): the declared delayed governance path of each oracle committee
  // = every delayed controller (timelock, Dual Governance, Aragon vote) in the head trees of the
  // holders of a declared power over the committee; with no such power, the subject's declared
  // timelocks. A member change executed through none of them is red.
  // UQ-19: the committee's own controllers (the holders of those powers) — a member change made
  // through a path controller that ranks BELOW them (its weakest proposer) is red.
  const committeePaths: Record<string, string[]> = {}
  const committeeControllers: Record<string, string[]> = {}
  // a path controller nested in a head tree (the DG timelock under the Agent): found there
  const treeNodes = new Map<string, Controller>()
  for (const [k, c] of Object.entries(raw.admin.controllers))
    if (k.endsWith('@head'))
      for (const x of controllerTree(c))
        if (!treeNodes.has(lc(x.address))) treeNodes.set(lc(x.address), x)
  const headTreeNode = (a: string): Controller | null => treeNodes.get(lc(a)) ?? null
  for (const em of new Set(
    raw.admin.events.filter((e) => COMMITTEE_EVENTS.has(e.event)).map((e) => lc(e.emitter)),
  )) {
    const on = powers.filter((p) => lc(p.contract) === em)
    const path = new Set<string>()
    for (const p of on)
      for (const h of p.holders)
        for (const c of controllerTree(h))
          if (isTimelockKind(c) && ((c.delaySec ?? 0) > 0 || (c.dg?.afterSubmitDelaySec ?? 0) > 0))
            path.add(lc(c.address))
    if (!on.length) for (const t of subject.timelocks) path.add(lc(t))
    committeePaths[em] = [...path]
    committeeControllers[em] = [...new Set(on.flatMap((p) => p.holders.map((h) => lc(h.address))))]
  }
  changes.push(
    ...classifyAdminEvents(raw.admin.events, {
      subject: subject.key,
      ctl,
      upgradeTimelocks,
      timelockSince,
      committeePaths,
      committeeControllers,
      ctlPath: (a: string, b: number) =>
        failedAt(a, b) ? ctl(a, b) : (ctl(a, b) ?? headTreeNode(a)),
      ...(raw.admin.txTo ? { txTo: raw.admin.txTo } : {}),
      upgradeHoldersAt: raw.admin.upgradeHoldersAt
        ? Object.fromEntries(
            Object.entries(raw.admin.upgradeHoldersAt).map(([k, hs]) => {
              const b = Number(k.split('@')[1]) - 1
              return [
                k,
                hs.map(
                  (h) =>
                    raw.admin.controllers[`${lc(h)}@${b}`] ?? {
                      kind: 'contract' as const,
                      address: lc(h),
                    },
                ),
              ]
            }),
          )
        : undefined,
      ctlExact: (a: string, b: number) => raw.admin.controllers[`${lc(a)}@${b}`] ?? null,
      deployBlocks: {
        ...Object.fromEntries(
          Object.entries(raw.admin.deployBlocks ?? {}).map(([k, b]) => [lc(k), b]),
        ),
        ...Object.fromEntries(subject.contracts.map((c) => [lc(c.address), c.deployBlock])),
      },
      tokens,
      announcement,
      minterCapSpec: capSpec,
      verified,
      scopeSince,
      scanFrom: raw.scan.from,
      fileFrom: raw.admin.fileFrom,
      whitelistReach,
    }),
  )

  // ---- mint / redeem ------------------------------------------------------------------------------------
  changes.push(
    ...classifyParamTransitions(raw.params.transitions, subject.params, {
      subject: subject.key,
      ctl,
      announcement,
      verified,
    }),
  )
  for (const spec of subject.params) {
    const v = raw.params.head[spec.key]
    const breaches: StateItem['breaches'] = []
    if (
      ['rate_provider', 'price_oracle', 'minter'].includes(spec.rule) &&
      typeof v === 'string' &&
      isEoaControlled(ctlHead(v))
    )
      breaches.push({
        ruleId: 'MR-2',
        message: `${spec.label} is ${describeController(ctlHead(v))}`,
      })
    if (spec.rule === 'pauser' && typeof v === 'string' && /^0x0{40}$/i.test(v))
      breaches.push({ ruleId: 'MR-1', message: 'no pauser' })
    items.push({
      subject: subject.key,
      dimension: 'mint_redeem',
      key: `mint/${spec.key}`,
      chainId: 1,
      block: head,
      display: `${spec.label}: ${v === undefined ? 'unread' : typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) ? describeController(ctlHead(v) ?? { kind: 'contract', address: lc(v) }) : (formatParamAmount(v, spec.unit) ?? String(v))}`,
      value: v,
      breaches,
    })
  }

  // ---- CCIP ----------------------------------------------------------------------------------------------
  for (const p of raw.ccip.pools) {
    const breaches: StateItem['breaches'] = []
    const reb = p.rebalancer ? ctlHead(p.rebalancer) : null
    // A 1.6 siloed chain has its OWN rebalancer (getChainRebalancer); the pool-wide one only
    // serves the unsiloed chains (review round 5: WBTC's card showed the unset unsiloed one).
    const siloed = p.chains.filter((c) => c.siloed)
    const unsiloed = p.chains.filter((c) => !c.siloed)
    if (reb && isEoaControlled(reb) && (unsiloed.length || !siloed.length))
      breaches.push({ ruleId: 'CC-3', message: `rebalancer is ${describeController(reb)}` })
    const siloLines: string[] = []
    for (const c of siloed) {
      const sr = c.rebalancer ? ctlHead(c.rebalancer) : null
      siloLines.push(
        `chain ${c.selector} siloed, rebalancer ${c.rebalancer === undefined || c.rebalancer === null ? 'NOT READ' : describeController(sr ?? { kind: 'contract', address: lc(c.rebalancer) })}`,
      )
      if (sr && isEoaControlled(sr))
        breaches.push({
          ruleId: 'CC-3',
          message: `silo rebalancer of chain ${c.selector} is ${describeController(sr)}`,
        })
    }
    for (const c of p.chains)
      if (c.inboundEnabled === false || c.outboundEnabled === false)
        breaches.push({ ruleId: 'CC-2', message: `rate limiter off for chain ${c.selector}` })
    const unreadSilo = siloed.filter((c) => !c.rebalancer).length
    const rebText =
      p.rebalancer && /^0x0{40}$/i.test(p.rebalancer)
        ? 'none set (address 0)'
        : describeController(reb)
    items.push({
      subject: subject.key,
      dimension: 'bridge',
      key: `bridge/ccip/${lc(p.pool)}`,
      chainId: 1,
      block: head,
      display: `CCIP pool ${lc(p.pool).slice(0, 10)}…: owner ${describeController(p.owner ? ctlHead(p.owner) : null)}, ${siloed.length ? `unsiloed rebalancer ${rebText}${unsiloed.length ? '' : ' (no unsiloed chain)'}; ${siloLines.join('; ')}` : `rebalancer ${rebText}`} (can withdraw locked liquidity), ${p.chains.length} chains · CCIP 2.0 verifier set (CCV/RMN) not read in v1`,
      breaches,
      warnings: [
        'CCIP 2.0 committee/CCV verifier set not read in v1',
        ...(unreadSilo ? [`${unreadSilo} siloed chain rebalancer(s) not read`] : []),
      ],
    })
  }

  // ---- Wormhole NTT (design §2 BR-2: the floor applies to the NTT threshold) ------------------------------
  const tokenPrice = {
    priceUsd: raw.lz.value?.priceUsd ?? null,
    priceBasis: raw.lz.value?.priceBasis ?? '',
  }
  const amountText = (a: Amount | null) => {
    const n = amountToNumber(a)
    return n === null ? 'not read' : n.toLocaleString('en-US', { maximumFractionDigits: 1 })
  }
  for (const n of raw.ntt ?? []) {
    const breaches: StateItem['breaches'] = []
    const itemWarnings: string[] = []
    const types = n.transceivers?.map((t) => t.type) ?? null
    const eff = types ? nttEffective(n.threshold, types) : null
    // review round 8: a peer that could not be read may be live (fail closed) — a failed read
    // never switches the floor off
    const live = Object.values(n.peers).some((p) => !p || !/^0x0*$/i.test(p.peer))
    if (eff && n.threshold !== null) {
      if (live && eff.E < 2)
        breaches.push({
          ruleId: 'BR-2',
          message: `NTT ${short(n.manager)}: ${eff.E} effective verifier network(s) attest a message (threshold ${n.threshold} over ${eff.distinct} distinct)`,
        })
      if (eff.unknown)
        breaches.push({
          ruleId: 'BR-7',
          message: `${eff.unknown} transceiver(s) of an unknown verifier network`,
        })
      if (eff.duplicate)
        breaches.push({
          ruleId: 'BR-7',
          message: `${eff.duplicate} transceiver(s) on a network already counted`,
        })
    } else
      itemWarnings.push('threshold / transceivers not read: the floor is not judged (read gap)')
    const own = n.owner ? ctlHead(n.owner) : null
    if (own && isEoaControlled(own))
      breaches.push({ ruleId: 'AD-3', message: `NTT owner is ${describeController(own)}` })
    const peers = Object.entries(n.peers)
      .map(
        ([ch, p]) =>
          `chain ${ch} ${p ? `0x…${p.peer.slice(-40, -34)}…${p.peer.slice(-4)}` : 'NOT READ'}`,
      )
      .join(', ')
    // the remote side of each live route (review 2026-10-07): the floor, the owner and the
    // bridged supply there — a message forged on the remote side mints there, and the remote
    // owner can upgrade the remote manager / transceivers into emitting messages Ethereum releases on
    const remote = nttRemoteLines(n)
    breaches.push(...remote.breaches)
    itemWarnings.push(...remote.warnings)
    const value = valueAtRisk({
      locked: n.locked,
      remoteSupply: remote.supply,
      ...tokenPrice,
      unread: [...(n.locked ? [] : ['locked balance not read']), ...remote.unread],
    })
    items.push({
      subject: subject.key,
      dimension: 'bridge',
      key: `bridge/ntt/${lc(n.manager)}`,
      chainId: 1,
      block: head,
      display: `Wormhole NTT manager ${short(n.manager)} (${n.mode ?? 'mode not read'}): threshold ${n.threshold ?? '?'} of ${n.transceivers?.length ?? '?'} transceivers (${(n.transceivers ?? []).map((t) => t.type ?? 'unknown').join(' + ') || 'none'}) · peers ${peers || 'none'} · ${amountText(n.locked)} locked · owner ${describeController(own)} · pauser ${n.pauser === null ? 'NOT READ' : /^0x0{40}$/i.test(n.pauser) ? 'none' : describeController(ctlHead(n.pauser) ?? { kind: 'contract', address: lc(n.pauser) })}${n.paused ? ' · PAUSED' : ''}${remote.parts.map((x) => ` · ${x}`).join('')}`,
      value: {
        threshold: n.threshold,
        transceivers: n.transceivers,
        peers: n.peers,
        ...(n.remote ? { remote: n.remote } : {}),
      },
      breaches,
      warnings: itemWarnings.length ? itemWarnings : undefined,
      valueAtRisk: value,
    })
  }

  // ---- canonical rollup bridges (L1 side): verification is the rollup's own proof system ------------------
  for (const b of raw.canonical ?? []) {
    const spec = subject.canonicalBridges?.find((x) => lc(x.address) === lc(b.bridge))
    const breaches: StateItem['breaches'] = []
    const adm = b.admin ? ctlHead(b.admin) : null
    if (adm && isEoaControlled(adm))
      breaches.push({ ruleId: 'AD-3', message: `bridge proxy admin is ${describeController(adm)}` })
    const sw = (x: boolean | null | undefined, what: string) =>
      x === undefined ? null : x === null ? `${what} NOT READ` : x ? `${what} on` : `${what} OFF`
    const value = valueAtRisk({
      locked: b.locked,
      remoteSupply: null,
      ...tokenPrice,
      unread: b.locked ? [] : ['locked balance not read'],
    })
    items.push({
      subject: subject.key,
      dimension: 'bridge',
      key: `bridge/canonical/${lc(b.bridge)}`,
      chainId: 1,
      block: head,
      display: [
        `${spec?.chain ?? 'rollup'} canonical bridge ${short(b.bridge)} (${spec?.operator ?? 'operator unknown'}): ${amountText(b.locked)} locked`,
        sw(b.depositsEnabled, 'deposits'),
        sw(b.withdrawalsEnabled, 'withdrawals'),
        b.ossified ? 'OSSIFIED (no upgrades)' : `proxy admin ${describeController(adm)}`,
      ]
        .filter(Boolean)
        .join(' · '),
      value: { locked: b.locked, admin: b.admin },
      breaches,
      warnings: [
        "the rollup's own message verification (proof system, sequencer, its upgrade keys) is not read",
      ],
      valueAtRisk: value,
    })
  }

  // ---- Lido Dual Governance at head: committees, canceller, state (wstETH) --------------------------------
  // The committees hold no declared power, yet in emergency mode the execution committee executes
  // scheduled proposals without the after-schedule delay and can reset governance; the reseal
  // committee extends a seal of the withdrawal queue; the tiebreaker executes when governance is
  // deadlocked; the canceller can cancel every pending proposal. A committee one key controls (an
  // EOA, a 1-of-N Safe, a contract an EOA owns) is the AD-3 head breach, like a power held by one.
  const dgTimelocks = new Map<string, Controller>()
  const findDg = (c: Controller | undefined, seen = new Set<Controller>()): void => {
    if (!c || seen.has(c)) return
    seen.add(c)
    if (c.kind === 'aragon_dg' && c.dg && !dgTimelocks.has(lc(c.address)))
      dgTimelocks.set(lc(c.address), c)
    findDg(c.ownedBy, seen)
    for (const e of c.executors ?? []) findDg(e, seen)
  }
  for (const p of powers) p.holders.forEach((h) => findDg(h))
  const dgGaps: string[] = []
  const dgCommitteeAddrs = new Set<string>()
  for (const [ept, c] of dgTimelocks) {
    const d = c.dg!
    const breaches: StateItem['breaches'] = []
    const lines: string[] = []
    for (const [field, name] of DG_COMMITTEE_FIELDS) {
      const a = d[field]
      if (a === undefined) continue // not read by the collector version that wrote this controller
      if (a === null) {
        lines.push(`${name} NOT READ`)
        dgGaps.push(`Dual Governance ${short(ept)}: ${name} not read`)
        continue
      }
      if (/^0x0{40}$/i.test(a)) {
        lines.push(`${name} none`)
        continue
      }
      dgCommitteeAddrs.add(lc(a))
      const h = ctlHead(a)
      if (!h) {
        lines.push(`${name} ${short(lc(a))} (not classified at head)`)
        dgGaps.push(`Dual Governance ${short(ept)}: ${name} ${short(lc(a))} not classified at head`)
        continue
      }
      lines.push(`${name} ${describeController(h)}`)
      if (isEoaControlled(h))
        breaches.push({
          ruleId: 'AD-3',
          message: `${name} of Dual Governance ${short(ept)} is ${describeController(h)}`,
        })
    }
    const ends = d.emergencyProtectionEndsAfter
    const protection =
      ends === null
        ? 'emergency protection end NOT READ'
        : ends <= raw.head.ts
          ? `emergency protection ended ${new Date(ends * 1000).toISOString().slice(0, 10)} (the emergency committees have no power)`
          : `emergency protection until ${new Date(ends * 1000).toISOString().slice(0, 10)}`
    const state =
      d.state === undefined
        ? null
        : d.state === null
          ? 'state NOT READ'
          : d.state === 'Normal'
            ? 'state Normal'
            : `STATE ${d.state} (stETH holders' veto: proposals cannot execute until it resolves)`
    const proposers = (d.proposers ?? []).map((x) => short(lc(x))).join(', ') || 'none read'
    items.push({
      subject: subject.key,
      dimension: 'admin',
      key: `admin/dg/${ept}`,
      chainId: 1,
      block: head,
      display: [
        `Lido Dual Governance timelock ${short(ept)}`,
        state,
        `proposals by ${proposers}${d.proposerVoteSec ? ` (${formatDelay(d.proposerVoteSec)} vote)` : ''} · after-submit ${d.afterSubmitDelaySec === null ? 'NOT READ' : formatDelay(d.afterSubmitDelaySec)} · after-schedule ${d.afterScheduleDelaySec === null ? 'NOT READ' : formatDelay(d.afterScheduleDelaySec)}`,
        `emergency mode ${d.emergencyModeActive === null ? 'NOT READ' : d.emergencyModeActive ? 'ACTIVE' : 'off'}`,
        protection,
        ...lines,
      ]
        .filter(Boolean)
        .join(' · '),
      value: d,
      breaches,
    })
  }

  // ---- AD-6 at head: Safe fields a delegatecall can change without an event, diffed per run --------------
  // Only THIS subject's Safes (review fix: the collector hands every subject one shared
  // controller map, so diffing all of it put one app's Safe change on every card): declared
  // Safes, Safes in the power graph (through deferral chains), timelock-admin holders, the
  // Safes whose queues this card reads, and the OApps' owners / delegates.
  // Every proposer / executor / canceller / admin of a declared timelock too (review round 7:
  // the Ethena timelock's EXECUTOR Safe had its events on the card but no run-to-run snapshot).
  const timelockRoleHolders = new Map<string, Set<string>>()
  for (const e of [...raw.admin.events].sort(
    (x, y) => x.block - y.block || x.logIndex - y.logIndex,
  )) {
    if (e.event !== 'RoleGranted' && e.event !== 'RoleRevoked') continue
    if (!subject.timelocks.map(lc).includes(lc(e.emitter))) continue
    const role = String(e.args.roleName ?? opt.roleName(String(e.args.role)))
    if (!TIMELOCK_SCOPE_ROLE_NAMES.includes(role)) continue
    const k = `${lc(e.emitter)}|${role}`
    const set = timelockRoleHolders.get(k) ?? new Set<string>()
    if (e.event === 'RoleGranted') set.add(lc(String(e.args.account)))
    else set.delete(lc(String(e.args.account)))
    timelockRoleHolders.set(k, set)
  }
  const subjectSafes = new Set<string>([
    ...subject.safes.map(lc),
    ...subject.contracts.map((c) => lc(c.address)),
    ...raw.queues.safeStatus.map((x) => lc(x.safe)),
    ...raw.admin.timelockAdmins.flatMap((t) => t.holders.map(lc)),
    ...[...timelockRoleHolders.values()].flatMap((x) => [...x]),
    // power-path hops (a ProxyAdmin) — a Safe there is tracked like a holder
    ...raw.admin.powers.flatMap((p) => (p.via ?? []).map(lc)),
    ...subject.lzOApps.flatMap((o) =>
      [raw.admin.owners[lc(o)], raw.admin.delegates[lc(o)]].filter((x): x is string => !!x),
    ),
  ])
  const addChain = (h: Controller | undefined): void => {
    if (!h) return
    subjectSafes.add(lc(h.address))
    addChain(h.ownedBy)
  }
  for (const p of powers) p.holders.forEach(addChain)
  for (const a of dgCommitteeAddrs) subjectSafes.add(a)
  // A Safe proxy whose slot 0 no longer holds a canonical singleton is classified as a plain
  // contract; it stays tracked (its `singleton` is kept) so that swap is never silent.
  const isSafeLike = (c: Controller | null | undefined): c is Controller =>
    !!c && (c.kind === 'safe' || !!c.singleton)
  const safeNow = [...subjectSafes]
    .map((a) => ctlHead(a))
    .filter((c): c is Controller => isSafeLike(c))
  const prevSafes = raw.admin.previousSafes
  const tracked = new Set([
    ...safeNow.map((c) => c.address),
    ...Object.keys(prevSafes?.controllers ?? {}).filter((a) => subjectSafes.has(lc(a))),
  ])
  for (const addr of tracked) {
    const prev = prevSafes?.controllers[addr]
    const c = ctlHead(addr)
    if (!prev || !c) continue
    const since = prevSafes!.block
    // AD-6 singleton: slot 0 moved (a canonical Safe whose singleton was swapped is no longer a
    // Safe — the delegatecall-takeover path), or a Safe no longer classifies as one.
    const wasSafe = prev.kind === 'safe'
    const isSafe = c.kind === 'safe'
    if ((prev.singleton ?? null) !== (c.singleton ?? null) || wasSafe !== isSafe) {
      const to = c.singleton ?? `none (now ${describeController(c)})`
      const v = classifySafeModuleChange('singleton', prev.singleton ?? undefined, to)
      if (wasSafe && !isSafe) v.notes.push('no longer a canonical Safe: ranked as a plain contract')
      changes.push({
        id: `1:safe-head:${addr}:singleton:${raw.head.block}`,
        subject: subject.key,
        dimension: 'admin',
        key: `admin/safe/${addr}/singleton`,
        title: `Safe ${addr.slice(0, 10)}…: singleton (slot 0) changed between runs (no event required)`,
        before: prev.singleton,
        after: c.singleton ?? null,
        state: 'historical',
        stage: 'executed',
        severity: v.severity,
        floorBreach: false,
        red: isRed(v),
        ruleIds: v.ruleIds,
        tags: ['bracketed'],
        unannounced: null,
        announcement,
        chainId: 1,
        block: raw.head.block,
        blockFrom: since,
        notes: v.notes.length ? v.notes : undefined,
      })
    }
    if (!isSafe || !wasSafe) continue
    // AD-1 without an event: a delegatecall can rewrite the threshold / owners too. Review round
    // 6: compared with what the EVENTS since the last run left (a silent drop after an evented
    // change was masked), and the owner SET is compared, not only its size (a silent swap).
    const msKey = `admin/multisig/${c.address}`
    const lastEv = changes
      .filter((x) => x.key === msKey && (x.block ?? 0) > since && !x.tags.includes('bracketed'))
      .sort((a, b) => (a.block ?? 0) - (b.block ?? 0))
      .at(-1)
    const evAfter = typeof lastEv?.after === 'string' ? lastEv.after.match(/^(\d+)\/(\d+)$/) : null
    const baseline: Controller = evAfter
      ? { ...prev, threshold: Number(evAfter[1]), signers: Number(evAfter[2]) }
      : prev
    // owners the events since the last run added / removed (AddedOwner / RemovedOwner carry them)
    const evOwners = raw.admin.events.filter(
      (e) =>
        lc(e.emitter) === c.address &&
        e.block > since &&
        (e.event === 'AddedOwner' || e.event === 'RemovedOwner'),
    )
    let swappedIn = 0
    let ownersMoved = false
    if (prev.owners && c.owners) {
      const expect = new Set(prev.owners.map(lc))
      for (const e of [...evOwners].sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)) {
        const o = lc(String(e.args.owner ?? ''))
        if (e.event === 'AddedOwner') expect.add(o)
        else expect.delete(o)
      }
      const now = new Set(c.owners.map(lc))
      swappedIn = [...now].filter((o) => !expect.has(o)).length
      ownersMoved = swappedIn > 0 || [...expect].some((o) => !now.has(o))
    }
    const countsMoved =
      (baseline.threshold ?? null) !== (c.threshold ?? null) ||
      (baseline.signers ?? null) !== (c.signers ?? null)
    if (countsMoved || ownersMoved) {
      const v = classifyMultisigChange(baseline, c, swappedIn || undefined)
      if (ownersMoved)
        v.notes.push(
          `${swappedIn} owner(s) not in the last read (plus the owner events since) — changed without an event`,
        )
      if (ownersMoved && !countsMoved && !isRed(v)) tag(v, 'rotation')
      const from = lastEv?.block ?? since
      changes.push({
        id: `1:safe-head:${c.address}:threshold:${raw.head.block}`,
        subject: subject.key,
        dimension: 'admin',
        key: msKey,
        title: `Safe ${c.address.slice(0, 10)}…: ${baseline.threshold}-of-${baseline.signers} → ${c.threshold}-of-${c.signers}${ownersMoved ? ' (owners changed)' : ''} between runs (no event required)`,
        before: `${baseline.threshold}/${baseline.signers}`,
        after: `${c.threshold}/${c.signers}`,
        state: 'historical',
        stage: 'executed',
        severity: v.severity,
        floorBreach: false,
        red: isRed(v),
        ruleIds: v.ruleIds,
        tags: [...new Set(['bracketed' as const, ...v.tags])],
        unannounced: null,
        announcement,
        chainId: 1,
        block: raw.head.block,
        blockFrom: from,
        notes: v.notes.length ? v.notes : undefined,
      })
    }
    const fields = ['guard', 'moduleGuard', 'fallbackHandler'] as const
    for (const f of fields) {
      const field = (
        {
          guard: 'guard',
          moduleGuard: 'module_guard',
          fallbackHandler: 'fallback_handler',
        } as const
      )[f]
      // Review round 7: compared with what the EVENTS since the last run left, not skipped
      // whenever one fired — a ChangedGuard(G1) since the last run masked a silent G1 → G2 at
      // head (the threshold fix of round 6, for guards, module guards and fallback handlers).
      const fk = `admin/safe/${c.address}/${field}`
      const lastField = changes
        .filter((x) => x.key === fk && (x.block ?? 0) > since && !x.tags.includes('bracketed'))
        .sort((a, b) => (a.block ?? 0) - (b.block ?? 0))
        .at(-1)
      const zeroish = (x: unknown) =>
        x === undefined || x === null || /^0x0{40}$/i.test(String(x)) ? null : lc(String(x))
      const base = lastField ? zeroish(lastField.after) : zeroish(prev[f])
      if (base === zeroish(c[f])) continue
      const v = classifySafeModuleChange(field, base ?? undefined, c[f] ?? undefined)
      if (lastField)
        v.notes.push(
          `the events since the last run set it to ${base ?? 'none'}; at head it is ${c[f] ?? 'none'} — changed without an event`,
        )
      changes.push({
        id: `1:safe-head:${c.address}:${f}:${raw.head.block}`,
        subject: subject.key,
        dimension: 'admin',
        key: fk,
        title: `Safe ${c.address.slice(0, 10)}…: ${field.replace('_', ' ')} changed between runs (no event required)`,
        before: base ?? undefined,
        after: c[f],
        state: 'historical',
        stage: 'executed',
        severity: v.severity,
        floorBreach: false,
        red: isRed(v),
        ruleIds: v.ruleIds,
        tags: ['bracketed'],
        unannounced: null,
        announcement,
        chainId: 1,
        block: raw.head.block,
        blockFrom: since,
        notes: v.notes.length ? v.notes : undefined,
      })
    }
    // per module (review round 7): one evented EnabledModule since the last run no longer hides
    // a second module enabled without an event
    const evModules = new Set(
      changes
        .filter(
          (x) =>
            x.key === `admin/safe/${c.address}/module_enabled` &&
            (x.block ?? 0) > since &&
            !x.tags.includes('bracketed'),
        )
        .map((x) => lc(String(x.after ?? ''))),
    )
    // review round 8: a module list unread on either run is no baseline (the read gap says so)
    const modulesComparable = !c.modulesUnread && !prev.modulesUnread
    for (const m of (modulesComparable ? (c.modules ?? []) : []).filter(
      (x) => !(prev.modules ?? []).map(lc).includes(lc(x)) && !evModules.has(lc(x)),
    )) {
      const v = classifySafeModuleChange('module_enabled', undefined, m)
      changes.push({
        id: `1:safe-head:${c.address}:module:${m}:${raw.head.block}`,
        subject: subject.key,
        dimension: 'admin',
        key: `admin/safe/${c.address}/module_enabled`,
        title: `Safe ${c.address.slice(0, 10)}…: module ${m.slice(0, 10)}… enabled between runs`,
        after: m,
        state: 'historical',
        stage: 'executed',
        severity: v.severity,
        floorBreach: false,
        red: isRed(v),
        ruleIds: v.ruleIds,
        tags: ['bracketed'],
        unannounced: null,
        announcement,
        chainId: 1,
        block: raw.head.block,
        blockFrom: since,
      })
    }
  }

  // ---- oracle (existing oracle-registry governance events for this asset) ----------------------------------
  // OR-1 on the oracle collector's governance events: source moves, CAPO growth bounds,
  // heartbeat / deviation / window / quorum parameters (old → new from the event, or from the
  // previous event of the same emitter); upgrades and source swaps are logic changes (AD-9).
  const lastOracle = new Map<string, unknown>()
  const oracleEvents = [...(raw.oracle?.events ?? [])].sort(
    (x, y) => x.block - y.block || x.logIndex - y.logIndex,
  )
  const PARAM_KIND: [RegExp, string][] = [
    [/heartbeat/i, 'heartbeat'],
    [/deviation/i, 'deviation_threshold'],
    [/twap|window/i, 'twap_window'],
    [/^bar$|quorum/i, 'quorum'],
    [/growth|ratechange|maxyearly/i, 'cap'],
  ]
  for (const e of oracleEvents) {
    const em = lc(e.emitter)
    const v = neutral()
    const merge = (x: ReturnType<typeof neutral>) => {
      if (x.severity === 'downgrade') v.severity = 'downgrade'
      for (const r of x.ruleIds) if (!v.ruleIds.includes(r)) v.ruleIds.push(r)
      for (const t of x.tags) tag(v, t)
      v.notes.push(...x.notes)
    }
    const args = e.args as Record<string, unknown>
    let after: unknown = e.args
    let before: unknown
    if (e.event === 'Upgraded' || e.event === 'BeaconUpgraded') {
      const impl = lc(String(args.implementation ?? args.beacon ?? ''))
      tag(v, 'logic_change')
      verificationRule(v, impl, verified(impl))
    } else if (e.event === 'AssetSourceUpdated' || /SourceUpdated|SourceSet$/.test(e.event)) {
      const src = lc(String(args.source ?? args.newSource ?? ''))
      const k = `${em}|source|${lc(String(args.asset ?? ''))}`
      before = lastOracle.get(k)
      after = src
      lastOracle.set(k, src)
      merge(classifyOracleParam('market_source', 'source', before, src, ctl(src, e.block)))
      if (/^0x0{40}$/.test(src)) merge(classifyOracleParam('fallback', 'source', before, null))
      else if (
        (before === undefined || (typeof before === 'string' && before !== src)) &&
        !isRed(v)
      ) {
        // review round 6: a source set as the FIRST event of the window replaced one that predates
        // it (unknown): judged as a replacement — red unless its source is verified (fail closed)
        if (before === undefined)
          v.notes.push('previous source not in the scanned window: judged as a replacement')
        tag(v, 'logic_change')
        verificationRule(v, src, verified(src))
      }
    } else if (e.event === 'TollGranted') {
      v.notes.push('reader access granted (Chronicle toll) — not a mechanism change')
    } else {
      // parameter events: old*/new* pairs in the event, else the previous event's value
      for (const [name, val] of Object.entries(args)) {
        const m = name.match(/^(old|new|prev|previous)?(.+)$/i)
        const param = (m?.[2] ?? name).replace(/^./, (c) => c.toLowerCase())
        if (/^(old|prev|previous)/i.test(name)) continue
        const kind = PARAM_KIND.find(([re]) => re.test(param))?.[1]
        if (!kind) continue
        const oldKey = Object.keys(args).find((x) =>
          new RegExp(`^(old|prev|previous)${param}$`, 'i').test(x),
        )
        const k = `${em}|${param}`
        const prev = oldKey ? args[oldKey] : lastOracle.get(k)
        lastOracle.set(k, val)
        if (prev === undefined) {
          v.notes.push(`${param}: previous value not in the scanned window`)
          continue
        }
        merge(classifyOracleParam(kind, param, prev, val))
      }
    }
    changes.push({
      id: `1:${e.tx}:${e.logIndex}`,
      subject: subject.key,
      dimension: 'oracle',
      key: `oracle/${e.entryIds[0] ?? em}/${e.event}`,
      title: `${e.event} on ${em.slice(0, 10)}… (${e.entryIds.join(', ')})`,
      before,
      after,
      state: 'historical',
      stage: 'executed',
      severity: v.severity,
      floorBreach: false,
      red: isRed(v),
      ruleIds: v.ruleIds,
      tags: v.tags,
      unannounced: null,
      announcement,
      chainId: 1,
      block: e.block,
      ts: e.ts,
      tx: e.tx,
      notes: v.notes.length ? v.notes : undefined,
    })
  }
  if (raw.oracle?.window)
    warnings.push(
      `oracle governance events cover ${raw.oracle.window.days} days (blocks ${raw.oracle.window.startBlock}–${raw.oracle.window.endBlock})`,
    )

  // ---- pending / proposed ---------------------------------------------------------------------------------
  // Last NON-ZERO value of each address param over the transitions (a queued setter A → 0 → B).
  const paramLastNonZero: Record<string, string> = {}
  for (const t of [...raw.params.transitions].sort((x, y) => x.block - y.block))
    for (const v of [t.before, t.after])
      if (typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v))
        paramLastNonZero[t.key] = lc(v)
  const libDir = (lib: string): 'send' | 'receive' | null => {
    const L = opt.registry.libraries[1]
    if (!L) return null
    if (L.send.map(lc).includes(lc(lib))) return 'send'
    if (L.receive.map(lc).includes(lc(lib))) return 'receive'
    return null
  }
  // Role holders at head and everyone who ever held a role, replayed from the events.
  const roleNow = new Map<string, Set<string>>()
  const roleEver = new Map<string, Set<string>>()
  for (const r of [...raw.admin.events].sort(
    (x, y) => x.block - y.block || x.logIndex - y.logIndex,
  )) {
    if (r.event !== 'RoleGranted' && r.event !== 'RoleRevoked') continue
    const k = `${lc(r.emitter)}|${lc(String(r.args.role))}`
    const acct = lc(String(r.args.account))
    const now = roleNow.get(k) ?? new Set<string>()
    if (r.event === 'RoleGranted') {
      now.add(acct)
      roleEver.set(k, new Set([...(roleEver.get(k) ?? []), acct]))
    } else now.delete(acct)
    roleNow.set(k, now)
  }
  // Every executed grant per (contract, role) with the grantee's code at its block, and the
  // roles that administer others (owner ruling #4: the operational bot pattern).
  const roleGrants = new Map<string, GrantRecord[]>()
  const roleAdmins = new Map<string, Set<string>>()
  for (const r of [...raw.admin.events].sort(
    (x, y) => x.block - y.block || x.logIndex - y.logIndex,
  )) {
    if (r.event === 'RoleGranted') {
      const k = `${lc(r.emitter)}|${lc(String(r.args.role))}`
      const acct = lc(String(r.args.account))
      roleGrants.set(k, [
        ...(roleGrants.get(k) ?? []),
        { block: r.block, account: acct, noCode: ctl(acct, r.block)?.kind === 'eoa' },
      ])
    } else if (r.event === 'RoleAdminChanged') {
      const name = String(r.args.newAdminRoleName ?? r.args.newAdminRole)
      roleAdmins.set(lc(r.emitter), new Set([...(roleAdmins.get(lc(r.emitter)) ?? []), name]))
    }
  }
  const q: QueueCtx = {
    subject: subject.key,
    announcement,
    eval: headCtx,
    block: head,
    endpoint: opt.endpoint,
    routes: headRoutes,
    defaults: raw.lz.headDefaults,
    libDirection: libDir,
    ctl: ctlHead,
    ownerOf: (c) => raw.admin.owners[lc(c)] ?? null,
    delegateOf: (o) => raw.admin.delegates[lc(o)] ?? null,
    implHistory: raw.admin.implHistory,
    minDelayOf: (t) => raw.admin.minDelays[lc(t)] ?? null,
    roleName: opt.roleName,
    contracts: [
      ...new Set([
        ...subject.contracts.map((c) => lc(c.address)),
        ...subject.timelocks,
        // power-path hops (a ProxyAdmin that is not declared): calls on them are this card's
        ...raw.admin.powers.flatMap((p) => (p.via ?? []).map(lc)),
        // review round 8: the NTT managers read at head and their transceivers
        ...(raw.ntt ?? []).flatMap((n) => [
          lc(n.manager),
          ...(n.transceivers ?? []).map((x) => lc(x.address)),
        ]),
      ]),
    ],
    oapps: subject.lzOApps.map(lc),
    safes: [
      ...new Set([
        ...subject.safes.map(lc),
        ...powers
          .flatMap((p) => p.holders)
          .filter((h) => h.kind === 'safe')
          .map((h) => h.address),
        // legacy MultiSigWallets at the end of a power's deferral chain: their self-calls
        ...powers
          .flatMap((p) => p.holders)
          .map(leaf)
          .filter((h) => h.kind === 'legacy_multisig')
          .map((h) => h.address),
      ]),
    ],
    lz: rep.state,
    routeInputs: headInputs,
    headOverrides,
    lastVerifying: rep.lastVerifying,
    lastPeer: rep.lastPeer,
    ccipPools: raw.ccip.pools,
    tokens,
    subjectCcipPools: subject.ccipPools.map(lc),
    ccipTokenAdmin: (token) => {
      // the last CCIP token administrator the events set (AdministratorTransferred)
      const last = raw.admin.events
        .filter(
          (e) => e.event === 'AdministratorTransferred' && lc(String(e.args.token)) === lc(token),
        )
        .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
        .at(-1)
      return last ? lc(String(last.args.newAdmin)) : null
    },
    roleHolders: (c, r) => [...(roleNow.get(`${lc(c)}|${lc(r)}`) ?? [])],
    roleEverHolders: (c, r) => [...(roleEver.get(`${lc(c)}|${lc(r)}`) ?? [])],
    roleGrants: (c, r) => roleGrants.get(`${lc(c)}|${lc(r)}`) ?? [],
    roleAdmins: (c) => roleAdmins.get(lc(c)) ?? new Set(),
    params: subject.params,
    paramHead: raw.params.head,
    paramLastNonZero,
    whitelistReach,
    verified,
    declaredSelectors: (contract, selector) => {
      const sel = selector.toLowerCase()
      let named: string | null = null
      for (const sp of subject.powers)
        for (const sig of sp.bypassExclude ?? []) {
          if (selectorOf(sig) !== sel) continue
          // restrict-only where the power acts: its contract, or a contract of its holder chain
          if (lc(sp.contract) === lc(contract) || chainActs.get(sp)?.has(lc(contract)))
            return { signature: sig, restrictOnly: true }
          named ??= sig
        }
      return named ? { signature: named, restrictOnly: false } : null
    },
    ccipEverRemotePools: (pool, selector) => {
      const out: string[] = []
      for (const e of [...raw.admin.events].sort(
        (x, y) => x.block - y.block || x.logIndex - y.logIndex,
      )) {
        if (e.event !== 'RemotePoolSet' && e.event !== 'RemotePoolAdded') continue
        if (lc(e.emitter) !== lc(pool) || String(e.args.remoteChainSelector) !== selector) continue
        const a = lc(String(e.args.remotePoolAddress ?? ''))
        if (a && !/^0x0*$/.test(a) && !out.includes(a)) out.push(a)
      }
      return out
    },
    ccipLastRemotePools: (pool, selector) =>
      ccipRemotePoolsReplay(raw.admin.events, pool, selector).last,
    ccipLastLimiterOn: (pool, selector) => {
      const last = [...raw.admin.events]
        .filter(
          (e) =>
            (e.event === 'ChainAdded' || e.event === 'ChainConfigured') &&
            lc(e.emitter) === lc(pool) &&
            String(e.args.remoteChainSelector) === selector,
        )
        .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
        .at(-1)
      if (!last) return null
      const on = (c: unknown) => (c as { isEnabled?: boolean } | undefined)?.isEnabled !== false
      return on(last.args.inboundRateLimiterConfig) && on(last.args.outboundRateLimiterConfig)
    },
    ntt: raw.ntt,
    ccipRemotePools: (pool, selector) => {
      const c = raw.ccip.pools
        .find((x) => lc(x.pool) === lc(pool))
        ?.chains.find((x) => x.selector === selector)
      if (!c) return raw.ccip.pools.some((x) => lc(x.pool) === lc(pool)) ? [] : null
      return c.remotePools === undefined ? null : c.remotePools
    },
    aragonAppProxies: raw.admin.aragonApps,
    permissionManagerOf: (app, role) => {
      // the last manager the ACL events set for (app, role)
      const last = raw.admin.events
        .filter(
          (e) =>
            e.event === 'PermissionManagerChanged' &&
            lc(e.emitter) === lc(app) &&
            lc(String(e.args.role)) === lc(role),
        )
        .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
        .at(-1)
      return last ? lc(String(last.args.manager)) : null
    },
  }
  const queue = [
    ...timelockChanges(raw.queues.ops, q, raw.head.ts),
    ...safeProposalChanges(raw.queues.safe, q),
    ...multisigSubmissionChanges(raw.queues.multisig ?? [], q),
  ]

  markStillInEffect(changes)
  // review round 8 (on-chain #1): a grant judged on the grantee as it was when granted is
  // re-judged on the grantee as it is at head — both ways
  changes.push(
    ...rejudgeRoleHoldersAtHead(changes, raw.admin.events, {
      ctlAt: (a, b) => raw.admin.controllers[`${lc(a)}@${b}`] ?? null,
      ctlRanked: ctl,
      ctlHead,
      administers: (c, r) => roleAdmins.get(lc(c))?.has(r) ?? false,
      head,
      subject: subject.key,
      announcement,
    }),
  )

  // Reads that failed in a way that can HIDE a red flag: the card never says "no red flags"
  // over them (default 2026-10-06). Route sides that were not read are counted apart (UNREAD).
  const readGaps = [
    ...raw.admin.powers
      .filter((p) => p.error)
      .map((p) => `${p.label}: holders not resolved (${p.error})`),
    // review round 6: a holder that could not be classified is counted with no delay, but a red
    // flag about it (an EOA holder, AD-3) cannot be ruled out — a read gap, never silence
    ...[
      ...new Set(
        powers.flatMap((p) =>
          p.holders
            .filter((h) => h.version === 'not classified at head')
            .map((h) => `${p.label}: holder ${short(h.address)} could not be classified at head`),
        ),
      ),
    ],
    ...[
      ...new Set(
        powers.flatMap((p) =>
          p.holders
            .map(leaf)
            .filter((h) => h.bypass?.unread)
            .map((h) => `timelock ${short(h.address)}: ${h.bypass!.fn} whitelist not read`),
        ),
      ),
    ],
    ...raw.queues.safeStatus
      .filter((x) => x.status === 'unavailable')
      .map(
        (x) =>
          `Safe Tx Service queue of ${short(lc(x.safe))} not read${x.note ? ` (${x.note})` : ''}`,
      ),
    ...(raw.queues.multisigStatus ?? [])
      .filter((x) => x.status === 'unavailable')
      .map(
        (x) =>
          `MultiSigWallet ${short(lc(x.multisig))} submissions not read${x.note ? ` (${x.note})` : ''}`,
      ),
    ...(raw.queues.dgStatus ?? [])
      .filter((x) => x.status === 'unavailable')
      .map(
        (x) =>
          `Dual Governance proposals of ${short(lc(x.timelock))} not read${x.note ? ` (${x.note})` : ''}`,
      ),
    ...(raw.ntt ?? [])
      .filter((n) => n.threshold === null || n.transceivers === null)
      .map((n) => `NTT manager ${short(n.manager)}: threshold / transceivers not read`),
    // review round 8: an unread peer or owner can hide BR-2 / BR-6 / AD-3 — never "no red flags"
    ...(raw.ntt ?? []).flatMap((n) =>
      Object.entries(n.peers)
        .filter(([, p]) => p === null)
        .map(([ch]) => `NTT manager ${short(n.manager)}: peer for chain ${ch} not read`),
    ),
    ...(raw.ntt ?? [])
      .filter((n) => !n.owner)
      .map((n) => `NTT manager ${short(n.manager)}: owner not read`),
    ...(raw.ntt ?? [])
      .filter((n) => n.owner && !ctlHead(n.owner))
      .map(
        (n) =>
          `NTT manager ${short(n.manager)}: owner ${short(lc(n.owner!))} could not be classified at head`,
      ),
    ...(raw.canonical ?? [])
      .filter((b) => b.ossified !== true && !b.admin)
      .map(
        (b) =>
          `canonical bridge ${short(b.bridge)}: proxy admin not read (upgrade control unknown)`,
      ),
    ...(raw.canonical ?? [])
      .filter((b) => b.ossified !== true && b.admin && !ctlHead(b.admin))
      .map(
        (b) =>
          `canonical bridge ${short(b.bridge)}: proxy admin ${short(lc(b.admin!))} could not be classified at head`,
      ),
    // review round 8: a Safe whose module list could not be read (ranked as a plain contract)
    ...[
      ...new Set(
        powers.flatMap((p) =>
          p.holders
            // UQ-22: through the whole tree (a timelock's proposer Safe included)
            .flatMap(controllerTree)
            .filter((h) => h.modulesUnread)
            .map((h) => `Safe ${short(h.address)}: modules not read (ranked as a plain contract)`),
        ),
      ),
    ],
    // owner ruling 2026-10-08 (#12): a timelock whose proposer set was not read ranks as a
    // plain contract — never "no red flags" over it (an EOA proposer would be AD-3)
    ...[
      ...new Set(
        powers.flatMap((p) =>
          p.holders
            .flatMap(controllerTree)
            .filter(schedulersUnreadOf)
            .map(
              (h) =>
                `timelock ${short(h.address)}: proposers not read (ranked as a plain contract)`,
            ),
        ),
      ),
    ],
    // review round 9: an Aragon Voting app whose vote time was not read ranks as a plain
    // contract — a read gap, like an unread proposer set
    ...[
      ...new Set(
        powers.flatMap((p) =>
          p.holders
            .flatMap(controllerTree)
            .filter((h) => h.kind === 'aragon_voting' && h.voting?.voteTimeSec === null)
            .map(
              (h) =>
                `Aragon Voting ${short(h.address)}: vote time not read (ranked as a plain contract)`,
            ),
        ),
      ),
    ],
    // UQ-17 / UQ-24: a token vote whose holder concentration was not read, an unrestricted
    // bypass whose bypassers were not classified, a DSPause authority whose callers were not
    // enumerated — each ranks as a plain contract; never "no red flags" over them
    ...[...new Set(powers.flatMap((p) => p.holders.flatMap(controllerTree).flatMap(nodeReadGaps)))],
    // the remote side of a live NTT route: its floor and owner cannot be judged unread
    ...(raw.ntt ?? []).flatMap(nttRemoteGaps),
    ...dgGaps,
  ]

  const all = [...changes, ...queue]
  const state: SubjectState = {
    version: 1,
    subject: subject.key,
    label: subject.label,
    oracleAssetKey: subject.oracleAssetKey,
    chainId: 1,
    asOf: { block: raw.head.block, ts: raw.head.ts },
    scan: raw.scan,
    govChannels: subject.govChannels,
    announcement,
    proposedSources: [
      ...raw.queues.safeStatus.map((s) => ({
        kind: 'safe_tx_service' as const,
        status: s.status,
        note: `${s.safe}${s.note ? ': ' + s.note : ''} (only proposals submitted through the Safe API are visible)`,
      })),
      { kind: 'snapshot', status: 'not_ingested' },
      { kind: 'discourse', status: 'not_ingested' },
    ],
    powers,
    safeSnapshot: safeNow,
    remoteSnapshot:
      Object.keys(remoteNow).length + Object.keys(remoteCarried).length
        ? { ...remoteCarried, ...remoteNow }
        : undefined,
    remoteReadAt: Object.keys(remoteReadAt).length ? remoteReadAt : undefined,
    remoteLastPeer: Object.keys(remoteLastPeer).length ? remoteLastPeer : undefined,
    remoteLastVerifying: Object.keys(remoteLastVerifying).length ? remoteLastVerifying : undefined,
    oracleWindow: raw.oracle?.window,
    items,
    counts: {
      red: all.filter((c) => c.red).length,
      // stale ops (past ETA, not executable) stay listed but are not counted as amber
      pending: queue.filter((c) => c.state === 'pending' && c.stage !== 'stale').length,
      proposed: queue.filter((c) => c.state === 'proposed').length,
      historical: changes.length,
      floorBreaches: floorBreachRoutes(items).length,
    },
    readGaps: readGaps.length ? readGaps : undefined,
    warnings,
  }
  return { state, changes: changes.sort((a, b) => (b.block ?? 0) - (a.block ?? 0)), queue }
}

/**
 * ROLE HOLDERS RE-JUDGED AT HEAD (review round 8, on-chain #1). A role grant is judged on the
 * grantee as it was at the grant block, and the account can change afterwards without an event
 * this card scans (an MCMS whose owner moved from a key to a timelock; a Safe whose threshold was
 * raised — or lowered). For every CURRENT holder (RoleGranted / RoleRevoked replayed):
 *   - a red grant (AD-4 only) still in effect whose grantee, as classified at head, ranks
 *     strictly stronger than at the grant AND would not have made the grant red (against the
 *     holders it was ranked against) is no longer in effect — noted with both controllers;
 *   - a holder of a privileged role whose grant was NOT red, EOA-controlled at head and strictly
 *     weaker than at the grant, gets a red AD-4 row (bracketed: grant block → head), in effect —
 *     unless an evented weakening of the same account is already a red in effect on the card.
 * A controller not read (at the grant block exactly, or at head) changes nothing: a red is never
 * resolved, and nothing is called calm, on a read that did not happen. Returns the new rows.
 */
export function rejudgeRoleHoldersAtHead(
  changes: ConfigChange[],
  events: readonly AdminEventRow[],
  o: {
    /** Exact classification at a block (no fallback): the grantee as it was granted. */
    ctlAt: (address: string, block: number) => Controller | null
    /** The lookup the replay ranked the other holders with (head fallback). */
    ctlRanked: (address: string, block: number) => Controller | null
    ctlHead: (address: string) => Controller | null
    administers: (contract: string, role: string) => boolean
    head: number
    subject: string
    announcement: AnnouncementStatus
  },
): ConfigChange[] {
  const byId = new Map(changes.map((c) => [c.id, c]))
  const holders = new Map<string, Set<string>>()
  // grants of the current holding period per `${contract}|${role}|${account}`, with the holders
  // just before each (what the replay ranked it against)
  const held = new Map<string, { e: AdminEventRow; before: string[] }[]>()
  for (const e of [...events].sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)) {
    if (e.event !== 'RoleGranted' && e.event !== 'RoleRevoked') continue
    const k = `${lc(e.emitter)}|${lc(String(e.args.role))}`
    const acct = lc(String(e.args.account))
    const set = holders.get(k) ?? new Set<string>()
    if (e.event === 'RoleGranted') {
      held.set(`${k}|${acct}`, [
        ...(held.get(`${k}|${acct}`) ?? []),
        { e, before: [...set].filter((h) => h !== acct) },
      ])
      set.add(acct)
    } else {
      set.delete(acct)
      held.delete(`${k}|${acct}`)
    }
    holders.set(k, set)
  }
  const shortA = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
  const added: ConfigChange[] = []
  for (const list of held.values()) {
    const { e: lastE } = list.at(-1)!
    const em = lc(lastE.emitter)
    const acct = lc(String(lastE.args.account))
    const now = o.ctlHead(acct)
    if (!now) continue
    const rowOf = (e: AdminEventRow) => byId.get(`${e.chainId}:${e.tx}:${e.logIndex}`)
    for (const { e, before } of list) {
      const row = rowOf(e)
      if (!row || !row.red || !row.stillInEffect) continue
      if (!row.ruleIds.length || row.ruleIds.some((r) => r !== 'AD-4')) continue
      const then = o.ctlAt(acct, e.block)
      if (!then || compareRank(controllerRank(now), controllerRank(then)) <= 0) continue
      // UQ-21 (owner: fail closed everywhere): a head rank that rests on a READ GAP (an unread
      // proposer set ranks as a plain contract, above the EOA that proposed at the grant) is no
      // read of the grantee — it never ends a red. The red stays in effect, and says why.
      if (rankHasReadGap(now)) {
        const note = `STILL IN EFFECT at head (block ${o.head}): the grantee's head read has a read gap (${describeController(now)}) — a failed read never ends a red`
        if (!(row.notes ?? []).includes(note)) row.notes = [...(row.notes ?? []), note]
        continue
      }
      const name = String(e.args.roleName ?? lc(String(e.args.role)))
      // Review round 10 (R-4): the holders the grant is ranked against must be READ too — one not
      // classified (dropped from the comparison) or resting on a read gap (ranked as a plain
      // contract) would make the grant look calm by comparison. The red stays in effect.
      const cmp = before.map((h) => ({ h, c: o.ctlRanked(h, e.block) }))
      const unreadCmp = cmp.filter((x) => !x.c || rankHasReadGap(x.c))
      if (unreadCmp.length) {
        const note = `STILL IN EFFECT at head (block ${o.head}): ${unreadCmp.length} holder(s) it was ranked against not read at block ${e.block} (${unreadCmp.map((x) => (x.c ? describeController(x.c) : shortA(x.h))).join(' | ')}) — a failed read never ends a red`
        if (!(row.notes ?? []).includes(note)) row.notes = [...(row.notes ?? []), note]
        continue
      }
      const ranked = cmp.map((x) => x.c as Controller)
      const v = classifyRoleGrant(name, now, ranked, true, {
        administersRoles: o.administers(em, name),
      })
      if (isRed(v)) continue
      row.stillInEffect = false
      row.notes = [
        ...(row.notes ?? []),
        `NO LONGER IN EFFECT at head (block ${o.head}): the grantee is now ${describeController(now)} (it was ${describeController(then)} when granted) — the grant would not be red today`,
      ]
    }
    // the reverse: a calm grant whose holder weakened afterwards
    const row = rowOf(lastE)
    if (!row || row.red) continue
    const name = String(lastE.args.roleName ?? lc(String(lastE.args.role)))
    if (!isPrivilegedRole(name) && !o.administers(em, name)) continue
    const then = o.ctlAt(acct, lastE.block)
    if (!then || !isEoaControlled(now)) continue
    if (compareRank(controllerRank(now), controllerRank(then)) >= 0) continue
    if (
      changes.some(
        (x) =>
          x.red &&
          x.stillInEffect &&
          (x.key === `admin/multisig/${acct}` || x.key === `admin/owner/${acct}`),
      )
    )
      continue
    added.push({
      id: `1:role-head:${em}:${lc(String(lastE.args.role))}:${acct}:${o.head}`,
      subject: o.subject,
      dimension: row.dimension,
      key: row.key,
      title: `${name} holder ${shortA(acct)} on ${shortA(em)} weakened since its grant: ${describeController(then)} → ${describeController(now)}`,
      before: acct,
      after: acct,
      state: 'historical',
      stage: 'executed',
      severity: 'downgrade',
      floorBreach: false,
      red: true,
      ruleIds: ['AD-4'],
      tags: ['bracketed'],
      unannounced: null,
      announcement: o.announcement,
      chainId: 1,
      block: o.head,
      blockFrom: lastE.block,
      stillInEffect: true,
      notes: [
        `${name} is held by ${describeController(now)} at head; it was ${describeController(then)} when granted at block ${lastE.block} — weakened since, with no event on this card`,
      ],
    })
  }
  return added
}

/**
 * CCIP remote pools of a token pool's chain, replayed from RemotePoolSet / RemotePoolAdded /
 * RemotePoolRemoved / ChainRemoved (review round 8): the pools it accepts after the last event
 * (`now`) and the ones it accepted the last time it served any (`last`; [] = never served). A
 * queued re-add of a pool outside `last` — an older pool included — is a re-point (CC-1).
 */
export function ccipRemotePoolsReplay(
  events: readonly {
    event: string
    emitter: string
    block: number
    logIndex: number
    args: Record<string, unknown>
  }[],
  pool: string,
  selector: string,
): { now: string[]; last: string[] } {
  let cur: string[] = []
  let last: string[] = []
  const zero = (a: string) => /^0x0*$/i.test(a)
  for (const e of [...events].sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)) {
    if (lc(e.emitter) !== lc(pool) || String(e.args.remoteChainSelector) !== selector) continue
    const a = lc(String(e.args.remotePoolAddress ?? ''))
    if (e.event === 'RemotePoolSet') cur = a && !zero(a) ? [a] : []
    else if (e.event === 'RemotePoolAdded') cur = cur.includes(a) ? cur : [...cur, a]
    else if (e.event === 'RemotePoolRemoved') cur = cur.filter((x) => x !== a)
    else if (e.event === 'ChainRemoved') cur = []
    else continue
    if (cur.length) last = [...cur]
  }
  return { now: cur, last }
}

/**
 * STILL IN EFFECT (review fixes 2026-10-06): a red historical change stays in effect until a
 * later change of the same key
 *   - is an upgrade (restores), or closes the route / removes the thing (minter removed), or
 *   - MOVES THE VALUE AWAY from what the red set: a role revoked from the account a red grant
 *     added; an owner / implementation / provider replaced — the replaced value is the change's
 *     `before`, or (slot keys, whose event carries only the new value) the last value an earlier
 *     change on the key set.
 * A same-rank rotation (tagged `rotation`: EOA → EOA, a Safe owner swap) carries the downgrade
 * forward instead of ending it, and a change that does not move the value (before = after)
 * ends nothing. Role keys are SETS of holders: a grant to another account never ends a red one;
 * a minter key ends only when the minter is removed (an allowance change is not a removal).
 */
export function markStillInEffect(changes: ConfigChange[]): void {
  const byKey = new Map<string, ConfigChange[]>()
  const ordered = changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.block ?? 0) - (b.c.block ?? 0) || a.i - b.i)
    .map((x) => x.c)
  for (const c of ordered) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c])
  const str = (x: unknown): string | null => (typeof x === 'string' ? lc(x) : null)
  for (const [key, list] of byKey) {
    // Oracle committee member sets (ruling #13): `before` = the members a change removed,
    // `after` = the ones it added. A red change stays in effect while any member it added is
    // still in, or any member it removed is still out.
    if (key.startsWith('oracle/committee/')) {
      const arr = (x: unknown) => (Array.isArray(x) ? x.map((m) => lc(String(m))) : [])
      let open: { c: ConfigChange; inn: Set<string>; out: Set<string> }[] = []
      for (const c of list) {
        const removed = arr(c.before)
        const added = arr(c.after)
        for (const o of open) {
          for (const m of removed) o.inn.delete(m)
          for (const m of added) o.out.delete(m)
        }
        open = open.filter((o) => o.inn.size > 0 || o.out.size > 0)
        if (c.red) open.push({ c, inn: new Set(added), out: new Set(removed) })
      }
      for (const o of open) o.c.stillInEffect = true
      continue
    }
    // role keys hold a SET of accounts; a minter key's value is its allowance, while its red is
    // about the minter existing (only its removal ends it)
    const isSet = key.startsWith('admin/role/') || key.startsWith('mint/minter/')
    let open: ConfigChange[] = []
    let last: string | null = null
    for (const c of list) {
      const closed = !!c.route && (c.after as { live?: boolean } | undefined)?.live === false
      if (c.severity === 'upgrade' || (closed && !c.red) || c.tags.includes('route_removed'))
        open = []
      const before: string | null = str(c.before) ?? (isSet ? null : last)
      const after: string | null = str(c.after)
      // a rotation, and (review round 10, R-3) a move to a holder whose rank rests on a read gap,
      // carry an open red forward: a failed read never ends a red
      const moved =
        before !== null &&
        before !== after &&
        !c.tags.includes('rotation') &&
        !c.tags.includes('read_gap')
      if (moved) open = open.filter((o) => str(o.after) !== before)
      if (!isSet && after !== null) last = after
      if (c.red) open.push(c)
    }
    for (const c of open) c.stillInEffect = true
  }
}

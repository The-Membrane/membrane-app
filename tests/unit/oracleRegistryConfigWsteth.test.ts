// wstETH (Lido) as the 8th config-card subject: the new parsers and rules it needed.
//   - Aragon: ACL SetPermission / ChangePermissionManager and Kernel SetApp rewritten onto the
//     apps (aragonRows), the acl_manager path step, ACL-checked role holders, the Aragon Voting
//     and Agent classifications, EVMScript forwarding and ACL / Kernel calls in a queued proposal
//   - Lido Dual Governance: the EmergencyProtectedTimelock classification (delay = proposer vote +
//     after-submit), its proposals as pending ops, its config events (AD-2 / AD-3), AD-5 with
//     ProposalExecuted
//   - Wormhole NTT: threshold / transceivers / peers (BR-1 / BR-2 / BR-6 / BR-7 / BR-8) in replay
//     and at head; canonical rollup bridges at head
//   - mint/redeem getters that return a list (count)
// No network: fake clients answer by (address, function).

import { describe, expect, it } from 'vitest'
import { encodeFunctionData, keccak256, parseAbi, toFunctionSelector, toHex } from 'viem'

import {
  buildSubject,
  markStillInEffect,
  type NttHead,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import {
  aragonCalls,
  decodeEvmScript,
  timelockChanges,
  unwrapCalls,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  classifyNttThreshold,
  classifyNttTransceiverAdded,
  classifyPeerChange,
  compareRank,
  controllerRank,
  describeController,
  isPrivilegedRole,
  nttEffective,
  PAUSE_ROLES,
  ADMIN_LEVEL_ROLES,
} from '@/lib/oracleRegistry/config/rules'
import { getConfigSubjects, parseSubjects } from '@/lib/oracleRegistry/config/subjects'
import type { ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry, EvalCtx } from '@/lib/oracleRegistry/config/uln'
import {
  ARAGON_NS,
  TOPIC,
  aragonRows,
  decodeLog,
  roleHash,
  roleName,
} from '@/scripts/oracle-registry/config/lib/abi.mjs'
import {
  aragonExecCandidatesFromRows,
  classify as classifyJs,
  dgProposalOp,
  isDgTimelockCode,
  readCanonicalBridge,
  readDgProposals as readDgProposalsJs,
  readNtt as readNttJs,
  resolvePath as resolvePathJs,
  roleHoldersFromEvents,
  setAragonExecCandidates,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { readParams } from '@/scripts/oracle-registry/config/lib/params.mjs'

// ---- fixtures ------------------------------------------------------------------------------------
// the collector is plain JS: its inferred return / option types are too narrow for fakes
const classify = classifyJs as unknown as (c: unknown, a: string, b?: number) => Promise<Controller>
const resolvePath = resolvePathJs as unknown as (
  c: unknown,
  o: Record<string, unknown>,
) => Promise<string[]>
const readDgProposals = readDgProposalsJs as unknown as (
  c: unknown,
  ept: string,
  o: { now: number; max?: number },
) => Promise<{ status: string; ops: TimelockOp[] }>
const readNtt = readNttJs as unknown as (
  c: unknown,
  m: string,
  chains?: number[],
) => Promise<NttHead>
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const KERNEL = A('1')
const ACL = A('2')
const AGENT = A('3')
const VOTING = A('4')
const EXEC = A('5')
const EPT = A('6')
const DG = A('7')
const STETH = A('8')
const IMPL_VOTING = A('9')
const IMPL_AGENT = A('a')
const NTT = A('b')
const WH = A('c')
const AX = A('d')
const EOA = A('e')
const TOKEN = A('f')
const SAFE = '0x' + '12'.repeat(20)
const ZERO = '0x' + '0'.repeat(40)
const sel = (sig: string) => toFunctionSelector(`function ${sig}`).slice(2)
const codeWith = (sigs: string[]) =>
  '0x6080' + sigs.map((x) => '63' + sel(x) + '14').join('') + '00'
const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })

/** A fake client: code per address, view answers per `${address}|${fn}` (a function = per args). */
function fake(o: {
  code?: Record<string, string>
  reads?: Record<string, unknown>
  storage?: Record<string, string>
  call?: (to: string, data: string) => void
}) {
  const lc = (x: string) => x.toLowerCase()
  return {
    getCode: async ({ address }: { address: string }) => o.code?.[lc(address)] ?? '0x',
    getBlockNumber: async () => 1000n,
    multicall: async ({
      contracts,
    }: {
      contracts: { address: string; functionName: string; args?: unknown[] }[]
    }) =>
      contracts.map((c) => {
        const k = `${lc(c.address)}|${c.functionName}`
        const v = o.reads?.[k]
        if (v === undefined) return { status: 'failure' }
        return { status: 'success', result: typeof v === 'function' ? v(c.args ?? []) : v }
      }),
    getStorageAt: async ({ address, slot }: { address: string; slot: string }) =>
      o.storage?.[`${lc(address)}|${slot}`] ?? '0x' + '0'.repeat(64),
    readContract: async ({
      address,
      functionName,
      args,
    }: {
      address: string
      functionName: string
      args?: unknown[]
    }) => {
      const v = o.reads?.[`${lc(address)}|${functionName}`]
      if (v === undefined) throw revert()
      const r = typeof v === 'function' ? v(args ?? []) : v
      if (r instanceof Error) throw r
      return r
    },
    call: async ({ to, data }: { to: string; data: string }) => {
      o.call?.(lc(to), data)
      return { data: '0x' }
    },
    request: async () => [],
  }
}

const dvns = {}
const registry: DvnRegistry = {
  byChain: { 1: dvns },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
const evalCtx: EvalCtx = { registry, code: () => true, useDeprecated: false }
const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
  chainId: 1,
  block: 100,
  logIndex: 0,
  tx: '0xt',
  emitter: STETH,
  event: 'RoleGranted',
  args: {},
  ...o,
})
const actx = (m: Record<string, Controller>, o: Record<string, unknown> = {}) => ({
  subject: 'wsteth',
  ctl: (a: string, b: number) => m[`${a}@${b}`] ?? m[`${a}@head`] ?? null,
  ctlExact: (a: string, b: number) => m[`${a}@${b}`] ?? null,
  upgradeTimelocks: {},
  deployBlocks: { [STETH]: 1, [NTT]: 1, [EPT]: 1, [DG]: 1, [WH]: 1 },
  tokens: [],
  announcement: 'not_checked' as const,
  ...o,
})
const dgCtl = (delay = 691200, o: Partial<Controller['dg']> = {}): Controller => ({
  kind: 'aragon_dg',
  address: EPT,
  delaySec: delay,
  dg: {
    proposers: [VOTING],
    proposerVoteSec: 432000,
    afterSubmitDelaySec: 259200,
    afterScheduleDelaySec: 86400,
    governance: DG,
    adminExecutor: EXEC,
    emergencyGovernance: null,
    activationCommittee: null,
    executionCommittee: null,
    emergencyModeActive: false,
    emergencyProtectionEndsAfter: null,
    ...o,
  },
})
const agentCtl = (owner: Controller | null): Controller => ({
  kind: 'contract',
  address: AGENT,
  version: 'Aragon Agent',
  ...(owner ? { ownedBy: { kind: 'contract', address: EXEC, ownedBy: owner } } : {}),
})
const voting = (sec = 432000): Controller => ({
  kind: 'aragon_voting',
  address: VOTING,
  delaySec: sec,
  voting: { voteTimeSec: sec, objectionPhaseSec: 172800 },
})

// =====================================================================================================
describe('Aragon rows: ACL and Kernel events rewritten onto the apps they act on', () => {
  const RUN = roleHash('RUN_SCRIPT_ROLE')
  const LIDO_APP_ID = '0x3ca7c3e38968823ccb4c78ea688df41356f182ae1d159e4ee608d30d68cef320'
  it('decodes the ACL / Kernel / NTT / Dual Governance events', () => {
    const enc = (sig: string, args: Record<string, unknown>, data: Hx = '0x') => {
      const ev = (parseAbi as (s: readonly string[]) => readonly unknown[])([sig])[0]
      return { topics: [TOPIC[(ev as { name: string }).name]], ev, args, data }
    }
    expect(TOPIC.SetPermission).toBe(
      keccak256(toHex('SetPermission(address,address,bytes32,bool)')),
    )
    expect(TOPIC.ThresholdChanged).toBe(keccak256(toHex('ThresholdChanged(uint8,uint8)')))
    expect(TOPIC.PeerUpdated).toBe(
      keccak256(toHex('PeerUpdated(uint16,bytes32,uint8,bytes32,uint8)')),
    )
    expect(TOPIC.AfterSubmitDelaySet).toBe(keccak256(toHex('AfterSubmitDelaySet(uint32)')))
    expect(enc).toBeTypeOf('function')
    // SetPermission: entity, app, role indexed; allowed in data
    const d = decodeLog({
      topics: [
        TOPIC.SetPermission,
        '0x' + '0'.repeat(24) + EXEC.slice(2),
        '0x' + '0'.repeat(24) + AGENT.slice(2),
        RUN,
      ],
      data: '0x' + '0'.repeat(63) + '1',
    })
    expect(d).toEqual({
      event: 'SetPermission',
      args: { entity: EXEC, app: AGENT, role: RUN, allowed: true },
    })
    // ProposalExecuted: both shapes (indexed id and not) share the topic
    const pe = decodeLog({
      topics: [TOPIC.ProposalExecuted, '0x' + '0'.repeat(63) + '7'],
      data: '0x',
    })
    expect(pe).toEqual({ event: 'ProposalExecuted', args: { id: '7' } })
    // a parameterless event decodes to empty args (the collector reads r.args.* on every row)
    expect(decodeLog({ topics: [TOPIC.EmergencyModeActivated], data: '0x' })).toEqual({
      event: 'EmergencyModeActivated',
      args: {},
    })
  })
  it('SetPermission → RoleGranted / RoleRevoked on the app; ChangePermissionManager → PermissionManagerChanged', () => {
    const base = { chainId: 1, block: 10, logIndex: 0, tx: '0x1', emitter: ACL }
    const out = aragonRows([
      {
        ...base,
        event: 'SetPermission',
        args: { entity: EXEC, app: AGENT, role: RUN, allowed: true },
      },
      {
        ...base,
        logIndex: 1,
        event: 'SetPermission',
        args: { entity: VOTING, app: AGENT, role: RUN, allowed: false },
      },
      {
        ...base,
        logIndex: 2,
        event: 'ChangePermissionManager',
        args: { app: AGENT, role: RUN, manager: AGENT },
      },
      { ...base, logIndex: 3, emitter: SAFE, event: 'AddedOwner', args: { owner: EOA } },
    ])
    expect(out.map((r: AdminEventRow) => [r.emitter, r.event])).toEqual([
      [AGENT, 'RoleGranted'],
      [AGENT, 'RoleRevoked'],
      [AGENT, 'PermissionManagerChanged'],
      [SAFE, 'AddedOwner'],
    ])
    expect(out[0].args).toMatchObject({ role: RUN, account: EXEC, via: 'ACL', acl: ACL })
    expect(out[2].args).toMatchObject({ role: RUN, manager: AGENT })
    // the replayed holders feed the role map and the Agent's executor candidates
    const rm = roleHoldersFromEvents(out)
    expect([...rm.get(`${AGENT}|${RUN}`)!]).toEqual([EXEC])
    expect([...aragonExecCandidatesFromRows(out).get(AGENT)!]).toEqual([EXEC])
    expect(roleName(RUN)).toBe('RUN_SCRIPT_ROLE')
  })
  it('SetApp(base, appId) → Upgraded on every declared proxy with that appId; core → the Kernel; app → AppAddressSet; other apps dropped', () => {
    const base = { chainId: 1, block: 10, logIndex: 0, tx: '0x1', emitter: KERNEL }
    const out = aragonRows(
      [
        {
          ...base,
          event: 'SetApp',
          args: { namespace: ARAGON_NS.base, appId: LIDO_APP_ID, app: A('9') },
        },
        {
          ...base,
          logIndex: 1,
          event: 'SetApp',
          args: { namespace: ARAGON_NS.base, appId: '0x' + 'ee'.repeat(32), app: A('9') },
        },
        {
          ...base,
          logIndex: 2,
          event: 'SetApp',
          args: { namespace: ARAGON_NS.core, appId: '0x' + 'cc'.repeat(32), app: A('a') },
        },
        {
          ...base,
          logIndex: 3,
          event: 'SetApp',
          args: { namespace: ARAGON_NS.app, appId: '0x' + 'dd'.repeat(32), app: A('b') },
        },
      ],
      { [LIDO_APP_ID]: [STETH] },
    )
    expect(
      out.map((r: AdminEventRow) => [r.emitter, r.event, r.args.implementation ?? r.args.app]),
    ).toEqual([
      [STETH, 'Upgraded', A('9')],
      [KERNEL, 'Upgraded', A('a')],
      [KERNEL, 'AppAddressSet', A('b')],
    ])
    expect(ARAGON_NS.base).toBe(
      '0xf1f3eb40f5bc1ad1344716ced8b8a0431d840b5783aea1fd01786bc26f35ac0f',
    )
  })
})

describe('Aragon power paths and classification (fake client)', () => {
  const APP_MGR = roleHash('APP_MANAGER_ROLE')
  const RUN = roleHash('RUN_SCRIPT_ROLE')
  const EXE = roleHash('EXECUTE_ROLE')
  const VOTING_CODE = codeWith(['voteTime()', 'executeVote(uint256)', 'getVote(uint256)'])
  const AGENT_CODE = codeWith(['forward(bytes)', 'execute(address,uint256,bytes)'])
  const PROXY_CODE = codeWith(['implementation()', 'kernel()', 'appId()'])
  const DG_CODE = codeWith([
    'getAfterSubmitDelay()',
    'getAfterScheduleDelay()',
    'getGovernance()',
    'getProposal(uint256)',
    'execute(uint256)',
  ])
  const world = (perm: Record<string, boolean> = {}) =>
    fake({
      code: {
        [VOTING]: PROXY_CODE,
        [AGENT]: PROXY_CODE,
        [IMPL_VOTING]: VOTING_CODE,
        [IMPL_AGENT]: AGENT_CODE,
        [EXEC]: '0x6080aa',
        [EPT]: DG_CODE,
        [KERNEL]: '0x6080bb',
        [ACL]: '0x6080cc',
        [STETH]: '0x6080dd',
      },
      reads: {
        [`${STETH}|kernel`]: KERNEL,
        [`${AGENT}|kernel`]: KERNEL,
        [`${KERNEL}|acl`]: ACL,
        [`${ACL}|getPermissionManager`]: (args: string[]) =>
          args[0].toLowerCase() === KERNEL && args[1] === APP_MGR ? AGENT : ZERO,
        [`${ACL}|hasPermission`]: (args: string[]) =>
          perm[`${args[0].toLowerCase()}|${args[1].toLowerCase()}|${args[2]}`] ?? false,
        [`${VOTING}|implementation`]: IMPL_VOTING,
        [`${VOTING}|voteTime`]: 432000n,
        [`${VOTING}|objectionPhaseTime`]: 172800n,
        [`${AGENT}|implementation`]: IMPL_AGENT,
        [`${EXEC}|owner`]: EPT,
        [`${EPT}|getAfterSubmitDelay`]: 259200,
        [`${EPT}|getAfterScheduleDelay`]: 86400,
        [`${EPT}|getGovernance`]: DG,
        [`${EPT}|getAdminExecutor`]: EXEC,
        [`${EPT}|isEmergencyModeActive`]: false,
        [`${EPT}|getEmergencyGovernance`]: ZERO,
        [`${EPT}|getEmergencyActivationCommittee`]: ZERO,
        [`${EPT}|getEmergencyExecutionCommittee`]: ZERO,
        [`${EPT}|getEmergencyProtectionDetails`]: {
          emergencyModeDuration: 0,
          emergencyModeEndsAfter: 0,
          emergencyProtectionEndsAfter: 0,
        },
        [`${DG}|getProposers`]: [{ account: VOTING, executor: EXEC }],
      },
    })
  it('acl_manager: the permission MANAGER of (Kernel, APP_MANAGER_ROLE) holds the stETH upgrade power', async () => {
    const hs = await resolvePath(world(), {
      endpoint: ZERO,
      contract: STETH,
      path: ['call:kernel()', 'acl_manager:APP_MANAGER_ROLE'],
      roleMap: new Map(),
    })
    expect(hs).toEqual([AGENT])
  })
  it('role: on an Aragon app is checked with its ACL (hasRole reverts); a revoked candidate drops', async () => {
    const roleMap = new Map([[`${AGENT}|${RUN}`, new Set([EXEC, VOTING])]])
    const hs = await resolvePath(world({ [`${EXEC}|${AGENT}|${RUN}`]: true }), {
      endpoint: ZERO,
      contract: AGENT,
      path: ['role:RUN_SCRIPT_ROLE'],
      roleMap,
    })
    expect(hs).toEqual([EXEC])
  })
  it('an Aragon Voting app is a vote of voteTime; a Dual Governance timelock adds the proposer vote to the after-submit delay', async () => {
    const v = await classify(world(), VOTING)
    expect(v).toMatchObject({ kind: 'aragon_voting', delaySec: 432000 })
    const t = await classify(world(), EPT)
    expect(t).toMatchObject({ kind: 'aragon_dg', delaySec: 432000 + 259200 })
    expect(t.dg).toMatchObject({
      proposers: [VOTING],
      proposerVoteSec: 432000,
      afterScheduleDelaySec: 86400,
    })
    expect(isDgTimelockCode(codeWith(['getAfterSubmitDelay()']))).toBe(false)
  })
  it('a proposer that is not an Aragon Voting adds nothing (fail closed: 3 d, not 8 d)', async () => {
    const c = world()
    const orig = c.readContract
    c.readContract = async (q: { address: string; functionName: string; args?: unknown[] }) =>
      q.address.toLowerCase() === DG && q.functionName === 'getProposers'
        ? [{ account: EOA, executor: EXEC }]
        : orig(q)
    const t = await classify(c, EPT)
    expect(t.delaySec).toBe(259200)
  })
  it('an Aragon Agent ranks through its executor at the block (candidates from the ACL events)', async () => {
    setAragonExecCandidates(new Map([[AGENT, [EXEC, VOTING]]]))
    // DG era: the Admin Executor holds RUN_SCRIPT_ROLE
    const dgEra = await classify(world({ [`${EXEC}|${AGENT}|${RUN}`]: true }), AGENT)
    expect(dgEra.version).toBe('Aragon Agent')
    expect(dgEra.ownedBy).toMatchObject({
      kind: 'contract',
      address: EXEC,
      ownedBy: { kind: 'aragon_dg' },
    })
    // Voting era: the Voting holds EXECUTE_ROLE
    const votingEra = await classify(world({ [`${VOTING}|${AGENT}|${EXE}`]: true }), AGENT)
    expect(votingEra.ownedBy).toMatchObject({ kind: 'aragon_voting' })
    // two executors (the DG launch window: both could make the Agent act): it ranks as the
    // WEAKEST of them — the Voting — and lists both
    const two = await classify(
      world({ [`${VOTING}|${AGENT}|${EXE}`]: true, [`${EXEC}|${AGENT}|${RUN}`]: true }),
      AGENT,
    )
    expect(two.ownedBy).toBeUndefined()
    expect(two.executors?.map((x: Controller) => x.kind).sort()).toEqual([
      'aragon_voting',
      'contract',
    ])
    expect(compareRank(controllerRank(two), controllerRank(voting()))).toBe(0)
    expect(describeController(two)).toMatch(/Aragon Voting 5d vote .*ranked as the weakest/)
    // no executor found: a plain contract, said so
    const none = await classify(world(), AGENT)
    expect(none.version).toMatch(/no executor found/)
    expect(controllerRank(none)).toEqual([2])
    setAragonExecCandidates(new Map())
    // ranks: the DG-era Agent outranks the Voting-era one (8 d > 5 d): the DG launch is no downgrade
    expect(compareRank(controllerRank(dgEra), controllerRank(votingEra))).toBe(1)
    expect(describeController(dgEra)).toMatch(
      /^Aragon Agent 0x3333…3333 → contract .* → Dual Governance timelock 8d/,
    )
  }, 30_000)
})

describe('Lido roles: recognised, admin-level, pause', () => {
  it('Aragon execution / ACL / Kernel roles and Lido limit roles are admin-level; disablers pause; unknown roles stay privileged', () => {
    for (const r of [
      'APP_MANAGER_ROLE',
      'RUN_SCRIPT_ROLE',
      'EXECUTE_ROLE',
      'CREATE_PERMISSIONS_ROLE',
      'STAKING_CONTROL_ROLE',
      'MANAGE_MEMBERS_AND_QUORUM_ROLE',
      'MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE',
    ])
      expect(ADMIN_LEVEL_ROLES.has(r)).toBe(true)
    for (const r of [
      'PAUSE_ROLE',
      'STAKING_PAUSE_ROLE',
      'DEPOSITS_DISABLER_ROLE',
      'WITHDRAWALS_DISABLER_ROLE',
    ])
      expect(PAUSE_ROLES.has(r)).toBe(true)
    expect(isPrivilegedRole('RESUME_ROLE')).toBe(false)
    expect(isPrivilegedRole('DEPOSITS_ENABLER_ROLE')).toBe(false)
    // named for display only: still privileged (ruling #8)
    expect(roleName(roleHash('BUFFER_RESERVE_MANAGER_ROLE'))).toBe('BUFFER_RESERVE_MANAGER_ROLE')
    expect(isPrivilegedRole('BUFFER_RESERVE_MANAGER_ROLE')).toBe(true)
    expect(isPrivilegedRole('TRANSFER_ROLE')).toBe(true)
  })
})

describe('Dual Governance history: config events, proposers, AD-5', () => {
  const m = {
    [`${EXEC}@199`]: { kind: 'contract', address: EXEC, ownedBy: dgCtl() } as Controller,
    [`${EXEC}@200`]: { kind: 'contract', address: EXEC, ownedBy: dgCtl() } as Controller,
    [`${EOA}@200`]: { kind: 'eoa', address: EOA } as Controller,
    [`${SAFE}@199`]: { kind: 'safe', address: SAFE, threshold: 5, signers: 7 } as Controller,
    [`${SAFE}@200`]: { kind: 'safe', address: SAFE, threshold: 5, signers: 7 } as Controller,
    [`${A('9')}@200`]: { kind: 'safe', address: A('9'), threshold: 2, signers: 7 } as Controller,
    [`${VOTING}@200`]: voting(),
  }
  it('an after-submit delay cut is AD-2; a first value set at deployment is initialization; an unread previous value fails closed', () => {
    const out = classifyAdminEvents(
      [
        row({
          emitter: EPT,
          block: 1,
          event: 'AfterSubmitDelaySet',
          args: { newAfterSubmitDelay: '259200' },
        }),
        row({
          emitter: EPT,
          block: 200,
          logIndex: 1,
          tx: '0x2',
          event: 'AfterSubmitDelaySet',
          args: { newAfterSubmitDelay: '86400' },
        }),
        row({
          emitter: DG,
          block: 300,
          tx: '0x3',
          event: 'AfterScheduleDelaySet',
          args: { newAfterScheduleDelay: '3600' },
        }),
      ],
      actx(m),
    )
    expect(out[0].tags).toContain('initialization')
    expect(out[1].red).toBe(true)
    expect(out[1].ruleIds).toEqual(['AD-2'])
    expect(out[2].red).toBe(true) // previous after-schedule delay never read
    expect(out[2].notes?.join(' ')).toMatch(/not read \(fail closed\)/)
  })
  it('an emergency committee replaced by a weaker Safe is AD-3; the previous holder comes from the read at block − 1', () => {
    const out = classifyAdminEvents(
      [
        row({
          emitter: EPT,
          block: 200,
          event: 'EmergencyExecutionCommitteeSet',
          args: { newExecutionCommittee: A('9') },
          prev: SAFE,
        }),
      ],
      actx(m),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(['AD-3'])
    expect(out[0].title).toMatch(/emergency execution committee/)
  })
  it('a governance contract replaced is a logic change: AD-9 unless its source is verified', () => {
    const ev = row({
      emitter: EPT,
      block: 200,
      event: 'GovernanceSet',
      args: { newGovernance: DG },
      prev: A('9'),
    })
    const ctxM = {
      ...m,
      [`${DG}@200`]: { kind: 'contract', address: DG } as Controller,
      [`${A('9')}@199`]: { kind: 'contract', address: A('9') } as Controller,
    }
    const unverified = classifyAdminEvents([ev], actx(ctxM, { verified: () => false }))
    expect(unverified[0].ruleIds).toContain('AD-9')
    const ok = classifyAdminEvents([ev], actx(ctxM, { verified: () => true }))
    expect(ok[0].red).toBe(false)
    expect(ok[0].tags).toContain('logic_change')
  })
  it('a new Dual Governance proposer that is an EOA is red (PROPOSER_ROLE, AD-4); the Aragon Voting is not', () => {
    const out = classifyAdminEvents(
      [
        row({
          emitter: DG,
          block: 200,
          event: 'ProposerRegistered',
          args: { proposer: VOTING, executor: EXEC },
        }),
        row({
          emitter: DG,
          block: 200,
          logIndex: 1,
          event: 'ProposerRegistered',
          args: { proposer: EOA, executor: EXEC },
        }),
      ],
      actx(m),
    )
    expect(out[0].red).toBe(false)
    expect(out[1].red).toBe(true)
    expect(out[1].ruleIds).toEqual(['AD-4'])
  })
  it('AD-5: an upgrade through a Dual Governance timelock needs its ProposalExecuted in the same transaction', () => {
    const holders = { [`${STETH}@200`]: [agentCtl(dgCtl())] }
    const upg = row({
      emitter: STETH,
      block: 200,
      tx: '0xu',
      event: 'Upgraded',
      args: { implementation: A('9'), via: 'SetApp' },
    })
    const bare = classifyAdminEvents(
      [upg],
      actx(m, { upgradeHoldersAt: holders, verified: () => true }),
    )
    expect(bare[0].ruleIds).toContain('AD-5')
    const viaDg = classifyAdminEvents(
      [
        upg,
        row({
          emitter: EPT,
          block: 200,
          tx: '0xu',
          logIndex: 9,
          event: 'ProposalExecuted',
          args: { id: '12' },
        }),
      ],
      actx(m, { upgradeHoldersAt: holders, verified: () => true }),
    )
    expect(viaDg[0].ruleIds).not.toContain('AD-5')
    expect(viaDg[0].red).toBe(false)
  })
  it('a permission manager moved from the Aragon Voting to the DG-governed Agent is no downgrade; to an EOA it is AD-3', () => {
    const mm = { ...m, [`${VOTING}@199`]: voting(259200), [`${AGENT}@200`]: agentCtl(dgCtl()) }
    const out = classifyAdminEvents(
      [
        row({
          emitter: STETH,
          block: 200,
          event: 'PermissionManagerChanged',
          args: { role: roleHash('PAUSE_ROLE'), roleName: 'PAUSE_ROLE', manager: AGENT },
          prev: VOTING,
        }),
        row({
          emitter: STETH,
          block: 200,
          logIndex: 1,
          event: 'PermissionManagerChanged',
          args: { role: roleHash('RESUME_ROLE'), roleName: 'RESUME_ROLE', manager: EOA },
          prev: VOTING,
        }),
      ],
      actx(mm),
    )
    expect(out[0].red).toBe(false)
    expect(out[0].severity).toBe('upgrade')
    expect(out[1].red).toBe(true)
    expect(out[1].ruleIds).toEqual(['AD-3'])
  })
  it('the DG launch window: a manager moved from the Voting to an Agent both the Voting and the DG executor control is not a downgrade', () => {
    const both: Controller = {
      kind: 'contract',
      address: AGENT,
      version: 'Aragon Agent',
      executors: [voting(), { kind: 'contract', address: EXEC, ownedBy: dgCtl() }],
    }
    const out = classifyAdminEvents(
      [
        row({
          emitter: KERNEL,
          block: 200,
          event: 'PermissionManagerChanged',
          args: {
            role: roleHash('APP_MANAGER_ROLE'),
            roleName: 'APP_MANAGER_ROLE',
            manager: AGENT,
          },
          prev: VOTING,
        }),
      ],
      actx({ ...m, [`${VOTING}@199`]: voting(), [`${AGENT}@200`]: both }),
    )
    expect(out[0].red).toBe(false)
    expect(out[0].tags).toContain('rotation')
  })
  it("Lido's namespaced bridge roles and Linea's pause roles are recognised switches, not privileged grants", () => {
    const h = keccak256(toHex('BridgingManager.DEPOSITS_DISABLER_ROLE'))
    expect(roleName(h)).toBe('DEPOSITS_DISABLER_ROLE')
    const out = classifyAdminEvents(
      [
        row({
          emitter: A('5'),
          block: 200,
          event: 'RoleGranted',
          args: { role: h, roleName: roleName(h), account: SAFE },
        }),
        row({
          emitter: A('5'),
          block: 200,
          logIndex: 1,
          event: 'RoleGranted',
          args: { role: roleHash('PAUSE_ALL_ROLE'), roleName: 'PAUSE_ALL_ROLE', account: EOA },
        }),
      ],
      actx({
        [`${SAFE}@200`]: { kind: 'safe', address: SAFE, threshold: 3, signers: 5 },
        [`${EOA}@200`]: { kind: 'eoa', address: EOA },
      }),
    )
    expect(out.map((c) => c.red)).toEqual([false, false])
  })
  it('rows before fileFrom (an ACL replayed from 2020) set state but are not listed', () => {
    const RUN = roleHash('RUN_SCRIPT_ROLE')
    const out = classifyAdminEvents(
      [
        row({
          emitter: AGENT,
          block: 50,
          event: 'RoleGranted',
          args: { role: RUN, roleName: 'RUN_SCRIPT_ROLE', account: VOTING },
        }),
        row({
          emitter: AGENT,
          block: 200,
          event: 'RoleGranted',
          args: { role: RUN, roleName: 'RUN_SCRIPT_ROLE', account: EXEC },
        }),
      ],
      actx({ ...m, [`${VOTING}@50`]: voting(), [`${VOTING}@200`]: voting() }, { fileFrom: 100 }),
    )
    expect(out).toHaveLength(1)
    expect(out[0].block).toBe(200)
    // judged against the replayed holder (the Voting): the DG executor is not weaker
    expect(out[0].red).toBe(false)
  })
})

describe('Wormhole NTT rules', () => {
  it('E counts distinct verifier networks; the floor binds below 2', () => {
    expect(nttEffective(2, ['wormhole', 'axelar'])).toMatchObject({ E: 2, distinct: 2 })
    expect(nttEffective(2, ['wormhole', 'wormhole'])).toMatchObject({ E: 1, duplicate: 1 })
    expect(nttEffective(2, ['wormhole', null])).toMatchObject({ E: 1, unknown: 1 })
    expect(classifyNttThreshold(2, 1, ['wormhole', 'axelar'])).toMatchObject({
      severity: 'downgrade',
      floorBreach: true,
      ruleIds: ['BR-1', 'BR-2'],
    })
    expect(classifyNttThreshold(1, 2, ['wormhole', 'axelar'])).toMatchObject({
      severity: 'upgrade',
      floorBreach: false,
    })
  })
  it('a transceiver added at the same threshold is AMBER wider set; a second one on the same network or an unknown one is BR-7', () => {
    const wider = classifyNttTransceiverAdded('axelar', ['wormhole', 'ccip'], 2, 2)
    expect(wider.severity).toBe('neutral')
    expect(wider.tags).toContain('wider_dvn_set')
    expect(classifyNttTransceiverAdded('wormhole', ['wormhole'], 1, 1).ruleIds).toContain('BR-7')
    expect(classifyNttTransceiverAdded(null, ['wormhole'], 2, 2).ruleIds).toContain('BR-7')
  })
  it('BR-6 on a peer: every re-point is red, also through zero; zeroing and a first peer are neutral', () => {
    const P1 = '0x' + '0'.repeat(24) + '1'.repeat(40)
    const P2 = '0x' + '0'.repeat(24) + '2'.repeat(40)
    const Z32 = '0x' + '0'.repeat(64)
    expect(classifyPeerChange(Z32, P1).tags).toContain('route_created')
    expect(classifyPeerChange(P1, Z32).tags).toContain('route_removed')
    expect(classifyPeerChange(P1, P2).ruleIds).toEqual(['BR-6'])
    expect(classifyPeerChange(Z32, P2, P1).ruleIds).toEqual(['BR-6'])
    expect(classifyPeerChange(P1, P1).severity).toBe('neutral')
  })
  it('replay: set-up before any peer is not a floor breach; the peer opening a 1-of-1 route is; the threshold raise is an upgrade', () => {
    const P = '0x' + '0'.repeat(24) + '6'.repeat(40)
    const Z32 = '0x' + '0'.repeat(64)
    const out = classifyAdminEvents(
      [
        row({
          emitter: NTT,
          block: 1,
          event: 'TransceiverAdded',
          args: {
            transceiver: WH,
            transceiversNum: '1',
            threshold: '1',
            transceiverType: 'wormhole',
          },
        }),
        row({
          emitter: NTT,
          block: 1,
          logIndex: 1,
          event: 'ThresholdChanged',
          args: { oldThreshold: '0', threshold: '1' },
        }),
        row({
          emitter: NTT,
          block: 30,
          tx: '0x2',
          event: 'PeerUpdated',
          args: {
            chainId_: '4',
            oldPeerContract: Z32,
            oldPeerDecimals: '0',
            peerContract: P,
            peerDecimals: '18',
          },
        }),
        row({
          emitter: NTT,
          block: 40,
          tx: '0x3',
          event: 'TransceiverAdded',
          args: {
            transceiver: AX,
            transceiversNum: '2',
            threshold: '1',
            transceiverType: 'axelar',
          },
        }),
        row({
          emitter: NTT,
          block: 50,
          tx: '0x4',
          event: 'ThresholdChanged',
          args: { oldThreshold: '1', threshold: '2' },
        }),
      ],
      actx({}),
    )
    expect(out.map((c) => [c.key.split('/').slice(-1)[0], c.red, c.floorBreach])).toEqual([
      ['verification', false, false],
      ['verification', false, false],
      ['verification', true, true], // the peer opens the route at 1-of-1
      ['verification', true, true], // still 1-of-2 on a live route (and a wider set)
      ['verification', false, false],
    ])
    expect(out[2].title).toMatch(/peer for chain 4/)
    expect(out[3].tags).toContain('wider_dvn_set')
    expect(out[4].severity).toBe('upgrade')
    expect(out.every((c) => c.dimension === 'bridge')).toBe(true)
    // the raise to 2-of-2 ends both floor reds (no longer STILL IN EFFECT)
    markStillInEffect(out)
    expect(out.filter((c) => c.stillInEffect)).toEqual([])
  })
  it('a pauser moved to address(0) is MR-1', () => {
    const out = classifyAdminEvents(
      [
        row({
          emitter: NTT,
          block: 200,
          event: 'PauserTransferred',
          args: { oldPauser: SAFE, newPauser: ZERO },
        }),
      ],
      actx({
        [`${SAFE}@199`]: { kind: 'safe', address: SAFE, threshold: 3, signers: 5 },
        [`${ZERO}@200`]: { kind: 'zero', address: ZERO },
      }),
    )
    expect(out[0].ruleIds).toContain('MR-1')
  })
})

describe('collector readers: Dual Governance proposals, NTT, canonical bridges, list counts (fake client)', () => {
  it('a DG proposal maps to a timelock op: submitted is pending, scheduled past its delay may be armed, executed / cancelled drop', () => {
    const p = (status: number, sub = 1000, sch = 0) => ({
      id: 3n,
      executor: EXEC,
      submittedAt: BigInt(sub),
      scheduledAt: BigInt(sch),
      status,
      calls: [{ target: AGENT, value: 0n, payload: '0x1234' }],
    })
    const d = { now: 2_000_000, afterSubmitDelaySec: 259200, afterScheduleDelaySec: 86400 }
    const submitted = dgProposalOp(EPT, p(1, 1_990_000), d)
    expect(submitted).toMatchObject({
      kind: 'dg',
      status: 'submitted',
      timestamp: 1_990_000 + 259200 + 86400,
    })
    // submitted long ago: still needs scheduling + the after-schedule delay
    expect(dgProposalOp(EPT, p(1, 100), d).timestamp).toBe(2_000_000 + 86400)
    expect(dgProposalOp(EPT, p(2, 100, 1_000_000), d).timestamp).toBe(1_086_400)
    expect(dgProposalOp(EPT, p(3), d).timestamp).toBe(1)
    expect(dgProposalOp(EPT, p(4), d).timestamp).toBe(0)
    expect(dgProposalOp(EPT, p(1), { ...d, afterSubmitDelaySec: null }).timestamp).toBeNull()
    expect(submitted.calls).toEqual([{ target: AGENT, value: '0', data: '0x1234' }])
  })
  it('readDgProposals keeps only open proposals and simulates a scheduled one past its delay', async () => {
    const calls: string[] = []
    const prop = (id: number, status: number, sub: number, sch: number) => [
      {
        id: BigInt(id),
        executor: EXEC,
        submittedAt: BigInt(sub),
        scheduledAt: BigInt(sch),
        status,
      },
      [{ target: AGENT, value: 0n, payload: '0xabcd' }],
    ]
    const c = fake({
      code: { [EPT]: '0x60' },
      reads: {
        [`${EPT}|getProposalsCount`]: 3n,
        [`${EPT}|getProposal`]: (args: bigint[]) =>
          ({ 1: prop(1, 3, 10, 20), 2: prop(2, 2, 10, 20), 3: prop(3, 1, 1_999_000, 0) })[
            Number(args[0])
          ],
        [`${EPT}|getAfterSubmitDelay`]: 259200,
        [`${EPT}|getAfterScheduleDelay`]: 86400,
        [`${EPT}|getGovernance`]: ZERO,
        [`${EPT}|getAdminExecutor`]: EXEC,
        [`${EPT}|getEmergencyGovernance`]: ZERO,
        [`${EPT}|getEmergencyActivationCommittee`]: ZERO,
        [`${EPT}|getEmergencyExecutionCommittee`]: ZERO,
        [`${EPT}|isEmergencyModeActive`]: false,
        [`${EPT}|getEmergencyProtectionDetails`]: {
          emergencyModeDuration: 0,
          emergencyModeEndsAfter: 0,
          emergencyProtectionEndsAfter: 0,
        },
      },
      call: (to) => calls.push(to),
    })
    const r = await readDgProposals(c, EPT, { now: 2_000_000 })
    expect(r.status).toBe('ok')
    expect(r.ops.map((o: TimelockOp) => [o.id, o.status, o.simulation])).toEqual([
      ['2', 'scheduled', 'ok'],
      ['3', 'submitted', 'not_run'],
    ])
    expect(calls).toEqual([EPT])
    const down = await readDgProposals(fake({}), EPT, { now: 1 })
    expect(down.status).toBe('unavailable')
  }, 20_000)
  it('readNtt: threshold, transceiver networks, peers, locked balance', async () => {
    const PEER = '0x' + '0'.repeat(24) + '6'.repeat(40)
    const c = fake({
      reads: {
        [`${NTT}|getThreshold`]: 2,
        [`${NTT}|getTransceivers`]: [WH, AX],
        [`${WH}|getTransceiverType`]: 'wormhole',
        [`${AX}|getTransceiverType`]: 'axelar',
        [`${WH}|getWormholePeer`]: PEER,
        [`${NTT}|getPeer`]: { peerAddress: PEER, tokenDecimals: 18 },
        [`${NTT}|token`]: TOKEN,
        [`${NTT}|getMode`]: 0,
        [`${NTT}|owner`]: AGENT,
        [`${NTT}|pauser`]: SAFE,
        [`${NTT}|isPaused`]: false,
        [`${TOKEN}|balanceOf`]: 5n * 10n ** 18n,
        [`${TOKEN}|decimals`]: 18,
      },
    })
    const n = await readNtt(c, NTT, [4])
    expect(n).toMatchObject({
      threshold: 2,
      mode: 'locking',
      owner: AGENT,
      pauser: SAFE,
      locked: { raw: '5000000000000000000', decimals: 18 },
      peers: { 4: { peer: PEER, decimals: 18 } },
    })
    expect(n.transceivers!.map((t) => t.type)).toEqual(['wormhole', 'axelar'])
  })
  it('readCanonicalBridge: a switch the bridge lacks is undefined, a failed read null', async () => {
    const BR = A('5')
    const c = fake({
      reads: {
        [`${TOKEN}|balanceOf`]: 7n,
        [`${TOKEN}|decimals`]: 18,
        [`${BR}|isDepositsEnabled`]: true,
        [`${BR}|isWithdrawalsEnabled`]: new Error('fetch failed'),
      },
      storage: {
        [`${BR}|0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`]:
          '0x' + '0'.repeat(24) + AGENT.slice(2),
      },
    })
    const b = await readCanonicalBridge(c, BR, TOKEN)
    expect(b).toMatchObject({
      depositsEnabled: true,
      withdrawalsEnabled: null,
      admin: AGENT,
      locked: { raw: '7' },
    })
    expect(b.ossified).toBeUndefined()
  })
  it('readParams count: a getter returning lists is judged on the length of the selected one', async () => {
    const c = fake({
      reads: {
        [`${A('7')}|getMembers`]: [
          [A('1'), A('2'), A('3')],
          [1n, 2n, 3n],
        ],
        [`${A('7')}|list`]: [A('1'), A('2')],
      },
    })
    const out = await readParams(c, [
      {
        key: 'm',
        contract: A('7'),
        sig: 'function getMembers() view returns (address[] addresses, uint256[] lastReportedRefSlots)',
        count: true,
        rule: 'quorum_members',
        label: 'm',
      },
      {
        key: 'l',
        contract: A('7'),
        sig: 'function list() view returns (address[])',
        count: true,
        rule: 'info',
        label: 'l',
      },
    ])
    expect(out).toEqual({ m: 3, l: 2 })
  })
})

describe('queue: an Aragon Agent forward(EVMScript) inside a Dual Governance proposal', () => {
  const script = (calls: { to: string; data: string }[]) =>
    '0x00000001' +
    calls
      .map(
        (c) =>
          c.to.slice(2) + ((c.data.length - 2) / 2).toString(16).padStart(8, '0') + c.data.slice(2),
      )
      .join('')
  const grantPermission = (entity: string, app: string, role: string) =>
    encodeFunctionData({
      abi: parseAbi(['function grantPermission(address entity, address app, bytes32 role)']),
      functionName: 'grantPermission',
      args: [entity as Hx, app as Hx, role as Hx],
    })
  const forward = (s: string) =>
    encodeFunctionData({
      abi: parseAbi(['function forward(bytes evmScript)']),
      functionName: 'forward',
      args: [s as Hx],
    })
  it('decodes spec-1 scripts and refuses truncated or foreign ones', () => {
    const s = script([
      { to: ACL, data: '0x12345678' },
      { to: STETH, data: '0xaabb' },
    ])
    expect(decodeEvmScript(s)).toEqual([
      { target: ACL, value: '0', data: '0x12345678' },
      { target: STETH, value: '0', data: '0xaabb' },
    ])
    expect(decodeEvmScript(s.slice(0, -2))).toBeNull()
    expect(decodeEvmScript('0x00000002' + s.slice(10))).toBeNull()
    expect(unwrapCalls({ target: AGENT, value: '0', data: forward(s) }).calls).toHaveLength(2)
  })
  it('ACL grantPermission becomes a grantRole on the app; Kernel setApp(base) an upgrade of the app proxy', () => {
    const appId = '0x' + 'ab'.repeat(32)
    const setApp = encodeFunctionData({
      abi: parseAbi(['function setApp(bytes32 namespace, bytes32 appId, address app)']),
      functionName: 'setApp',
      args: [ARAGON_NS.base as Hx, appId as Hx, A('9')],
    })
    const out = aragonCalls(
      [
        {
          target: ACL,
          value: '0',
          data: grantPermission(EOA, STETH, roleHash('STAKING_CONTROL_ROLE')),
        },
        { target: KERNEL, value: '0', data: setApp },
      ],
      { [appId]: [STETH] },
    )
    expect(out.map((c) => [c.target, c.data.slice(0, 10)])).toEqual([
      [STETH, '0x' + sel('grantRole(bytes32,address)')],
      [STETH, '0x' + sel('upgradeTo(address)')],
    ])
  })
  it('a scheduled proposal past its delay granting an admin-level stETH role to an EOA is red AD-4 + AD-8, listed as a DG proposal', () => {
    const op: TimelockOp = {
      kind: 'dg',
      status: 'scheduled',
      timelock: EPT,
      id: '15',
      calls: [
        {
          target: AGENT,
          value: '0',
          data: forward(
            script([
              { to: ACL, data: grantPermission(EOA, STETH, roleHash('STAKING_CONTROL_ROLE')) },
            ]),
          ),
        },
      ],
      predecessor: '0x' + '0'.repeat(64),
      delaySec: 345600,
      scheduledBlock: 10,
      scheduledTx: '0xs',
      timestamp: 500,
      predecessorDone: true,
      simulation: 'ok',
    }
    const q: QueueCtx = {
      subject: 'wsteth',
      announcement: 'not_checked',
      eval: evalCtx,
      block: 1000,
      endpoint: ZERO,
      routes: {},
      defaults: {},
      libDirection: () => null,
      ctl: (a) => (a === EOA ? { kind: 'eoa', address: EOA } : null),
      ownerOf: () => null,
      delegateOf: () => null,
      implHistory: {},
      minDelayOf: () => null,
      roleName: (h) => roleName(h),
      contracts: [STETH, AGENT, ACL, KERNEL],
      oapps: [],
    }
    const out = timelockChanges([op], q, 1000)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ state: 'pending', stage: 'armed', red: true })
    expect(out[0].ruleIds).toEqual(expect.arrayContaining(['AD-4', 'AD-8']))
    expect(out[0].queue).toEqual({ kind: 'dg_timelock', address: EPT, opId: '15' })
    expect(out[0].notes?.join(' ')).toMatch(/Dual Governance proposal #15 scheduled/)
  })
})

describe('engine: NTT and canonical bridge lines, DG delays on powers', () => {
  const subject = (o: Partial<ConfigSubject> = {}): ConfigSubject => ({
    key: 'wsteth',
    label: 'wstETH',
    oracleAssetKey: null,
    class: 'lrt',
    contracts: [
      {
        role: 'other',
        dimension: 'bridge',
        chainId: 1,
        address: NTT,
        label: 'ntt',
        deployBlock: 1,
      },
      {
        role: 'other',
        dimension: 'bridge',
        chainId: 1,
        address: A('5'),
        label: 'arb',
        deployBlock: 1,
      },
      {
        role: 'token',
        dimension: 'mint_redeem',
        chainId: 1,
        address: STETH,
        label: 'steth',
        deployBlock: 1,
      },
    ],
    lzOApps: [],
    ccipPools: [],
    powers: [
      {
        power: 'upgrade',
        contract: STETH,
        path: ['call:kernel()', 'acl_manager:APP_MANAGER_ROLE'],
        label: 'Upgrade stETH',
      },
    ],
    params: [],
    timelocks: [],
    safes: [],
    govChannels: [],
    nttManagers: [NTT],
    canonicalBridges: [{ address: A('5'), chain: 'Arbitrum', token: TOKEN, operator: 'Lido' }],
    ...o,
  })
  const raw = (o: { ntt?: RawSubject['ntt']; emergency?: boolean } = {}): RawSubject => ({
    version: 1,
    subjectKey: 'wsteth',
    head: { block: 1000, ts: 2000 },
    scan: { from: 1, to: 1000 },
    lz: {
      events: [],
      headRoutes: [],
      headDefaults: {},
      remote: [],
      codeProbes: {},
      dvnSigner: [],
      dvnHead: {},
      value: {
        priceUsd: 4000,
        priceBasis: 'wstETH registry consensus',
        locked: {},
        remoteSupply: {},
      },
    },
    admin: {
      events: [],
      controllers: {
        [`${AGENT}@head`]: agentCtl(dgCtl(691200, { emergencyModeActive: !!o.emergency })),
        [`${SAFE}@head`]: { kind: 'safe', address: SAFE, threshold: 3, signers: 5 },
      },
      powers: [{ power: 'upgrade', label: 'Upgrade stETH', contract: STETH, holders: [AGENT] }],
      timelockAdmins: [],
      implHistory: {},
      owners: {},
      delegates: {},
      minDelays: {},
    },
    params: { head: {}, transitions: [] },
    queues: { ops: [], safe: [], safeStatus: [], dgStatus: [{ timelock: EPT, status: 'ok' }] },
    ccip: { pools: [] },
    ntt: o.ntt ?? [
      {
        manager: NTT,
        token: TOKEN,
        mode: 'locking',
        threshold: 2,
        transceivers: [
          { address: WH, type: 'wormhole', peers: {} },
          { address: AX, type: 'axelar', peers: {} },
        ],
        peers: { 4: { peer: '0x' + '0'.repeat(24) + '6'.repeat(40), decimals: 18 } },
        owner: AGENT,
        pauser: SAFE,
        paused: false,
        locked: { raw: '1000000000000000000000', decimals: 18 },
      },
    ],
    canonical: [
      {
        bridge: A('5'),
        token: TOKEN,
        locked: { raw: '2000000000000000000', decimals: 18 },
        depositsEnabled: true,
        withdrawalsEnabled: false,
        ossified: false,
        admin: AGENT,
      },
    ],
    warnings: [],
  })
  const build = (r: RawSubject) =>
    buildSubject(subject(), r, { registry, eidName: () => 'x', roleName, endpoint: ZERO })
  it('a 2-of-2 Wormhole + Axelar NTT route is not a floor breach; 1-of-2 is, ranked by the locked value', () => {
    const ok = build(raw()).state.items.find((i) => i.key === `bridge/ntt/${NTT}`)!
    expect(ok.breaches).toEqual([])
    expect(ok.display).toMatch(/threshold 2 of 2 transceivers \(wormhole \+ axelar\)/)
    expect(ok.valueAtRisk?.usd).toBe(4_000_000)
    const r1 = raw()
    r1.ntt![0].threshold = 1
    const bad = build(r1)
    expect(
      bad.state.items.find((i) => i.key === `bridge/ntt/${NTT}`)!.breaches.map((b) => b.ruleId),
    ).toEqual(['BR-2'])
    expect(bad.state.counts.floorBreaches).toBe(1)
    // two transceivers on ONE network count once
    const r2 = raw()
    r2.ntt![0].transceivers![1].type = 'wormhole'
    expect(
      build(r2)
        .state.items.find((i) => i.key === `bridge/ntt/${NTT}`)!
        .breaches.map((b) => b.ruleId),
    ).toEqual(['BR-2', 'BR-7'])
  })
  it('canonical bridge line: locked, switches, proxy admin; NTT reads that failed are a read gap', () => {
    const out = build(raw())
    const c = out.state.items.find((i) => i.key === `bridge/canonical/${A('5')}`)!
    expect(c.display).toMatch(
      /^Arbitrum canonical bridge 0x5555…5555 \(Lido\): 2 locked · deposits on · withdrawals OFF · proxy admin Aragon Agent/,
    )
    const r = raw({ ntt: [{ ...raw().ntt![0], threshold: null }] })
    expect(build(r).state.readGaps?.join(' ')).toMatch(/NTT manager .* not read/)
  })
  it('a power held through the Agent shows the Dual Governance delay; emergency mode is an AD-2 breach at head', () => {
    const out = build(raw())
    expect(out.state.powers[0].effectiveDelaySec).toBe(691200)
    const item = out.state.items.find((i) => i.key === `admin/power/upgrade/${STETH}`)!
    expect(item.breaches).toEqual([])
    const em = build(raw({ emergency: true }))
    expect(
      em.state.items
        .find((i) => i.key === `admin/power/upgrade/${STETH}`)!
        .breaches.map((b) => b.ruleId),
    ).toEqual(['AD-2'])
  })
})

describe('subjects.json: the wstETH subject', () => {
  it('is the 8th subject, priced with the registry consensus, with its Aragon ACL, NTT manager and canonical bridges declared', () => {
    const s = getConfigSubjects().subjects.find((x) => x.key === 'wsteth')!
    expect(getConfigSubjects().subjects).toHaveLength(8)
    expect(s.oracleAssetKey).toBe('wstETH')
    expect(s.valuation).toEqual({ asset: 'wstETH' })
    expect(s.aragonAcl).toBe('0x9895f0f17cc1d1891b6f18ee0b483b6f221b37bb')
    expect(s.nttManagers).toEqual(['0xb948a93827d68a82f6513ad178964da487fe2bd9'])
    expect(s.canonicalBridges!.map((b) => b.chain)).toEqual(
      expect.arrayContaining(['Arbitrum', 'Optimism', 'Base', 'Unichain', 'Linea']),
    )
    expect(s.powers.find((p) => p.label.startsWith('Upgrade stETH'))!.path).toEqual([
      'call:kernel()',
      'acl_manager:APP_MANAGER_ROLE',
    ])
    expect(s.ccipPools).toEqual(['0xa586a732394a1affcf15b972cd47c936033c9fa7'])
  })
  it('rejects a list count on a non-list getter and an undeclared NTT manager / bridge', () => {
    const f = () => JSON.parse(JSON.stringify(getConfigSubjects()))
    const g = f()
    const w = g.subjects.find((x: ConfigSubject) => x.key === 'wsteth')
    w.params.find((p: { key: string }) => p.key === 'oracleQuorum').count = true
    expect(() => parseSubjects(g)).toThrow(/count needs a getter returning a list/)
    const h = f()
    h.subjects.find((x: ConfigSubject) => x.key === 'wsteth').nttManagers = ['0x' + '9'.repeat(40)]
    expect(() => parseSubjects(h)).toThrow(/not a declared contract/)
    const k = f()
    k.subjects.find((x: ConfigSubject) => x.key === 'wsteth').canonicalBridges[0].address =
      '0x' + '9'.repeat(40)
    expect(() => parseSubjects(k)).toThrow(/bridge .* is not a declared contract/)
  })
})

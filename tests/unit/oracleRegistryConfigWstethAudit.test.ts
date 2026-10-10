// wstETH (Lido) audit (2026-10-07): what the 8th subject still missed after its first run.
//   - the Dual Governance committees (emergency activation / execution, reseal, tiebreaker) and
//     the proposals canceller: read on the timelock's governance contract, classified at head,
//     shown on the card (AD-3 when one key controls one), tracked in the run-to-run Safe snapshot
//   - Wormhole NTT rate limits are TrimmedAmounts (uint72 amount << 8 | decimals): decoded to
//     token base units before they are stored and compared (the card showed 768000000000008
//     for 30,000 wstETH); amounts shown with their unit; the NTT pauser on the bridge line
//   - the NTT limit setters are declared: a queued setOutboundLimit / setInboundLimit is judged
// No network: fake clients answer by (address, function).

import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem'

import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import { timelockChanges, type QueueCtx, type TimelockOp } from '@/lib/oracleRegistry/config/queue'
import { getConfigSubjects, parseSubjects } from '@/lib/oracleRegistry/config/subjects'
import type { ConfigSubject, Controller, ParamSpec } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry, EvalCtx } from '@/lib/oracleRegistry/config/uln'
import { formatParamAmount } from '@/lib/oracleRegistry/config/value'
import { roleName } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import {
  classify as classifyJs,
  DG_STATES,
  dgCommitteeAddresses,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { decodeTrimmedAmount, readParams } from '@/scripts/oracle-registry/config/lib/params.mjs'
import { tokenVote } from './oracleRegistryVoteFixtures'

type Hx = `0x${string}`
// the collector is plain JS: its inferred return types are unions of object literals
const classify = classifyJs as unknown as (c: unknown, a: string, b?: number) => Promise<Controller>
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const AGENT = A('3')
const VOTING = A('4')
const EXEC = A('5')
const EPT = A('6')
const DG = A('7')
const STETH = A('8')
const NTT = A('b')
const WH = A('c')
const AX = A('d')
const EOA = A('e')
const TOKEN = A('f')
const ACT = '0x' + '21'.repeat(20)
const EXE = '0x' + '22'.repeat(20)
const RESEAL = '0x' + '23'.repeat(20)
const TIE = '0x' + '24'.repeat(20)
const PAUSER = '0x' + '25'.repeat(20)
const ZERO = '0x' + '0'.repeat(40)
const sel = (sig: string) => toFunctionSelector(`function ${sig}`).slice(2)
const codeWith = (sigs: string[]) =>
  '0x6080' + sigs.map((x) => '63' + sel(x) + '14').join('') + '00'
const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })

function fake(o: { code?: Record<string, string>; reads?: Record<string, unknown> }) {
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
        const v = o.reads?.[`${lc(c.address)}|${c.functionName}`]
        if (v === undefined) return { status: 'failure' }
        return { status: 'success', result: typeof v === 'function' ? v(c.args ?? []) : v }
      }),
    getStorageAt: async () => '0x' + '0'.repeat(64),
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
    call: async () => ({ data: '0x' }),
    request: async () => [],
  }
}

const registry: DvnRegistry = {
  byChain: { 1: {} },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
const evalCtx: EvalCtx = { registry, code: () => true, useDeprecated: false }

const dgCtl = (o: Partial<NonNullable<Controller['dg']>> = {}): Controller => ({
  kind: 'aragon_dg',
  address: EPT,
  delaySec: 691200,
  // ruling #12: the declared proposer (the Aragon Voting), classified
  schedulers: [tokenVote(VOTING)],
  dg: {
    proposers: [VOTING],
    proposerVoteSec: 432000,
    afterSubmitDelaySec: 259200,
    afterScheduleDelaySec: 86400,
    governance: DG,
    adminExecutor: EXEC,
    emergencyGovernance: null,
    activationCommittee: ACT,
    executionCommittee: EXE,
    emergencyModeActive: false,
    emergencyProtectionEndsAfter: 1_813_449_600,
    resealCommittee: RESEAL,
    tiebreakerCommittee: TIE,
    proposalsCanceller: VOTING,
    state: 'Normal',
    ...o,
  },
})
const agentCtl = (dg: Controller): Controller => ({
  kind: 'contract',
  address: AGENT,
  version: 'Aragon Agent',
  executors: [{ kind: 'contract', address: EXEC, ownedBy: dg }],
  ownedBy: { kind: 'contract', address: EXEC, ownedBy: dg },
})
const safe = (address: string, threshold: number, signers: number): Controller => ({
  kind: 'safe',
  address,
  threshold,
  signers,
})

// =====================================================================================================
describe('NTT TrimmedAmount: rate limits decoded to token base units', () => {
  it('decodes amount << 8 | decimals; the wstETH → BNB limit is 30,000 wstETH', () => {
    // read on-chain 2026-10-07: getOutboundLimitParams().limit = 768000000000008,
    // getCurrentOutboundCapacity() = 30000e18
    expect(decodeTrimmedAmount(768000000000008n, 18)).toBe('30000000000000000000000')
    expect(decodeTrimmedAmount('768000000000008', 18)).toBe('30000000000000000000000')
    expect(decodeTrimmedAmount(0n, 18)).toBe('0')
    // a 6-decimal token is trimmed to 6: no rescale
    expect(decodeTrimmedAmount((5_000_000n << 8n) | 6n, 6)).toBe('5000000')
    // stored decimals above the token's (never written by NTT): scaled down, not up
    expect(decodeTrimmedAmount((123_000n << 8n) | 9n, 6)).toBe('123')
    expect(decodeTrimmedAmount(1n, -1)).toBeUndefined()
    expect(decodeTrimmedAmount('not a number', 18)).toBeUndefined()
  })
  it('readParams applies the decode to the selected output; an undecoded spec keeps the raw value', async () => {
    const c = fake({
      reads: {
        [`${NTT}|getOutboundLimitParams`]: [768000000000008n, 767769536435208n, 1_791_307_511n],
        [`${NTT}|getInboundLimitParams`]: () => [768000000000008n, 1n, 1n],
      },
    })
    const sig =
      'function getOutboundLimitParams() view returns (uint72 limit, uint72 currentCapacity, uint64 lastTxTimestamp)'
    const out = await readParams(c, [
      {
        key: 'out',
        contract: NTT,
        sig,
        outputIndex: 0,
        decode: 'trimmed_amount',
        decimals: 18,
        rule: 'cap',
        zero: 'closed',
        label: 'o',
      },
      {
        key: 'cap',
        contract: NTT,
        sig,
        outputIndex: 1,
        decode: 'trimmed_amount',
        decimals: 18,
        rule: 'info',
        label: 'c',
      },
      { key: 'raw', contract: NTT, sig, outputIndex: 0, rule: 'info', label: 'r' },
      {
        key: 'in',
        contract: NTT,
        sig: 'function getInboundLimitParams(uint16) view returns (uint72 limit, uint72 currentCapacity, uint64 lastTxTimestamp)',
        args: [4],
        outputIndex: 0,
        decode: 'trimmed_amount',
        decimals: 18,
        rule: 'cap',
        zero: 'closed',
        label: 'i',
      },
    ])
    expect(out).toEqual({
      out: '30000000000000000000000',
      cap: '29990997517000000000000',
      raw: '768000000000008',
      in: '30000000000000000000000',
    })
  })
  it('amounts with a unit read as token amounts; addresses, flags and unit-less values do not', () => {
    const u = { decimals: 18, symbol: 'wstETH' }
    expect(formatParamAmount('30000000000000000000000', u)).toBe('30,000 wstETH')
    expect(formatParamAmount('150000000000000000000000', { decimals: 18, symbol: 'ETH' })).toBe(
      '150,000 ETH',
    )
    expect(formatParamAmount('1500000000000000', u)).toBe('0.0015 wstETH')
    expect(formatParamAmount(AGENT, u)).toBeNull()
    expect(formatParamAmount(true, u)).toBeNull()
    expect(formatParamAmount('3000', undefined)).toBeNull()
  })
})

describe('subjects.json: decode / unit declarations', () => {
  it('the wstETH NTT limits are decoded, carry a unit and declare their setters', () => {
    const s = getConfigSubjects().subjects.find((x) => x.key === 'wsteth')!
    const out = s.params.find((p) => p.key === 'nttOutboundLimit')!
    const inb = s.params.find((p) => p.key === 'nttInboundLimitBsc')!
    expect(out).toMatchObject({
      decode: 'trimmed_amount',
      decimals: 18,
      unit: { decimals: 18, symbol: 'wstETH' },
    })
    expect(out.setter).toEqual({ sig: 'function setOutboundLimit(uint256 limit)', value: 0 })
    expect(inb.setter).toMatchObject({ value: 0, match: [1] })
    expect(s.params.find((p) => p.key === 'maxStakeLimit')!.unit).toEqual({
      decimals: 18,
      symbol: 'ETH',
    })
  })
  it('rejects a decode without token decimals and a malformed unit', () => {
    const f = () => JSON.parse(JSON.stringify(getConfigSubjects()))
    const g = f()
    delete g.subjects
      .find((x: ConfigSubject) => x.key === 'wsteth')
      .params.find((p: ParamSpec) => p.key === 'nttOutboundLimit').decimals
    expect(() => parseSubjects(g)).toThrow(/decode 'trimmed_amount' needs the token decimals/)
    const h = f()
    h.subjects
      .find((x: ConfigSubject) => x.key === 'wsteth')
      .params.find((p: ParamSpec) => p.key === 'maxStakeLimit').unit = { decimals: 18 }
    expect(() => parseSubjects(h)).toThrow(/unit needs integer decimals and a symbol/)
    const k = f()
    k.subjects
      .find((x: ConfigSubject) => x.key === 'wsteth')
      .params.find((p: ParamSpec) => p.key === 'nttOutboundLimit').decode = 'packed'
    expect(() => parseSubjects(k)).toThrow(/decode/)
  })
})

describe('Dual Governance committees: read, walked, classified', () => {
  const DG_CODE = codeWith([
    'getAfterSubmitDelay()',
    'getAfterScheduleDelay()',
    'getGovernance()',
    'getProposal(uint256)',
    'execute(uint256)',
  ])
  const reads = (o: Record<string, unknown> = {}) => ({
    [`${EPT}|getAfterSubmitDelay`]: 259200,
    [`${EPT}|getAfterScheduleDelay`]: 86400,
    [`${EPT}|getGovernance`]: DG,
    [`${EPT}|getAdminExecutor`]: EXEC,
    [`${EPT}|isEmergencyModeActive`]: false,
    [`${EPT}|getEmergencyGovernance`]: ZERO,
    [`${EPT}|getEmergencyActivationCommittee`]: ACT,
    [`${EPT}|getEmergencyExecutionCommittee`]: EXE,
    [`${EPT}|getEmergencyProtectionDetails`]: {
      emergencyModeDuration: 0,
      emergencyModeEndsAfter: 0,
      emergencyProtectionEndsAfter: 1_813_449_600,
    },
    [`${DG}|getProposers`]: [],
    [`${DG}|getResealCommittee`]: RESEAL,
    [`${DG}|getProposalsCanceller`]: VOTING,
    [`${DG}|getTiebreakerDetails`]: {
      isTie: false,
      tiebreakerCommittee: TIE,
      tiebreakerActivationTimeout: 31_536_000,
      sealableWithdrawalBlockers: [],
    },
    [`${DG}|getEffectiveState`]: 1,
    ...o,
  })
  it('the timelock classification carries the governance contract committees, canceller and state', async () => {
    const t = await classify(fake({ code: { [EPT]: DG_CODE }, reads: reads() }), EPT)
    expect(t.kind).toBe('aragon_dg')
    expect(t.dg).toMatchObject({
      activationCommittee: ACT,
      executionCommittee: EXE,
      resealCommittee: RESEAL,
      tiebreakerCommittee: TIE,
      proposalsCanceller: VOTING,
      state: 'Normal',
    })
    expect(DG_STATES[5]).toBe('RageQuit')
    // a governance contract that does not answer: every field it owns is null (unread), never a guess
    const bare = reads()
    for (const k of Object.keys(bare))
      if (k.startsWith(`${DG}|get`) && !k.endsWith('getProposers')) delete bare[k]
    const u = await classify(fake({ code: { [EPT]: DG_CODE }, reads: bare }), EPT)
    expect(u.dg).toMatchObject({
      resealCommittee: null,
      tiebreakerCommittee: null,
      proposalsCanceller: null,
      state: null,
    })
    expect(u.dg!.activationCommittee).toBe(ACT)
    // an unnamed state number is kept, not dropped
    const odd = await classify(
      fake({ code: { [EPT]: DG_CODE }, reads: reads({ [`${DG}|getEffectiveState`]: 9 }) }),
      EPT,
    )
    expect(odd.dg!.state).toBe('state 9')
  })
  it('dgCommitteeAddresses walks deferral chains and Agent executors; zero and unread are skipped', () => {
    const got = dgCommitteeAddresses(
      agentCtl(dgCtl({ tiebreakerCommittee: null, resealCommittee: ZERO })),
    )
    expect([...got].sort()).toEqual([ACT, EXE, VOTING].sort())
    expect([...dgCommitteeAddresses({ kind: 'eoa', address: EOA })]).toEqual([])
    expect([...dgCommitteeAddresses(undefined)]).toEqual([])
  })
})

describe('engine: the Dual Governance line, the NTT pauser, units', () => {
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
    params: [
      {
        key: 'nttOutboundLimit',
        contract: NTT,
        sig: 'function getOutboundLimitParams() view returns (uint72 limit, uint72 currentCapacity, uint64 lastTxTimestamp)',
        outputIndex: 0,
        decode: 'trimmed_amount',
        decimals: 18,
        rule: 'cap',
        zero: 'closed',
        label: 'NTT outbound rate limit',
        unit: { decimals: 18, symbol: 'wstETH' },
      },
    ],
    timelocks: [],
    safes: [],
    govChannels: [],
    nttManagers: [NTT],
    ...o,
  })
  const raw = (
    o: {
      dg?: Partial<NonNullable<Controller['dg']>>
      controllers?: Record<string, Controller>
      ts?: number
    } = {},
  ): RawSubject => ({
    version: 1,
    subjectKey: 'wsteth',
    head: { block: 1000, ts: o.ts ?? 1_791_416_579 },
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
        [`${AGENT}@head`]: agentCtl(dgCtl(o.dg)),
        [`${ACT}@head`]: safe(ACT, 4, 7),
        [`${EXE}@head`]: safe(EXE, 5, 7),
        [`${RESEAL}@head`]: safe(RESEAL, 5, 6),
        [`${TIE}@head`]: { kind: 'contract', address: TIE },
        [`${VOTING}@head`]: tokenVote(VOTING),
        [`${PAUSER}@head`]: safe(PAUSER, 3, 5),
        ...o.controllers,
      },
      powers: [{ power: 'upgrade', label: 'Upgrade stETH', contract: STETH, holders: [AGENT] }],
      timelockAdmins: [],
      implHistory: {},
      owners: {},
      delegates: {},
      minDelays: {},
    },
    params: { head: { nttOutboundLimit: '30000000000000000000000' }, transitions: [] },
    queues: { ops: [], safe: [], safeStatus: [], dgStatus: [{ timelock: EPT, status: 'ok' }] },
    ccip: { pools: [] },
    ntt: [
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
        pauser: PAUSER,
        paused: false,
        locked: { raw: '1000000000000000000000', decimals: 18 },
        // the remote side read clean (WstethRemote tests cover it): no read gap from it here
        remote: [
          {
            wormholeChainId: 4,
            chainId: 56,
            chainKey: 'bsc',
            status: 'ok',
            manager: '0x' + '6'.repeat(40),
            token: TOKEN,
            mode: 'burning',
            threshold: 2,
            transceivers: [
              { address: WH, type: 'wormhole', peers: {} },
              { address: AX, type: 'axelar', peers: {} },
            ],
            peerBack: { peer: '0x' + '0'.repeat(24) + NTT.slice(2), decimals: 18 },
            owner: { kind: 'safe', address: PAUSER, threshold: 3, signers: 5 },
            pauser: { kind: 'safe', address: PAUSER, threshold: 3, signers: 5 },
            paused: false,
            supply: { raw: '1000000000000000000000', decimals: 18 },
          },
        ],
      },
    ],
    canonical: [],
    warnings: [],
  })
  const build = (r: RawSubject, s = subject()) =>
    buildSubject(s, r, { registry, eidName: () => 'x', roleName, endpoint: ZERO })
  const dgItem = (r: RawSubject) => build(r).state.items.find((i) => i.key === `admin/dg/${EPT}`)
  it('one line per Dual Governance timelock: state, delays, emergency protection, every committee', () => {
    const it0 = dgItem(raw())!
    expect(it0.dimension).toBe('admin')
    expect(it0.breaches).toEqual([])
    expect(it0.display).toMatch(
      /^Lido Dual Governance timelock 0x6666…6666 · state Normal · proposals by 0x4444…4444 \(5d vote\) · after-submit 3d · after-schedule 1d · emergency mode off · emergency protection until 2027-06-20/,
    )
    expect(it0.display).toMatch(/Emergency Activation Committee Safe 4-of-7 0x2121…2121/)
    expect(it0.display).toMatch(/Emergency Execution Committee Safe 5-of-7 0x2222…2222/)
    expect(it0.display).toMatch(/Reseal Committee Safe 5-of-6 0x2323…2323/)
    expect(it0.display).toMatch(/Tiebreaker Committee contract 0x2424…2424/)
    expect(it0.display).toMatch(/Proposals canceller Aragon Voting/)
  })
  it('a committee one key controls is the AD-3 head breach: an EOA, a 1-of-N Safe', () => {
    const eoa = dgItem(raw({ controllers: { [`${EXE}@head`]: { kind: 'eoa', address: EXE } } }))!
    expect(eoa.breaches).toEqual([
      {
        ruleId: 'AD-3',
        message: expect.stringMatching(
          /^Emergency Execution Committee of Dual Governance 0x6666…6666 is EOA/,
        ),
        // UQ-30: what the breach is about, stable across runs (matches a carried breach)
        ref: 'committee:executionCommittee',
      },
    ])
    const one = dgItem(raw({ controllers: { [`${RESEAL}@head`]: safe(RESEAL, 1, 6) } }))!
    expect(one.breaches.map((b) => b.ruleId)).toEqual(['AD-3'])
    expect(one.breaches[0].message).toMatch(/Reseal Committee/)
    // a 2-of-N Safe is no breach (control)
    expect(
      dgItem(raw({ controllers: { [`${RESEAL}@head`]: safe(RESEAL, 2, 6) } }))!.breaches,
    ).toEqual([])
  })
  it('a committee not read, or not classified at head, is a read gap; a zero one reads "none"; non-Normal states are spelled out', () => {
    const r = raw({ dg: { resealCommittee: null } })
    const out = build(r)
    expect(out.state.items.find((i) => i.key === `admin/dg/${EPT}`)!.display).toMatch(
      /Reseal Committee NOT READ/,
    )
    expect(out.state.readGaps?.join(' ')).toMatch(
      /Dual Governance 0x6666…6666: Reseal Committee not read/,
    )
    const r2 = raw()
    delete r2.admin.controllers[`${ACT}@head`]
    expect(build(r2).state.readGaps?.join(' ')).toMatch(
      /Emergency Activation Committee 0x2121…2121 not classified at head/,
    )
    expect(dgItem(raw({ dg: { tiebreakerCommittee: ZERO } }))!.display).toMatch(
      /Tiebreaker Committee none/,
    )
    expect(dgItem(raw({ dg: { state: 'VetoSignalling' } }))!.display).toMatch(
      /STATE VetoSignalling \(stETH holders' veto/,
    )
    // protection over: said so (the committees no longer act)
    expect(dgItem(raw({ ts: 1_900_000_000 }))!.display).toMatch(
      /emergency protection ended 2027-06-20 \(the emergency committees have no power\)/,
    )
    // a controller written by the previous collector version (no governance fields): no line, no gap
    const old = raw({
      dg: {
        resealCommittee: undefined,
        tiebreakerCommittee: undefined,
        proposalsCanceller: undefined,
        state: undefined,
      },
    })
    const o = build(old)
    expect(o.state.items.find((i) => i.key === `admin/dg/${EPT}`)!.display).not.toMatch(
      /Reseal|Tiebreaker|canceller|state/,
    )
    expect(o.state.readGaps ?? []).toEqual([])
  })
  it('the committee Safes are in the run-to-run Safe snapshot even when undeclared', () => {
    const snap = build(raw()).state.safeSnapshot!.map((c) => c.address)
    expect(snap).toEqual(expect.arrayContaining([ACT, EXE, RESEAL]))
  })
  it('the NTT line names its pauser; decoded limits read in token units', () => {
    const out = build(raw())
    expect(out.state.items.find((i) => i.key === `bridge/ntt/${NTT}`)!.display).toMatch(
      /pauser Safe 3-of-5 0x2525…2525/,
    )
    expect(out.state.items.find((i) => i.key === 'mint/nttOutboundLimit')!.display).toBe(
      'NTT outbound rate limit: 30,000 wstETH',
    )
    const none = raw()
    none.ntt![0].pauser = ZERO
    expect(build(none).state.items.find((i) => i.key === `bridge/ntt/${NTT}`)!.display).toMatch(
      /pauser none/,
    )
  })
  it('a param transition title uses the unit', () => {
    const r = raw()
    r.params.transitions = [
      {
        key: 'nttOutboundLimit',
        block: 900,
        blockFrom: 899,
        before: '30000000000000000000000',
        after: '60000000000000000000000',
      },
    ]
    const c = build(r).changes.find((x) => x.key === 'mint/nttOutboundLimit')!
    expect(c.title).toBe('NTT outbound rate limit: 30,000 wstETH → 60,000 wstETH')
    expect(c.tags).toContain('large_raise')
  })
})

describe('queue: a Dual Governance proposal changing the NTT rate limits', () => {
  const spec = getConfigSubjects().subjects.find((x) => x.key === 'wsteth')!.params
  const NTT_MAIN = '0xb948a93827d68a82f6513ad178964da487fe2bd9'
  const q = (head: Record<string, unknown>): QueueCtx => ({
    subject: 'wsteth',
    announcement: 'not_checked',
    eval: evalCtx,
    block: 1000,
    endpoint: ZERO,
    routes: {},
    defaults: {},
    libDirection: () => null,
    ctl: () => null,
    ownerOf: () => null,
    delegateOf: () => null,
    implHistory: {},
    minDelayOf: () => null,
    roleName: (h) => roleName(h),
    contracts: [NTT_MAIN],
    oapps: [],
    params: spec,
    paramHead: head,
  })
  const op = (data: string): TimelockOp => ({
    kind: 'dg',
    status: 'submitted',
    timelock: EPT,
    id: '40',
    calls: [{ target: NTT_MAIN, value: '0', data }],
    predecessor: '0x' + '0'.repeat(64),
    delaySec: 345600,
    scheduledBlock: 0,
    scheduledTx: '0x',
    timestamp: 5000,
    predecessorDone: true,
    simulation: 'not_run',
  })
  const abi = parseAbi([
    'function setOutboundLimit(uint256 limit)',
    'function setInboundLimit(uint256 limit, uint16 chainId_)',
  ])
  it('a limit set to type(uint256).max is red MR-4; a 2x raise is a tagged large raise; another chain id is not this parameter', () => {
    const head = {
      nttOutboundLimit: '30000000000000000000000',
      nttInboundLimitBsc: '30000000000000000000000',
    }
    const max = timelockChanges(
      [op(encodeFunctionData({ abi, functionName: 'setOutboundLimit', args: [2n ** 256n - 1n] }))],
      q(head),
      1000,
    )
    expect(max).toHaveLength(1)
    expect(max[0]).toMatchObject({ state: 'pending', red: true })
    expect(max[0].ruleIds).toContain('MR-4')
    const raise = timelockChanges(
      [
        op(
          encodeFunctionData({
            abi,
            functionName: 'setInboundLimit',
            args: [60_000n * 10n ** 18n, 4],
          }),
        ),
      ],
      q(head),
      1000,
    )
    expect(raise[0].red).toBe(false)
    expect(raise[0].tags).toContain('large_raise')
    expect(raise[0].title).toMatch(
      /NTT inbound rate limit from BNB Chain \(per 24 h\) → 60,000 wstETH/,
    )
    const other = timelockChanges(
      [
        op(
          encodeFunctionData({
            abi,
            functionName: 'setInboundLimit',
            args: [60_000n * 10n ** 18n, 30],
          }),
        ),
      ],
      q(head),
      1000,
    )
    expect(other[0].title).not.toMatch(/BNB Chain/)
  })
})

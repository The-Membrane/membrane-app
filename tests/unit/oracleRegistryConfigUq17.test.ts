// Config cards — owner ruling 2026-10-08 UQ-17 (a TOKEN VOTE ranks by HOLDER CONCENTRATION) and
// the registered fail-open items UQ-18..UQ-24 (owner: fail closed everywhere; a timelock is its
// weakest proposer). Each test failed on the code before the change (controls are marked).
// Synthetic fixtures; the on-chain shapes they copy are cited.

import { describe, expect, it } from 'vitest'
import { keccak256, pad, toHex } from 'viem'

import {
  classifyAdminEvents,
  committeePathTooWeak,
  type AdminEventRow,
} from '@/lib/oracleRegistry/config/adminReplay'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import {
  TOKEN_VOTE_MAX_SIGNERS,
  classifyControllerChange,
  compareRank,
  controllerRank,
  describeController,
  isEoaControlled,
  isRed,
  nodeReadGaps,
  rankHasReadGap,
  tokenVoteDecision,
} from '@/lib/oracleRegistry/config/rules'
import { getConfigSubjects } from '@/lib/oracleRegistry/config/subjects'
import type { ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { roleHash } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import {
  VOTE_SELF,
  classify,
  enrichTokenVotes,
  setLogClients,
  timelockSchedulers,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import {
  applyTransfer,
  holderSnapshots,
  topBalances,
} from '@/scripts/oracle-registry/config/lib/holders.mjs'
import { crossCheckedLogs } from '@/scripts/oracle-registry/config/lib/rpc.mjs'
import {
  LIDO_QUORUM,
  LIDO_SUPPORT,
  holderAddr,
  tokenVote,
  voteData,
} from './oracleRegistryVoteFixtures'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const DAY = 86_400
const SAFE = A('6')
const EOA = A('e')
const TL = A('c')
const PROXY = A('1')
const HC = A('d')
const VOTING = A('4')
const AGENT = A('3')
const EXEC = A('5')
const EPT = A('7')
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const safe = (a: string, t: number, n: number, o: Partial<Controller> = {}): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
  ...o,
})
const SAFE_6_11 = safe(SAFE, 6, 11)
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const tl = (
  delaySec: number,
  schedulers?: Controller[],
  o: Partial<Controller> = {},
): Controller => ({
  kind: 'oz_timelock',
  address: TL,
  delaySec,
  ...(schedulers ? { schedulers } : {}),
  ...o,
})
const plain = (a: string): Controller => ({ kind: 'contract', address: a })
const E18 = 10n ** 18n

const registry: DvnRegistry = {
  byChain: { 1: {} },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
const subject = (o: Partial<ConfigSubject> = {}): ConfigSubject => ({
  key: 'z',
  label: 'Z',
  oracleAssetKey: null,
  class: 'lrt',
  contracts: [
    { role: 'token', dimension: 'admin', chainId: 1, address: PROXY, label: 'p', deployBlock: 1 },
  ],
  lzOApps: [],
  ccipPools: [],
  powers: [],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
  ...o,
})
const rawOf = (o: { admin?: Partial<RawSubject['admin']>; head?: number }): RawSubject => ({
  version: 1,
  subjectKey: 'z',
  head: { block: o.head ?? 30_000_000, ts: 2000 },
  scan: { from: 1, to: o.head ?? 30_000_000 },
  lz: {
    events: [],
    headRoutes: [],
    headDefaults: {},
    remote: [],
    codeProbes: {},
    dvnSigner: [],
    dvnHead: {},
  },
  admin: {
    events: [],
    controllers: {},
    powers: [],
    timelockAdmins: [],
    implHistory: {},
    owners: {},
    delegates: {},
    minDelays: {},
    ...o.admin,
  },
  params: { head: {}, transitions: [] },
  queues: { ops: [], safe: [], safeStatus: [] },
  ccip: { pools: [] },
  warnings: [],
})
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
  chainId: 1,
  block: 100,
  logIndex: 0,
  tx: '0xt',
  emitter: HC,
  event: 'MemberAdded',
  args: {},
  ...o,
})
const powerOn = (holder: string, label = 'Upgrade P') => ({
  s: subject({
    powers: [{ power: 'upgrade', contract: PROXY, path: ['eip1967_admin'], label }],
  }),
  power: { power: 'upgrade' as const, label, contract: PROXY, holders: [holder] },
})
void OAPP

// =====================================================================================================
describe('UQ-17: a token vote ranks by HOLDER CONCENTRATION (owner ruling 2026-10-08)', () => {
  // the Lido thresholds: quorum (minimum acceptance) 5 %, support 50 %; a 5-day vote
  // The Lido Agent shape: executed by the vote itself through Dual Governance — a back-reference
  // (it votes only after a vote passed), never a voter of its own.
  const lidoAgent = (): Controller => ({
    kind: 'contract',
    address: AGENT,
    version: 'Aragon Agent',
    ownedBy: {
      kind: 'contract',
      address: EXEC,
      ownedBy: {
        kind: 'aragon_dg',
        address: EPT,
        delaySec: 691200,
        schedulers: [{ kind: 'aragon_voting', address: VOTING, selfRef: true }],
        dg: {
          afterSubmitDelaySec: 259200,
          afterScheduleDelaySec: 86400,
          governance: null,
          adminExecutor: EXEC,
          emergencyGovernance: null,
          activationCommittee: null,
          executionCommittee: null,
          emergencyModeActive: false,
          emergencyProtectionEndsAfter: null,
        },
      },
    },
  })
  it('MEASURED: LDO at block 26,152,213 — ONE holder passes a Lido vote alone (k = 1): ranked as an EOA', () => {
    // verified on chain (totalSupply / balanceOf at the block): supply 1e9 LDO; the Agent 12.15 %
    // (a back-reference); 0xf977…acec, an EOA (Binance hot wallet), 6.078 % — above the 5 %
    // minimum acceptance quorum on its own, and 100 % support when nobody else votes; 0x695c…7740
    // exactly 5.000 % (not above: Aragon's test is strict).
    const measured = tokenVote(VOTING, {
      voting: {
        voteTimeSec: 432000,
        objectionPhaseSec: 172800,
        token: '0x5a98fcbea516cf06857215779fd812ca3bef1b32',
        supportRequiredPct: LIDO_SUPPORT,
        minAcceptQuorumPct: LIDO_QUORUM,
        supply: '1000000000000000000000000000',
        holderCount: 66485,
        truncated: true,
        holders: [
          { address: AGENT, balance: '121497545794599365251635349', ctl: lidoAgent() },
          {
            address: '0xf977814e90da44bfa03b6295a0616a897441acec',
            balance: '60783425960000000000000000',
            ctl: eoa('0xf977814e90da44bfa03b6295a0616a897441acec'),
          },
        ],
      },
    })
    const d = tokenVoteDecision(measured)
    expect(d).toMatchObject({ kind: 'one', k: 1 })
    expect(d.kind === 'one' && d.holders[0].address).toBe(
      '0xf977814e90da44bfa03b6295a0616a897441acec',
    )
    expect(controllerRank(measured)[0]).toBe(1)
    expect(isEoaControlled(measured)).toBe(true)
  })
  it('a BROADLY HELD vote (synthetic, Lido thresholds) ranks above every multisig and reports k', () => {
    // the same Agent back-reference first; then no holder near 5 %: 13 of 4 % make 52 > 50
    const agent = lidoAgent()
    const lido = tokenVote(VOTING, {
      voting: voteData([121, ...Array.from({ length: 14 }, () => 4)], { ctls: { 0: agent } }),
    })
    const d = tokenVoteDecision(lido)
    // 13 independent holders of 4 make 52 > 50 (5 % of 1,000): k = 13
    expect(d).toMatchObject({ kind: 'broad', k: 13 })
    expect(controllerRank(lido)).toEqual([5, 0, 0, 432000])
    expect(describeController(lido)).toMatch(/broadly held: k = 13 of the largest holders/)
    // still above every multisig: Safe 6/11 → the vote is an upgrade
    expect(classifyControllerChange(SAFE_6_11, lido).severity).toBe('upgrade')
  })
  it('a synthetic ONE-WHALE vote ranks as an EOA (class [1]; the vote time is its delay stage)', () => {
    const whale = tokenVote(VOTING, { voting: voteData([60, 10, 10]) }) // 6 % > 5 % alone
    expect(tokenVoteDecision(whale)).toMatchObject({ kind: 'one', k: 1 })
    expect(controllerRank(whale)[0]).toBe(1)
    expect(isEoaControlled(whale)).toBe(true)
    // with a vote time under 24 h, exactly an EOA
    const fast = tokenVote(VOTING, { voteTimeSec: 3600, voting: voteData([60, 10]) })
    expect(compareRank(controllerRank(fast), controllerRank(eoa(EOA)))).toBe(0)
    // Safe 6/11 → it is RED (was an upgrade: every read vote ranked above every multisig)
    const v = classifyControllerChange(SAFE_6_11, whale)
    expect(isRed(v)).toBe(true)
    expect(v.ruleIds).toContain('AD-3')
    expect(describeController(whale)).toMatch(/ONE holder .* can pass a vote alone/)
  })
  it('a whale that is a CONTRACT ranks as that contract (follow it)', () => {
    // review round 10 (R-1): the next holder is examined too (it does not pass alone) — a list
    // that ends on a holder passing alone is not settled (a read gap)
    const w = tokenVote(VOTING, {
      voting: voteData([60, 10], { ctls: { 0: safe(A('a1'), 4, 7) } }),
    })
    expect(controllerRank(w).slice(0, 3)).toEqual([4, 4, -7])
    const owned = tokenVote(VOTING, {
      voting: voteData([60], {
        ctls: { 0: { kind: 'contract', address: A('a2'), ownedBy: eoa(EOA) } },
      }),
    })
    expect(controllerRank(owned)[0]).toBe(1)
  })
  it('a 3-HOLDER vote ranks as a 3-of-3 multisig', () => {
    const three = tokenVote(VOTING, { voteTimeSec: 3600, voting: voteData([20, 20, 20, 1]) })
    expect(tokenVoteDecision(three)).toMatchObject({ kind: 'few', k: 3 })
    expect(controllerRank(three)).toEqual([4, 3, -3])
    expect(describeController(three)).toMatch(
      /3 holders .* can pass a vote alone: ranked as a 3-of-3 multisig/,
    )
    // a Safe 6/11 outranks it: Safe 6/11 → this vote is red
    expect(isRed(classifyControllerChange(SAFE_6_11, three))).toBe(true)
  })
  it('the weakest-holder rule: a plain-contract holder among the k caps the vote at its rank', () => {
    const v = tokenVote(VOTING, {
      voteTimeSec: 3600,
      voting: voteData([20, 20, 20], { ctls: { 1: plain(A('a3')) } }),
    })
    expect(controllerRank(v)).toEqual([2])
    // a key-like holder (a contract an EOA owns) is an ordinary signer: no cap
    const k = tokenVote(VOTING, {
      voteTimeSec: 3600,
      // review round 10 (R-1): a fourth, smaller holder settles the passing sets of three
      voting: voteData([20, 20, 20, 1], {
        ctls: { 1: { kind: 'contract', address: A('a4'), ownedBy: eoa(EOA) } },
      }),
    })
    expect(controllerRank(k)).toEqual([4, 3, -3])
  })
  it('UNREAD holder data: a plain contract and a READ GAP (fail closed)', () => {
    const unread = tokenVote(VOTING, {
      voting: {
        voteTimeSec: 432000,
        objectionPhaseSec: null,
        holdersUnread: 'Transfer logs not read from block 5',
      },
    })
    expect(controllerRank(unread)).toEqual([2])
    expect(rankHasReadGap(unread)).toBe(true)
    expect(describeController(unread)).toMatch(/holder concentration UNREAD/)
    expect(nodeReadGaps(unread).join(' ')).toMatch(/holder concentration not read/)
    // no holder data at all (an old classification) is unread too
    const none: Controller = {
      kind: 'aragon_voting',
      address: VOTING,
      delaySec: 432000,
      voting: { voteTimeSec: 432000, objectionPhaseSec: null },
    }
    expect(controllerRank(none)).toEqual([2])
    // the head state lists it as a read gap
    const { s, power } = powerOn(VOTING)
    const out = build(
      s,
      rawOf({ admin: { powers: [power], controllers: { [`${VOTING}@head`]: unread } } }),
    )
    expect(out.state.readGaps?.join(' ')).toMatch(/holder concentration not read/)
    // a delay above it adds nothing (UQ-18): a 7-day timelock proposed by the unread vote
    expect(controllerRank(tl(7 * DAY, [unread]))).toEqual([2])
  })
  it('k is decided only on enough holders: a short truncated list is unread; 100 % support never passes', () => {
    const short = tokenVote(VOTING, { voting: voteData([4, 4, 4], { truncated: true }) })
    expect(tokenVoteDecision(short).kind).toBe('unread')
    const all = tokenVote(VOTING, { voting: voteData([4, 4, 4], { truncated: false }) })
    expect(tokenVoteDecision(all)).toMatchObject({ kind: 'broad', k: null })
    const never = tokenVote(VOTING, { voting: voteData([600], { support: E18.toString() }) })
    expect(tokenVoteDecision(never)).toMatchObject({ kind: 'broad' })
    expect(TOKEN_VOTE_MAX_SIGNERS).toBe(10)
  })
  it('the quorum is strict (Aragon `_isValuePct`: greater than): exactly 5 % is not enough', () => {
    const exact = tokenVote(VOTING, { voting: voteData([50, 1, 1], { truncated: false }) })
    expect(tokenVoteDecision(exact)).toMatchObject({ kind: 'few', k: 2 })
  })
})

// ---- UQ-17 collector: holders rebuilt from Transfer logs, verified, and classified ---------------
describe('UQ-17 collector: holder snapshots and the vote enrichment', () => {
  const TOKEN = A('70')
  const T = keccak256(toHex('Transfer(address,address,uint256)'))
  const ZERO = '0x0000000000000000000000000000000000000000'
  const tr = (block: number, from: string, to: string, v: bigint, i = 0) => ({
    address: TOKEN,
    topics: [T, pad(from as Hx, { size: 32 }), pad(to as Hx, { size: 32 })],
    data: toHex(v, { size: 32 }),
    blockNumber: toHex(block),
    logIndex: toHex(i),
  })
  const logs = [
    tr(10, ZERO, A('a1'), 600n),
    tr(10, ZERO, A('a2'), 400n, 1),
    tr(25, A('a1'), A('a3'), 100n),
    tr(31, A('a2'), ZERO, 50n), // burn
  ]
  const logClient = (rows: typeof logs, o: { emptyFrom?: number; failFrom?: number } = {}) => ({
    request: async ({ params }: { params: { fromBlock: string; toBlock: string }[] }) => {
      const a = Number(params[0].fromBlock)
      const b = Number(params[0].toBlock)
      if (o.failFrom !== undefined && a >= o.failFrom) throw new Error('boom')
      if (o.emptyFrom !== undefined && a >= o.emptyFrom) return []
      return rows.filter((l) => Number(l.blockNumber) >= a && Number(l.blockNumber) <= b)
    },
  })
  // the archive verification: balances after each block from the same history
  const truth = (block: number) => {
    const m = new Map<string, bigint>()
    let supply = 0n
    for (const l of logs) if (Number(l.blockNumber) <= block) supply += applyTransfer(m, l)
    return { m, supply }
  }
  const state = {
    readContract: async ({
      functionName,
      args,
      blockNumber,
    }: {
      functionName: string
      args?: string[]
      blockNumber: bigint
    }) => {
      const t = truth(Number(blockNumber))
      return functionName === 'totalSupply'
        ? t.supply
        : (t.m.get(String(args![0]).toLowerCase()) ?? 0n)
    },
  }
  it('topBalances / applyTransfer: largest first, burns and mints move the supply', () => {
    const t = truth(40)
    expect(t.supply).toBe(950n)
    expect(topBalances(t.m)).toEqual([
      [A('a1'), 500n],
      [A('a2'), 350n],
      [A('a3'), 100n],
    ])
  })
  it('one pass rebuilds every requested block, verified on chain (state AFTER the block)', async () => {
    const snaps = await holderSnapshots({
      logClients: { primary: logClient(logs), secondary: logClient(logs) },
      state,
      token: TOKEN,
      from: 1,
      blocks: [10, 24, 25, 40],
      span: 7,
    })
    expect(snaps.get(10)).toMatchObject({ supply: '1000', holderCount: 2 })
    expect(snaps.get(24)?.top?.[0]).toEqual([A('a1'), '600'])
    expect(snaps.get(25)?.top?.[0]).toEqual([A('a1'), '500'])
    expect(snaps.get(40)).toMatchObject({ supply: '950', holderCount: 3 })
  })
  it('a FALSE-EMPTY chunk on the first endpoint is corrected by the second (UQ-23 cross-check)', async () => {
    const snaps = await holderSnapshots({
      logClients: { primary: logClient(logs, { emptyFrom: 20 }), secondary: logClient(logs) },
      state,
      token: TOKEN,
      from: 1,
      blocks: [40],
      span: 7,
    })
    expect(snaps.get(40)).toMatchObject({ supply: '950' })
  })
  it('a chunk neither endpoint answers, or a rebuilt set that does not verify, is an ERROR (fail closed)', async () => {
    const lost = await holderSnapshots({
      logClients: {
        primary: logClient(logs, { failFrom: 22 }),
        secondary: logClient(logs, { failFrom: 22 }),
      },
      state,
      token: TOKEN,
      from: 1,
      blocks: [15, 40],
      span: 7,
    })
    expect(lost.get(15)).toMatchObject({ supply: '1000' })
    expect(lost.get(40)).toMatchObject({ error: expect.stringMatching(/not read from block 22/) })
    // both endpoints false-empty: the rebuilt balances disagree with balanceOf at the block
    const both = await holderSnapshots({
      logClients: {
        primary: logClient(logs, { emptyFrom: 20 }),
        secondary: logClient(logs, { emptyFrom: 20 }),
      },
      state,
      token: TOKEN,
      from: 1,
      blocks: [40],
      span: 7,
    })
    expect(both.get(40)).toMatchObject({ error: expect.stringMatching(/not verified/) })
  })
  it('enrichTokenVotes: holders classified at the block, the vote marked; examined until k is decided', async () => {
    // a world where holder 0 is the Agent whose executor is the vote itself, the rest EOAs
    const PROXY_CODE_SEL = [
      'implementation()',
      'kernel()',
      'appId()',
      'forward(bytes)',
      'execute(address,uint256,bytes)',
    ]
    const code =
      '0x6080' +
      PROXY_CODE_SEL.map((x) => '63' + keccak256(toHex(x)).slice(2, 10) + '14').join('') +
      '00'
    const RUN = roleHash('RUN_SCRIPT_ROLE')
    const holders = [AGENT, ...Array.from({ length: 13 }, (_, i) => holderAddr(i + 1))]
    const client = {
      getCode: async ({ address }: { address: string }) =>
        address.toLowerCase() === AGENT ? code : '0x',
      multicall: async ({ contracts }: { contracts: unknown[] }) =>
        contracts.map(() => ({ status: 'failure' })),
      getStorageAt: async () => '0x' + '0'.repeat(64),
      readContract: async (q: { address: string; functionName: string; args?: unknown[] }) => {
        const a = q.address.toLowerCase()
        if (a === AGENT && q.functionName === 'implementation') return AGENT
        if (a === AGENT && q.functionName === 'kernel') return A('8')
        if (a === A('8') && q.functionName === 'acl') return A('9')
        if (a === A('9') && q.functionName === 'hasPermission')
          return String(q.args![0]).toLowerCase() === VOTING && q.args![2] === RUN
        throw Object.assign(new Error('execution reverted'), {
          name: 'ContractFunctionRevertedError',
        })
      },
    }
    const { setAragonExecCandidates } =
      await import('@/scripts/oracle-registry/config/lib/admin.mjs')
    setAragonExecCandidates(new Map([[AGENT, new Set([VOTING])]]))
    const v: Controller = {
      kind: 'aragon_voting',
      address: VOTING,
      delaySec: 432000,
      voting: {
        voteTimeSec: 432000,
        objectionPhaseSec: null,
        token: A('70'),
        supportRequiredPct: (E18 / 2n).toString(),
        minAcceptQuorumPct: (E18 / 20n).toString(),
      },
    }
    const snap = {
      supply: (1000n * E18).toString(),
      holderCount: 5000,
      top: holders.map((h, i) => [h, ((i === 0 ? 121n : 4n) * E18).toString()]),
    }
    const n = await enrichTokenVotes(
      client,
      { [`${VOTING}@head`]: v },
      {
        head: 1000,
        decide: tokenVoteDecision,
        snapshotsFor: async () => new Map([[1000, snap]]),
      },
    )
    setAragonExecCandidates(new Map())
    expect(n).toBe(1)
    // the Agent's executor is the vote: a back-reference (no voter); 13 EOAs of 4 decide k = 13
    expect(v.voting?.holders?.[0].ctl?.executors?.[0]).toMatchObject({ selfRef: true })
    expect(tokenVoteDecision(v)).toMatchObject({ kind: 'broad', k: 13 })
    expect(v.voting?.holders).toHaveLength(14)
  })
  it('classify: the vote under evaluation is a back-reference wherever it is met (VOTE_SELF marker)', async () => {
    const c = await classify({} as never, VOTING, 5, 0, new Set([VOTE_SELF + VOTING]))
    expect(c).toEqual({ kind: 'aragon_voting', address: VOTING, selfRef: true })
    expect(controllerRank(c)[0]).toBe(7)
  })
})

// =====================================================================================================
describe('UQ-18: a delay never lifts a fail-closed rank', () => {
  it('a 7-day timelock whose only proposer is a timelock with an UNREAD proposer set ranks [2], no credit (was [2, 0, 0, 604800])', () => {
    const inner = tl(DAY, undefined, { address: A('c1') })
    const outer = tl(7 * DAY, [inner])
    expect(controllerRank(outer)).toEqual([2])
    expect(rankHasReadGap(outer)).toBe(true)
    // plain contract → it is NOT an upgrade
    expect(classifyControllerChange(plain(A('a9')), outer).severity).not.toBe('upgrade')
    expect(describeController(outer)).toMatch(
      /read gap below it: ranked as a plain contract, no delay credit/,
    )
  })
  it('the same for a proposer Safe whose module list was not read', () => {
    const s = safe(A('a8'), 4, 7, { modulesUnread: true })
    expect(controllerRank(tl(7 * DAY, [s]))).toEqual([2])
  })
  it('control: a read plain-contract proposer still earns the credit (no gap)', () => {
    expect(controllerRank(tl(7 * DAY, [plain(A('a7'))]))).toEqual([2, 0, 0, 7 * DAY])
  })
  it('a gap anywhere caps the whole rank: Safe 6/11 and an unread timelock both propose', () => {
    const r = controllerRank(tl(7 * DAY, [SAFE_6_11, tl(DAY, undefined, { address: A('c2') })]))
    expect(r).toEqual([2])
  })
})

// =====================================================================================================
describe('UQ-19: the committee path counts only when its own rank is not below the committee controller', () => {
  const TX = ('0x2aac8dd0' + '0'.repeat(56)) as Hx
  const swap = (emitter: string, event = 'CallExecuted') => [
    row({
      tx: TX,
      logIndex: 1,
      event: 'MemberAdded',
      args: { addr: A('f1'), newTotalMembers: '3', newQuorum: '2' },
    }),
    row({
      tx: TX,
      logIndex: 2,
      event,
      emitter,
      args: { target: HC, data: '0x' + A('f1').slice(2) },
    }),
  ]
  const ctx = (m: Record<string, Controller>, o: Record<string, unknown> = {}) => ({
    subject: 'z',
    ctl: (a: string, b: number) => m[`${a}@${b}`] ?? m[`${a}@head`] ?? null,
    upgradeTimelocks: {},
    deployBlocks: { [HC]: 10 },
    tokens: [],
    announcement: 'not_checked' as const,
    committeePaths: { [HC]: [TL] },
    txTo: { [TX]: TL },
    ...o,
  })
  const STRONG = A('b1') // the committee controller: a 7-day timelock proposed by Safe 6/11
  const strongCtl = tl(7 * DAY, [SAFE_6_11], { address: STRONG })
  it('a 60 s timelock proposed by the Safe is RED against a 7-day controller (was neutral)', () => {
    const out = classifyAdminEvents(
      swap(TL),
      ctx(
        { [`${TL}@head`]: tl(60, [SAFE_6_11]), [`${STRONG}@head`]: strongCtl },
        { committeeControllers: { [HC]: [STRONG] } },
      ),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(['AD-5'])
    expect(out[0].notes?.join(' ')).toMatch(
      /does not count as the delayed governance path: .*ranks below the committee's controller/,
    )
  })
  it('a 10-day timelock an EOA proposes into is RED', () => {
    const out = classifyAdminEvents(
      swap(TL),
      ctx(
        { [`${TL}@head`]: tl(10 * DAY, [eoa(EOA)]), [`${STRONG}@head`]: strongCtl },
        { committeeControllers: { [HC]: [STRONG] } },
      ),
    )
    expect(out[0].red).toBe(true)
  })
  it('control: the path IS the controller (equal rank) — neutral', () => {
    const out = classifyAdminEvents(
      swap(TL),
      ctx({ [`${TL}@head`]: strongCtl }, { committeeControllers: { [HC]: [TL] } }),
    )
    expect(out[0].red).toBe(false)
  })
  it('no declared controller: the path must rank at least as a multisig behind ≥ 24 h', () => {
    const weak = classifyAdminEvents(swap(TL), ctx({ [`${TL}@head`]: tl(60, [SAFE_6_11]) }))
    expect(weak[0].red).toBe(true)
    const ok = classifyAdminEvents(swap(TL), ctx({ [`${TL}@head`]: tl(2 * DAY, [SAFE_6_11]) }))
    expect(ok[0].red).toBe(false)
  })
  it('fail closed: a path controller that was not classified, or rests on a read gap, does not count', () => {
    expect(committeePathTooWeak({ ctl: () => null }, HC, TL, 100)).toMatch(
      /could not be classified/,
    )
    expect(
      committeePathTooWeak({ ctl: (a) => (a === TL ? tl(7 * DAY) : null) }, HC, TL, 100),
    ).toMatch(/read gap/)
  })
})

// =====================================================================================================
describe('UQ-20: the weETH committee power is declared (RoleRegistry role over the EtherFiOracle)', () => {
  it('subjects.json: the EtherFiOracle carries its RoleRegistry role and the RoleRegistry owner as powers', () => {
    const weeth = getConfigSubjects().subjects.find((s) => s.key === 'weeth')!
    const on = weeth.powers.filter(
      (p) => p.contract === '0x57aaf0004c716388b21795431cd7d5f9d3bb6a41',
    )
    expect(on.map((p) => p.path)).toEqual([
      [
        'call:roleRegistry()',
        'role:0xe6bda0fc5c63b525e475d178ed9c7fa9913b3429ade866197b11eb0f2c18c673',
      ],
      ['call:roleRegistry()', 'owner'],
    ])
  })
  it('engine: the head state shows the role over the committee, and the path comes from its holder', () => {
    const s = subject({
      contracts: [
        {
          role: 'oracle',
          dimension: 'oracle',
          chainId: 1,
          address: HC,
          label: 'EtherFiOracle',
          deployBlock: 1,
        },
      ],
      powers: [
        {
          power: 'oracle',
          contract: HC,
          path: ['call:roleRegistry()', 'role:0x' + 'e6'.repeat(32)],
          label: 'committee role',
        },
      ],
    })
    const out = build(
      s,
      rawOf({
        admin: {
          powers: [{ power: 'oracle', label: 'committee role', contract: HC, holders: [TL] }],
          controllers: { [`${TL}@head`]: tl(2 * DAY, [SAFE_6_11]) },
          events: [
            row({
              block: 200,
              tx: '0x1',
              logIndex: 1,
              event: 'CommitteeMemberAdded',
              args: { member: A('f2') },
            }),
            row({
              block: 200,
              tx: '0x1',
              logIndex: 2,
              event: 'CallExecuted',
              emitter: TL,
              args: { target: HC, data: '0x' + A('f2').slice(2) },
            }),
          ],
        },
      }),
    )
    expect(out.state.items.find((i) => i.key === `admin/power/oracle/${HC}`)?.display).toMatch(
      /committee role: Timelock 2d/,
    )
    expect(out.changes.find((c) => c.key === `oracle/committee/${HC}`)?.red).toBe(false)
  })
})

// =====================================================================================================
describe('UQ-21: a failed head read never ends a red', () => {
  const MINTING = A('2')
  const MC = A('b2')
  const ROLE = '0x' + 'ab'.repeat(32)
  const grant = row({
    emitter: MINTING,
    event: 'RoleGranted',
    block: 100,
    tx: '0x64',
    args: { role: ROLE, roleName: 'PROPOSER_ROLE', account: MC },
  })
  const s = subject({
    contracts: [
      {
        role: 'minting',
        dimension: 'mint_redeem',
        chainId: 1,
        address: MINTING,
        label: 'm',
        deployBlock: 1,
      },
    ],
  })
  it('a red grant to a timelock an EOA proposed into stays IN EFFECT when the head proposer read fails (was "no longer in effect")', () => {
    const out = build(
      s,
      rawOf({
        admin: {
          events: [grant],
          controllers: {
            [`${MC}@100`]: tl(10 * DAY, [eoa(EOA)], { address: MC }),
            [`${MC}@head`]: tl(10 * DAY, undefined, { address: MC }),
          },
        },
      }),
    )
    const g = out.changes.find((c) => c.key === `admin/role/${MINTING}/PROPOSER_ROLE`)!
    expect(g.red).toBe(true)
    expect(g.stillInEffect).toBe(true)
    expect(g.notes?.join(' ')).toMatch(/read gap .* a failed read never ends a red/)
    expect(g.notes?.join(' ')).not.toMatch(/NO LONGER IN EFFECT/)
  })
  it('control: a READ stronger head proposer still ends it', () => {
    const out = build(
      s,
      rawOf({
        admin: {
          events: [grant],
          controllers: {
            [`${MC}@100`]: tl(10 * DAY, [eoa(EOA)], { address: MC }),
            [`${MC}@head`]: tl(10 * DAY, [SAFE_6_11], { address: MC }),
          },
        },
      }),
    )
    const g = out.changes.find((c) => c.key === `admin/role/${MINTING}/PROPOSER_ROLE`)!
    expect(g.stillInEffect).toBeFalsy()
  })
})

// =====================================================================================================
describe('UQ-22: AD-6 (a Safe module) carries through a timelock to its proposers', () => {
  it('a power held by a 0 s timelock whose proposer Safe has a module is AD-6 at head (wstETH Linea bridge shape)', () => {
    const modSafe = safe(A('b8'), 3, 5, { modules: [A('78')] })
    const t = tl(0, [safe(A('89'), 5, 9, { modules: [] }), modSafe])
    expect(controllerRank(t)).toEqual([2]) // the timelock inherits the plain-contract rank
    const { s, power } = powerOn(TL, 'Upgrade the Linea bridge (L1 side)')
    const out = build(s, rawOf({ admin: { powers: [power], controllers: { [`${TL}@head`]: t } } }))
    const item = out.state.items.find((i) => i.key === `admin/power/upgrade/${PROXY}`)!
    expect(item.breaches.map((b) => b.ruleId)).toContain('AD-6')
    expect(item.breaches.find((b) => b.ruleId === 'AD-6')?.message).toMatch(/0xb8b8…b8b8.*module/)
  })
  it('subjects.json declares the wstETH proposer Safe, so its module history is scanned', () => {
    const w = getConfigSubjects().subjects.find((s) => s.key === 'wsteth')!
    expect(w.safes).toContain('0xb8f5524d73f549cf14a0587a3c7810723f9c0051')
    expect(w.contracts.map((c) => c.address)).toContain(
      '0xb8f5524d73f549cf14a0587a3c7810723f9c0051',
    )
  })
})

// =====================================================================================================
describe('UQ-23: proposer-log reads cross-check empty chunks on a second endpoint', () => {
  const GRANTED = keccak256(toHex('RoleGranted(bytes32,address,address)'))
  const PROPOSER = roleHash('PROPOSER_ROLE').toLowerCase()
  const grantLog = (t: string) => ({
    address: t,
    topics: [GRANTED, PROPOSER, pad(SAFE, { size: 32 }), pad(SAFE, { size: 32 })],
    data: '0x',
    blockNumber: '0x5',
  })
  const ep = (answer: 'logs' | 'empty' | 'fail', t: string) => ({
    request: async () => {
      if (answer === 'fail') throw new Error('timeout')
      return answer === 'logs' ? [grantLog(t)] : []
    },
  })
  it('crossCheckedLogs: an empty answer is asked again; a failure without a confirming empty throws', async () => {
    const q = { address: TL, topics0: [GRANTED], fromBlock: 1, toBlock: 10 }
    expect((await crossCheckedLogs(ep('empty', TL), ep('logs', TL), q)).logs).toHaveLength(1)
    expect((await crossCheckedLogs(ep('empty', TL), ep('logs', TL), q)).corrected).toBe(true)
    expect((await crossCheckedLogs(ep('empty', TL), ep('empty', TL), q)).logs).toEqual([])
    await expect(crossCheckedLogs(ep('fail', TL), ep('empty', TL), q)).rejects.toThrow()
    await expect(crossCheckedLogs(ep('empty', TL), null, q)).rejects.toThrow()
  })
  it('timelockSchedulers: a false-empty chunk on the first endpoint no longer drops the proposer (was unread)', async () => {
    const t = A('a6')
    const SINGLETON = '0x' + '0'.repeat(24) + 'd9db270c1b5e3bd161e8c8503c55ceabee709552'
    const revert = () =>
      Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
    const world = {
      getCode: async ({ address }: { address: string }) =>
        address.toLowerCase() === SAFE
          ? '0x60806040'
          : address.toLowerCase() === t
            ? '0x6080'
            : '0x',
      getBlockNumber: async () => 1000n,
      multicall: async ({
        contracts,
      }: {
        contracts: { address: string; functionName: string }[]
      }) =>
        contracts.map((c) =>
          c.address.toLowerCase() === SAFE && c.functionName === 'getThreshold'
            ? { status: 'success', result: 6n }
            : c.address.toLowerCase() === SAFE && c.functionName === 'getOwners'
              ? {
                  status: 'success',
                  result: Array.from(
                    { length: 11 },
                    (_, i) => '0x' + String(i + 1).padStart(40, '0'),
                  ),
                }
              : { status: 'failure' },
        ),
      getStorageAt: async ({ address, slot }: { address: string; slot: string }) =>
        address.toLowerCase() === SAFE && BigInt(slot) === 0n ? SINGLETON : '0x' + '0'.repeat(64),
      readContract: async (q: { address: string; functionName: string; args?: unknown[] }) => {
        const a = q.address.toLowerCase()
        if (a === SAFE && q.functionName === 'getModulesPaginated')
          return [[], '0x0000000000000000000000000000000000000001']
        if (a !== t) throw revert()
        if (q.functionName === 'getRoleAdmin') return roleHash('TIMELOCK_ADMIN_ROLE')
        if (q.functionName === 'hasRole')
          return (
            String(q.args![0]).toLowerCase() === PROPOSER &&
            String(q.args![1]).toLowerCase() === SAFE
          )
        throw revert()
      },
      // the state ring: false-empty
      request: async () => [],
    }
    setLogClients(ep('empty', t), ep('logs', t))
    try {
      const r = await timelockSchedulers(world, t, 900)
      expect(r.unread).toBe(false)
      expect(r.schedulers.map((c: Controller) => c.address)).toEqual([SAFE])
    } finally {
      setLogClients(null)
    }
  })
})

// =====================================================================================================
describe('UQ-24: bypass holders and DSPause authorities are ranked; unranked fails closed', () => {
  const bypass = (holderCtls?: Controller[]): Controller =>
    tl(7 * DAY, [SAFE_6_11], {
      bypass: {
        fn: 'bypasserExecuteBatch',
        scope: 'any',
        holders: (holderCtls ?? [eoa(EOA)]).map((h) => h.address),
        ...(holderCtls ? { holderCtls } : {}),
      },
    })
  it('EOA → a timelock whose unrestricted bypasser is that same EOA is NOT an upgrade (was [2])', () => {
    const t = bypass([eoa(EOA)])
    expect(controllerRank(t)).toEqual([1])
    expect(classifyControllerChange(eoa(EOA), t).severity).not.toBe('upgrade')
    expect(describeController(t)).toMatch(/held by EOA 0xeeee…eeee/)
  })
  it('a bypass held by a Safe 6/11 ranks as that Safe with NO credit from the bypassed delay', () => {
    expect(controllerRank(bypass([SAFE_6_11]))).toEqual([4, 6, -11])
  })
  it('an unclassified bypasser is a read gap: plain contract, and listed', () => {
    const t = bypass(undefined)
    expect(controllerRank(t)).toEqual([2])
    expect(rankHasReadGap(t)).toBe(true)
    expect(nodeReadGaps(t).join(' ')).toMatch(/bypassers not classified/)
  })
  it('a DSPause with a non-zero authority whose callers were not read: plain contract, read gap', () => {
    const p: Controller = {
      kind: 'ds_pause',
      address: A('d5'),
      delaySec: 2 * DAY,
      schedulers: [SAFE_6_11],
      dsAuthority: { address: A('d6') },
    }
    expect(controllerRank(p)).toEqual([2])
    expect(rankHasReadGap(p)).toBe(true)
    expect(nodeReadGaps(p).join(' ')).toMatch(/callers its authority .* permits were not read/)
    // its permitted callers read: ranked as the weakest of owner and callers, with the credit
    const read = { ...p, dsAuthority: { address: A('d6'), callers: [safe(A('d7'), 3, 5)] } }
    expect(controllerRank(read)).toEqual([4, 3, -5, 2 * DAY])
  })
})

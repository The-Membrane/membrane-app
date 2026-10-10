// Config cards — fail-closed audit (2026-10-10), part 5: the remaining read sites — the collector's
// own helpers (head route eids, the AD-7 holder read, the oracle input file, skipped remote sides),
// the classification markers of a Dual Governance proposer and of an unclassified new value, a
// Safe's setup without a confirmed deploy block, the module baseline across an unread run, and the
// history read gaps. Every test failed on the code before its fix unless it is marked (control);
// the ones written after their fix were run against the pre-fix files (`git show HEAD:<file>`).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { keccak256, pad, toFunctionSelector, toHex } from 'viem'
import { describe, expect, it } from 'vitest'

import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import { runLzBacktest, type LzFixture } from '@/lib/oracleRegistry/config/backtest'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import { classifyCcip, classifyParamChange, isRed } from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigSubject,
  Controller,
  ParamSpec,
  SubjectState,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { roleHash } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import {
  classifyDgTimelock,
  opsFromEvents,
  resolvePath as resolvePathJs,
  setLogClients,
  timelockAdminHolders,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { readOracleChanges } from '@/scripts/oracle-registry/config/lib/files.mjs'
import {
  headRouteEids,
  replayDvnSigners,
  skippedRemoteSides,
} from '@/scripts/oracle-registry/config/lib/lz.mjs'
import { seedLzState } from '@/scripts/oracle-registry/config/lib/seed.mjs'

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const OAPP = A('a')
const PROXY = A('1')
const SAFE = A('6')
const TL = A('7')
const EOA = A('e')
const NTTM = A('8')
const sel = (sig: string) => toFunctionSelector(`function ${sig}`).slice(2)
const codeWith = (sigs: string[]) =>
  '0x6080' + sigs.map((x) => '63' + sel(x) + '14').join('') + '00'
const httpErr = () => Object.assign(new Error('HTTP 503'), { name: 'HttpRequestError' })
const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
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
const rawOf = (o: { admin?: Partial<RawSubject['admin']>; head?: number } = {}): RawSubject =>
  ({
    version: 1,
    subjectKey: 'z',
    head: { block: o.head ?? 1_000_000, ts: 2_000_000_000 },
    scan: { from: 1, to: o.head ?? 1_000_000 },
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
  }) as RawSubject
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const gaps = (st: SubjectState) => (st.readGaps ?? []).join('\n')

// =====================================================================================================
describe('LZ-01 / EV-06 (collector helper): the head route eids never depend on events alone', () => {
  it('an eid the previous run had an item for, or a sweep found live, is read even with no event (it was never read)', () => {
    const prevItems = [{ key: `bridge/lz/1/${OAPP}/30110/receive` }]
    expect(headRouteEids(OAPP, [], prevItems, [30184]).sort()).toEqual([30110, 30184])
  })
})

describe('RC-M7 (collector helper): skipped remote sides are REMOTE UNREAD placeholders', () => {
  it('every side the collector would read is a placeholder (it was absent: "no red flags")', () => {
    const out = skippedRemoteSides(
      new Map([[30110, [{ oapp: OAPP, peer: '0x' + '0'.repeat(24) + 'ab'.repeat(20) }]]]),
      {
        eids: { 30110: { chainKey: 'arbitrum' } },
        chains: { 30110: { chainId: 42161 } },
      },
    )
    expect(out).toEqual([
      expect.objectContaining({ oapp: OAPP, eid: 30110, status: 'remote_unread', chainId: 42161 }),
    ])
  })
})

describe('PO-07 / MISSED-1 (collector helper): the oracle governance input', () => {
  it('missing: a read gap ("unread"), never an empty read; unparsable: the run stops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-or-'))
    try {
      expect(readOracleChanges(join(dir, 'none.json'))).toMatchObject({
        events: [],
        unread: expect.any(String),
      })
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, '{"events":[{"bl')
      expect(() => readOracleChanges(bad)).toThrow()
      const ok = join(dir, 'ok.json')
      writeFileSync(
        ok,
        JSON.stringify({ events: [], window: { startBlock: 1, endBlock: 2, days: 1 } }),
      )
      expect(readOracleChanges(ok).unread).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PH-13 (collector helper): the AD-7 holders are read on the timelock, not only from the admin scan', () => {
  const ADMIN = roleHash('TIMELOCK_ADMIN_ROLE').toLowerCase()
  const fake = (o: {
    logs?: () => unknown
    count?: unknown
    member?: unknown
    hasRole?: unknown
  }) => ({
    getCode: async () => '0x6080',
    getBlockNumber: async () => 2000n,
    readContract: async ({ functionName }: { functionName: string }) => {
      const v =
        functionName === 'getRoleMemberCount'
          ? o.count
          : functionName === 'getRoleMember'
            ? o.member
            : functionName === 'hasRole'
              ? (o.hasRole ?? true)
              : undefined
      if (v === undefined) throw revert()
      if (v instanceof Error) throw v
      return v
    },
    request: async () => (o.logs ? o.logs() : []),
  })
  it("a RoleGranted the admin scan lost is found in the timelock's own logs (an EOA admin: AD-7)", async () => {
    const grant = {
      address: TL,
      topics: [
        keccak256(toHex('RoleGranted(bytes32,address,address)')),
        ADMIN,
        pad(EOA, { size: 32 }),
        pad(EOA, { size: 32 }),
      ],
      data: '0x',
      blockNumber: '0x10',
      logIndex: '0x0',
      transactionHash: '0x' + '1'.repeat(64),
    }
    const c = fake({ logs: () => [grant] })
    setLogClients(c, c)
    try {
      const r = await timelockAdminHolders(c, TL, ['TIMELOCK_ADMIN_ROLE', 'DEFAULT_ADMIN_ROLE'], [])
      expect(r.holders).toContain(EOA)
      expect(r.unread).toBe(false)
    } finally {
      setLogClients(null, null)
    }
  }, 60_000)
  it('logs not readable and no enumeration: UNREAD (a read gap), never "no holder"', async () => {
    const c = fake({
      logs: () => {
        throw new Error('down')
      },
    })
    setLogClients(c, c)
    try {
      const r = await timelockAdminHolders(c, A('2'), ['TIMELOCK_ADMIN_ROLE'], [])
      expect(r.unread).toBe(true)
    } finally {
      setLogClients(null, null)
    }
  }, 60_000)
})

// =====================================================================================================
describe('TV-12 / DG cycle: a Dual Governance proposer that cannot be decided', () => {
  const EPT = A('b')
  const GOV = A('c')
  const VOTE = A('4')
  const DG_CODE = codeWith([
    'getAfterSubmitDelay()',
    'getAfterScheduleDelay()',
    'getGovernance()',
    'getProposal(uint256)',
    'execute(uint256)',
  ])
  const APP_CODE = codeWith(['implementation()', 'kernel()', 'appId()'])
  const client = (proposer: string, implErr = true) => ({
    getCode: async ({ address }: { address: string }) =>
      address.toLowerCase() === EPT
        ? DG_CODE
        : address.toLowerCase() === proposer
          ? APP_CODE
          : '0x',
    getBlockNumber: async () => 10n,
    getStorageAt: async () => '0x' + '0'.repeat(64),
    multicall: async ({ contracts }: { contracts: unknown[] }) =>
      contracts.map(() => ({ status: 'failure', error: revert() })),
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      const a = address.toLowerCase()
      if (a === EPT && functionName === 'getAfterSubmitDelay') return 259_200
      if (a === EPT && functionName === 'getAfterScheduleDelay') return 86_400
      if (a === EPT && functionName === 'getGovernance') return GOV
      if (a === GOV && functionName === 'getProposers')
        return [{ account: proposer, executor: A('5') }]
      if (a === proposer && functionName === 'implementation') {
        if (implErr) throw httpErr()
        return A('9')
      }
      throw revert()
    },
  })
  it('TV-12: a proposer Voting whose implementation was not read is a marker AND the vote time is unread', async () => {
    const c = await classifyDgTimelock(client(VOTE), EPT)
    expect(c.schedulers.some((x: Controller) => x.appUnread)).toBe(true)
    expect(c.dg.proposerVoteUnread).toBe(true)
  }, 60_000)
  it('a proposer already on the control path is a cycle placeholder (it was dropped)', async () => {
    const c = await classifyDgTimelock(client(SAFE, false), EPT, undefined, 0, new Set([SAFE]))
    expect(c.schedulers).toEqual([expect.objectContaining({ kind: 'contract', address: SAFE })])
  }, 60_000)
})

// =====================================================================================================
describe('CL-08: a NEW value whose controller could not be classified is judged fail closed', () => {
  const spec = {
    key: 'rp',
    contract: PROXY,
    sig: 'x',
    rule: 'rate_provider',
    label: 'rate provider',
  } as ParamSpec
  it('classifyParamChange: a provider moved to an unclassified address is red MR-2 (it read amber)', () => {
    const v = classifyParamChange(spec, A('2'), A('3'), null, { nextVerified: true })
    expect(isRed(v)).toBe(true)
    expect(v.tags).toContain('read_gap')
  })
  it('classifyCcip: a new rebalancer not classified is red CC-3', () => {
    const v = classifyCcip('rebalancer', { prevCtl: null, nextCtl: null, nextUnread: 'x' })
    expect(v.ruleIds).toContain('CC-3')
  })
})

describe('ST-04 (b): a Safe event is its setup only in its CONFIRMED deploy block', () => {
  it('"no code one block earlier" with the deploy block unknown is a change with a read gap (it was "initialization")', () => {
    const row: AdminEventRow = {
      chainId: 1,
      block: 500,
      logIndex: 0,
      tx: '0xm' as Hx,
      emitter: SAFE,
      event: 'EnabledModule',
      args: { module: A('9') },
    }
    const out = classifyAdminEvents([row], {
      subject: 's',
      ctl: () => null,
      ctlExact: (a: string, b: number) =>
        a === SAFE && b === 499 ? { kind: 'eoa', address: SAFE } : null,
      upgradeTimelocks: {},
      deployBlocks: {},
      tokens: [],
      announcement: 'not_checked',
    })
    expect(out[0].tags).not.toContain('initialization')
    expect(out[0].tags).toContain('read_gap')
    expect(out[0].red).toBe(true)
  })
})

// =====================================================================================================
describe('SQ-07 / NB-06 (engine)', () => {
  const safe = (o: Partial<Controller>): Controller => ({
    kind: 'safe',
    address: SAFE,
    threshold: 3,
    signers: 5,
    singleton: '0x41675c099f32341bf84bfc5382af534df5c7461a',
    ...o,
  })
  it('SQ-07: a module list not read this run keeps the last read one in the snapshot (no baseline was kept)', () => {
    const st = build(
      subject({ safes: [SAFE] }),
      rawOf({
        head: 2_000_000,
        admin: {
          controllers: { [`${SAFE}@head`]: safe({ modulesUnread: true }) },
          previousSafes: { block: 1_000_000, controllers: { [SAFE]: safe({ modules: [] }) } },
        },
      }),
    ).state
    const snap = st.safeSnapshot!.find((c) => c.address === SAFE)!
    expect(snap.modules).toEqual([])
    expect(snap.modulesReadAt).toBe(1_000_000)
  })
  it('NB-06: a history transceiver whose verifier network was not read is a listed read gap', () => {
    const st = build(
      subject({ nttManagers: [NTTM] }),
      rawOf({
        admin: {
          events: [
            {
              chainId: 1,
              block: 100,
              logIndex: 0,
              tx: '0xn' as Hx,
              emitter: NTTM,
              event: 'TransceiverAdded',
              args: { transceiver: A('9'), transceiverType: null },
            },
          ],
        },
      }),
    ).state
    expect(gaps(st)).toMatch(/verifier network not read \(history/)
  })
})

// =====================================================================================================
describe('RC-13 / RC-14 (backtest): a fixture is never built from, nor evaluated on, a failed read', () => {
  it('RC-13: seedLzState STOPS on a read that failed (it dropped it: no peer, a default instead of an override)', async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'peers') throw httpErr()
        throw revert()
      },
    }
    await expect(
      seedLzState(client, { chainId: 130, endpoint: EP, oapp: OAPP, eids: [30101], block: 5 }),
    ).rejects.toThrow()
  }, 60_000)
  it('RC-14: a point read whose getConfig was NOT READ is "NOT READ" and never a match (it was "reverted (no DVN)")', () => {
    const fx = JSON.parse(
      readFileSync(
        join(process.cwd(), 'data/oracle-registry/config/backtest/kelp-rseth.fixture.json'),
        'utf8',
      ),
    ) as LzFixture
    const pr = fx.local.pointReads[0]
    const bad = {
      ...fx,
      local: { ...fx.local, pointReads: [{ ...pr, merged: null, ok: false, error: 'timeout' }] },
    }
    const out = runLzBacktest(bad, pr.block)
    expect(out.crossChecks[0].read).toMatch(/NOT READ/)
    expect(out.crossChecks[0].match).toBe(false)
  })
})

describe('MS-3 (engine): an Aragon Agent holder keeps its AD-3 while the ACL scan is not confirmed', () => {
  it('a lost executor candidate cannot drop the breach silently: the ACL scan gap carries it', () => {
    const AGENT = A('3')
    const agent = (exec: Controller): Controller => ({
      kind: 'contract',
      address: AGENT,
      version: 'Aragon Agent',
      executors: [exec],
      ownedBy: exec,
    })
    const s = subject({
      powers: [{ power: 'upgrade', contract: PROXY, path: ['owner'], label: 'P' }],
    })
    const raw = (exec: Controller, extra: Record<string, unknown> = {}) =>
      ({
        ...rawOf({
          admin: {
            powers: [{ power: 'upgrade', label: 'P', contract: PROXY, holders: [AGENT] }],
            controllers: { [`${AGENT}@head`]: agent(exec) },
          },
        }),
        ...extra,
      }) as RawSubject
    const run1 = build(s, raw({ kind: 'eoa', address: EOA })).state
    expect(run1.items.flatMap((i) => i.breaches).filter((b) => b.ruleId === 'AD-3')).toHaveLength(1)
    const st = build(
      s,
      raw(
        { kind: 'safe', address: SAFE, threshold: 4, signers: 7, modules: [] },
        {
          previousHead: { block: run1.asOf.block, items: run1.items },
          scanGaps: [
            {
              scan: 'Aragon ACL scan (before the window)',
              from: 1,
              to: 9,
              error: 'x',
              addresses: [A('9')],
            },
          ],
        },
      ),
    ).state
    expect(st.items.flatMap((i) => i.breaches).filter((b) => b.ruleId === 'AD-3')).toHaveLength(1)
  })
})

// =====================================================================================================
describe('LZ-15 (UNSURE, fixed): a DVN signer row whose state before was carried, not read', () => {
  it('the archive read failed: the row says its prev is carried (it was indistinguishable from a read)', async () => {
    const DVN = A('d')
    const rows = [
      {
        emitter: DVN,
        block: 100,
        logIndex: 0,
        tx: '0x1',
        event: 'UpdateQuorum',
        args: { _quorum: 2 },
      },
      {
        emitter: DVN,
        block: 200,
        logIndex: 0,
        tx: '0x2',
        event: 'UpdateQuorum',
        args: { _quorum: 1 },
      },
    ]
    const out = await replayDvnSigners(rows, async (_d: string, b: number) =>
      b === 99 ? { quorum: 3, signers: 5 } : { quorum: null, signers: null },
    )
    expect(out[1]).toMatchObject({ prevCarried: true })
  })
})

// =====================================================================================================
describe('QU-05 (4): an op whose CallScheduled rows have holes', () => {
  it('a call index never seen (a lost log) marks the op incomplete (it was judged as complete)', () => {
    const row = (index: number) => ({
      emitter: TL,
      event: 'CallScheduled',
      block: 10,
      tx: '0xs',
      args: {
        id: '0xop',
        index,
        target: PROXY,
        value: '0',
        data: '0x',
        predecessor: '0x' + '0'.repeat(64),
        delay: 86400,
      },
    })
    const ops = opsFromEvents([row(1)], TL)
    expect(ops[0].callsIncomplete).toBe(true)
    expect(opsFromEvents([row(0), row(1)], TL)[0].callsIncomplete).toBeUndefined()
  })
})

// =====================================================================================================
describe('PH-03 / MS-5: role holders of a power on a contract that cannot list them', () => {
  const resolvePath = resolvePathJs as unknown as (
    c: unknown,
    o: Record<string, unknown>,
  ) => Promise<string[]>
  const ROLE = roleHash('MINTER_ROLE').toLowerCase()
  const C1 = A('5')
  const client = (o: { count?: unknown }) => ({
    getCode: async () => '0x6080',
    getBlockNumber: async () => 2000n,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === 'hasRole') return String(args?.[1]).toLowerCase() === EOA
      if (functionName === 'getRoleMemberCount' && o.count !== undefined) return o.count
      if (functionName === 'getRoleMember') return EOA
      throw revert()
    },
    request: async () => [
      {
        address: C1,
        topics: [
          keccak256(toHex('RoleGranted(bytes32,address,address)')),
          ROLE,
          pad(EOA, { size: 32 }),
          pad(EOA, { size: 32 }),
        ],
        data: '0x',
        blockNumber: '0x20',
        logIndex: '0x0',
        transactionHash: '0x' + '2'.repeat(64),
      },
    ],
  })
  it("PH-03: a holder the admin scan lost is found in the contract's own RoleGranted logs (it vanished, AD-3 with it)", async () => {
    const c = client({})
    setLogClients(c, c)
    try {
      const hs = await resolvePath(c, {
        endpoint: EP,
        contract: C1,
        path: ['role:MINTER_ROLE'],
        roleMap: new Map(),
      })
      expect(hs).toContain(EOA)
    } finally {
      setLogClients(null, null)
    }
  }, 60_000)
  it('MS-5: more members than read is an error, never a silent cut at 50', async () => {
    const c = client({ count: 250n })
    await expect(
      resolvePath(c, {
        endpoint: EP,
        contract: A('4'),
        path: ['role:MINTER_ROLE'],
        roleMap: new Map(),
      }),
    ).rejects.toThrow()
  }, 60_000)
})

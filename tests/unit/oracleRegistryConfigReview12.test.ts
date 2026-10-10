// Config cards — review round 12 (2026-10-10): the review of the round-12 work (UQ-30, UQ-31 and
// the re-collection). Two reviewers found paths where a failed read could still drop a head
// breach, end a red or read calm, and two where a red was kept in effect on a read failure that
// never happened. Every test failed on the code before the fix except the controls, which are
// marked. Standing rulings: a failed read never ends a red; fail closed everywhere.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'

import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import {
  buildSubject,
  rejudgeRoleHoldersAtHead,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import {
  classifyControllerChange,
  classifyRoleAdminChange,
  controllerRank,
  rankHasReadGap,
  treeReadGaps,
} from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  SubjectState,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { countsOf } from '@/lib/oracleRegistry/config/view'
import {
  aragonAgentOf,
  coHolderReads,
  hasReadFailure,
  readCcipPool,
  resolvePath as resolvePathJs,
  setLogClients,
  timelockBypass,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { readPreviousState, writeJsonAtomic } from '@/scripts/oracle-registry/config/lib/files.mjs'
import { crossCheckedLogs } from '@/scripts/oracle-registry/config/lib/rpc.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const PROXY = A('1')
const PADMIN = A('2')
const AGENT = A('3')
const EXEC = A('5')
const SAFE = A('6')
const TL = A('7')
const EPT = A('8')
const MS = A('9')
const POOL = A('c')
const EOA2 = A('d')
const EOA = A('e')
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const SINGLETON = '0x41675c099f32341bf84bfc5382af534df5c7461a'
const HEAD1 = 30_000_000
const HEAD2 = 30_007_200
const HEAD3 = 30_014_400

const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
const zeroData = () =>
  Object.assign(new Error('returned no data ("0x")'), { name: 'ContractFunctionZeroDataError' })
const httpErr = () =>
  Object.assign(new Error('HTTP request failed. Status: 503'), { name: 'HttpRequestError' })
const word = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const sel = (sig: string) => toFunctionSelector(`function ${sig}`).slice(2)
const codeWith = (sigs: string[]) =>
  '0x6080' + sigs.map((x) => '63' + sel(x) + '14').join('') + '00'

const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const safe = (a: string, t: number, n: number, extra: Partial<Controller> = {}): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
  modules: [],
  owners: Array.from({ length: n }, (_, i) => '0x' + String(i + 1).padStart(40, '0')),
  singleton: SINGLETON,
  ...extra,
})
const timelock = (
  a: string,
  delaySec: number,
  schedulers: Controller[],
  extra: Partial<Controller> = {},
): Controller => ({ kind: 'oz_timelock', address: a, delaySec, schedulers, ...extra })
const dg = (emergencyModeActive: boolean | null): Controller => ({
  kind: 'aragon_dg',
  address: EPT,
  delaySec: 259200,
  schedulers: [safe(SAFE, 5, 10)],
  dg: {
    afterSubmitDelaySec: 259200,
    afterScheduleDelaySec: 86400,
    governance: null,
    adminExecutor: EXEC,
    emergencyGovernance: null,
    activationCommittee: '0x0000000000000000000000000000000000000000',
    executionCommittee: '0x0000000000000000000000000000000000000000',
    emergencyModeActive,
    emergencyProtectionEndsAfter: null,
  },
})

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
  powers: [{ power: 'upgrade', contract: PROXY, path: ['owner'], label: 'Owner P' }],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
  ...o,
})
type Prev = { block: number; changes: ConfigChange[] }
const safesOf = (st: SubjectState) => ({
  block: st.asOf.block,
  controllers: Object.fromEntries((st.safeSnapshot ?? []).map((c) => [c.address, c])),
  readAt: (st as SubjectState & { safeReadAt?: Record<string, number> }).safeReadAt,
})
const rawOf = (o: {
  head: number
  holders?: string[]
  controllers?: Record<string, Controller>
  previous?: SubjectState
  previousChanges?: Prev
  previousQueue?: Prev
  previousSafes?: ReturnType<typeof safesOf>
  ccip?: RawSubject['ccip']
  multisigStatus?: { multisig: string; status: 'ok' | 'unavailable'; note?: string }[]
}): RawSubject =>
  ({
    version: 1,
    subjectKey: 'z',
    head: { block: o.head, ts: 2000 },
    scan: { from: 1, to: o.head },
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
      controllers: o.controllers ?? {},
      powers: o.holders
        ? [{ power: 'upgrade', label: 'Owner P', contract: PROXY, holders: o.holders }]
        : [],
      timelockAdmins: [],
      implHistory: {},
      owners: {},
      delegates: {},
      minDelays: {},
      ...(o.previousSafes ? { previousSafes: o.previousSafes } : {}),
    },
    params: { head: {}, transitions: [] },
    queues: {
      ops: [],
      safe: [],
      safeStatus: [],
      ...(o.multisigStatus ? { multisig: [], multisigStatus: o.multisigStatus } : {}),
    },
    ccip: o.ccip ?? { pools: [] },
    ...(o.previous
      ? { previousHead: { block: o.previous.asOf.block, items: o.previous.items } }
      : {}),
    ...(o.previousChanges ? { previousChanges: o.previousChanges } : {}),
    ...(o.previousQueue ? { previousQueue: o.previousQueue } : {}),
    warnings: [],
  }) as RawSubject
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const breachesBy = (st: SubjectState, rule: string) =>
  st.items.flatMap((i) => i.breaches).filter((b) => b.ruleId === rule)

/** A viem-like client: per `${address}|${fn}` answers (a function = per args; an Error is thrown). */
function fake(o: {
  code?: Record<string, string>
  reads?: Record<string, unknown>
  storage?: Record<string, string>
  logs?: (q: { address: unknown; fromBlock: string; toBlock: string }) => unknown[]
}) {
  const lc = (x: string) => x.toLowerCase()
  return {
    getCode: async ({ address }: { address: string }) => o.code?.[lc(address)] ?? '0x',
    getBlockNumber: async () => 2_000_000n,
    getStorageAt: async ({ address, slot }: { address: string; slot: string }) =>
      o.storage?.[`${lc(address)}|${slot}`] ?? '0x' + '0'.repeat(64),
    multicall: async ({
      contracts,
    }: {
      contracts: { address: string; functionName: string; args?: unknown[] }[]
    }) =>
      contracts.map((c) => {
        const v = o.reads?.[`${lc(c.address)}|${c.functionName}`]
        if (v === undefined || v instanceof Error) return { status: 'failure' }
        return { status: 'success', result: typeof v === 'function' ? v(c.args ?? []) : v }
      }),
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
    request: async ({
      method,
      params,
    }: {
      method: string
      params: { address: unknown; fromBlock: string; toBlock: string }[]
    }) => {
      if (method !== 'eth_getLogs') throw new Error('unexpected ' + method)
      return o.logs ? o.logs(params[0]) : []
    },
  }
}
// the collector is JavaScript: its inferred parameter types are narrowed here
const resolvePath = resolvePathJs as unknown as (
  client: unknown,
  o: { endpoint: string; contract: string; path: string[]; roleMap: Map<string, Set<string>> },
) => Promise<string[]>
const EIP1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

// =====================================================================================================
describe('RV12-3 (on-chain #1, HIGH): a power path read that fails is an error, never "no holder"', () => {
  it('owner() failing with a transport error throws (→ power.error → read gap), not []', async () => {
    const client = fake({
      storage: { [`${PROXY}|${EIP1967_ADMIN}`]: word(PADMIN) },
      code: { [PADMIN]: '0x6080' },
      reads: { [`${PADMIN}|owner`]: httpErr() },
    })
    await expect(
      resolvePath(client, {
        endpoint: EP,
        contract: PROXY,
        path: ['eip1967_admin', 'owner'],
        roleMap: new Map(),
      }),
    ).rejects.toThrow()
  }, 20_000)
  it('a proxy admin that is an EOA holds the power itself (owner() returns no data)', async () => {
    const client = fake({
      storage: { [`${PROXY}|${EIP1967_ADMIN}`]: word(EOA) },
      reads: { [`${EOA}|owner`]: zeroData() },
    })
    const hs = await resolvePath(client, {
      endpoint: EP,
      contract: PROXY,
      path: ['eip1967_admin', 'owner'],
      roleMap: new Map(),
    })
    expect(hs).toEqual([EOA])
  }, 20_000)
  it('a proxy admin that is a Safe (owner() reverts) holds the power itself', async () => {
    const client = fake({
      storage: { [`${PROXY}|${EIP1967_ADMIN}`]: word(SAFE) },
      code: { [SAFE]: '0x6080' },
    })
    const hs = await resolvePath(client, {
      endpoint: EP,
      contract: PROXY,
      path: ['eip1967_admin', 'owner'],
      roleMap: new Map(),
    })
    expect(hs).toEqual([SAFE])
  }, 20_000)
  it('a role whose member count fails with a transport error throws (no silent empty set)', async () => {
    const client = fake({
      code: { [PROXY]: '0x6080' },
      reads: { [`${PROXY}|getRoleMemberCount`]: httpErr() },
    })
    await expect(
      resolvePath(client, {
        endpoint: EP,
        contract: PROXY,
        path: ['role:MINTER_ROLE'],
        roleMap: new Map(),
      }),
    ).rejects.toThrow()
  }, 20_000)
  it('lz_delegate, call: and acl_manager steps whose read fails throw', async () => {
    const client = fake({ code: { [PROXY]: '0x6080' }, reads: { [`${EP}|delegates`]: httpErr() } })
    for (const path of [['lz_delegate'], ['call:token()'], ['acl_manager:APP_MANAGER_ROLE']])
      await expect(
        resolvePath(client, { endpoint: EP, contract: PROXY, path, roleMap: new Map() }),
      ).rejects.toThrow()
  }, 30_000)
  it('control: a role read that succeeds with no member is no holder (a revoked role is not a read gap)', async () => {
    const client = fake({
      code: { [PROXY]: '0x6080' },
      reads: { [`${PROXY}|getRoleMemberCount`]: 0n },
    })
    const hs = await resolvePath(client, {
      endpoint: EP,
      contract: PROXY,
      path: ['role:MINTER_ROLE'],
      roleMap: new Map(),
    })
    expect(hs).toEqual([])
  }, 20_000)
  it('AD-5: an upgrade whose past-block holder read FAILED is judged against the declared timelock (fail closed), not skipped', () => {
    const rows: AdminEventRow[] = [
      {
        chainId: 1,
        block: 200,
        logIndex: 0,
        tx: '0xbb',
        emitter: PROXY,
        event: 'Upgraded',
        args: { implementation: A('f') },
      },
    ]
    const ctx = {
      subject: 'z',
      ctl: () => null,
      upgradeTimelocks: { [PROXY]: [TL] },
      timelockSince: { [TL]: 0 },
      upgradeHoldersAt: {},
      upgradeHoldersUnread: [`${PROXY}@200`],
      deployBlocks: { [PROXY]: 1 },
      tokens: [],
      announcement: 'no_gov_channel' as const,
    }
    const out = classifyAdminEvents(rows, ctx)
    expect(out.flatMap((c) => c.ruleIds)).toContain('AD-5')
    // control: a read that SUCCEEDED and found no timelock judges nothing
    const ok = classifyAdminEvents(rows, { ...ctx, upgradeHoldersUnread: [] })
    expect(ok.flatMap((c) => c.ruleIds)).not.toContain('AD-5')
  })
})

// =====================================================================================================
describe('RV12-4 / RV12-6 / RV12-7 / RV12-8: a failed read under an AD-2, CC-2 or AD-3 breach carries it (UQ-30)', () => {
  it('AD-2 whitelist bypass (the USDe / sUSDe 0xe8dc shape): the whitelist read fails next run — the breach is carried', () => {
    const tl = (bypass: Controller['bypass']) =>
      timelock(TL, 86400, [safe(SAFE, 5, 10)], { bypass })
    const run1 = build(
      subject(),
      rawOf({
        head: HEAD1,
        holders: [TL],
        controllers: {
          [`${TL}@head`]: tl({
            fn: 'executeWhitelisted',
            scope: 'whitelist',
            targets: { [PROXY]: ['setPeer(uint32,bytes32)'] },
          }),
        },
      }),
    ).state
    expect(breachesBy(run1, 'AD-2')).toHaveLength(1)
    const run2 = build(
      subject(),
      rawOf({
        head: HEAD2,
        holders: [TL],
        controllers: {
          [`${TL}@head`]: tl({ fn: 'executeWhitelisted', scope: 'any', unread: true }),
        },
        previous: run1,
      }),
    ).state
    const ad2 = breachesBy(run2, 'AD-2')
    expect(ad2).toHaveLength(1)
    expect(ad2[0].message).toMatch(
      /breach unconfirmed: read gap \(timelock 0x7777…7777: executeWhitelisted whitelist not read/,
    )
    expect(run2.readGaps).toContain('timelock 0x7777…7777: executeWhitelisted whitelist not read')
    // listed once
    expect(run2.readGaps!.filter((g) => /whitelist not read/.test(g))).toHaveLength(1)
    expect(countsOf(run2.items, [], run2.readGaps ?? []).openRed).toBe(1)
  })
  it('AD-2 Dual Governance emergency mode NOT READ: the breach is carried and the gap is counted', () => {
    const holder = (active: boolean | null): Controller => ({
      kind: 'contract',
      address: EXEC,
      ownedBy: dg(active),
    })
    const run1 = build(
      subject(),
      rawOf({ head: HEAD1, holders: [EXEC], controllers: { [`${EXEC}@head`]: holder(true) } }),
    ).state
    expect(breachesBy(run1, 'AD-2')).toHaveLength(1)
    const run2 = build(
      subject(),
      rawOf({
        head: HEAD2,
        holders: [EXEC],
        controllers: { [`${EXEC}@head`]: holder(null) },
        previous: run1,
      }),
    ).state
    const ad2 = breachesBy(run2, 'AD-2')
    expect(ad2).toHaveLength(1)
    expect(ad2[0].message).toMatch(
      /breach unconfirmed: read gap \(Dual Governance 0x8888…8888: emergency mode not read/,
    )
    expect(run2.readGaps).toContain('Dual Governance 0x8888…8888: emergency mode not read')
    // a first run with the read failed is never "no red flags"
    const first = build(
      subject(),
      rawOf({ head: HEAD2, holders: [EXEC], controllers: { [`${EXEC}@head`]: holder(null) } }),
    ).state
    expect(first.readGaps).toContain('Dual Governance 0x8888…8888: emergency mode not read')
  })
  it('CC-2: the CCIP pool chain list is not read next run — the rate-limiter breach is carried', () => {
    const s = subject({ ccipPools: [POOL] })
    const pool = (chains: RawSubject['ccip']['pools'][number]['chains'], unread = false) => ({
      pools: [
        {
          pool: POOL,
          owner: EOA2,
          rebalancer: '0x0000000000000000000000000000000000000000',
          chains,
          ...(unread ? { chainsUnread: true } : {}),
        },
      ],
    })
    const run1 = build(
      s,
      rawOf({
        head: HEAD1,
        ccip: pool([
          {
            selector: '5009297550715157269',
            inboundEnabled: false,
            outboundEnabled: true,
            remotePools: [],
            siloed: false,
          },
        ]),
      }),
    ).state
    expect(breachesBy(run1, 'CC-2')).toHaveLength(1)
    const run2 = build(s, rawOf({ head: HEAD2, ccip: pool([], true), previous: run1 })).state
    const cc2 = breachesBy(run2, 'CC-2')
    expect(cc2).toHaveLength(1)
    expect(cc2[0].message).toMatch(
      /breach unconfirmed: read gap \(CCIP pool 0xcccc…cccc: supported chains not read/,
    )
    expect(run2.readGaps).toContain('CCIP pool 0xcccc…cccc: supported chains not read')
  })
  it('AD-3 through an Aragon Agent whose executors are not found: a read gap that carries the breach', () => {
    const agent = (o: Partial<Controller>): Controller => ({
      kind: 'contract',
      address: AGENT,
      version: 'Aragon Agent',
      ...o,
    })
    const run1 = build(
      subject(),
      rawOf({
        head: HEAD1,
        holders: [AGENT],
        controllers: { [`${AGENT}@head`]: agent({ executors: [eoa(EOA)], ownedBy: eoa(EOA) }) },
      }),
    ).state
    expect(breachesBy(run1, 'AD-3')).toHaveLength(1)
    const unread = agent({
      version: 'Aragon Agent: no executor found — ranked as a plain contract',
      executorsUnread: true,
    })
    expect(rankHasReadGap(unread)).toBe(true)
    expect(controllerRank(unread)).toEqual([2])
    const run2 = build(
      subject(),
      rawOf({
        head: HEAD2,
        holders: [AGENT],
        controllers: { [`${AGENT}@head`]: unread },
        previous: run1,
      }),
    ).state
    const ad3 = breachesBy(run2, 'AD-3')
    expect(ad3).toHaveLength(1)
    expect(ad3[0].message).toMatch(
      /breach unconfirmed: read gap \(Aragon Agent 0x3333…3333: no executor found/,
    )
  })
})

// =====================================================================================================
describe('RV12-5 (on-chain #3): the FunctionWhitelisted log read cross-checks empty chunks', () => {
  const WL_CODE = codeWith([
    'getMinDelay()',
    'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
    'executeWhitelisted(address,uint256,bytes)',
  ])
  const endpoint = (logs: unknown[] | Error) => ({
    request: async () => {
      if (logs instanceof Error) throw logs
      return logs
    },
  })
  it('an empty answer that no second endpoint confirms is UNREAD (fail closed), not "no bypass"', async () => {
    const t = A('a1')
    const client = fake({ code: { [t]: WL_CODE } })
    setLogClients(endpoint([]), null)
    try {
      const b = await timelockBypass(client, t, WL_CODE, undefined)
      expect(b).toEqual({ fn: 'executeWhitelisted', scope: 'any', unread: true })
    } finally {
      setLogClients(null)
    }
  }, 20_000)
  it('a false-empty primary corrected by the second endpoint finds the whitelist', async () => {
    const t = A('a2')
    const log = {
      address: t,
      topics: [
        '0x' + '0'.repeat(64),
        word(PROXY),
        '0x' + sel('setPeer(uint32,bytes32)') + '0'.repeat(56),
      ],
      blockNumber: '0x10',
      data: '0x',
    }
    const client = fake({
      code: { [t]: WL_CODE },
      reads: { [`${t}|isWhitelisted`]: true },
    })
    setLogClients(endpoint([]), endpoint([log]))
    try {
      const b = await timelockBypass(client, t, WL_CODE, undefined)
      expect(b?.scope).toBe('whitelist')
      expect(Object.keys(b?.targets ?? {})).toEqual([PROXY])
    } finally {
      setLogClients(null)
    }
  }, 20_000)
  it('control: both endpoints confirm the empty answer — no whitelisted function, no bypass', async () => {
    const t = A('a3')
    const client = fake({ code: { [t]: WL_CODE } })
    setLogClients(endpoint([]), endpoint([]))
    try {
      expect(await timelockBypass(client, t, WL_CODE, undefined)).toBeUndefined()
    } finally {
      setLogClients(null)
    }
  }, 20_000)
})

// =====================================================================================================
describe('RV12-9 (rules #5): a change FROM a holder whose rank rests on a read gap is never an upgrade', () => {
  const unreadTl = timelock(TL, 7 * 86400, [], { schedulersUnread: true })
  it('timelock 7 d with an unread proposer set → Safe 3-of-5: not an upgrade, tagged read gap', () => {
    const v = classifyControllerChange(unreadTl, safe(SAFE, 3, 5))
    expect(v.severity).not.toBe('upgrade')
    expect(v.tags).toContain('read_gap')
    expect(v.notes.join(' ')).toMatch(/previous holder's rank rests on a read gap/)
  })
  it('control: the same move judged against a READ previous holder is still ranked (a real downgrade is red)', () => {
    const readTl = timelock(TL, 7 * 86400, [safe(A('b'), 6, 11)])
    const v = classifyControllerChange(readTl, safe(SAFE, 3, 5))
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('AD-3')
  })
  it('control: a move to an EOA from a gap-ranked holder stays red', () => {
    const v = classifyControllerChange(unreadTl, eoa(EOA))
    expect(v.ruleIds).toContain('AD-3')
  })
  it('role admin: a previous admin side resting on a read gap (or not classified) is never an upgrade', () => {
    for (const prev of [unreadTl, null]) {
      const v = classifyRoleAdminChange(
        'MINTER_ROLE',
        { name: 'OLD_ADMIN', holders: [prev] },
        { name: 'NEW_ADMIN', holders: [safe(SAFE, 3, 5)] },
      )
      expect(v.severity).not.toBe('upgrade')
      expect(v.tags).toContain('read_gap')
    }
  })
})

// =====================================================================================================
describe('RV12-10 / RV12-11 (rules #6): run-to-run Safe diffs are never lost', () => {
  const s = subject({ powers: [], safes: [SAFE] })
  it('a silent threshold drop found between two runs stays on the card in the next run (no chain change)', () => {
    const run1 = build(
      s,
      rawOf({ head: HEAD1, controllers: { [`${SAFE}@head`]: safe(SAFE, 4, 7) } }),
    )
    const r2 = build(
      s,
      rawOf({
        head: HEAD2,
        controllers: { [`${SAFE}@head`]: safe(SAFE, 2, 7) },
        previousSafes: safesOf(run1.state),
      }),
    )
    const row = r2.changes.find((c) => c.id.includes(':safe-head:'))
    expect(row?.red).toBe(true)
    const r3 = build(
      s,
      rawOf({
        head: HEAD3,
        controllers: { [`${SAFE}@head`]: safe(SAFE, 2, 7) },
        previousSafes: safesOf(r2.state),
        previousChanges: { block: HEAD2, changes: r2.changes },
      }),
    )
    const kept = r3.changes.find((c) => c.id === row!.id)
    expect(kept?.red).toBe(true)
    expect(kept?.stillInEffect).toBe(true)
    expect(r3.state.counts.red).toBe(1)
  })
  it('a Safe not classified in one run keeps its last read: a silent drop across that run is bracketed', () => {
    const run1 = build(
      s,
      rawOf({ head: HEAD1, controllers: { [`${SAFE}@head`]: safe(SAFE, 4, 7) } }),
    )
    const run2 = build(
      s,
      rawOf({ head: HEAD2, controllers: {}, previousSafes: safesOf(run1.state) }),
    )
    expect((run2.state.safeSnapshot ?? []).map((c) => c.address)).toContain(SAFE)
    expect(run2.state.readGaps?.join(' ')).toMatch(/Safe 0x6666…6666: not classified this run/)
    const run3 = build(
      s,
      rawOf({
        head: HEAD3,
        controllers: { [`${SAFE}@head`]: safe(SAFE, 2, 7) },
        previousSafes: safesOf(run2.state),
        previousChanges: { block: HEAD2, changes: run2.changes },
      }),
    )
    const row = run3.changes.find((c) => c.id.includes(':safe-head:'))
    expect(row?.red).toBe(true)
    // bracketed from the run that last READ it
    expect(row?.blockFrom).toBe(HEAD1)
  })
})

// =====================================================================================================
describe('RV12-12 (rules #6): a head-derived AD-4 role row survives a failed head read', () => {
  const role = '0x' + '0'.repeat(64)
  const ev: AdminEventRow = {
    chainId: 1,
    block: 100,
    logIndex: 0,
    tx: '0xaa',
    emitter: PROXY,
    event: 'RoleGranted',
    args: { role, roleName: 'DEFAULT_ADMIN_ROLE', account: SAFE, sender: EOA2 },
  }
  const grant = (): ConfigChange => ({
    id: '1:0xaa:0',
    subject: 'z',
    dimension: 'admin',
    key: `admin/role/${PROXY}/DEFAULT_ADMIN_ROLE`,
    title: 'grant',
    before: null,
    after: SAFE,
    state: 'historical',
    stage: 'executed',
    severity: 'neutral',
    floorBreach: false,
    red: false,
    ruleIds: [],
    tags: [],
    unannounced: null,
    announcement: 'no_gov_channel',
    chainId: 1,
    block: 100,
  })
  const opts = (head: number, now: Controller | null, previous?: ConfigChange[]) => ({
    ctlAt: (a: string, b: number) => (a === SAFE && b === 100 ? safe(SAFE, 3, 5) : null),
    ctlRanked: () => null,
    ctlHead: () => now,
    administers: () => false,
    head,
    subject: 'z',
    announcement: 'no_gov_channel' as const,
    ...(previous ? { previous } : {}),
  })
  it('run 1 finds the grantee weakened (3-of-5 → 1-of-5); run 2 cannot read it at head — the red row stays', () => {
    const added1 = rejudgeRoleHoldersAtHead([grant()], [ev], opts(HEAD1, safe(SAFE, 1, 5)))
    expect(added1).toHaveLength(1)
    expect(added1[0].red).toBe(true)
    const added2 = rejudgeRoleHoldersAtHead([grant()], [ev], opts(HEAD2, null, added1))
    expect(added2).toHaveLength(1)
    expect(added2[0]).toMatchObject({ id: added1[0].id, red: true, stillInEffect: true })
    expect(added2[0].notes?.join(' ')).toMatch(/not read at head \(block 30007200\)/)
  })
  it('control: read again and strong at head, the row is resolved', () => {
    const added1 = rejudgeRoleHoldersAtHead([grant()], [ev], opts(HEAD1, safe(SAFE, 1, 5)))
    const added2 = rejudgeRoleHoldersAtHead([grant()], [ev], opts(HEAD2, safe(SAFE, 4, 5), added1))
    expect(added2).toHaveLength(0)
  })
})

// =====================================================================================================
describe('RV12-13 (rules #7): a pending queue row survives a failed queue read', () => {
  const row: ConfigChange = {
    id: `multisig:${MS}:21:0`,
    subject: 'z',
    dimension: 'admin',
    key: `admin/multisig/${MS}`,
    title: 'addOwner',
    state: 'pending',
    stage: 'submitted',
    severity: 'downgrade',
    floorBreach: false,
    red: true,
    ruleIds: ['AD-1'],
    tags: [],
    unannounced: null,
    announcement: 'no_gov_channel',
    chainId: 1,
    block: 100,
    queue: { kind: 'legacy_multisig', address: MS, opId: '21' },
  }
  it('MultiSigWallet submissions not read: the red pending row from the last run stays, marked carried', () => {
    const r = build(
      subject({ powers: [] }),
      rawOf({
        head: HEAD2,
        multisigStatus: [{ multisig: MS, status: 'unavailable', note: 'timeout' }],
        previousQueue: { block: HEAD1, changes: [row] },
      }),
    )
    const kept = r.queue.find((c) => c.id === row.id)
    expect(kept?.red).toBe(true)
    expect(kept?.tags).toContain('read_gap')
    expect(kept?.notes?.join(' ')).toMatch(/NOT READ this run \(carried from block 30000000\)/)
    expect(r.state.counts.red).toBe(1)
  })
  it('control: the queue read succeeds and the row is gone (executed or cancelled) — resolved', () => {
    const r = build(
      subject({ powers: [] }),
      rawOf({
        head: HEAD2,
        multisigStatus: [{ multisig: MS, status: 'ok' }],
        previousQueue: { block: HEAD1, changes: [row] },
      }),
    )
    expect(r.queue.find((c) => c.id === row.id)).toBeUndefined()
  })
})

// =====================================================================================================
describe('RV12-14 (rules #8): the previous state is never silently lost', () => {
  it('writes go through a temporary file and a rename (no torn state file)', () => {
    const d = mkdtempSync(join(tmpdir(), 'cfg-'))
    try {
      const p = join(d, 'state.json')
      writeFileSync(p, '{"old":true}\n')
      writeJsonAtomic(p, { a: 1 })
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1 })
      expect(readdirSync(d)).toEqual(['state.json'])
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
  it('a missing previous state is a first run (null); a corrupt one STOPS the run instead of dropping every carry', () => {
    const d = mkdtempSync(join(tmpdir(), 'cfg-'))
    try {
      expect(readPreviousState(join(d, 'none.json'))).toBeNull()
      const p = join(d, 'bad.json')
      writeFileSync(p, '{"items": [')
      expect(() => readPreviousState(p)).toThrow(/previous state/)
      expect(existsSync(p)).toBe(true)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

// =====================================================================================================
describe('RV12-15 (on-chain #4 / rules #9): stale and cyclic bypass reads are not read gaps forever', () => {
  const stale = timelock(TL, 3 * 3600, [safe(SAFE, 5, 9)], {
    bypass: { fn: 'bypasserExecuteBatch', scope: 'any', holders: [A('b')] },
  })
  it('hasReadFailure: a bypass with no (or too few) classified bypassers, an Agent with no executor, an unread vote time or Dual Governance field is not cached', () => {
    expect(hasReadFailure(stale)).toBe(true)
    expect(
      hasReadFailure({
        kind: 'contract',
        address: AGENT,
        version: 'Aragon Agent',
        executorsUnread: true,
      }),
    ).toBe(true)
    expect(
      hasReadFailure({
        kind: 'aragon_voting',
        address: A('4'),
        delaySec: 0,
        voting: { voteTimeSec: null, objectionPhaseSec: null },
      }),
    ).toBe(true)
    expect(
      hasReadFailure({ ...dg(false), dg: { ...dg(false).dg!, afterSubmitDelaySec: null } }),
    ).toBe(true)
    expect(hasReadFailure(dg(null))).toBe(true)
    // control: a fully read tree is cached
    expect(
      hasReadFailure({ ...stale, bypass: { ...stale.bypass!, holderCtls: [eoa(A('b'))] } }),
    ).toBe(false)
    expect(hasReadFailure(dg(false))).toBe(false)
  })
  it('a bypasser already on the control path (0x117e, owned by the timelock it bypasses) ranks as a plain contract — no read gap', async () => {
    const BYP = A('b')
    const RBAC = codeWith([
      'getMinDelay()',
      'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
      'bypasserExecuteBatch((address,uint256,bytes)[])',
    ])
    const client = fake({
      code: { [TL]: RBAC },
      reads: {
        [`${TL}|BYPASSER_ROLE`]: '0x' + 'b'.repeat(64),
        [`${TL}|getRoleMemberCount`]: 1n,
        [`${TL}|getRoleMember`]: BYP,
      },
    })
    const b = (await timelockBypass(
      client,
      TL,
      RBAC,
      100,
      1,
      new Set([BYP]),
    )) as Controller['bypass']
    expect(b?.holders).toEqual([BYP])
    expect(b?.holderCtls).toHaveLength(1)
    expect(b?.holderCtls?.[0]).toMatchObject({ kind: 'contract', address: BYP })
    const t = timelock(TL, 3 * 3600, [safe(SAFE, 5, 9)], { bypass: b })
    expect(rankHasReadGap(t)).toBe(false)
    expect(controllerRank(t)).toEqual([2])
    expect(treeReadGaps([t])).toEqual([])
    expect(hasReadFailure(t)).toBe(false)
  }, 20_000)
})

// =====================================================================================================
describe('RV12-16 (on-chain #5): a co-holder that was an EOA is not "not read" at a later grant', () => {
  it('coHolderReads reuses the EOA classification at the later grant block instead of leaving it unread', () => {
    const role = '0x' + '1'.repeat(64)
    const g = (block: number, account: string): Record<string, unknown> => ({
      chainId: 1,
      block,
      logIndex: 0,
      tx: '0x' + String(block).padStart(64, '0'),
      emitter: PROXY,
      event: 'RoleGranted',
      args: { role, roleName: 'MANAGER', account, sender: EOA2 },
    })
    const rows = [g(100, EOA), g(200, SAFE)]
    const atCache = { [`${EOA}@100`]: eoa(EOA) }
    const r = coHolderReads(rows, atCache, () => true)
    expect(r.want).not.toContain(`${EOA}@200`)
    expect((r.reuse as Record<string, Controller>)[`${EOA}@200`]).toEqual(eoa(EOA))
    // a co-holder with no cached EOA read is classified at the block
    const r2 = coHolderReads(rows, {}, () => true)
    expect(r2.want).toContain(`${EOA}@200`)
  })
})

// =====================================================================================================
describe('collector reads (RV12-7 / RV12-8): unread CCIP chains and Aragon executors are marked, never empty', () => {
  it('readCcipPool: getSupportedChains failing marks the chain list unread', async () => {
    const client = fake({
      reads: {
        [`${POOL}|owner`]: EOA2,
        [`${POOL}|getRebalancer`]: '0x0000000000000000000000000000000000000000',
        [`${POOL}|getSupportedChains`]: httpErr(),
      },
    })
    const p = await readCcipPool(client, POOL)
    expect(p.chains).toEqual([])
    expect((p as { chainsUnread?: boolean }).chainsUnread).toBe(true)
  }, 20_000)
  it('aragonAgentOf: no executor found is a read gap (executorsUnread), not a plain contract', async () => {
    const IMPL = A('f')
    const client = fake({
      code: {
        [AGENT]: codeWith(['implementation()', 'kernel()', 'appId()']),
        [IMPL]: codeWith(['forward(bytes)', 'execute(address,uint256,bytes)']),
      },
      reads: { [`${AGENT}|implementation`]: IMPL },
    })
    const c = await aragonAgentOf(
      client,
      AGENT,
      codeWith(['implementation()', 'kernel()', 'appId()']),
      undefined,
    )
    expect(c).toMatchObject({ kind: 'contract', address: AGENT, executorsUnread: true })
    expect(hasReadFailure(c)).toBe(true)
  }, 20_000)
})

// =====================================================================================================
describe('KG-6 (closed): the second log endpoint is asked in pieces it accepts', () => {
  it('an empty 500k-block chunk is confirmed in ≤ 10,000-block requests — none refused', async () => {
    const asked: number[] = []
    const primary = { request: async () => [] }
    const secondary = {
      request: async ({ params }: { params: { fromBlock: string; toBlock: string }[] }) => {
        const span = Number(params[0].toBlock) - Number(params[0].fromBlock) + 1
        asked.push(span)
        if (span > 10_000) throw new Error('range 499999 exceeds limit of 10000')
        return []
      },
    }
    const r = await crossCheckedLogs(primary, secondary, {
      address: TL,
      topics0: ['0x01'],
      fromBlock: 1_000_000,
      toBlock: 1_499_999,
    })
    expect(r.logs).toEqual([])
    expect(Math.max(...asked)).toBeLessThanOrEqual(10_000)
    expect(asked).toHaveLength(50)
  }, 20_000)
})

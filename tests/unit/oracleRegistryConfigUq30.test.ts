// Config cards — UQ-30 (decided 2026-10-09 under the standing rulings "a failed read never ends a
// red" and "fail closed everywhere"): a failed head read NEVER drops a head breach. When a read a
// breach depends on fails (a token vote's trailing-year history or holders at head, a Safe's
// module list, a parameter, a route side), the breach the previous run confirmed stays — counted
// and shown red — with the note "breach unconfirmed: read gap" and the read-gap line. Every test
// failed on the code before the change except the controls, which are marked.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  buildSubject,
  carryUnconfirmedBreaches,
  legacyBreachRef,
  ROUTE_SIDE_UNREAD,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import { describeController, isEoaControlled } from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigSubject,
  Controller,
  StateItem,
  SubjectState,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { breachesOf, countsOf } from '@/lib/oracleRegistry/config/view'
import { hasReadFailure } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { defenseOf, tokenVote, voteData } from './oracleRegistryVoteFixtures'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const VOTING = A('4')
const AGENT = A('3')
const EXEC = A('5')
const EPT = A('7')
const PROXY = A('1')
const SAFE = A('6')
const RP = A('8')
const OAPP = A('9')
const PEER = A('a')
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const HEAD1 = 30_000_000
const HEAD2 = 30_007_200
const HEAD3 = 30_014_400

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
  powers: [{ power: 'upgrade', contract: PROXY, path: ['eip1967_admin'], label: 'Upgrade P' }],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
  ...o,
})
const rawOf = (o: {
  head?: number
  holder?: string
  controllers?: Record<string, Controller>
  params?: Record<string, unknown>
  lz?: Partial<RawSubject['lz']>
  previous?: SubjectState
}): RawSubject => ({
  version: 1,
  subjectKey: 'z',
  head: { block: o.head ?? HEAD1, ts: 2000 },
  scan: { from: 1, to: o.head ?? HEAD1 },
  lz: {
    events: [],
    headRoutes: [],
    headDefaults: {},
    remote: [],
    codeProbes: {},
    dvnSigner: [],
    dvnHead: {},
    ...o.lz,
  },
  admin: {
    events: [],
    controllers: o.controllers ?? {},
    powers: o.holder
      ? [{ power: 'upgrade', label: 'Upgrade P', contract: PROXY, holders: [o.holder] }]
      : [],
    timelockAdmins: [],
    implHistory: {},
    owners: {},
    delegates: {},
    minDelays: {},
  },
  params: { head: o.params ?? {}, transitions: [] },
  queues: { ops: [], safe: [], safeStatus: [] },
  ccip: { pools: [] },
  ...(o.previous
    ? { previousHead: { block: o.previous.asOf.block, items: o.previous.items } }
    : {}),
  warnings: [],
})
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'arbitrum', roleName: (h) => h, endpoint: EP })
const breachCount = (st: SubjectState) => st.items.reduce((n, i) => n + i.breaches.length, 0)

// The wstETH shape: a Lido power held by the Aragon Agent, executed by the Dual Governance
// timelock, whose proposer is the LDO vote. ONE holder (an EOA whale, 6 % of supply) can pass a
// vote alone against D, so the vote — and every power under it — ranks as an EOA: AD-3 at head.
const vote = (o: { defenseUnread?: string; holdersUnread?: boolean; nays?: number[] } = {}) => {
  const v = tokenVote(VOTING, {
    // a third, smaller holder is examined, so k is settled
    voting: voteData([60, 10, 1], { defense: defenseOf(o.nays ?? [1]) }),
  })
  if (o.defenseUnread)
    v.voting = { ...v.voting!, defense: undefined, defenseUnread: o.defenseUnread }
  if (o.holdersUnread)
    v.voting = { ...v.voting!, holders: undefined, holdersUnread: 'Transfer scan failed' }
  return v
}
const agentOver = (v: Controller): Controller => ({
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
      schedulers: [v],
      dg: {
        afterSubmitDelaySec: 259200,
        afterScheduleDelaySec: 86400,
        governance: null,
        adminExecutor: EXEC,
        emergencyGovernance: null,
        // no committee set (read as address 0): no committee read gap in the fixture
        activationCommittee: '0x0000000000000000000000000000000000000000',
        executionCommittee: '0x0000000000000000000000000000000000000000',
        emergencyModeActive: false,
        emergencyProtectionEndsAfter: null,
      },
    },
  },
})
const lidoRun = (v: Controller, head: number, previous?: SubjectState) =>
  build(
    subject(),
    rawOf({ head, holder: AGENT, controllers: { [`${AGENT}@head`]: agentOver(v) }, previous }),
  ).state

// =====================================================================================================
describe('UQ-30: a failed head read never drops a head breach (the wstETH shape)', () => {
  it('with the trailing-year history read, the power has its AD-3 head breach, its ref naming the holder', () => {
    const st = lidoRun(vote(), HEAD1)
    expect(isEoaControlled(agentOver(vote()))).toBe(true)
    const ad3 = st.items.flatMap((i) => i.breaches).filter((b) => b.ruleId === 'AD-3')
    expect(ad3).toHaveLength(1)
    expect(ad3[0].ref).toBe(`holder:${short(AGENT)}`)
    expect(st.readGaps ?? []).toEqual([])
  })
  it('the vote D read fails at the next head: the AD-3 breach STAYS — counted, red, "breach unconfirmed: read gap", with the read-gap line', () => {
    const run1 = lidoRun(vote(), HEAD1)
    const run2 = lidoRun(vote({ defenseUnread: 'getVote(205) failed' }), HEAD2, run1)
    // the head breach is still there
    const ad3 = run2.items.flatMap((i) => i.breaches).filter((b) => b.ruleId === 'AD-3')
    expect(ad3).toHaveLength(1)
    expect(ad3[0].message).toMatch(/^Upgrade P held by Aragon Agent 0x3333…3333/)
    expect(ad3[0].message).toMatch(
      /breach unconfirmed: read gap \(Aragon Voting 0x4444…4444: trailing-year vote history not read/,
    )
    expect(ad3[0].message).toMatch(new RegExp(`last confirmed at block ${HEAD1}$`))
    expect(ad3[0].unconfirmed).toMatchObject({ lastConfirmedBlock: HEAD1 })
    expect(ad3[0].unconfirmed!.message).toBe(run1.items[0].breaches[0].message)
    // the read-gap line is listed
    expect(run2.readGaps?.join(' ')).toMatch(/trailing-year vote history not read/)
    // counted: the view's rule breaches and open reds, and the banner shows it
    const c = countsOf(run2.items, [], run2.readGaps ?? [])
    expect(c.ruleBreaches).toBe(1)
    expect(c.openRed).toBe(1)
    expect(c.readGaps).toBeGreaterThan(0)
    const banner = breachesOf(run2.items)
    expect(banner).toHaveLength(1)
    expect(banner[0].unconfirmed).toMatch(/trailing-year vote history not read/)
  })
  it('control: the SAME failed read with no previous run has nothing to carry (the breach the old code dropped)', () => {
    const st = lidoRun(vote({ defenseUnread: 'getVote(205) failed' }), HEAD2)
    expect(breachCount(st)).toBe(0)
    expect(st.readGaps?.join(' ')).toMatch(/trailing-year vote history not read/)
  })
  it('unread holder data at head (UQ-17) is carried the same way', () => {
    const run1 = lidoRun(vote(), HEAD1)
    const run2 = lidoRun(vote({ holdersUnread: true }), HEAD2, run1)
    const ad3 = run2.items.flatMap((i) => i.breaches).filter((b) => b.ruleId === 'AD-3')
    expect(ad3).toHaveLength(1)
    expect(ad3[0].message).toMatch(
      /breach unconfirmed: read gap \(Aragon Voting 0x4444…4444: holder concentration not read/,
    )
  })
  it('a breach carried twice keeps its first confirmation block and is not re-suffixed; re-confirmed, it is a plain breach again', () => {
    const run1 = lidoRun(vote(), HEAD1)
    const run2 = lidoRun(vote({ defenseUnread: 'x' }), HEAD2, run1)
    const run3 = lidoRun(vote({ defenseUnread: 'y' }), HEAD3, run2)
    const b3 = run3.items[0].breaches
    expect(b3).toHaveLength(1)
    expect(b3[0].unconfirmed?.lastConfirmedBlock).toBe(HEAD1)
    expect(b3[0].message.match(/breach unconfirmed/g)).toHaveLength(1)
    expect(b3[0].message).toMatch(
      /\(Aragon Voting 0x4444…4444: trailing-year vote history not read \(vote history not read: y/,
    )
    // read again: re-confirmed, no longer carried
    const run4 = lidoRun(vote(), HEAD3 + 7200, run3)
    expect(run4.items[0].breaches).toHaveLength(1)
    expect(run4.items[0].breaches[0].unconfirmed).toBeUndefined()
  })
  it('control: a breach that a SUCCESSFUL read no longer finds is resolved (dropped) — D now stops the whale', () => {
    const run1 = lidoRun(vote(), HEAD1)
    // D = 65 tokens: the 6 % whale fails support; 60 + 10 = 70 / 135 = 51.9 % passes — k = 2,
    // a 2-of-2 multisig of two EOAs, not EOA-controlled
    const run2 = lidoRun(vote({ nays: [195, 0, 0] }), HEAD2, run1)
    expect(breachCount(run2)).toBe(0)
    expect(run2.readGaps ?? []).toEqual([])
  })
  it('control: a holder no longer listed (the holder list WAS read) takes its breach with it', () => {
    const run1 = lidoRun(vote(), HEAD1)
    const other: Controller = { kind: 'safe', address: SAFE, threshold: 4, signers: 7 }
    const run2 = build(
      subject(),
      rawOf({
        head: HEAD2,
        holder: SAFE,
        controllers: { [`${SAFE}@head`]: other },
        previous: run1,
      }),
    ).state
    expect(breachCount(run2)).toBe(0)
  })
  it('a holder list that could not be resolved keeps every breach it had', () => {
    const run1 = lidoRun(vote(), HEAD1)
    const raw = rawOf({ head: HEAD2, previous: run1 })
    raw.admin.powers = [
      {
        power: 'upgrade',
        label: 'Upgrade P',
        contract: PROXY,
        holders: [],
        error: 'admin slot read failed',
      },
    ]
    const st = build(subject(), raw).state
    expect(st.items[0].breaches).toHaveLength(1)
    expect(st.items[0].breaches[0].message).toMatch(
      /read gap \(Upgrade P: holders not resolved \(admin slot read failed\)\)/,
    )
  })
  it('two powers sharing one item key (an OFT owner and its delegate): the breach stays on ITS item, matched by order', () => {
    const s = subject({
      powers: [
        { power: 'bridge_config', contract: OAPP, path: ['owner'], label: 'OFT owner' },
        { power: 'bridge_config', contract: OAPP, path: ['lz_delegate'], label: 'OFT delegate' },
      ],
    })
    const safe: Controller = { kind: 'safe', address: SAFE, threshold: 4, signers: 7, modules: [] }
    const runOf = (v: Controller, sf: Controller, head: number, previous?: SubjectState) => {
      const raw = rawOf({
        head,
        controllers: { [`${AGENT}@head`]: agentOver(v), [`${SAFE}@head`]: sf },
        previous,
      })
      raw.admin.powers = [
        { power: 'bridge_config', label: 'OFT owner', contract: OAPP, holders: [AGENT] },
        { power: 'bridge_config', label: 'OFT delegate', contract: OAPP, holders: [SAFE] },
      ]
      return build(s, raw).state
    }
    const pw = (st: SubjectState) => st.items.filter((x) => x.key.startsWith('admin/power/'))
    const run1 = runOf(vote(), safe, HEAD1)
    expect(pw(run1).map((i) => i.key)).toEqual([
      `admin/power/bridge_config/${OAPP}`,
      `admin/power/bridge_config/${OAPP}`,
    ])
    expect(pw(run1).map((i) => i.breaches.length)).toEqual([1, 0])
    // the owner's vote history unread: carried on the OWNER item (was: on the delegate's)
    const run2 = runOf(vote({ defenseUnread: 'x' }), safe, HEAD2, run1)
    expect(pw(run2).map((i) => i.breaches.length)).toEqual([1, 0])
    expect(pw(run2)[0].breaches[0].unconfirmed).toBeDefined()
    // the delegate's Safe unread, the owner re-confirmed: one breach, not carried
    const run3 = runOf(vote(), { ...safe, modules: undefined, modulesUnread: true }, HEAD3, run1)
    expect(pw(run3).map((i) => i.breaches.length)).toEqual([1, 0])
    expect(pw(run3)[0].breaches[0].unconfirmed).toBeUndefined()
  })
})

// =====================================================================================================
describe('UQ-30: every other head breach type', () => {
  it('AD-6: a Safe whose module list could not be read keeps its module breach', () => {
    const withModule: Controller = {
      kind: 'safe',
      address: SAFE,
      threshold: 3,
      signers: 5,
      modules: [A('d')],
    }
    const unread: Controller = {
      kind: 'safe',
      address: SAFE,
      threshold: 3,
      signers: 5,
      modulesUnread: true,
    }
    const run1 = build(
      subject(),
      rawOf({ holder: SAFE, controllers: { [`${SAFE}@head`]: withModule } }),
    ).state
    expect(run1.items[0].breaches.map((b) => b.ruleId)).toEqual(['AD-6'])
    const run2 = build(
      subject(),
      rawOf({
        head: HEAD2,
        holder: SAFE,
        controllers: { [`${SAFE}@head`]: unread },
        previous: run1,
      }),
    ).state
    expect(run2.items[0].breaches.map((b) => b.ruleId)).toEqual(['AD-6'])
    expect(run2.items[0].breaches[0].message).toMatch(
      /breach unconfirmed: read gap \(Safe 0x6666…6666: modules not read/,
    )
    expect(run2.readGaps?.join(' ')).toMatch(/Safe 0x6666…6666: modules not read/)
  })
  it('MR-2: a rate provider that could not be read keeps its EOA breach, and the unread parameter is a read gap', () => {
    const s = subject({
      params: [
        {
          key: 'rp',
          contract: PROXY,
          sig: 'function rp() view returns (address)',
          rule: 'rate_provider',
          label: 'Rate provider',
        },
      ],
    })
    const run1 = build(
      s,
      rawOf({ params: { rp: RP }, controllers: { [`${RP}@head`]: { kind: 'eoa', address: RP } } }),
    ).state
    expect(run1.items.flatMap((i) => i.breaches).map((b) => b.ruleId)).toEqual(['MR-2'])
    const run2 = build(s, rawOf({ head: HEAD2, params: {}, previous: run1 })).state
    const mr2 = run2.items.flatMap((i) => i.breaches)
    expect(mr2.map((b) => b.ruleId)).toEqual(['MR-2'])
    expect(mr2[0].message).toMatch(
      /^Rate provider is EOA 0x8888…8888 — breach unconfirmed: read gap \(Rate provider: not read at head\)/,
    )
    expect(run2.readGaps).toContain('Rate provider: not read at head')
    // read again and now a contract nobody controls: resolved
    const run3 = build(
      s,
      rawOf({
        head: HEAD3,
        params: { rp: RP },
        controllers: { [`${RP}@head`]: { kind: 'immutable', address: RP } },
        previous: run2,
      }),
    ).state
    expect(run3.items.flatMap((i) => i.breaches)).toHaveLength(0)
  })
  it('BR-2: a route side whose config read fails keeps its floor breach — counted as a floor-breach ROUTE', () => {
    const key = `bridge/lz/1/${OAPP}/30110/receive`
    const prev: SubjectState = {
      ...lidoRun(vote(), HEAD1),
      items: [
        {
          subject: 'z',
          dimension: 'bridge',
          key,
          chainId: 1,
          block: HEAD1,
          display: 'eid 30110 (arbitrum) receive: E=1 · 1 required + 0 optional · 20 conf',
          value: { E: 1, live: true },
          breaches: [
            {
              ruleId: 'BR-2',
              message: 'live route at E=1: fewer than 2 distinct known DVN operators',
            },
          ],
        },
      ],
    }
    const s = subject({ lzOApps: [OAPP], powers: [] })
    const lz = {
      headRoutes: [
        {
          oapp: OAPP,
          eid: 30110,
          direction: 'receive' as const,
          lib: '0x0000000000000000000000000000000000000000',
          libIsDefault: null,
          merged: null,
          mergedError: 'getConfig timed out',
          app: null,
          peer: '0x' + PEER.slice(2).padStart(64, '0'),
        },
      ],
    }
    // control: the old behaviour — the unread side has no breach
    const without = build(s, rawOf({ head: HEAD2, lz })).state
    expect(without.counts.floorBreaches).toBe(0)
    const st = build(s, rawOf({ head: HEAD2, lz, previous: prev })).state
    const item = st.items.find((i) => i.key === key)!
    expect(item.warnings).toContain('UNREAD')
    expect(item.breaches.map((b) => b.ruleId)).toEqual(['BR-2'])
    expect(item.breaches[0].unconfirmed?.readGap.startsWith(ROUTE_SIDE_UNREAD)).toBe(true)
    expect(st.counts.floorBreaches).toBe(1)
    expect(countsOf(st.items, []).floorBreaches).toBe(1)
    // the unread side is counted apart (UNREAD), not again as a read-gap line
    expect(st.readGaps ?? []).toEqual([])
  })
  it('a remote side that was NOT read this run (absent, REMOTE UNREAD placeholder) is added back with its breach', () => {
    const key = `bridge/lz/42161/${PEER}/30101/receive`
    const prev: SubjectState = {
      ...lidoRun(vote(), HEAD1),
      items: [
        {
          subject: 'z',
          dimension: 'bridge',
          key,
          chainId: 42161,
          block: 1234,
          display: 'eid 30110 (arbitrum) remote receive: E=1 · 1 required + 0 optional',
          value: { E: 1, live: true, localOApp: OAPP },
          breaches: [
            {
              ruleId: 'BR-2',
              message: 'live route at E=1: fewer than 2 distinct known DVN operators',
            },
          ],
        },
      ],
    }
    const s = subject({ lzOApps: [OAPP], powers: [] })
    const lz = {
      remote: [
        {
          oapp: OAPP,
          eid: 30110,
          chainKey: 'arbitrum',
          chainId: 42161,
          status: 'remote_unread' as const,
          reason: 'public RPC timed out',
          peer: PEER,
        },
      ],
    }
    const st = build(s, rawOf({ head: HEAD2, lz, previous: prev })).state
    const back = st.items.find((i) => i.key === key)!
    expect(back.display).toMatch(/NOT READ this run \(carried from block 30000000\)$/)
    expect(back.breaches[0].message).toMatch(
      /breach unconfirmed: read gap \(route side not read: eid 30110 \(arbitrum\) remote side: REMOTE UNREAD — public RPC timed out\)/,
    )
    expect(st.counts.floorBreaches).toBe(1)
    // control: superseded — the same remote chain and direction READ this run through another
    // peer does not carry the old peer's breach (not a read gap)
    const read = build(
      s,
      rawOf({
        head: HEAD2,
        previous: prev,
        lz: {
          remote: [
            {
              oapp: OAPP,
              eid: 30110,
              chainKey: 'arbitrum',
              chainId: 42161,
              status: 'ok' as const,
              peer: A('b'),
              peerBack: '0x' + OAPP.slice(2).padStart(64, '0'),
              directions: {
                receive: {
                  lib: A('c'),
                  merged: {
                    confirmations: '20',
                    requiredDVNCount: 255,
                    optionalDVNCount: 0,
                    optionalDVNThreshold: 0,
                    requiredDVNs: [],
                    optionalDVNs: [],
                  },
                },
                send: {
                  lib: A('c'),
                  merged: {
                    confirmations: '20',
                    requiredDVNCount: 255,
                    optionalDVNCount: 0,
                    optionalDVNThreshold: 0,
                    requiredDVNs: [],
                    optionalDVNs: [],
                  },
                },
              },
            },
          ],
        },
      }),
    ).state
    expect(read.items.find((i) => i.key === key)).toBeUndefined()
  })
})

// =====================================================================================================
describe('UQ-30: breaches recorded before refs existed (legacy state files)', () => {
  it('legacyBreachRef derives the holder of an AD-3 from its message (a bypass timelock names its bypasser first)', () => {
    const msg = `Upgrade P held by ${describeController(agentOver(vote()))}`
    expect(
      legacyBreachRef(
        `admin/power/upgrade/${PROXY}`,
        { ruleId: 'AD-3', message: msg },
        { label: 'Upgrade P', holders: [short(AGENT)] },
      ),
    ).toBe(`holder:${short(AGENT)}`)
    const tlMsg =
      'X held by Timelock 3h (bypass: bypasserExecuteBatch, held by EOA 0xeeee…eeee) 0xcccc…cccc [proposed by EOA 0xdddd…dddd]'
    expect(
      legacyBreachRef(
        'admin/power/upgrade/0x1',
        { ruleId: 'AD-3', message: tlMsg },
        { label: 'X', holders: ['0xcccc…cccc'] },
      ),
    ).toBe('holder:0xcccc…cccc')
    expect(
      legacyBreachRef(
        'admin/power/upgrade/0x1',
        {
          ruleId: 'AD-6',
          message:
            'X: Safe 3-of-5 0xb8f5…0051 (in the tree of 0x1111…1111) has 1 module(s) that execute without signatures',
        },
        { label: 'X' },
      ),
    ).toBe('node:0xb8f5…0051')
    // AD-2 on a bypassed timelock: the timelock, not the bypasser its "(bypass: …)" names first
    // (the committed wstETH / WBTC CCIP pool owner rows)
    expect(
      legacyBreachRef(
        'admin/power/bridge_config/0x1',
        {
          ruleId: 'AD-2',
          message:
            'CCIP pool owner: Timelock 3h (bypass: bypasserExecuteBatch, held by contract 0x117e…aadc (the weakest of 2)) 0x4483…9449 [proposed by contract 0xe532…012f (the weakest of 3)] is bypassed — bypasserExecuteBatch executes any call with NO delay',
        },
        { label: 'CCIP pool owner' },
      ),
    ).toBe('node:0x4483…9449')
    expect(
      legacyBreachRef('mint/rp', { ruleId: 'MR-2', message: 'Rate provider is EOA 0x8888…8888' }),
    ).toBe('param')
    expect(
      legacyBreachRef('bridge/ntt/0x1', {
        ruleId: 'AD-3',
        message: 'NTT owner on solana is EOA 0x1234…5678',
      }),
    ).toBe('remote:solana:owner')
    expect(
      legacyBreachRef('bridge/ccip/0x1', {
        ruleId: 'CC-2',
        message: 'rate limiter off for chain 123',
      }),
    ).toBe('chain:123')
  })
  it('a legacy (ref-less) AD-3 breach is carried over a failed read and matched when re-confirmed', () => {
    const run1 = lidoRun(vote(), HEAD1)
    const legacy: SubjectState = {
      ...run1,
      items: run1.items.map((i) => ({
        ...i,
        breaches: i.breaches.map(({ ref: _ref, ...b }) => b),
      })),
    }
    expect(legacy.items[0].breaches[0].ref).toBeUndefined()
    const carried = lidoRun(vote({ defenseUnread: 'x' }), HEAD2, legacy)
    expect(carried.items[0].breaches).toHaveLength(1)
    expect(carried.items[0].breaches[0].ref).toBe(`holder:${short(AGENT)}`)
    // re-confirmed by a read: one breach, not the old one next to the new one
    const again = lidoRun(vote(), HEAD2, legacy)
    expect(again.items[0].breaches).toHaveLength(1)
    expect(again.items[0].breaches[0].unconfirmed).toBeUndefined()
  })
  it('the committed wstETH card: a failed vote-history read at head keeps all its head breaches (was 42 → 0)', () => {
    const file = join(process.cwd(), 'data/oracle-registry/config/state/wsteth.json')
    const st = JSON.parse(readFileSync(file, 'utf8')) as SubjectState
    const before = breachCount(st)
    const ad3 = st.items.flatMap((i) => i.breaches).filter((b) => b.ruleId === 'AD-3').length
    expect(ad3).toBeGreaterThan(0)
    // what this run would build if the D read failed: every vote-ranked AD-3 gone (the Lido
    // powers, the canonical bridges' proxy admin — the Agent — the NTT owner and the DG
    // committees all rank through the LDO vote)
    const items: StateItem[] = st.items.map((i) => ({
      ...i,
      breaches: i.breaches.filter((b) => b.ruleId !== 'AD-3'),
    }))
    const gap =
      'Aragon Voting 0x2e59…618e: trailing-year vote history not read (vote history not read: getVote(205) failed; ranked as a plain contract)'
    const holders = (key: string) =>
      st.powers
        .find((p) => `admin/power/${p.power}/${p.contract.toLowerCase()}` === key)
        ?.holders.map((h) => short(h.address))
    const label = (key: string) =>
      st.powers.find((p) => `admin/power/${p.power}/${p.contract.toLowerCase()}` === key)?.label
    const r = carryUnconfirmedBreaches(
      items,
      { block: st.asOf.block, items: st.items },
      {
        gapsOf: (_key, b) => (b.ruleId === 'AD-3' ? [gap] : []),
        refOf: (key, b) => legacyBreachRef(key, b, { label: label(key), holders: holders(key) }),
      },
    )
    expect(r.carried).toBe(ad3)
    expect(items.reduce((n, i) => n + i.breaches.length, 0)).toBe(before)
    expect(r.gaps).toEqual([gap])
    expect(countsOf(items, []).ruleBreaches).toBe(before)
  })
})

// =====================================================================================================
describe('round 12 (found by the re-collection): a classification in which a read failed is never cached as a fact', () => {
  it('hasReadFailure: an unread proposer set, module list or bypass whitelist anywhere in the tree', () => {
    const tlUnread: Controller = {
      kind: 'oz_timelock',
      address: A('c'),
      delaySec: 180,
      schedulers: [],
      schedulersUnread: true,
    }
    expect(hasReadFailure(tlUnread)).toBe(true)
    // nested: a contract owned by a timelock whose proposer Safe's module list was not read
    const nested: Controller = {
      kind: 'contract',
      address: A('b'),
      ownedBy: {
        kind: 'oz_timelock',
        address: A('c'),
        delaySec: 86400,
        schedulers: [
          { kind: 'safe', address: SAFE, threshold: 3, signers: 5, modulesUnread: true },
        ],
      },
    }
    expect(hasReadFailure(nested)).toBe(true)
    expect(
      hasReadFailure({
        kind: 'oz_timelock',
        address: A('c'),
        delaySec: 0,
        schedulers: [],
        bypass: { fn: 'executeWhitelisted', scope: 'whitelist', unread: true },
      } as Controller),
    ).toBe(true)
    // controls: fully read trees are cacheable
    expect(hasReadFailure({ kind: 'eoa', address: A('e') })).toBe(false)
    expect(hasReadFailure(agentOver(vote()))).toBe(false)
    expect(
      hasReadFailure({
        kind: 'oz_timelock',
        address: A('c'),
        delaySec: 180,
        schedulers: [{ kind: 'safe', address: SAFE, threshold: 6, signers: 11, modules: [] }],
      }),
    ).toBe(false)
  })
})

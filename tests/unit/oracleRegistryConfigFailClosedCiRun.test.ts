// Config cards — the first GitHub Actions run (2026-10-11, run 38159707123, data commit d078fcf0).
// Fixed here (lane E, engine labels): (1) an AD-5 committee red that rests ONLY on an unread
// input was shown as an evidenced downgrade with no READ GAP chip; (2) a red AD-4 grant was
// ended at head ("NO LONGER IN EFFECT") through a scan range of its emitter that was never
// confirmed. Each test failed on the code before the change (controls are marked).
// Synthetic fixtures; the on-chain shapes they copy are cited.

import { describe, expect, it } from 'vitest'

import {
  classifyAdminEvents,
  committeePathTooWeak,
  committeePathWeakness,
  type AdminEventRow,
} from '@/lib/oracleRegistry/config/adminReplay'
import {
  buildSubject,
  rejudgeRoleHoldersAtHead,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import { rankHasReadGap } from '@/lib/oracleRegistry/config/rules'
import type { ConfigChange, ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'

import { tokenVote, voteData } from './oracleRegistryVoteFixtures'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const DAY = 86_400
const EOA = A('e')
const PROXY = A('1')
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const safe = (a: string, t: number, n: number): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
})
const SAFE_6_11 = safe(A('6'), 6, 11)
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const tl = (address: string, delaySec: number, schedulers?: Controller[]): Controller => ({
  kind: 'oz_timelock',
  address,
  delaySec,
  ...(schedulers ? { schedulers } : {}),
})

// =====================================================================================================
// (1) changes/wsteth.json row 1:0x2aac8dd0…:21 — the AccountingOracle HashConsensus 0xd624…b288
// had all 9 members replaced (quorum 5) by a Dual Governance proposal: ProposalExecuted from the
// EmergencyProtectedTimelock 0xce04…2316, the transaction sent to it. The timelock's proposer is
// the Lido Aragon Voting 0x2e59…618e, whose holder concentration was NOT READ ("Transfer logs not
// read from block 11493216") — so the path ranks as a plain contract and the row is red AD-5. It
// was shown as an evidenced downgrade: no `read_gap` tag, so no READ GAP chip and no read-gap row.
describe('AD-5: a committee red that rests only on an unread input is tagged read_gap', () => {
  const TX = '0x2aac8dd013e5284a39a08c3ca463862aa22b06b3c1253390a4fc806d0bca6a9e' as Hx
  const HC = '0xd624b08c83baecf0807dd2c6880c3154a5f0b288'
  const EPT = '0xce0425301c85c5ea2a0873a2dee44d78e02d2316'
  const VOTING = '0x2e59a20f205bb85a89c53f1936454680651e618e'
  const OLD = Array.from({ length: 9 }, (_, i) => A(`a${i + 1}`))
  const NEW = Array.from({ length: 9 }, (_, i) => A(`b${i + 1}`))
  const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
    chainId: 1,
    block: 26_054_464,
    logIndex: 0,
    tx: TX,
    emitter: HC,
    event: 'MemberAdded',
    args: {},
    ...o,
  })
  // 9 removed, 9 added (HashConsensus carries the totals after each change), then the execution
  const swap = (): AdminEventRow[] => {
    const rows: AdminEventRow[] = []
    let i = 1
    let n = 9
    for (const m of OLD)
      rows.push(
        row({
          logIndex: i++,
          event: 'MemberRemoved',
          args: { addr: m, newTotalMembers: String(--n), newQuorum: '5' },
        }),
      )
    for (const m of NEW)
      rows.push(
        row({
          logIndex: i++,
          event: 'MemberAdded',
          args: { addr: m, newTotalMembers: String(++n), newQuorum: '5' },
        }),
      )
    rows.push(row({ logIndex: 100, event: 'ProposalExecuted', emitter: EPT, args: {} }))
    return rows
  }
  const unreadVoting = tokenVote(VOTING, {
    voting: { ...voteData([60]), holdersUnread: 'Transfer logs not read from block 11493216' },
  })
  const dg = (schedulers: Controller[]): Controller => ({
    kind: 'aragon_dg',
    address: EPT,
    delaySec: 691_200,
    schedulers,
    dg: {
      proposers: [VOTING],
      proposerVoteSec: 432_000,
      afterSubmitDelaySec: 259_200,
      afterScheduleDelaySec: 86_400,
      governance: A('8'),
      adminExecutor: A('5'),
      emergencyGovernance: null,
      activationCommittee: null,
      executionCommittee: null,
      emergencyModeActive: false,
      emergencyProtectionEndsAfter: null,
    },
  })
  const ctx = (m: Record<string, Controller>, o: Record<string, unknown> = {}) => ({
    subject: 'wsteth',
    ctl: (a: string, b: number) => m[`${a}@${b}`] ?? m[`${a}@head`] ?? null,
    upgradeTimelocks: {},
    deployBlocks: { [HC]: 10 },
    tokens: [],
    announcement: 'not_checked' as const,
    committeePaths: { [HC]: [EPT, VOTING] },
    txTo: { [TX]: EPT },
    ...o,
  })
  const committeeRow = (c: ReturnType<typeof ctx>) => {
    const out = classifyAdminEvents(swap(), c)
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe(`oracle/committee/${HC}`)
    expect(out[0].title).toMatch(/9 members replaced \(9 → 9 members, quorum 5\)/)
    return out[0]
  }

  it('the wstETH shape: the path rests on an UNREAD holder concentration — red AD-5 WITH read_gap (was untagged)', () => {
    const path = dg([unreadVoting])
    expect(rankHasReadGap(path)).toBe(true) // fixture check: the on-chain row's rank note
    const c = committeeRow(ctx({ [`${EPT}@head`]: path }))
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(['AD-5'])
    expect(c.tags).toContain('read_gap')
    expect(c.notes?.join(' ')).toMatch(
      /does not count as the delayed governance path: its rank rests on a read gap \(Dual Governance timelock .*holder concentration UNREAD \(Transfer logs not read from block 11493216\)/,
    )
  })

  it('a committee controller not classified, or ranked on a read gap: read_gap', () => {
    const CTRL = A('c1')
    const strong = dg([tokenVote(VOTING)]) // the broadly held 13 × 4 vote: read, strong
    expect(rankHasReadGap(strong)).toBe(false)
    const notClassified = committeeRow(
      ctx({ [`${EPT}@head`]: strong }, { committeeControllers: { [HC]: [CTRL] } }),
    )
    expect(notClassified.red).toBe(true)
    expect(notClassified.tags).toContain('read_gap')
    expect(notClassified.notes?.join(' ')).toMatch(/controller 0xc1c1…c1c1 could not be classified/)
    const onGap = committeeRow(
      ctx(
        { [`${EPT}@head`]: strong, [`${CTRL}@head`]: tl(CTRL, 7 * DAY) },
        { committeeControllers: { [HC]: [CTRL] } },
      ),
    )
    expect(onGap.red).toBe(true)
    expect(onGap.tags).toContain('read_gap')
    // the path controller itself not classified
    const pathUnread = committeeRow(ctx({}))
    expect(pathUnread.red).toBe(true)
    expect(pathUnread.tags).toContain('read_gap')
  })

  it('control: a READ path that ranks below the committee controller is red WITHOUT read_gap', () => {
    const CTRL = A('c1')
    const weak = dg([eoa(EOA)])
    const c = committeeRow(
      ctx(
        { [`${EPT}@head`]: weak, [`${CTRL}@head`]: tl(CTRL, 7 * DAY, [SAFE_6_11]) },
        { committeeControllers: { [HC]: [CTRL] } },
      ),
    )
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(['AD-5'])
    expect(c.tags).not.toContain('read_gap')
    expect(c.notes?.join(' ')).toMatch(/ranks below the committee's controller/)
    // and with no declared controller: below a multisig behind 24 h — read, no gap
    const noCtl = committeeRow(ctx({ [`${EPT}@head`]: weak }))
    expect(noCtl.red).toBe(true)
    expect(noCtl.tags).not.toContain('read_gap')
  })

  it('control: a READ, broadly held path is neutral (no AD-5, no read_gap)', () => {
    const c = committeeRow(ctx({ [`${EPT}@head`]: dg([tokenVote(VOTING)]) }))
    expect(c.red).toBe(false)
    expect(c.tags).not.toContain('read_gap')
    expect(c.tags).toContain('rotation')
  })

  // Review of lane E (2026-10-11, finding 3a): collect-config.mjs writes null when
  // eth_getTransactionByHash throws. Without the recipient, proof (a) — the transaction SENT to
  // the path, whose execution follows the member events — cannot be made: the red rests on a read
  // that did not happen, and the note said "the transaction was not sent to the path".
  it('the transaction recipient NOT READ, a path execution after the members: red AD-5 WITH read_gap (was untagged)', () => {
    const strong = dg([tokenVote(VOTING)])
    for (const txTo of [{ [TX]: null }, {}]) {
      const c = committeeRow(ctx({ [`${EPT}@head`]: strong }, { txTo }))
      expect(c.red, JSON.stringify(txTo)).toBe(true)
      expect(c.ruleIds).toEqual(['AD-5'])
      expect(c.tags).toContain('read_gap')
      const notes = c.notes?.join(' ') ?? ''
      expect(notes).toMatch(/the transaction's recipient was not read/)
      expect(notes).not.toMatch(/the transaction was not sent to the path/)
    }
    // with no txTo map at all (an older raw): the same
    const noMap: Partial<ReturnType<typeof ctx>> = ctx({ [`${EPT}@head`]: strong })
    delete noMap.txTo
    const [none] = classifyAdminEvents(swap(), noMap as ReturnType<typeof ctx>)
    expect(none.red).toBe(true)
    expect(none.tags).toContain('read_gap')
  })

  it('control: the recipient READ and not the path, or no path execution after the members: red WITHOUT read_gap', () => {
    const strong = dg([tokenVote(VOTING)])
    const elsewhere = committeeRow(ctx({ [`${EPT}@head`]: strong }, { txTo: { [TX]: A('9') } }))
    expect(elsewhere.red).toBe(true)
    expect(elsewhere.tags).not.toContain('read_gap')
    expect(elsewhere.notes?.join(' ')).toMatch(/the transaction was not sent to the path/)
    // the path ran only BEFORE the member events: no recipient could prove it
    const rows = swap().map((x) => (x.event === 'ProposalExecuted' ? { ...x, logIndex: 0 } : x))
    const early = classifyAdminEvents(rows, ctx({ [`${EPT}@head`]: strong }, { txTo: {} }))
    expect(early[0].red).toBe(true)
    expect(early[0].tags).not.toContain('read_gap')
  })

  // Review of lane E (finding 3b): collect-config.mjs writes `holders: []` with an error when a
  // declared power over the committee is not resolved; the engine then knew NO path (the power
  // exists, so the subject's timelocks are not used) and the row was red "the committee has no
  // declared delayed governance path" — untagged. The path and the controllers were not read.
  it('the committee power NOT READ (no path known): red AD-5 WITH read_gap, and says why (was untagged)', () => {
    const unreadPower = { [HC]: ['Oracle committee members: holders not resolved (HTTP 429)'] }
    const c = committeeRow(
      ctx({}, { committeePaths: { [HC]: [] }, committeePathsUnread: unreadPower }),
    )
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(['AD-5'])
    expect(c.tags).toContain('read_gap')
    expect(c.notes?.join(' ')).toMatch(
      /no delayed governance path is known: the declared power over the committee was not read \(Oracle committee members: holders not resolved \(HTTP 429\); fail closed\)/,
    )
    // a path known from another READ power, the change made through it, but the committee's
    // controllers partly unread: the weakness rests on the unread holders
    const CTRL = A('c1')
    const partial = committeeRow(
      ctx(
        { [`${EPT}@head`]: dg([eoa(EOA)]), [`${CTRL}@head`]: tl(CTRL, 7 * DAY, [SAFE_6_11]) },
        { committeeControllers: { [HC]: [CTRL] }, committeePathsUnread: unreadPower },
      ),
    )
    expect(partial.red).toBe(true)
    expect(partial.tags).toContain('read_gap')
    // control: the same with every power read — no path is evidence, no read_gap
    const read = committeeRow(ctx({}, { committeePaths: { [HC]: [] } }))
    expect(read.red).toBe(true)
    expect(read.tags).not.toContain('read_gap')
    expect(read.notes?.join(' ')).toMatch(/has no declared delayed governance path \(fail closed\)/)
  })

  it('committeePathWeakness says whether the weakness rests on a read gap; committeePathTooWeak keeps the reason', () => {
    const CTRL = A('c1')
    const unread = { ctl: () => null }
    expect(committeePathWeakness(unread, HC, EPT, 100)).toEqual({
      reason: expect.stringMatching(/could not be classified/),
      readGap: true,
    })
    expect(committeePathTooWeak(unread, HC, EPT, 100)).toMatch(/could not be classified/)
    const gap = { ctl: (a: string) => (a === EPT ? dg([unreadVoting]) : null) }
    expect(committeePathWeakness(gap, HC, EPT, 100)?.readGap).toBe(true)
    const read = {
      ctl: (a: string) =>
        a === EPT ? dg([eoa(EOA)]) : a === CTRL ? tl(CTRL, 7 * DAY, [SAFE_6_11]) : null,
      committeeControllers: { [HC]: [CTRL] },
    }
    expect(committeePathWeakness(read, HC, EPT, 100)?.readGap).toBe(false)
    const ok = { ctl: (a: string) => (a === EPT ? dg([tokenVote(VOTING)]) : null) }
    expect(committeePathWeakness(ok, HC, EPT, 100)).toBeNull()
    expect(committeePathTooWeak(ok, HC, EPT, 100)).toBeNull()
  })
})

// =====================================================================================================
// (2) UQ-21 class: a red AD-4 grant ends at head only on a replay the scan confirmed. The grant is
// still held because no RoleRevoked was SEEN; a chunk of the emitter that was not confirmed
// between the grant and head may hold a revoke and a re-grant, or the grant itself. The first CI
// run had 204 unconfirmed scan chunks ("HTTP request failed." from the second log endpoint).
describe('rejudgeRoleHoldersAtHead: no clearance through an unconfirmed scan range of the emitter', () => {
  const MINTING = A('2')
  const MC = A('b2')
  const ROLE = '0x' + 'ab'.repeat(32)
  const HEAD = 1000
  const grantEv: AdminEventRow = {
    chainId: 1,
    block: 100,
    logIndex: 0,
    tx: '0x64',
    emitter: MINTING,
    event: 'RoleGranted',
    args: { role: ROLE, roleName: 'PROPOSER_ROLE', account: MC },
  }
  const redRow = (): ConfigChange =>
    ({
      id: '1:0x64:0',
      subject: 'z',
      dimension: 'admin',
      key: `admin/role/${MINTING}/PROPOSER_ROLE`,
      title: '',
      state: 'historical',
      stage: 'executed',
      severity: 'downgrade',
      floorBreach: false,
      red: true,
      ruleIds: ['AD-4'],
      tags: [],
      unannounced: null,
      announcement: 'not_checked',
      chainId: 1,
      block: 100,
      stillInEffect: true,
      notes: [],
    }) as unknown as ConfigChange
  // granted to a 10-day timelock an EOA proposed into; at head a Safe 6/11 proposes: stronger,
  // and the grant would not be red today — the clearance case
  const run = (scanGaps?: RawSubject['scanGaps']) => {
    const r = redRow()
    rejudgeRoleHoldersAtHead([r], [grantEv], {
      ctlAt: (a, b) => (a === MC && b === 100 ? tl(MC, 10 * DAY, [eoa(EOA)]) : null),
      ctlRanked: () => null,
      ctlHead: (a) => (a === MC ? tl(MC, 10 * DAY, [SAFE_6_11]) : null),
      administers: () => false,
      head: HEAD,
      subject: 'z',
      announcement: 'not_checked',
      scanGaps,
    })
    return r
  }
  const gap = (from: number, to: number, addresses?: string[]) => ({
    scan: 'admin event scan',
    from,
    to,
    ...(addresses ? { addresses } : {}),
    error: 'HTTP request failed.',
  })

  it('a gap on the emitter between the grant and head: STILL IN EFFECT (was "NO LONGER IN EFFECT")', () => {
    const r = run([gap(500, 599, [PROXY, MINTING.toUpperCase().replace('0X', '0x')])])
    expect(r.stillInEffect).toBe(true)
    const notes = r.notes?.join(' ') ?? ''
    expect(notes).not.toMatch(/NO LONGER IN EFFECT/)
    expect(notes).toMatch(
      /STILL IN EFFECT at head \(block 1000\): .*admin event scan blocks 500–599 of 0x2222…2222 were not confirmed \(HTTP request failed\.\) — a failed read never ends a red/,
    )
  })

  it('a gap that holds the grant block itself, or one with no address list (fail closed): still in effect', () => {
    expect(run([gap(0, 100, [MINTING])]).stillInEffect).toBe(true)
    expect(run([gap(900, 999)]).stillInEffect).toBe(true)
  })

  // Review of lane E (2026-10-11, finding 1): the holders a grant is ranked against are the replay
  // of EVERY earlier event of the emitter, so a gap wholly BEFORE the grant counts too (it was the
  // control here: `gap(0, 99)` ended the red).
  it('control: no gap, a gap on another emitter, or one after head — it ends', () => {
    for (const g of [undefined, [gap(500, 599, [PROXY])], [gap(1001, 1100, [MINTING])]]) {
      const r = run(g)
      expect(r.stillInEffect, JSON.stringify(g)).toBe(false)
      expect(r.notes?.join(' ')).toMatch(/NO LONGER IN EFFECT at head/)
    }
  })

  it('a gap wholly BEFORE the grant (it can hide the revoke of a weaker co-holder): still in effect (was "NO LONGER IN EFFECT")', () => {
    // the reviewer's probe: W (10-day timelock, Safe 6/11 proposing) granted at 10, X (an EOA) at
    // 50, X REVOKED at 80 — that log lost in an unconfirmed range 60–99 of the emitter. MC (a
    // 10-day timelock an EOA proposed into) granted at 100: red. At head MC's proposer is a Safe
    // 2/3: ranked against [W, X] the grant would not be red today, against [W] it still is.
    const W = A('a7')
    const X = A('a8')
    const ev = (block: number, account: string, event = 'RoleGranted'): AdminEventRow => ({
      ...grantEv,
      block,
      tx: `0x${block.toString(16)}` as Hx,
      event,
      args: { ...grantEv.args, account },
    })
    const seen = [ev(10, W), ev(50, X), grantEv] // the revoke at 80 is in the gap
    const probe = (scanGaps?: RawSubject['scanGaps'], events = seen) => {
      const r = redRow()
      rejudgeRoleHoldersAtHead([r], events, {
        ctlAt: (a, b) => (a === MC && b === 100 ? tl(MC, 10 * DAY, [eoa(EOA)]) : null),
        ctlRanked: (a) => (a === W ? tl(W, 10 * DAY, [SAFE_6_11]) : a === X ? eoa(X) : null),
        ctlHead: (a) => (a === MC ? tl(MC, 10 * DAY, [safe(A('3'), 2, 3)]) : null),
        administers: () => false,
        head: HEAD,
        subject: 'z',
        announcement: 'not_checked',
        scanGaps,
      })
      return r
    }
    // fixture checks: the replay that saw X's revoke keeps the red; the one that missed it ends it
    expect(probe(undefined, [...seen, ev(80, X, 'RoleRevoked')]).stillInEffect).toBe(true)
    expect(probe(undefined).stillInEffect).toBe(false)
    // the gap 60–99 sits wholly before the grant at 100: the clearance rests on it
    const r = probe([gap(60, 99, [MINTING])])
    expect(r.stillInEffect).toBe(true)
    expect(r.notes?.join(' ')).not.toMatch(/NO LONGER IN EFFECT/)
    expect(r.notes?.join(' ')).toMatch(
      /admin event scan blocks 60–99 of 0x2222…2222 were not confirmed \(HTTP request failed\.\) — a failed read never ends a red/,
    )
    // and from the deploy block on: a gap at block 0 still counts
    expect(probe([gap(0, 9, [MINTING])]).stillInEffect).toBe(true)
  })

  it('an Aragon row: a gap in the ACL scan its history was read from keeps the red (second review)', () => {
    // aragonRows rewrites ACL SetPermission logs onto the app (emitter = app, args.acl = ACL), so
    // the app's replay rests on the ACL's scan; a gap there must count like one on the emitter
    const ACL = A('ac')
    const W = A('a7')
    const X = A('a8')
    const ev = (block: number, account: string, event = 'RoleGranted'): AdminEventRow => ({
      ...grantEv,
      block,
      tx: `0x${block.toString(16)}` as Hx,
      event,
      args: { ...grantEv.args, account, via: 'ACL', acl: ACL },
    })
    const grant = { ...grantEv, args: { ...grantEv.args, via: 'ACL', acl: ACL } }
    const seen = [ev(10, W), ev(50, X), grant]
    const probe = (scanGaps?: RawSubject['scanGaps']) => {
      const r = redRow()
      rejudgeRoleHoldersAtHead([r], seen, {
        ctlAt: (a, b) => (a === MC && b === 100 ? tl(MC, 10 * DAY, [eoa(EOA)]) : null),
        ctlRanked: (a) => (a === W ? tl(W, 10 * DAY, [SAFE_6_11]) : a === X ? eoa(X) : null),
        ctlHead: (a) => (a === MC ? tl(MC, 10 * DAY, [safe(A('3'), 2, 3)]) : null),
        administers: () => false,
        head: HEAD,
        subject: 'z',
        announcement: 'not_checked',
        scanGaps,
      })
      return r
    }
    // control: no gap, or a gap on an unrelated address — the clearance stands
    expect(probe(undefined).stillInEffect).toBe(false)
    expect(probe([gap(60, 99, [PROXY])]).stillInEffect).toBe(false)
    // the pre-window ACL scan (addresses: [ACL]) failed over 60–99: the red stays in effect
    const r = probe([
      {
        ...gap(60, 99, [ACL.toUpperCase().replace('0X', '0x')]),
        scan: 'Aragon ACL scan (before the window)',
      },
    ])
    expect(r.stillInEffect).toBe(true)
    expect(r.notes?.join(' ')).toMatch(
      /Aragon ACL scan \(before the window\) blocks 60–99 .* a failed read never ends a red/,
    )
  })

  // the engine passes this run's scan gaps (raw.scanGaps) to the re-judge
  const registry: DvnRegistry = {
    byChain: { 1: {} },
    dead: { 1: [] },
    libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
  }
  const s: ConfigSubject = {
    key: 'z',
    label: 'Z',
    oracleAssetKey: null,
    class: 'lrt',
    contracts: [
      { role: 'token', dimension: 'admin', chainId: 1, address: PROXY, label: 'p', deployBlock: 1 },
      {
        role: 'minting',
        dimension: 'mint_redeem',
        chainId: 1,
        address: MINTING,
        label: 'm',
        deployBlock: 1,
      },
    ],
    lzOApps: [],
    ccipPools: [],
    powers: [],
    params: [],
    timelocks: [],
    safes: [],
    govChannels: [],
  } as ConfigSubject
  const raw = (scanGaps?: RawSubject['scanGaps']): RawSubject => ({
    version: 1,
    subjectKey: 'z',
    head: { block: 30_000_000, ts: 2000 },
    scan: { from: 1, to: 30_000_000 },
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
      events: [grantEv],
      controllers: {
        [`${MC}@100`]: tl(MC, 10 * DAY, [eoa(EOA)]),
        [`${MC}@head`]: tl(MC, 10 * DAY, [SAFE_6_11]),
      },
      powers: [],
      timelockAdmins: [],
      implHistory: {},
      owners: {},
      delegates: {},
      minDelays: {},
    },
    params: { head: {}, transitions: [] },
    queues: { ops: [], safe: [], safeStatus: [] },
    ccip: { pools: [] },
    warnings: [],
    ...(scanGaps ? { scanGaps } : {}),
  })
  const grantRow = (r: RawSubject) =>
    buildSubject(s, r, {
      registry,
      eidName: () => 'x',
      roleName: (h) => h,
      endpoint: EP,
    }).changes.find((c) => c.key === `admin/role/${MINTING}/PROPOSER_ROLE`)!

  it('engine: buildSubject passes raw.scanGaps — the grant stays in effect (was ended)', () => {
    const g = grantRow(raw([gap(20_000_000, 20_499_999, [MINTING])]))
    expect(g.red).toBe(true)
    expect(g.stillInEffect).toBe(true)
    expect(g.notes?.join(' ')).toMatch(/were not confirmed .* a failed read never ends a red/)
  })

  it('control (engine): no scan gap — a READ stronger head grantee still ends it', () => {
    const g = grantRow(raw())
    expect(g.red).toBe(true)
    expect(g.stillInEffect).toBeFalsy()
    expect(g.notes?.join(' ')).toMatch(/NO LONGER IN EFFECT at head/)
  })
})

// =====================================================================================================
// Review of lane E (2026-10-11, finding 3b, engine) and 3c (the upgrade AD-5 judged against the
// declared timelock because the upgrade holders were not read).
describe('AD-5: the remaining fail-closed AD-5 paths carry read_gap', () => {
  const HC = A('d')
  const EPT = A('7')
  const VOTING = A('4')
  const EXEC = A('5')
  const AGENT = A('3')
  const TX = '0x7878' as Hx
  const registry: DvnRegistry = {
    byChain: { 1: {} },
    dead: { 1: [] },
    libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
  }
  const s = {
    key: 'z',
    label: 'Z',
    oracleAssetKey: null,
    class: 'lrt',
    contracts: [
      { role: 'oracle', dimension: 'oracle', chainId: 1, address: HC, label: 'HC', deployBlock: 1 },
    ],
    lzOApps: [],
    ccipPools: [],
    powers: [
      {
        power: 'oracle',
        contract: HC,
        path: ['role:MANAGE_MEMBERS_AND_QUORUM_ROLE'],
        label: 'Oracle committee members',
      },
    ],
    params: [],
    timelocks: [],
    safes: [],
    govChannels: [],
  } as unknown as ConfigSubject
  const agent: Controller = {
    kind: 'contract',
    address: AGENT,
    version: 'Aragon Agent',
    ownedBy: {
      kind: 'contract',
      address: EXEC,
      ownedBy: {
        kind: 'aragon_dg',
        address: EPT,
        delaySec: 691_200,
        schedulers: [tokenVote(VOTING)],
        dg: {
          proposers: [VOTING],
          proposerVoteSec: 432_000,
          afterSubmitDelaySec: 259_200,
          afterScheduleDelaySec: 86_400,
          governance: A('8'),
          adminExecutor: EXEC,
          emergencyGovernance: null,
          activationCommittee: null,
          executionCommittee: null,
          emergencyModeActive: false,
          emergencyProtectionEndsAfter: null,
        },
      } as Controller,
    },
  }
  const ev = (o: Partial<AdminEventRow>): AdminEventRow => ({
    chainId: 1,
    block: 26_054_464,
    logIndex: 0,
    tx: TX,
    emitter: HC,
    event: 'MemberAdded',
    args: {},
    ...o,
  })
  const events = [
    ev({
      logIndex: 1,
      event: 'MemberRemoved',
      args: { addr: A('a1'), newTotalMembers: '8', newQuorum: '5' },
    }),
    ev({
      logIndex: 2,
      event: 'MemberAdded',
      args: { addr: A('b1'), newTotalMembers: '9', newQuorum: '5' },
    }),
    ev({ logIndex: 3, event: 'ProposalExecuted', emitter: EPT }),
  ]
  const raw = (power: RawSubject['admin']['powers'][number]): RawSubject => ({
    version: 1,
    subjectKey: 'z',
    head: { block: 30_000_000, ts: 2000 },
    scan: { from: 1, to: 30_000_000 },
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
      events,
      controllers: { [`${AGENT}@head`]: agent },
      powers: [power],
      timelockAdmins: [],
      implHistory: {},
      owners: {},
      delegates: {},
      minDelays: {},
      txTo: { [TX]: EPT },
    },
    params: { head: {}, transitions: [] },
    queues: { ops: [], safe: [], safeStatus: [] },
    ccip: { pools: [] },
    warnings: [],
  })
  const committee = (r: RawSubject) =>
    buildSubject(s, r, {
      registry,
      eidName: () => 'x',
      roleName: (h) => h,
      endpoint: EP,
    }).changes.filter((c) => c.key === `oracle/committee/${HC}`)

  it('engine: the power over the committee NOT READ (holders [] + error) — red AD-5 WITH read_gap (was untagged)', () => {
    const [c] = committee(
      raw({
        power: 'oracle',
        label: 'Oracle committee members',
        contract: HC,
        holders: [],
        error: 'HTTP request failed.',
      }),
    )
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(['AD-5'])
    expect(c.tags).toContain('read_gap')
    expect(c.notes?.join(' ')).toMatch(
      /not read \(Oracle committee members: holders not resolved \(HTTP request failed\.\); fail closed\)/,
    )
  })

  it('control (engine): the power READ — the change made through its Dual Governance path is neutral', () => {
    const [c] = committee(
      raw({ power: 'oracle', label: 'Oracle committee members', contract: HC, holders: [AGENT] }),
    )
    expect(c.red).toBe(false)
    expect(c.tags).not.toContain('read_gap')
  })

  // 3c: adminReplay ad5 — holders not read, judged against the declared timelock: the sibling
  // branch (no timelock known at all) was tagged, this one was not
  const TL = A('c')
  const up: AdminEventRow[] = [
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
  const uctx = (o: Record<string, unknown>) => ({
    subject: 'z',
    ctl: () => null,
    upgradeTimelocks: {},
    timelockSince: { [TL]: 0 },
    upgradeHoldersAt: {},
    deployBlocks: { [PROXY]: 1 },
    tokens: [],
    announcement: 'no_gov_channel' as const,
    ...o,
  })
  const ad5Row = (o: Record<string, unknown>) => {
    const out = classifyAdminEvents(up, uctx(o))
    const c = out.find((x) => x.ruleIds.includes('AD-5'))
    expect(c, JSON.stringify(out.map((x) => x.ruleIds))).toBeDefined()
    return c!
  }

  it('an upgrade whose holders were NOT READ, judged against the declared timelock: red AD-5 WITH read_gap (was untagged)', () => {
    for (const o of [
      { upgradeHoldersUnread: [`${PROXY}@200`], upgradeTimelocks: { [PROXY]: [TL] } },
      { upgradeHoldersUnread: [`${PROXY}@200`], declaredTimelocks: [TL] },
    ]) {
      const c = ad5Row(o)
      expect(c.red, JSON.stringify(o)).toBe(true)
      expect(c.tags).toContain('read_gap')
      expect(c.notes?.join(' ')).toMatch(
        /the upgrade holders before it were not read: judged against the declared timelock/,
      )
    }
  })

  it('control: holders READ (a timelock that did not execute it) — red AD-5 WITHOUT read_gap', () => {
    const c = ad5Row({
      upgradeHoldersAt: { [`${PROXY}@200`]: [tl(TL, 2 * DAY, [SAFE_6_11])] },
    })
    expect(c.red).toBe(true)
    expect(c.tags).not.toContain('read_gap')
  })
})

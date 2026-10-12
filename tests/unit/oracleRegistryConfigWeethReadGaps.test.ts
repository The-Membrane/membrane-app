// Config cards — F3 / F4 (weETH re-collect, bot data commit d88410c5, head 26,173,524).
//   F3: an upgrade whose holders were not read is judged against the subject's DECLARED timelocks
//       (PH-07), floored only by `timelockSince` — filled for the timelocks holding an upgrade
//       power at head. The 2023 weETH upgrades read "no CallExecuted … from 0xcd42…5d7a", a
//       timelock deployed at 22,089,226 (2025). Each declared timelock now counts from its deploy
//       block; with none deployed yet the fail-closed branch ("no timelock is known") applies.
//   F4: the card listed ONE read gap (the oracle window) while 13 rows were tagged read_gap — 9
//       AD-5 upgrades on holders not read at the block before (roleRegistry() reverts before the
//       RoleRegistry 0x6224… existed: the collector sent that to `warnings` only) and 4 AD-4 grants
//       to timelock 0x8221…9f2a, whose proposers were not read at the grant blocks (no power at
//       head: no head tree lists it). RV11-1: a card never renders a read gap it does not count.
//   R4: F4's collector half (the reason recorded per proxy@block, filed on its subject) is two
//       admin.mjs helpers with their own tests — every F4 test above them passes a ready-made raw.
//   R6: one F3 test pins the `timelockSince` half of the floor: it fails on a deploy-block-only
//       floor (the mutant), not on the code before R6 — a test, no behaviour change.
// Each test failed on the code before the fix unless it is marked (control). Synthetic fixtures;
// the on-chain shapes they copy are cited.

import { readFileSync } from 'fs'

import { describe, expect, it } from 'vitest'

import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import type { ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import {
  buildConfigCard,
  buildConfigSummary,
  readGapsOf,
  type ConfigInputs,
} from '@/lib/oracleRegistry/config/view'
import {
  recordUpgradeHoldersUnread as recordUnreadJs,
  upgradeHoldersUnreadFor as unreadForJs,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'

import { causeListed } from './oracleRegistryReadGapCause'

// the collector is JavaScript: its inferred parameter types are narrowed here
type UnreadAcc = { unread: string[]; why: Record<string, string> }
const recordUnread = recordUnreadJs as unknown as (
  acc: UnreadAcc,
  proxy: string,
  block: number,
  err: unknown,
) => string
const unreadFor = unreadForJs as unknown as (
  acc: UnreadAcc,
  subjectAddrs: Set<string>,
) => Pick<RawSubject['admin'], 'upgradeHoldersUnread' | 'upgradeHoldersUnreadWhy'>

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const EP = '0x1a44076050125825900e736c501f859c50fe728c'

// subjects.json weeth: LiquidityPool (UUPS), RoleRegistry, the two declared timelocks
const POOL = '0x308861a430be4cce5502d0a12724771fc6daf216'
const POOL_DEPLOY = 17_664_317
const RR = '0x62247d29b4b9becf4bb73e0c722cf6445cfc7ce9'
const RR_DEPLOY = 22_039_954
const TL_UP = '0x9f26d4c958fd811a1f59b01b86be7dffc9d20761' // Upgrade timelock (10 d)
const TL_UP_DEPLOY = 19_298_624
const TL_OP = '0xcd425f44758a08baab3c4908f3e3de5776e45d7a' // Operating timelock (2 d)
const TL_OP_DEPLOY = 22_089_226
// changes/weeth.json: the 8 h timelock granted RoleRegistry roles at 22,084,653 / 655 / 676
const TL8 = '0x82215f1274356e94543a4d6bac6f7170d8a59f2a'
const ROLE = '0xdf341d2a9af804fa0099198f83a0a0611aa273a03b36d576993f914e695dff2a'
const ADAPTER = '0xcd2eb13d6831d4602d80e5db9230a57596cdca63' // weETH OFT adapter (an owner change)
const ADAPTER_DEPLOY = 20_865_339
const OLD_OWNER = A('7')
const SAFE = A('5')
// the collector's scrubbed error (warnings: "upgrade holders of 0x3088…@17730778: …")
const WHY = `roleRegistry() not present on ${POOL} (declared path call:roleRegistry()>owner)`

const registry: DvnRegistry = {
  byChain: { 1: {} },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
const contract = (address: string, deployBlock: number, role: 'token' | 'config' | 'timelock') => ({
  role,
  dimension: 'admin' as const,
  chainId: 1 as const,
  address,
  label: short(address),
  deployBlock,
})
const subject = (o: Partial<ConfigSubject> = {}): ConfigSubject => ({
  key: 'weeth',
  label: 'weETH',
  oracleAssetKey: null,
  class: 'lrt',
  contracts: [
    contract(POOL, POOL_DEPLOY, 'token'),
    contract(RR, RR_DEPLOY, 'config'),
    contract(ADAPTER, ADAPTER_DEPLOY, 'config'),
    contract(TL_UP, TL_UP_DEPLOY, 'timelock'),
    contract(TL_OP, TL_OP_DEPLOY, 'timelock'),
  ],
  lzOApps: [],
  ccipPools: [],
  powers: [],
  params: [],
  timelocks: [TL_UP, TL_OP],
  safes: [],
  govChannels: [],
  ...o,
})
const ev = (o: Partial<AdminEventRow> & Pick<AdminEventRow, 'block' | 'event'>): AdminEventRow => ({
  chainId: 1,
  logIndex: 0,
  tx: `0x${o.block.toString(16)}`,
  emitter: POOL,
  args: {},
  ...o,
})
const upgraded = (block: number, impl: string, tx?: string) =>
  ev({ block, event: 'Upgraded', args: { implementation: impl }, ...(tx ? { tx } : {}) })
const tl8: Controller = {
  kind: 'oz_timelock',
  address: TL8,
  delaySec: 8 * 3600,
  schedulersUnread: true,
}
const safe: Controller = { kind: 'safe', address: SAFE, threshold: 3, signers: 5 }

// the AD-5 upgrades on holders not read: two in 2023 (no declared timelock deployed yet), one
// between the two deployments; then one the Operating timelock executed (holders unread too)
const UP_2023 = [17_730_779, 18_537_431]
const UP_MID = 20_000_000
const UP_EXEC = 22_131_382
const EXEC_TX = '0xe0'
const GRANTS = [22_084_653, 22_084_655, 22_084_676]
const OWNER_MOVE = 21_000_000
const events: AdminEventRow[] = [
  ...UP_2023.map((b, i) => upgraded(b, A(String(i + 1)))),
  upgraded(UP_MID, A('3')),
  upgraded(UP_EXEC, A('4'), EXEC_TX),
  ev({
    block: UP_EXEC,
    event: 'CallExecuted',
    emitter: TL_OP,
    tx: EXEC_TX,
    logIndex: 1,
    args: { id: '0x01', index: 0, target: POOL },
  }),
  ...GRANTS.map((b, i) =>
    ev({
      block: b,
      logIndex: i,
      event: 'RoleGranted',
      emitter: RR,
      args: { role: ROLE, account: TL8, sender: A('9') },
    }),
  ),
  ev({
    block: OWNER_MOVE,
    event: 'OwnershipTransferred',
    emitter: ADAPTER,
    args: { previousOwner: OLD_OWNER, newOwner: SAFE },
  }),
]
const unreadKeys = [...UP_2023, UP_MID, UP_EXEC].map((b) => `${POOL}@${b}`)
const rawOf = (o: Partial<RawSubject['admin']> = {}): RawSubject => ({
  version: 1,
  subjectKey: 'weeth',
  head: { block: 26_173_524, ts: 2000 },
  scan: { from: 1, to: 26_173_524 },
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
    controllers: {
      ...Object.fromEntries(GRANTS.map((b) => [`${TL8}@${b}`, tl8])),
      [`${SAFE}@${OWNER_MOVE}`]: safe,
    },
    // the previous owner's classification at block − 1 FAILED
    classifyFailed: [`${OLD_OWNER}@${OWNER_MOVE - 1}`],
    powers: [],
    timelockAdmins: [],
    implHistory: {},
    owners: {},
    delegates: {},
    minDelays: {},
    upgradeHoldersAt: {},
    upgradeHoldersUnread: unreadKeys,
    upgradeHoldersUnreadWhy: Object.fromEntries(unreadKeys.map((k) => [k, WHY])),
    verification: Object.fromEntries(['1', '2', '3', '4'].map((n) => [A(n), true])),
    ...o,
  },
  params: { head: {}, transitions: [] },
  queues: { ops: [], safe: [], safeStatus: [] },
  ccip: { pools: [] },
  warnings: [],
})
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const at = (out: ReturnType<typeof build>, block: number, key = `admin/implementation/${POOL}`) =>
  out.changes.find((c) => c.block === block && c.key === key)!

// =====================================================================================================
describe('F3: an upgrade on unread holders is never judged against a timelock that did not exist yet', () => {
  it('weETH 0x3088…f216 @17,730,779: no declared timelock deployed yet — "no timelock is known" (was "from 0xcd42…5d7a")', () => {
    // the shape weETH stored: 0x9f26… holds the upgrade power at head (timelockSince = its first
    // power event), 0xcd42… only declared (no `timelockSince`: counted from block 0)
    const out = classifyAdminEvents([upgraded(UP_2023[0], A('1'))], {
      subject: 'weeth',
      ctl: () => null,
      upgradeTimelocks: { [POOL]: [TL_UP] },
      timelockSince: { [TL_UP]: TL_UP_DEPLOY },
      upgradeHoldersAt: {},
      upgradeHoldersUnread: [`${POOL}@${UP_2023[0]}`],
      declaredTimelocks: [TL_UP, TL_OP],
      deployBlocks: { [POOL]: POOL_DEPLOY, [TL_UP]: TL_UP_DEPLOY, [TL_OP]: TL_OP_DEPLOY },
      tokens: [],
      announcement: 'no_gov_channel',
      verified: () => true,
    })
    const [c] = out
    const notes = c.notes?.join(' ') ?? ''
    expect(notes).not.toMatch(new RegExp(`${short(TL_OP)}|${short(TL_UP)}`))
    expect(notes).toMatch(
      /the upgrade holders before it were not read and no timelock is known to judge it against \(fail closed\)/,
    )
    // the verdict is the same red, on the same read gap (text-only until the holders are read)
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('AD-5')
    expect(c.tags).toEqual(expect.arrayContaining(['read_gap', 'authority_unread']))
  })

  it('engine: 2023 upgrades name no timelock; one between the deployments is judged against 0x9f26…0761 only (was "0x9f26…0761/0xcd42…5d7a")', () => {
    const out = build(subject(), rawOf())
    for (const b of UP_2023) {
      const c = at(out, b)
      expect(c.notes?.join(' ')).not.toMatch(new RegExp(`${short(TL_OP)}|${short(TL_UP)}`))
      expect(c.notes?.join(' ')).toMatch(/no timelock is known to judge it against/)
      expect(c.red).toBe(true)
    }
    const mid = at(out, UP_MID).notes?.join(' ') ?? ''
    expect(mid).toMatch(
      `no CallExecuted / ProposalExecuted from ${short(TL_UP)} in this transaction`,
    )
    expect(mid).not.toMatch(short(TL_OP))
  })

  // R6 (2026-10-12): pins the `timelockSince` half of the floor (Math.max in ad5) — the tests above
  // pass on a deploy-block-only floor. A timelock deployed before the upgrade but holding no
  // upgrade power until after it executed nothing then.
  it('a declared timelock deployed BEFORE the upgrade whose timelockSince is AFTER it: "no timelock is known" (was unpinned: a deploy-block-only floor read "from 0x9f26…0761")', () => {
    const out = classifyAdminEvents([upgraded(UP_MID, A('3'))], {
      subject: 'weeth',
      ctl: () => null,
      upgradeTimelocks: { [POOL]: [TL_UP] },
      // deployed at 19,298,624 < 20,000,000; the upgrade power held from 22,131,382 only
      timelockSince: { [TL_UP]: UP_EXEC },
      upgradeHoldersAt: {},
      upgradeHoldersUnread: [`${POOL}@${UP_MID}`],
      declaredTimelocks: [TL_UP, TL_OP],
      deployBlocks: { [POOL]: POOL_DEPLOY, [TL_UP]: TL_UP_DEPLOY, [TL_OP]: TL_OP_DEPLOY },
      tokens: [],
      announcement: 'no_gov_channel',
      verified: () => true,
    })
    const [c] = out
    const notes = c.notes?.join(' ') ?? ''
    expect(notes).not.toMatch(new RegExp(`${short(TL_OP)}|${short(TL_UP)}`))
    expect(notes).toMatch(
      /the upgrade holders before it were not read and no timelock is known to judge it against \(fail closed\)/,
    )
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('AD-5')
    expect(c.tags).toEqual(expect.arrayContaining(['read_gap', 'authority_unread']))
  })

  it('control: an upgrade the Operating timelock executed after its deployment stays calm', () => {
    const c = at(build(subject(), rawOf()), UP_EXEC)
    expect(c.red).toBe(false)
    expect(c.tags).not.toContain('read_gap')
  })
})

// =====================================================================================================
describe('F4: every read gap a history row rests on is listed and counted on the card', () => {
  it('AD-5: one line per proxy with the blocks whose verdict rests on the unread holders, and why (was none — warnings only)', () => {
    const gaps = build(subject(), rawOf()).state.readGaps ?? []
    expect(gaps).toContain(
      `upgrade holders of ${short(POOL)} not read before the upgrades at blocks 17,730,779, 18,537,431, 20,000,000 (roleRegistry() not present on ${short(POOL)} (declared path call:roleRegistry()>owner)) — who authorised them is unknown (AD-5 judged fail closed)`,
    )
    // the upgrade the declared timelock executed does not rest on it: not listed
    expect(gaps.join(' ')).not.toMatch('22,131,382')
  })

  it('AD-4: a timelock whose proposers were not read at the grant blocks (no power at head) — listed with the block range (was none)', () => {
    const out = build(subject(), rawOf())
    for (const b of GRANTS) {
      const c = at(out, b, `admin/role/${RR}/${ROLE}`)
      expect(c.red).toBe(true)
      expect(c.tags).toContain('read_gap')
    }
    expect(out.state.readGaps).toContain(
      `timelock ${short(TL8)}: proposers not read (ranked as a plain contract) — read at blocks 22,084,653–22,084,676`,
    )
  })

  it('a classification that FAILED at a past block (a previous owner) — listed (was none)', () => {
    const out = build(subject(), rawOf())
    const c = at(out, OWNER_MOVE, `admin/owner/${ADAPTER}`)
    expect(c.red).toBe(true)
    expect(c.tags).toContain('read_gap')
    expect(out.state.readGaps).toContain(
      `${short(OLD_OWNER)} could not be classified at block 20,999,999 (a history row judged on it is fail closed)`,
    )
  })

  it('the collector gave no reason (an older raw): the AD-5 line is still there, without one (was none)', () => {
    const gaps =
      build(subject(), rawOf({ upgradeHoldersUnreadWhy: undefined })).state.readGaps ?? []
    expect(gaps).toContain(
      `upgrade holders of ${short(POOL)} not read before the upgrades at blocks 17,730,779, 18,537,431, 20,000,000 — who authorised them is unknown (AD-5 judged fail closed)`,
    )
  })

  it('holders READ but one not classified at block − 1 (judged as unread, PH-07): on the same line, with why (was none)', () => {
    const k = `${POOL}@${UP_MID}`
    const gaps =
      build(
        subject(),
        rawOf({
          upgradeHoldersAt: { [k]: [SAFE] },
          upgradeHoldersUnread: unreadKeys.filter((x) => x !== k),
          upgradeHoldersUnreadWhy: Object.fromEntries(
            unreadKeys.filter((x) => x !== k).map((x) => [x, WHY]),
          ),
        }),
      ).state.readGaps ?? []
    expect(gaps).toContain(
      `upgrade holders of ${short(POOL)} not read before the upgrades at blocks 17,730,779, 18,537,431, 20,000,000 (roleRegistry() not present on ${short(POOL)} (declared path call:roleRegistry()>owner); holder ${short(SAFE)} could not be classified at block 19,999,999) — who authorised them is unknown (AD-5 judged fail closed)`,
    )
  })

  it('control: a timelock gap the head already lists is not counted twice', () => {
    const s = subject({
      powers: [{ power: 'roles', contract: RR, path: ['owner'], label: 'RoleRegistry owner' }],
    })
    const out = build(
      s,
      rawOf({
        powers: [{ power: 'roles', label: 'RoleRegistry owner', contract: RR, holders: [TL8] }],
        controllers: {
          ...rawOf().admin.controllers,
          [`${TL8}@head`]: tl8,
        },
      }),
    )
    const lines = (out.state.readGaps ?? []).filter((g) => g.includes(short(TL8)))
    expect(lines).toEqual([
      `timelock ${short(TL8)}: proposers not read (ranked as a plain contract)`,
    ])
  })
})

// =====================================================================================================
// RV11-1, generic: F4's weETH-only test here was replaced by the every-shape test (R3, 2026-10-12:
// oracleRegistryConfigReadGapCauses.test.ts); `causeListed` is shared (oracleRegistryReadGapCause.ts).

// S1 (2026-10-12): the view lists the rows of a STORED card whose cause its read gaps do not name
// (oracleRegistryConfigStoredReadGaps.test.ts) — on the weETH shapes the current engine builds, it
// names every cause already: the card adds nothing (no double count).
describe('S1 (control): the weETH card the current engine builds gets no untraced-rows line', () => {
  it('every read_gap row is listed by the engine; the card lines equal the stored ones', () => {
    const s = subject()
    const out = build(s, rawOf())
    const tagged = out.changes.filter((c) => c.tags.includes('read_gap'))
    expect(tagged.length).toBeGreaterThanOrEqual(GRANTS.length + UP_2023.length)
    const inputs: ConfigInputs = {
      subject: s,
      state: out.state,
      changes: out.changes,
      queue: out.queue,
    }
    const card = buildConfigCard(inputs)
    expect(card.readGaps).toEqual(readGapsOf(out.state))
    expect((card.readGaps ?? []).join('\n')).not.toMatch(/judged on reads that failed/)
    expect(buildConfigSummary(inputs).counts.readGaps).toBe(readGapsOf(out.state).length)
  })
})

// =====================================================================================================
// Review of R1 (R2, 2026-10-12): a NEW owner whose classification at the block FAILED was red AD-3
// with no `read_gap` tag (classifyControllerChange: a null `next` sorts lowest, c < 0). The card
// did not count it (pastReadGaps lists only the lookups of `read_gap` rows), and the move ended
// the red before it — the read gap under the new owner's rank read as a fully read value.
describe('R2: an owner change to a holder that could not be classified is counted and carries the red before it', () => {
  const NEXT_MOVE = OWNER_MOVE + 100
  const NEW_OWNER = A('8')
  const raw = () =>
    rawOf({
      events: [
        ...events,
        ev({
          block: NEXT_MOVE,
          event: 'OwnershipTransferred',
          emitter: ADAPTER,
          args: { previousOwner: SAFE, newOwner: NEW_OWNER },
        }),
      ],
      controllers: { ...rawOf().admin.controllers, [`${SAFE}@${NEXT_MOVE - 1}`]: safe },
      // the new owner's classification at the block FAILED
      classifyFailed: [`${OLD_OWNER}@${OWNER_MOVE - 1}`, `${NEW_OWNER}@${NEXT_MOVE}`],
    })

  it('Safe → an owner not classified: red AD-3 tagged read_gap, its cause listed on the card (was untagged, not listed)', () => {
    const out = build(subject(), raw())
    const c = at(out, NEXT_MOVE, `admin/owner/${ADAPTER}`)
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('AD-3')
    expect(c.tags).toContain('read_gap')
    expect(out.state.readGaps).toContain(
      `${short(NEW_OWNER)} could not be classified at block 21,000,100 (a history row judged on it is fail closed)`,
    )
    expect(causeListed(c, out.state.readGaps ?? [])).toBe(true)
  })

  it('the red before it (an unread previous owner → the Safe) stays in effect (was ended by the move)', () => {
    const out = build(subject(), raw())
    const before = at(out, OWNER_MOVE, `admin/owner/${ADAPTER}`)
    expect(before.red).toBe(true)
    expect(
      [before, at(out, NEXT_MOVE, `admin/owner/${ADAPTER}`)].map((c) => !!c.stillInEffect),
    ).toEqual([true, true])
  })
})

// =====================================================================================================
// Review of F4 (R4, 2026-10-12: the collector half had no test that failed without it — every F4
// test passes a ready-made `upgradeHoldersUnreadWhy`; dropping the reason in the catch, or the
// field in the per-subject filter, left the suite green and the card's AD-5 line without a cause).
describe('R4: the collector records why the upgrade holders were not read and files it on its own subject', () => {
  const OTHER = A('e') // another subject's proxy: its gap belongs on its own card
  const fresh = (): UnreadAcc => ({ unread: [], why: {} })
  const addrs = new Set(subject().contracts.map((c) => c.address))
  const recordAll = (acc: UnreadAcc) => {
    for (const k of unreadKeys) recordUnread(acc, POOL, Number(k.split('@')[1]), new Error(WHY))
    recordUnread(acc, OTHER, 1, new Error('other'))
    return acc
  }

  it('a failed read is keyed proxy@block with its error as the reason (was: no test failed if the collector dropped it)', () => {
    const acc = fresh()
    const k = `${POOL}@${UP_2023[0]}`
    expect(recordUnread(acc, POOL, UP_2023[0], new Error(WHY))).toBe(k)
    expect(acc).toEqual({ unread: [k], why: { [k]: WHY } })
  })

  it('the reason is scrubbed: an RPC URL in the error never reaches the card (was untested)', () => {
    const acc = fresh()
    recordUnread(
      acc,
      POOL,
      UP_MID,
      new Error(`HTTP request failed. URL: https://rpc.invalid/v2/k3yk3yk3yk3y Details: ${WHY}`),
    )
    const why = acc.why[`${POOL}@${UP_MID}`]
    expect(why).toContain(WHY)
    expect(why).not.toMatch(/https?:|rpc\.invalid|k3yk3y/)
  })

  it('an error with no text still carries a reason (was untested): never an empty cause', () => {
    const acc = fresh()
    recordUnread(acc, POOL, UP_MID, new Error('   '))
    recordUnread(acc, POOL, UP_EXEC, undefined)
    expect(acc.unread).toEqual([`${POOL}@${UP_MID}`, `${POOL}@${UP_EXEC}`])
    expect(acc.why).toEqual({
      [`${POOL}@${UP_MID}`]: 'read failed (no error text)',
      [`${POOL}@${UP_EXEC}`]: 'read failed (no error text)',
    })
  })

  it("a subject gets its own proxies' keys AND reasons, never another subject's (was: no test failed if the filter dropped the reasons)", () => {
    const acc = recordAll(fresh())
    expect(unreadFor(acc, addrs)).toEqual({
      upgradeHoldersUnread: unreadKeys,
      upgradeHoldersUnreadWhy: Object.fromEntries(unreadKeys.map((k) => [k, WHY])),
    })
    expect(unreadFor(acc, new Set([OTHER]))).toEqual({
      upgradeHoldersUnread: [`${OTHER}@1`],
      upgradeHoldersUnreadWhy: { [`${OTHER}@1`]: 'other' },
    })
  })

  it('control: a subject with none of its proxies unread gets neither field', () => {
    const acc = fresh()
    recordUnread(acc, OTHER, 1, new Error('other'))
    expect(unreadFor(acc, addrs)).toEqual({})
  })

  it('end to end: the recorded reason reaches the card’s AD-5 read-gap line (was: only a ready-made raw field was tested)', () => {
    const out = build(
      subject(),
      rawOf({
        upgradeHoldersUnread: undefined,
        upgradeHoldersUnreadWhy: undefined,
        ...unreadFor(recordAll(fresh()), addrs),
      }),
    )
    expect(out.state.readGaps).toContain(
      `upgrade holders of ${short(POOL)} not read before the upgrades at blocks 17,730,779, 18,537,431, 20,000,000 (roleRegistry() not present on ${short(POOL)} (declared path call:roleRegistry()>owner)) — who authorised them is unknown (AD-5 judged fail closed)`,
    )
    expect((out.state.readGaps ?? []).join(' ')).not.toMatch(short(OTHER))
  })

  it('the collector records and files through these helpers (was inline: untested)', () => {
    const src = readFileSync('scripts/oracle-registry/config/collect-config.mjs', 'utf8')
    expect(src).toMatch(
      /recordUpgradeHoldersUnread\(upgradeHoldersUnread, r\.emitter, r\.block, e\)/,
    )
    expect(src).toMatch(/\.\.\.upgradeHoldersUnreadFor\(upgradeHoldersUnread, subjectAddrs\)/)
    expect(src).not.toMatch(/upgradeHoldersUnreadWhy\[/)
  })
})

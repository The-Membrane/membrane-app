// Config cards — F1 (weETH re-collect, bot data commit d88410c5, head 26,173,524): `markStillInEffect`
// never let a `read_gap` row move a value (review round 10, R-3: a move to a holder whose RANK
// rests on a read gap carries an open red forward). The weETH AD-5 upgrade rows are red on a read
// gap of another kind: the upgrade holders before them were not read (roleRegistry() reverts before
// the RoleRegistry 0x6224… was deployed at 22,039,954), so WHO authorised each upgrade is unknown —
// but the implementation it set is read in full from its Upgraded log. A clean upgrade ended only
// the row right before it, and 6 replaced implementations stayed "still in effect" (5 on
// 0x3088…f216, 1 on 0x35fa…8ac2), counted as open reds. Each test failed on the code before the
// fix (controls are marked). Synthetic fixtures; the on-chain shapes they copy are cited.

import { describe, expect, it } from 'vitest'

import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import { markStillInEffect } from '@/lib/oracleRegistry/config/engine'
import { classifyControllerChange } from '@/lib/oracleRegistry/config/rules'
import type { ConfigChange, Controller } from '@/lib/oracleRegistry/config/types'

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx

// changes/weeth.json, admin/implementation/0x3088…f216 (deployed 17,664,317): six red AD-5
// upgrades whose holders were not read — :185 :194 :284 :204 :111 :170 — then the clean upgrade
// 1:0xf32d13d7…:90 at 19,507,905 (holders read). Judged against the declared timelock 0xcd42…5d7a.
const PROXY = '0x308861a430be4cce5502d0a12724771fc6daf216'
const TL = '0xcd425f44758a08baab3c4908f3e3de5776e45d7a'
const DEPLOY = 17_664_317
const AD5 = [
  [17_730_779, '0xcef4286e4274433f167320db9ae81073accfc474'],
  [18_537_431, '0x4d784aa9eacc108ea5a326747870897f88d93860'],
  [18_737_540, '0x72481fb01eede2093af919f2fe29334527b97f4a'],
  [19_037_135, '0x833514b6d9bafdda9b45669c1f15dc0cd33cc0b8'],
  [19_165_797, '0x11858bcac85832acdda0bde9b867830f7d21cf63'],
  [19_276_464, '0x403ba4cd327293a4d23bee172982509d37310cef'],
] as const
const CLEAN = [19_507_905, '0x605f17e88027e25e18c95be0d8011ac969426399'] as const
const SAFE: Controller = { kind: 'safe', address: A('5'), threshold: 2, signers: 6 }

const upgraded = (
  emitter: string,
  block: number,
  impl: string,
  extra: Record<string, unknown> = {},
): AdminEventRow => ({
  chainId: 1,
  block,
  logIndex: 0,
  tx: `0x${block.toString(16)}`,
  emitter,
  event: 'Upgraded',
  args: { implementation: impl, ...extra },
})
const ctx = (unread: string[], read: Record<string, Controller[]> = {}) => ({
  subject: 'weeth',
  ctl: () => null,
  upgradeTimelocks: {},
  timelockSince: { [TL]: 0 },
  upgradeHoldersAt: read,
  upgradeHoldersUnread: unread,
  declaredTimelocks: [TL],
  deployBlocks: { [PROXY]: DEPLOY },
  tokens: [],
  announcement: 'no_gov_channel' as const,
  verified: () => true,
})

describe('F1: an upgrade whose AUTHORISER was not read still replaces the implementation', () => {
  const rows = AD5.map(([b, impl]) => upgraded(PROXY, b, impl))
  const unread = AD5.map(([b]) => `${PROXY}@${b}`)

  it('weETH 0x3088…f216: six AD-5 upgrades on unread holders, then a clean one — no replaced implementation stays in effect (was 5 still in effect)', () => {
    const out = classifyAdminEvents(
      [...rows, upgraded(PROXY, CLEAN[0], CLEAN[1])],
      ctx(unread, { [`${PROXY}@${CLEAN[0]}`]: [SAFE] }),
    )
    markStillInEffect(out)
    const red = out.filter((c) => c.ruleIds.includes('AD-5'))
    expect(red).toHaveLength(6)
    // the reds themselves are untouched: still red, still on a read gap (READ GAP chip)
    for (const c of red) {
      expect(c.red).toBe(true)
      expect(c.tags).toContain('read_gap')
    }
    expect(red.filter((c) => c.stillInEffect).map((c) => c.block)).toEqual([])
    const clean = out.find((c) => c.block === CLEAN[0])!
    expect(clean.red).toBe(false)
  })

  it('with no later upgrade, only the implementation live at head stays in effect (was all 6)', () => {
    const out = classifyAdminEvents(rows, ctx(unread))
    markStillInEffect(out)
    expect(out.filter((c) => c.stillInEffect).map((c) => c.block)).toEqual([AD5[5][0]])
  })

  it('control: a row whose VALUE rests on a read gap still never ends a red — Kernel SetApps of unmapped apps share the kernel key', () => {
    // abi.mjs (TV-10): with the appId mapping incomplete, a base-namespace SetApp of an unmapped
    // app stays on the KERNEL as an Upgraded marked `appUnread`; the kernel's own (core) upgrades
    // land on the same key. Two unknown apps, then a kernel upgrade whose holders were not read.
    const K = A('9')
    const app = (b: number, impl: string, id: string) =>
      upgraded(K, b, impl, { via: 'SetApp', appId: id, kernel: K, appUnread: true })
    const out = classifyAdminEvents(
      [app(100, A('a'), '0x01'), app(200, A('b'), '0x02'), upgraded(K, 300, A('c'))],
      { ...ctx([`${K}@100`, `${K}@200`, `${K}@300`]), deployBlocks: { [K]: 1 } },
    )
    markStillInEffect(out)
    expect(out.map((c) => c.red)).toEqual([true, true, true])
    // which app each unknown SetApp upgraded is not known: no later row on the key ends either
    expect(out.map((c) => !!c.stillInEffect)).toEqual([true, true, true])
  })
})

// Review of F1 (R1, 2026-10-12): `authority_unread` was tagged on ANY AD-5 row with no `read_gap`
// yet. classifyControllerChange tags no read gap when the NEW holder could not be classified (a
// null `next` ranks lowest: c < 0, plain red AD-3), so an AdminChanged EOA → an unclassified admin
// on unread upgrade holders read as "only the authoriser unread" — and markStillInEffect let it
// end the Safe → EOA red before it (the code before F1 carried it: a plain `read_gap` row).
describe('R1: `authority_unread` only on a row whose value carries no rank (Upgraded / BeaconUpgraded)', () => {
  const EOA: Controller = { kind: 'eoa', address: A('e') }
  const UNCLASSIFIED = A('7')
  const ctls: Record<string, Controller> = { [SAFE.address]: SAFE, [EOA.address]: EOA }
  const adminChanged = (block: number, prev: string, next: string): AdminEventRow => ({
    chainId: 1,
    block,
    logIndex: 0,
    tx: `0x${block.toString(16)}`,
    emitter: PROXY,
    event: 'AdminChanged',
    args: { previousAdmin: prev, newAdmin: next },
  })

  it('AdminChanged to an unclassified admin on unread upgrade holders carries the red before it (was ended)', () => {
    const [b1, b2] = [DEPLOY + 100, DEPLOY + 200]
    const out = classifyAdminEvents(
      [adminChanged(b1, SAFE.address, EOA.address), adminChanged(b2, EOA.address, UNCLASSIFIED)],
      {
        // the Safe → EOA move on read holders (no timelock held the power); the next on unread ones
        ...ctx([`${PROXY}@${b2}`], { [`${PROXY}@${b1}`]: [SAFE] }),
        ctl: (x: string) => ctls[x] ?? null,
      },
    )
    markStillInEffect(out)
    const [safeToEoa, toUnclassified] = out
    expect(safeToEoa.red).toBe(true)
    expect(safeToEoa.ruleIds).toContain('AD-3')
    expect(toUnclassified.red).toBe(true)
    expect(toUnclassified.ruleIds).toEqual(expect.arrayContaining(['AD-3', 'AD-5']))
    // a move to a holder that could not be classified never ends a red
    expect(out.map((c) => !!c.stillInEffect)).toEqual([true, true])
    // the new admin's rank was not read: a read gap on the VALUE, never "only the authoriser"
    expect(toUnclassified.tags).toContain('read_gap')
    expect(toUnclassified.tags).not.toContain('authority_unread')
  })

  // S1 (2026-10-12: R1 was unpinned — with R2 in place the test above passes with R1 reverted,
  // because R2 already tags the null `next` read_gap). Here the new admin IS classified (rank read,
  // no gap on the value): only R1's event check keeps the row a plain `read_gap`.
  it('AdminChanged to a CLASSIFIED admin on unread upgrade holders: plain read_gap, the red before it stays in effect (was authority_unread, ended)', () => {
    const [b1, b2] = [DEPLOY + 100, DEPLOY + 200]
    const SAFE_B: Controller = { kind: 'safe', address: A('8'), threshold: 3, signers: 5 }
    const byAddr: Record<string, Controller> = { ...ctls, [SAFE_B.address]: SAFE_B }
    const out = classifyAdminEvents(
      [adminChanged(b1, SAFE.address, EOA.address), adminChanged(b2, EOA.address, SAFE_B.address)],
      {
        // the Safe → EOA move on read holders (no timelock held the power); the next on unread ones
        ...ctx([`${PROXY}@${b2}`], { [`${PROXY}@${b1}`]: [SAFE] }),
        ctl: (x: string) => byAddr[x] ?? null,
      },
    )
    markStillInEffect(out)
    const [safeToEoa, toSafe] = out
    expect(safeToEoa.red).toBe(true)
    expect(safeToEoa.ruleIds).toContain('AD-3')
    // EOA → a Safe ranks up; red only on AD-5 (no CallExecuted from the declared timelock, the
    // holders before it unread)
    expect(toSafe.red).toBe(true)
    expect(toSafe.ruleIds).toContain('AD-5')
    expect(toSafe.after).toBe(SAFE_B.address)
    // a row judged on a failed read never ends a red: Safe → EOA stays in effect
    expect(out.map((c) => !!c.stillInEffect)).toEqual([true, true])
    // R1: an AdminChanged value is a holder — its read gap stays on the value
    expect(toSafe.tags).toContain('read_gap')
    expect(toSafe.tags).not.toContain('authority_unread')
  })
})

// Review of R1 (R2, 2026-10-12): the hole under R1 is in classifyControllerChange — a NEW holder
// that could not be classified (`next` null: its classification failed or is missing) was red
// AD-3 with no `read_gap` tag, on both branches (the previous holder not read either: "neither …
// could be classified"; read: a null rank sorts lowest, c < 0). On READ upgrade holders no AD-5
// applies, so R1 never ran: the row moved the value like a read one, ended the red before it, and
// the card did not count the gap (pastReadGaps lists only the lookups of `read_gap` rows).
describe('R2: a new holder that could not be classified is a read gap on the value', () => {
  const EOA: Controller = { kind: 'eoa', address: A('e') }
  const SAFE_LOW: Controller = { kind: 'safe', address: A('6'), threshold: 2, signers: 9 }
  const UNCLASSIFIED = A('7')
  const [b1, b2] = [DEPLOY + 100, DEPLOY + 200]
  const adminChanged = (block: number, prev: string, next: string): AdminEventRow => ({
    chainId: 1,
    block,
    logIndex: 0,
    tx: `0x${block.toString(16)}`,
    emitter: PROXY,
    event: 'AdminChanged',
    args: { previousAdmin: prev, newAdmin: next },
  })
  // upgrade holders READ at both blocks (a Safe, no timelock held the power): no AD-5 on either
  const readHolders = (ctl: (a: string, block: number) => Controller | null) => ({
    ...ctx([], { [`${PROXY}@${b1}`]: [SAFE], [`${PROXY}@${b2}`]: [SAFE] }),
    ctl,
  })
  const byAddr: Record<string, Controller> = {
    [SAFE.address]: SAFE,
    [SAFE_LOW.address]: SAFE_LOW,
    [EOA.address]: EOA,
  }

  it('holders read: Safe → EOA, then EOA → an unclassified admin — tagged read_gap, the red before it stays in effect (was tagged [], ended)', () => {
    const out = classifyAdminEvents(
      [adminChanged(b1, SAFE.address, EOA.address), adminChanged(b2, EOA.address, UNCLASSIFIED)],
      readHolders((x) => byAddr[x] ?? null),
    )
    markStillInEffect(out)
    const [safeToEoa, toUnclassified] = out
    expect(safeToEoa.red).toBe(true)
    expect(toUnclassified.red).toBe(true)
    expect(toUnclassified.ruleIds).toEqual(['AD-3'])
    expect(toUnclassified.tags).toEqual(['read_gap'])
    // a move to a holder that could not be classified never ends a red
    expect(out.map((c) => !!c.stillInEffect)).toEqual([true, true])
  })

  it('the previous admin not classified at block − 1 either ("neither …"): tagged read_gap, the red before it stays in effect (was tagged [], ended)', () => {
    const out = classifyAdminEvents(
      [adminChanged(b1, SAFE.address, EOA.address), adminChanged(b2, EOA.address, UNCLASSIFIED)],
      // the EOA read at b1 (Safe → EOA), not classified at b2 − 1
      readHolders((x, block) =>
        x === EOA.address && block === b2 - 1 ? null : (byAddr[x] ?? null),
      ),
    )
    markStillInEffect(out)
    const toUnclassified = out[1]
    expect(toUnclassified.red).toBe(true)
    expect(toUnclassified.tags).toEqual(['read_gap'])
    expect(out.map((c) => !!c.stillInEffect)).toEqual([true, true])
  })

  it('rules: a new holder not classified — red AD-3 tagged read_gap, the previous one read or not (were untagged)', () => {
    for (const prev of [EOA, SAFE, null]) {
      const v = classifyControllerChange(prev, null)
      expect(v.severity).toBe('downgrade')
      expect(v.ruleIds).toEqual(['AD-3'])
      expect(v.tags).toEqual(['read_gap'])
    }
  })

  it('control: a move to a CLASSIFIED holder still ends the red before it (Safe 2-of-6 → Safe 2-of-9 → EOA)', () => {
    const out = classifyAdminEvents(
      [
        adminChanged(b1, SAFE.address, SAFE_LOW.address),
        adminChanged(b2, SAFE_LOW.address, EOA.address),
      ],
      readHolders((x) => byAddr[x] ?? null),
    )
    markStillInEffect(out)
    expect(out.map((c) => c.red)).toEqual([true, true])
    expect(out.map((c) => c.tags)).toEqual([[], []])
    expect(out.map((c) => !!c.stillInEffect)).toEqual([false, true])
  })
})

// Review of F1 (S3, 2026-10-12): F1's guard — "never end a red whose own value rests on a read
// gap" — ran only when the ENDING row was `authority_unread`. A fully read, clean Upgraded on the
// Kernel key (the Kernel's own core-namespace SetApp) still ended an earlier Kernel SetApp red of
// an UNMAPPED app (`appUnread`, read_gap on its value): an Upgraded log carries only the new
// implementation, so the clean row's `before` was inferred from the key's last value — the other
// app's implementation (abi.mjs aragonRows: SetApp(core) and the unmapped SetApp(base) both stay
// on the Kernel's key). Only a row that names the value it replaced is evidence the same slot moved.
describe('S3: a red whose value rests on a read gap is never ended by a row whose `before` is inferred', () => {
  const K = A('9')
  // synthetic app ids: the Kernel's own (core namespace) and an app the subject does not map
  const CORE_ID = '0x' + 'c0'.repeat(32)
  const APP_ID = '0x' + 'a0'.repeat(32)
  const appUnread = (b: number, impl: string) =>
    upgraded(K, b, impl, { via: 'SetApp', appId: APP_ID, kernel: K, appUnread: true })
  const core = (b: number, impl: string) =>
    upgraded(K, b, impl, { via: 'SetApp', appId: CORE_ID, kernel: K })
  const kctx = (unread: string[], read: Record<string, Controller[]>, bad: string[]) => ({
    ...ctx(unread, read),
    deployBlocks: { [K]: 1 },
    verified: (x: string) => !bad.includes(x),
  })

  it('Kernel SetApp of an unmapped app (red AD-5/AD-9), then a clean core upgrade on read holders: the app red stays in effect (was ended)', () => {
    const out = classifyAdminEvents(
      [appUnread(100, A('a')), core(300, A('c'))],
      kctx([`${K}@100`], { [`${K}@300`]: [SAFE] }, [A('a')]),
    )
    markStillInEffect(out)
    const [app, kernel] = out
    expect(app.key).toBe(kernel.key)
    expect(app.red).toBe(true)
    expect(app.ruleIds).toEqual(expect.arrayContaining(['AD-5', 'AD-9']))
    expect(app.tags).toEqual(['logic_change', 'read_gap', 'unverified'])
    // the core upgrade is read in full: clean, no gap of any kind
    expect(kernel.red).toBe(false)
    expect(kernel.tags).toEqual(['logic_change'])
    // which slot the unmapped SetApp moved is not known: the Kernel's own upgrade never ends it
    expect(out.map((c) => !!c.stillInEffect)).toEqual([true, false])
  })

  it('the same on synthetic rows: a clean row with no `before` never ends a value-gap red on its key (was ended)', () => {
    const ch = (o: Partial<ConfigChange>): ConfigChange =>
      ({
        id: String(o.block),
        subject: 'z',
        dimension: 'admin',
        key: `admin/implementation/${K}`,
        title: '',
        state: 'historical',
        stage: 'executed',
        severity: 'neutral',
        floorBreach: false,
        red: false,
        ruleIds: [],
        tags: ['logic_change'],
        unannounced: null,
        announcement: 'not_checked',
        chainId: 1,
        ...o,
      }) as ConfigChange
    const gap = ch({
      block: 100,
      after: A('a'),
      red: true,
      severity: 'downgrade',
      ruleIds: ['AD-9'],
      tags: ['logic_change', 'read_gap', 'unverified'],
    })
    const clean = ch({ block: 300, after: A('c') })
    markStillInEffect([gap, clean])
    expect(gap.stillInEffect).toBe(true)
    expect(clean.stillInEffect).toBeFalsy()
  })

  it('control: a clean core upgrade still ends an earlier core red read in full (no gap: one slot)', () => {
    const out = classifyAdminEvents(
      [core(100, A('a')), core(300, A('c'))],
      kctx([], { [`${K}@100`]: [SAFE], [`${K}@300`]: [SAFE] }, [A('a')]),
    )
    markStillInEffect(out)
    expect(out.map((c) => c.red)).toEqual([true, false])
    expect(out.map((c) => c.tags.includes('read_gap'))).toEqual([false, false])
    expect(out.map((c) => !!c.stillInEffect)).toEqual([false, false])
  })

  it('control: a row that NAMES the value it replaced still ends a value-gap red (an owner moved off an unclassified holder)', () => {
    const X = A('7')
    const owner = (block: number, before: string, after: string, o: Partial<ConfigChange> = {}) =>
      ({
        id: String(block),
        subject: 'z',
        dimension: 'admin',
        key: `admin/owner/${PROXY}`,
        title: '',
        state: 'historical',
        stage: 'executed',
        severity: 'neutral',
        floorBreach: false,
        red: false,
        ruleIds: [],
        tags: [],
        unannounced: null,
        announcement: 'not_checked',
        chainId: 1,
        block,
        before,
        after,
        ...o,
      }) as ConfigChange
    // EOA → X (X not classified: red AD-3 on a read gap), then X → a read Safe: the event names X
    const gap = owner(100, A('e'), X, {
      red: true,
      severity: 'downgrade',
      ruleIds: ['AD-3'],
      tags: ['read_gap'],
    })
    const moved = owner(200, X, SAFE.address, { severity: 'upgrade' })
    markStillInEffect([gap, moved])
    expect(gap.stillInEffect).toBeFalsy()
    // same, with a neutral (non-upgrade) move: the named `before` alone is the evidence
    const gap2 = owner(100, A('e'), X, {
      red: true,
      severity: 'downgrade',
      ruleIds: ['AD-3'],
      tags: ['read_gap'],
    })
    markStillInEffect([gap2, owner(200, X, A('b'))])
    expect(gap2.stillInEffect).toBeFalsy()
  })
})

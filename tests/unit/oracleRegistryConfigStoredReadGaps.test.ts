// Config cards — S1 (2026-10-12): RV11-1 on a STORED card. A card never renders a read gap it does
// not count — but the committed weETH card (bot data commit d88410c5, head 26,173,524) was built
// before F4 / R3 named the causes: 14 history rows are tagged READ GAP / VERIFICATION LOOKUP FAILED
// (9 AD-5 upgrades on unread holders, 4 AD-4 grants to timelock 0x8221…9f2a whose proposers were
// not read, 1 AD-9 implementation whose verification was not read) while its state lists ONE read
// gap (the oracle window), which names none of them. The view now lists those rows on one counted
// line, using R3's `causeListed`: a row whose cause a listed line names adds nothing, so a card the
// current engine built adds nothing (controls: oracleRegistryConfigReadGapCauses.test.ts and
// oracleRegistryConfigWeethReadGaps.test.ts). Each test failed on the code before the fix unless it
// is marked (control). Synthetic fixture copying the committed rows (key, title, value, block,
// tags, rules).

import { describe, expect, it } from 'vitest'

import type { ConfigChange, ConfigSubject, SubjectState } from '@/lib/oracleRegistry/config/types'
import {
  buildConfigCard,
  buildConfigSummary,
  untracedRowGaps,
  type ConfigInputs,
} from '@/lib/oracleRegistry/config/view'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const n = (b: number) => b.toLocaleString('en-US')

const RR = '0x62247d29b4b9becf4bb73e0c722cf6445cfc7ce9' // RoleRegistry
const TL8 = '0x82215f1274356e94543a4d6bac6f7170d8a59f2a' // Timelock 8h (proposers unread)
const POOL = '0x308861a430be4cce5502d0a12724771fc6daf216' // LiquidityPool
const P35 = '0x35fa164735182de50811e8e2e824cfb9b6118ac2'
const PCD = '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee'
const PD7 = '0xd789870bea40d056a4d26055d0befcc8755da146'
const HEAD = 26_173_524
const ORACLE_LINE =
  "oracle governance events after block 26,129,366 not read (the oracle collector's window ends 44,158 blocks below head)"

const row = (o: Partial<ConfigChange> & Pick<ConfigChange, 'key' | 'title'>): ConfigChange => ({
  id: `1:0x${(o.block ?? 0).toString(16)}:${o.key.length}`,
  subject: 'weeth',
  dimension: 'admin',
  state: 'historical',
  stage: 'executed',
  severity: 'downgrade',
  floorBreach: false,
  red: true,
  ruleIds: [],
  tags: [],
  unannounced: null,
  announcement: 'no_gov_channel',
  chainId: 1,
  ...o,
})
// changes/weeth.json @ d88410c5: the 4 AD-4 grants to the 8 h timelock
const grant = (block: number, role: string) =>
  row({
    key: `admin/role/${RR}/${role}`,
    title: `${role} granted to Timelock 8h ${short(TL8)} [proposers UNREAD: ranked as a plain contract] on ${short(RR)}`,
    after: TL8,
    block,
    ruleIds: ['AD-4'],
    tags: ['read_gap', 'anomaly'],
    notes: [`${role} is not a recognised role: judged privileged`],
  })
// … the 9 AD-5 upgrades on unread holders, and the AD-9 one whose verification was not read
const upgrade = (proxy: string, block: number, impl: string, stillInEffect = false) =>
  row({
    key: `admin/implementation/${proxy}`,
    title: `implementation of ${short(proxy)} → ${short(impl)}`,
    after: impl,
    block,
    ruleIds: ['AD-5'],
    tags: ['logic_change', 'read_gap'],
    ...(stillInEffect ? { stillInEffect } : {}),
    notes: [
      'no CallExecuted / ProposalExecuted from 0xcd42…5d7a in this transaction (the upgrade holders before it were not read: judged against the declared timelock)',
    ],
  })
const ROWS: ConfigChange[] = [
  grant(22_084_676, '0xdf341d2a9af804fa0099198f83a0a0611aa273a03b36d576993f914e695dff2a'),
  grant(22_084_676, '0xf63b1ce674d2cec0dbfcdcc7e504ce31a335c457c363b9fafb6ca524addf1775'),
  grant(22_084_655, '0x1fa5f863eb8a62c868fa7eb98a4e47ded14913e6885050cfd9090d04516345b0'),
  grant(22_084_653, '0x0e8d94121b3383f03d9ae60b39295aa793469d7230d51a3f62cbf47cd45481d9'),
  row({
    key: `admin/implementation/${PD7}`,
    title: `implementation of ${short(PD7)} → 0x2e34…085e`,
    after: '0x2e346c302925148c4b01625398d40faf8961085e',
    block: 19_687_687,
    ruleIds: ['AD-9'],
    tags: ['logic_change', 'verification_unread'],
    notes: [
      'new implementation 0x2e346c302925148c4b01625398d40faf8961085e: source verification could not be read',
    ],
  }),
  upgrade(POOL, 19_276_464, '0x403ba4cd327293a4d23bee172982509d37310cef'),
  upgrade(POOL, 19_165_797, '0x11858bcac85832acdda0bde9b867830f7d21cf63', true),
  upgrade(POOL, 19_037_135, '0x833514b6d9bafdda9b45669c1f15dc0cd33cc0b8', true),
  upgrade(POOL, 18_737_540, '0x72481fb01eede2093af919f2fe29334527b97f4a', true),
  upgrade(P35, 18_549_887, '0x1b47a665364bc15c28b05f449b53354d0ceff72f'),
  upgrade(POOL, 18_537_431, '0x4d784aa9eacc108ea5a326747870897f88d93860', true),
  upgrade(P35, 18_537_431, '0xe8e55a0734f81fd8cffcb14447bf52054722e3e6', true),
  upgrade(PCD, 18_537_431, '0xe629ee84c1bd9ea9c677d2d5391919fcf5e7d5d9'),
  upgrade(POOL, 17_730_779, '0xcef4286e4274433f167320db9ae81073accfc474', true),
  // a calm row (no read gap) is never listed
  row({
    key: `admin/implementation/${POOL}`,
    title: `implementation of ${short(POOL)} → 0x605f…6399`,
    after: '0x605f17e88027e25e18c95be0d8011ac969426399',
    block: 19_507_905,
    severity: 'neutral',
    red: false,
    tags: ['logic_change'],
  }),
]

const subject: ConfigSubject = {
  key: 'weeth',
  label: 'weETH',
  oracleAssetKey: null,
  class: 'lrt',
  contracts: [],
  lzOApps: [],
  ccipPools: [],
  powers: [],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
}
const stored = (readGaps: string[] | undefined, extra: ConfigChange[] = []): ConfigInputs => {
  const state: SubjectState = {
    version: 1,
    subject: 'weeth',
    label: 'weETH',
    oracleAssetKey: null,
    chainId: 1,
    asOf: { block: HEAD, ts: 1_760_000_000 },
    scan: { from: 17_000_000, to: HEAD },
    govChannels: [],
    announcement: 'no_gov_channel',
    proposedSources: [],
    powers: [],
    items: [],
    counts: { red: 14, pending: 0, proposed: 0, historical: ROWS.length, floorBreaches: 0 },
    ...(readGaps ? { readGaps } : {}),
    warnings: [],
  }
  return {
    subject,
    state,
    changes: ROWS,
    queue: extra,
  }
}
// the line names a row by its title (bracketed notes dropped, a role hash shortened) and block
const label = (c: ConfigChange) =>
  `${c.title.replace(/\s*\[[^\]]*\]/g, '').replace(/0x[0-9a-f]{64}/g, short)} (block ${n(c.block!)})`
const S1 = /^(\d+) (history )?rows? (were|was) judged on reads that failed \(fail closed/

describe('S1: a stored card whose rows rest on read gaps it does not list still lists and counts them', () => {
  it('the committed weETH shape: 14 tagged rows, 1 listed line — one more line naming all 14, counted (was 1 read gap, none of them named)', () => {
    const inp = stored([ORACLE_LINE])
    const card = buildConfigCard(inp)
    expect(card.readGaps).toHaveLength(2)
    expect(card.readGaps![0]).toBe(ORACLE_LINE)
    const line = card.readGaps![1]
    expect(line).toMatch(S1)
    expect(line.startsWith('14 history rows were judged on reads that failed')).toBe(true)
    // every row tagged READ GAP / VERIFICATION LOOKUP FAILED is named, oldest first
    const tagged = ROWS.filter((c) => c.red)
    for (const c of tagged) expect(line).toContain(label(c))
    expect(line.indexOf(n(17_730_779))).toBeLessThan(line.indexOf(n(22_084_676)))
    // e.g. a role grant reads short (no 66-character hash, no bracketed rank note)
    expect(line).toContain(
      `0xdf34…ff2a granted to Timelock 8h ${short(TL8)} on ${short(RR)} (block 22,084,676)`,
    )
    // the calm row is not
    expect(line).not.toContain('0x605f…6399')
    // counted on the card and the tab summary alike
    expect(card.counts.readGaps).toBe(2)
    expect(buildConfigSummary(inp).counts.readGaps).toBe(2)
  })

  it('no stored read gaps at all: the line is the only one, counted (was 0 read gaps)', () => {
    const inp = stored(undefined)
    expect(buildConfigCard(inp).readGaps).toEqual([expect.stringMatching(S1)])
    expect(buildConfigSummary(inp).counts.readGaps).toBe(1)
  })

  it("a row whose cause a stored line names is not repeated: F4's AD-5 line for 0x3088…f216 covers its 6 upgrades — the line names the other 8 (was none)", () => {
    const f4 = `upgrade holders of ${short(POOL)} not read before the upgrades at blocks 17,730,779, 18,537,431, 18,737,540, 19,037,135, 19,165,797, 19,276,464 — who authorised them is unknown (AD-5 judged fail closed)`
    const card = buildConfigCard(stored([ORACLE_LINE, f4]))
    expect(card.readGaps).toHaveLength(3)
    const line = card.readGaps![2]
    expect(line.startsWith('8 history rows were judged on reads that failed')).toBe(true)
    expect(line).not.toContain(`implementation of ${short(POOL)}`)
    for (const c of ROWS.filter((x) => x.red && !x.key.endsWith(POOL)))
      expect(line).toContain(label(c))
    expect(card.counts.readGaps).toBe(3)
  })

  it('a queued row on an unread verification is named as queued — "row", not "history row" (was none)', () => {
    const queued = row({
      key: `admin/implementation/${PCD}`,
      title: `implementation of ${short(PCD)} → 0xabcd…ef01`,
      after: '0xabcdabcdabcdabcdabcdabcdabcdabcdabcdef01',
      state: 'pending',
      stage: 'scheduled',
      block: undefined,
      ruleIds: ['AD-9'],
      tags: ['logic_change', 'verification_unread'],
    })
    const inp = stored([ORACLE_LINE], [queued])
    const line = buildConfigCard(inp).readGaps![1]
    expect(line.startsWith('15 rows were judged on reads that failed')).toBe(true)
    expect(line.endsWith(`implementation of ${short(PCD)} → 0xabcd…ef01 (queued)`)).toBe(true)
  })

  it('a row is named short: its (…) / […] rank notes dropped, address(0) kept (was none)', () => {
    // the frozen wstETH shape (1c94be6e, 22,225,938): the rank note outruns the timelock's address
    const tl = row({
      key: 'admin/owner/0xa586a732394a1affcf15b972cd47c936033c9fa7',
      title:
        'owner of 0xa586…9fa7: EOA 0x8761…df34 → Timelock 3h (bypass: bypasserExecuteBatch, bypassers UNREAD: ranked as a plain contract) 0x4483…9449 [proposed by contract 0xe532…012f (the weakest of 2)]',
      block: 22_225_938,
      red: false,
      tags: ['read_gap'],
    })
    const zero = row({
      key: `admin/owner/${PCD}`,
      title: `owner of ${short(PCD)}: address(0) → contract 0x1111…1111 (not classified)`,
      block: 22_225_939,
      tags: ['read_gap'],
    })
    const line = untracedRowGaps([tl, zero], [])[0]
    expect(line).toBe(
      `2 history rows were judged on reads that failed (fail closed; this card's data does not name the read): owner of 0xa586…9fa7: EOA 0x8761…df34 → Timelock 3h 0x4483…9449 (block 22,225,938); owner of ${short(PCD)}: address(0) → contract 0x1111…1111 (block 22,225,939)`,
    )
  })

  it('control: every cause listed (the lines the current engine writes for these rows) — nothing added', () => {
    const lines = [
      ORACLE_LINE,
      `upgrade holders of ${short(POOL)} not read before the upgrades at blocks 17,730,779, 18,537,431, 18,737,540, 19,037,135, 19,165,797, 19,276,464 — who authorised them is unknown (AD-5 judged fail closed)`,
      `upgrade holders of ${short(P35)} not read before the upgrades at blocks 18,537,431, 18,549,887 — who authorised them is unknown (AD-5 judged fail closed)`,
      `upgrade holders of ${short(PCD)} not read before the upgrade at block 18,537,431 — who authorised it is unknown (AD-5 judged fail closed)`,
      `timelock ${short(TL8)}: proposers not read (ranked as a plain contract) — read at blocks 22,084,653–22,084,676`,
      `source verification of 0x2e34…085e not read — the row at block 19,687,687 judged fail closed (AD-9)`,
    ]
    const inp = stored(lines)
    expect(buildConfigCard(inp).readGaps).toEqual(lines)
    expect(buildConfigSummary(inp).counts.readGaps).toBe(lines.length)
  })
})

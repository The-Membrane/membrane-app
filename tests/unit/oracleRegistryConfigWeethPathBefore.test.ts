// Config cards — F2 (weETH re-collect, bot data commit d88410c5, head 26,173,524): the declared
// upgrade path of LiquidityPool / eETH / weETH is `call:roleRegistry()>owner`. roleRegistry()
// reverts on every implementation before the one that added it, so the collector read the holders
// before 9 upgrades of 2023-24 as UNREAD ("roleRegistry() not present", warnings of
// state/weeth.json) and AD-5 judged them fail closed: 9 red read_gap rows. Those implementations
// authorised upgrades `onlyOwner`, and owner() was the 2-of-6 Safe 0xf155…b8a5 with no timelock
// in existence. The fix is a DECLARATION (`pathBefore` in subjects.json), never a fallback on a
// revert. Each test failed on the code before the fix (controls are marked).
//
// Measured 2026-10-12 (repo helpers: ethereumClients + tryRead; verified sources on Blockscout):
//   owner() of 0x3088…f216 / 0x35fa…8ac2 / 0xcd5f…b7ee at 17,730,778, 18,537,430 and 19,276,463
//     = 0xf155…b8a5 on all three;
//   roleRegistry() reverts on 0x3088 at 22,131,381 and answers 0x6224…7ce9 at 22,131,382 (its
//     upgrade to 0xa609…c515 in tx 0x3bd34099…); on 0x35fa / 0xcd5f it reverts at 23,089,685
//     and answers at 23,089,686 (upgrades to 0xcb3d…ad84 / 0x2d10…fd6b in tx 0x81977c7d…);
//   owner() of 0x3088 at 22,131,381 and of 0x35fa / 0xcd5f at 23,089,685 = Timelock 10 d
//     0x9f26…0761, the CallExecuted emitter of both of those upgrade transactions;
//   `_authorizeUpgrade(...) internal override onlyOwner` in every implementation before the
//     switch (LiquidityPool 0xe869, 0xcef4, 0x4d78, 0x7248, 0x8335, 0x1185, 0x403b, 0x605f,
//     0x0265, 0xa8a8; EETH 0x5e90, 0xe8e5, 0x1b47, 0x46c5; WeETH 0xdd78, 0xe629, 0x353e);
//     `roleRegistry.onlyProtocolUpgrader` / a RoleRegistry check in 0xa609, 0xcb3d and 0x2d10.

import { readFileSync } from 'fs'

import { describe, expect, it } from 'vitest'

import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import {
  getConfigSubjects,
  parseSubjects,
  subjectByKey,
} from '@/lib/oracleRegistry/config/subjects'
import type { Controller, PowerSpec } from '@/lib/oracleRegistry/config/types'
import {
  pathAtBlock as pathAtBlockJs,
  resolvePath as resolvePathJs,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'

const LP = '0x308861a430be4cce5502d0a12724771fc6daf216'
const EETH = '0x35fa164735182de50811e8e2e824cfb9b6118ac2'
const WEETH = '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee'
const RR = '0x62247d29b4b9becf4bb73e0c722cf6445cfc7ce9'
const SAFE = '0xf155a2632ef263a6a382028b3b33feb29175b8a5'
const TL10 = '0x9f26d4c958fd811a1f59b01b86be7dffc9d20761'
const EP = '0x1a44076050125825900e736c501f859c50fe728c'

// the collector is JavaScript: its inferred parameter types are narrowed here
const resolvePath = resolvePathJs as unknown as (
  client: unknown,
  o: {
    endpoint: string
    contract: string
    path: string[]
    pathBefore?: PowerSpec['pathBefore']
    roleMap: Map<string, Set<string>>
    block?: number
  },
) => Promise<string[]>
const pathAtBlock = pathAtBlockJs as unknown as (
  path: string[],
  pathBefore: PowerSpec['pathBefore'],
  block?: number,
) => string[]

const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
const httpErr = () =>
  Object.assign(new Error('HTTP request failed. Status: 503'), { name: 'HttpRequestError' })

type Answer = string | 'revert' | 'http'
/**
 * A chain that answers ONLY the reads measured above, by (address, function, block); any other
 * read is a transport failure, so a test cannot pass on an unmeasured answer. `calls` records
 * every read (the path actually taken).
 */
function chain(extra: Record<string, Answer> = {}) {
  const at = (b: number, a: string, fn: string) => `${a}|${fn}|${b}`
  const m: Record<string, Answer> = {}
  for (const b of [17_730_778, 18_537_430, 19_276_463])
    for (const p of [LP, EETH, WEETH]) {
      m[at(b, p, 'owner')] = SAFE
      m[at(b, p, 'roleRegistry')] = 'revert'
    }
  m[at(22_131_381, LP, 'roleRegistry')] = 'revert'
  m[at(22_131_381, LP, 'owner')] = TL10
  m[at(22_131_382, LP, 'roleRegistry')] = RR
  for (const p of [EETH, WEETH]) {
    m[at(23_089_685, p, 'roleRegistry')] = 'revert'
    m[at(23_089_685, p, 'owner')] = TL10
    m[at(23_089_686, p, 'roleRegistry')] = RR
  }
  // the RoleRegistry owner (CONFIG-CARDS-KNOWN-GAPS UQ-20: Timelock 10 d)
  m[at(22_131_382, RR, 'owner')] = TL10
  m[at(23_089_686, RR, 'owner')] = TL10
  m[`${LP}|roleRegistry|head`] = RR
  m[`${RR}|owner|head`] = TL10
  Object.assign(m, extra)
  const calls: string[] = []
  return {
    calls,
    readContract: async ({
      address,
      functionName,
      blockNumber,
    }: {
      address: string
      functionName: string
      blockNumber?: bigint
    }) => {
      const k = `${address.toLowerCase()}|${functionName}|${blockNumber === undefined ? 'head' : Number(blockNumber)}`
      calls.push(k)
      const v = m[k]
      if (v === undefined || v === 'http') throw httpErr()
      if (v === 'revert') throw revert()
      return v
    },
  }
}

const weeth = () => subjectByKey('weeth')!
const upgradeSpec = (contract: string) =>
  weeth().powers.find((p) => p.power === 'upgrade' && p.contract === contract)!
const read = (c: ReturnType<typeof chain>, contract: string, block?: number, spec?: PowerSpec) => {
  const sp = spec ?? upgradeSpec(contract)
  return resolvePath(c, {
    endpoint: EP,
    contract,
    path: sp.path,
    pathBefore: sp.pathBefore,
    roleMap: new Map(),
    block,
  })
}

// state/weeth.json warnings: the 9 AD-5 rows' reads (proxy @ upgrade block − 1)
const AD5_READS = [
  [LP, 17_730_778],
  [LP, 18_537_430],
  [LP, 18_737_539],
  [LP, 19_037_134],
  [LP, 19_165_796],
  [LP, 19_276_463],
  [EETH, 18_537_430],
  [EETH, 18_549_886],
  [WEETH, 18_537_430],
] as const

describe('F2: an upgrade power reads its DECLARED older path below the block that changed it', () => {
  it('weETH: the holders before the 2023-24 upgrades are read through owner() — the Safe 0xf155…b8a5 (was: "roleRegistry() not present", unread, red AD-5 read_gap)', async () => {
    for (const b of [17_730_778, 18_537_430, 19_276_463])
      for (const p of [LP, EETH, WEETH]) {
        const c = chain()
        expect(await read(c, p, b)).toEqual([SAFE])
        expect(c.calls).toEqual([`${p}|owner|${b}`])
      }
  })

  it('every one of the 9 AD-5 reads takes the declared older path (was: call:roleRegistry()>owner at each)', () => {
    for (const [p, b] of AD5_READS) {
      const sp = upgradeSpec(p)
      expect(pathAtBlock(sp.path, sp.pathBefore, b)).toEqual(['owner'])
    }
  })

  it('the last read on the older path and the first on the current one sit on the measured upgrade blocks (was: unread at 22,131,381 / 23,089,685)', async () => {
    let c = chain()
    expect(await read(c, LP, 22_131_381)).toEqual([TL10])
    expect(c.calls).toEqual([`${LP}|owner|22131381`])
    c = chain()
    expect(await read(c, LP, 22_131_382)).toEqual([TL10])
    expect(c.calls).toEqual([`${LP}|roleRegistry|22131382`, `${RR}|owner|22131382`])
    for (const p of [EETH, WEETH]) {
      c = chain()
      expect(await read(c, p, 23_089_685)).toEqual([TL10])
      expect(c.calls).toEqual([`${p}|owner|23089685`])
      c = chain()
      expect(await read(c, p, 23_089_686)).toEqual([TL10])
      expect(c.calls).toEqual([`${p}|roleRegistry|23089686`, `${RR}|owner|23089686`])
    }
  })

  it('a failed read of the declared older path is still a read gap — it throws (fail closed; was: thrown on roleRegistry())', async () => {
    await expect(read(chain({ [`${LP}|owner|18537430`]: 'http' }), LP, 18_537_430)).rejects.toThrow(
      /owner\(\) on 0x3088\w+ not read/,
    )
    await expect(
      read(chain({ [`${LP}|owner|18537430`]: 'revert' }), LP, 18_537_430),
    ).rejects.toThrow(
      /owner\(\) not present on 0x3088\w+ \(declared path owner, declared below block 22131382\)/,
    )
  })

  it('control: an UNDECLARED revert stays a read gap — no path is inferred from it', async () => {
    const bare: PowerSpec = { ...upgradeSpec(LP), pathBefore: undefined }
    await expect(read(chain(), LP, 18_537_430, bare)).rejects.toThrow(
      /roleRegistry\(\) not present on 0x3088\w+ \(declared path call:roleRegistry\(\)>owner\)/,
    )
  })

  it('control: a head read (no block) always uses the current path', async () => {
    const c = chain()
    expect(await read(c, LP)).toEqual([TL10])
    expect(c.calls).toEqual([`${LP}|roleRegistry|head`, `${RR}|owner|head`])
  })

  it('pathAtBlock: the lowest entry above the block, else the current path (was: no path history)', () => {
    const A = ['owner']
    const B = ['eip1967_admin', 'owner']
    const C = ['call:roleRegistry()', 'owner']
    const hist = [
      { block: 100, path: A },
      { block: 200, path: B },
    ]
    expect([50, 99, 100, 199, 200, 10_000].map((b) => pathAtBlock(C, hist, b))).toEqual([
      A,
      A,
      B,
      B,
      C,
      C,
    ])
    expect(pathAtBlock(C, hist)).toBe(C)
    expect(pathAtBlock(C, undefined, 50)).toBe(C)
  })

  // R6 (2026-10-12): the collector loads subjects.json with a bare JSON.parse, never
  // parseSubjects (whose "must ascend" check would reject this order) — the pick may not lean on it
  it('pathAtBlock: an UNSORTED history picks the entry with the smallest block above the read (was the first one listed above it)', () => {
    const A = ['owner']
    const B = ['eip1967_admin', 'owner']
    const C = ['call:roleRegistry()', 'owner']
    const hist = [
      { block: 200, path: B },
      { block: 100, path: A },
    ]
    expect([50, 99, 100, 199, 200, 10_000].map((b) => pathAtBlock(C, hist, b))).toEqual([
      A,
      A,
      B,
      B,
      C,
      C,
    ])
  })

  it('an UNSORTED history: a failed read names the block its path is declared below (was the first entry listed)', async () => {
    const unsorted: PowerSpec = {
      ...upgradeSpec(LP),
      pathBefore: [
        { block: 23_000_000, path: ['owner'] },
        { block: 22_131_382, path: ['owner'] },
      ],
    }
    await expect(
      read(chain({ [`${LP}|owner|18537430`]: 'revert' }), LP, 18_537_430, unsorted),
    ).rejects.toThrow(/\(declared path owner, declared below block 22131382\)/)
  })

  it('the collector reads the AD-5 holders with the spec’s pathBefore (was: the bare path)', () => {
    const src = readFileSync('scripts/oracle-registry/config/collect-config.mjs', 'utf8')
    expect(src).toMatch(/if \(p\.power === 'upgrade'\) upgradeSpecs\.set\(p\.contract, p\)/)
    expect(src).toMatch(/pathBefore: upgradeSpecs\.get\(r\.emitter\)\.pathBefore,/)
  })

  it('control: with the holders read (the Safe, no timelock), the 9 upgrades are neutral — no AD-5, no read gap', () => {
    const safe: Controller = { kind: 'safe', address: SAFE, threshold: 2, signers: 6 }
    const rows: AdminEventRow[] = AD5_READS.map(([p, b], i) => ({
      chainId: 1,
      block: b + 1,
      logIndex: i,
      tx: `0x${(b + 1).toString(16)}${i}`,
      emitter: p,
      event: 'Upgraded',
      args: { implementation: '0x' + String(i + 1).repeat(40) },
    }))
    const out = classifyAdminEvents(rows, {
      subject: 'weeth',
      ctl: () => null,
      upgradeTimelocks: {},
      timelockSince: {},
      upgradeHoldersAt: Object.fromEntries(AD5_READS.map(([p, b]) => [`${p}@${b + 1}`, [safe]])),
      upgradeHoldersUnread: [],
      declaredTimelocks: [TL10, '0xcd425f44758a08baab3c4908f3e3de5776e45d7a'],
      deployBlocks: { [LP]: 17_664_317, [EETH]: 17_664_324, [WEETH]: 17_664_336 },
      tokens: [],
      announcement: 'no_gov_channel' as const,
      verified: () => true,
    })
    expect(out).toHaveLength(9)
    for (const c of out) {
      expect(c.ruleIds).not.toContain('AD-5')
      expect(c.red).toBe(false)
      expect(c.tags).not.toContain('read_gap')
    }
  })
})

describe('F2: subjects.json pathBefore', () => {
  it('declares the measured switch blocks on weETH’s three upgrade powers (was: none — 9 red AD-5 on a read gap)', () => {
    expect(upgradeSpec(LP).pathBefore).toEqual([{ block: 22_131_382, path: ['owner'] }])
    expect(upgradeSpec(EETH).pathBefore).toEqual([{ block: 23_089_686, path: ['owner'] }])
    expect(upgradeSpec(WEETH).pathBefore).toEqual([{ block: 23_089_686, path: ['owner'] }])
    // no other power declares one (the wstETH committee path is untouched)
    const others = getConfigSubjects()
      .subjects.flatMap((s) => s.powers)
      .filter((p) => p.pathBefore && ![LP, EETH, WEETH].includes(p.contract))
    expect(others).toEqual([])
  })

  it('rejects a pathBefore nothing reads or that is misordered (was: accepted silently)', () => {
    const edit = (f: (p: PowerSpec) => void) => {
      const g = JSON.parse(JSON.stringify(getConfigSubjects()))
      const s = g.subjects.find((x: { key: string }) => x.key === 'weeth')
      f(s.powers.find((p: PowerSpec) => p.power === 'upgrade' && p.contract === LP))
      return () => parseSubjects(g)
    }
    // on a non-upgrade power: only AD-5 reads a past block
    expect(
      edit((p) => {
        p.power = 'roles'
      }),
    ).toThrow(/pathBefore is read only for an upgrade power/)
    expect(
      edit((p) => {
        p.pathBefore = []
      }),
    ).toThrow(/pathBefore is read only for an upgrade power/)
    // at or before the contract's deploy block (17,664,317), or not ascending
    expect(
      edit((p) => {
        p.pathBefore = [{ block: 17_664_317, path: ['owner'] }]
      }),
    ).toThrow(/pathBefore blocks must ascend/)
    expect(
      edit((p) => {
        p.pathBefore = [
          { block: 22_131_382, path: ['owner'] },
          { block: 20_000_000, path: ['owner'] },
        ]
      }),
    ).toThrow(/pathBefore blocks must ascend/)
    expect(
      edit((p) => {
        p.pathBefore = [{ block: 22_131_382.5, path: ['owner'] }]
      }),
    ).toThrow(/pathBefore blocks must ascend/)
    // a bad or empty older path
    expect(
      edit((p) => {
        p.pathBefore = [{ block: 22_131_382, path: ['selfdestruct'] }]
      }),
    ).toThrow(/pathBefore path selfdestruct/)
    expect(
      edit((p) => {
        p.pathBefore = [{ block: 22_131_382, path: [] }]
      }),
    ).toThrow(/pathBefore path/)
  })
})

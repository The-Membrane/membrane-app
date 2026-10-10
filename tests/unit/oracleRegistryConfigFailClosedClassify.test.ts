// Config cards — fail-closed audit (2026-10-10), part 2: controller CLASSIFICATION. A read that
// failed inside `classify` (a multicall chunk rejected, a storage word not served, a member or a
// count not read, an Aragon implementation not read, an ACL not read, a Dual Governance delay not
// read) must leave a MARKER: the rank is the fail-closed plain-contract cap with a read gap, the
// card lists it, the UQ-30 carry finds it, a change FROM it is never an upgrade, and the past-block
// cache never keeps it. Before the fixes each of these classified as a calm, unmarked node.
// Every test failed on the code before its fix unless it is marked (control).

import { keccak256, pad, toFunctionSelector, toHex } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyControllerChange,
  controllerRank,
  isEoaControlled,
  isRed,
  nodeReadGaps,
  rankHasReadGap,
  treeReadGaps,
} from '@/lib/oracleRegistry/config/rules'
import type { Controller } from '@/lib/oracleRegistry/config/types'
import { roleHash } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import {
  classify,
  enrichTokenVotes,
  hasReadFailure,
  readCcipPool,
  readDgProposals,
  readNtt,
  resolvePath as resolvePathJs,
  setLogClients,
  setRoleCandidates,
  timelockBypass,
  timelockExecutors,
  timelockSchedulers,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { firstCodeBlocks } from '@/scripts/oracle-registry/config/lib/lz.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const C = A('1')
const SAFE = A('6')
const TL = A('7')
const AGENT = A('3')
const VOTING = A('4')
const IMPL = A('5')
const KERNEL = A('8')
const ACL = A('9')
const EOA = A('e')
const EOA2 = A('d')
const SENTINEL = '0x0000000000000000000000000000000000000001'
const SINGLETON = '0x41675c099f32341bf84bfc5382af534df5c7461a'
const word = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const sel = (sig: string) => toFunctionSelector(`function ${sig}`).slice(2)
const codeWith = (sigs: string[]) =>
  '0x6080' + sigs.map((x) => '63' + sel(x) + '14').join('') + '00'
const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
const httpErr = () =>
  Object.assign(new Error('HTTP request failed. Status: 503'), { name: 'HttpRequestError' })
const TL_CODE = codeWith([
  'getMinDelay()',
  'getTimestamp(bytes32)',
  'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'execute(address,uint256,bytes,bytes32,bytes32)',
  'hashOperation(address,uint256,bytes,bytes32,bytes32)',
  'getRoleMemberCount(bytes32)',
])
const RBAC_CODE = codeWith([
  'getMinDelay()',
  'getTimestamp(bytes32)',
  'scheduleBatch((address,uint256,bytes)[],bytes32,bytes32,uint256)',
  'executeBatch((address,uint256,bytes)[],bytes32,bytes32)',
  'bypasserExecuteBatch((address,uint256,bytes)[])',
])
const APP_CODE = codeWith(['implementation()', 'kernel()', 'appId()'])
const VOTING_IMPL_CODE = codeWith(['voteTime()', 'executeVote(uint256)', 'getVote(uint256)'])
const AGENT_IMPL_CODE = codeWith(['forward(bytes)', 'execute(address,uint256,bytes)'])
const OWNED_CODE = codeWith(['owner()'])
const PROPOSER = roleHash('PROPOSER_ROLE').toLowerCase()
const ADMIN = roleHash('TIMELOCK_ADMIN_ROLE').toLowerCase()

/**
 * A viem-like client. reads: `${address}|${fn}` → value | Error (thrown / a multicall failure WITH
 * that error) | (args) => value; undefined = the function is not there (reverts / absent).
 */
function fake(o: {
  code?: Record<string, string | null | ((block?: bigint) => string | null)>
  reads?: Record<string, unknown>
  storage?: Record<string, unknown>
  logs?: (q: { address: unknown; fromBlock: string; toBlock: string }) => unknown
  chainId?: number
}) {
  const lc = (x: string) => x.toLowerCase()
  const val = (address: string, functionName: string, args: unknown[]) => {
    const v = o.reads?.[`${lc(address)}|${functionName}`]
    return typeof v === 'function' ? v(args) : v
  }
  return {
    ...(o.chainId ? { chain: { id: o.chainId } } : {}),
    getCode: async ({ address, blockNumber }: { address: string; blockNumber?: bigint }) => {
      const c = o.code?.[lc(address)]
      const v = typeof c === 'function' ? c(blockNumber) : c
      return v === undefined ? undefined : v
    },
    getBlockNumber: async () => 2_000n,
    getStorageAt: async ({ address, slot }: { address: string; slot: string }) => {
      const v = o.storage?.[`${lc(address)}|${slot}`]
      return v === undefined ? '0x' + '0'.repeat(64) : v
    },
    multicall: async ({
      contracts,
    }: {
      contracts: { address: string; functionName: string; args?: unknown[] }[]
    }) =>
      contracts.map((c) => {
        const v = val(c.address, c.functionName, c.args ?? [])
        if (v === undefined) return { status: 'failure', error: revert() }
        if (v instanceof Error) return { status: 'failure', error: v }
        return { status: 'success', result: v }
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
      const v = val(address, functionName, args ?? [])
      if (v === undefined) throw revert()
      if (v instanceof Error) throw v
      return v
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
const safeReads = (a: string, t: number, owners: string[]) => ({
  [`${a}|getThreshold`]: BigInt(t),
  [`${a}|getOwners`]: owners,
  [`${a}|VERSION`]: '1.4.1',
})
const safeStorage = (a: string) => ({ [`${a}|0x${'0'.repeat(64)}`]: word(SINGLETON) })
afterEach(() => setLogClients(null, null))

// =====================================================================================================
describe('CL-02 / RC-M5: a rejected multicall chunk is a FAILED read, never "every view absent"', () => {
  it('classify of an EOA-owned contract whose multicall chunk was rejected (HTTP 429) throws (it was a calm plain contract)', async () => {
    const e = Object.assign(new Error('HTTP request failed. Status: 429'), {
      name: 'HttpRequestError',
    })
    const client = fake({
      code: { [C]: OWNED_CODE },
      reads: { [`${C}|owner`]: EOA },
    })
    client.multicall = async ({ contracts }: { contracts: unknown[] }) =>
      contracts.map(() => ({ status: 'failure', error: e }))
    await expect(classify(client, C)).rejects.toThrow()
  }, 30_000)
  it('(control) per-view reverts inside aggregate3 are "not there": the contract is classified', async () => {
    const client = fake({ code: { [C]: OWNED_CODE }, reads: { [`${C}|owner`]: EOA } })
    const c = await classify(client, C)
    expect(c.ownedBy).toMatchObject({ kind: 'eoa' })
  })
})

describe('CL-03: an owner() the code dispatches but that was not read is a read gap', () => {
  it('owner read failed (not a revert): ownerUnread, ranked as a read gap, listed, never cached', async () => {
    const client = fake({ code: { [C]: OWNED_CODE }, reads: { [`${C}|owner`]: undefined } })
    // the batched read said "not there"; the direct re-read fails on transport
    client.readContract = async () => {
      throw httpErr()
    }
    const c = (await classify(client, C)) as Controller & { ownerUnread?: boolean }
    expect(c.ownerUnread).toBe(true)
    expect(rankHasReadGap(c)).toBe(true)
    expect(hasReadFailure(c)).toBe(true)
    expect(nodeReadGaps(c).join()).toMatch(/owner\(\) not read/)
  }, 30_000)
})

describe('CL-04 / M-2 / PH-06: a storage word that is not a 32-byte word is not read', () => {
  it("a Safe whose slot-0 read answers null is not 'a plain contract' (it lost its 1-of-N EOA rank)", async () => {
    const client = fake({
      code: { [SAFE]: '0x6080' },
      reads: safeReads(SAFE, 1, [EOA, EOA2]),
      storage: { [`${SAFE}|0x${'0'.repeat(64)}`]: null },
    })
    await expect(classify(client, SAFE)).rejects.toThrow()
  }, 30_000)
  it('(control) a canonical Safe 1-of-2 ranks with an EOA', async () => {
    const client = fake({
      code: { [SAFE]: '0x6080' },
      reads: {
        ...safeReads(SAFE, 1, [EOA, EOA2]),
        [`${SAFE}|getModulesPaginated`]: [[], SENTINEL],
      },
      storage: safeStorage(SAFE),
    })
    const c = await classify(client, SAFE)
    expect(c.kind).toBe('safe')
    expect(isEoaControlled(c)).toBe(true)
  })
  it('PH-06: an eip1967 admin slot answering null throws (it was "no admin": no holder, no gap)', async () => {
    const resolvePath = resolvePathJs as unknown as (
      c: unknown,
      o: Record<string, unknown>,
    ) => Promise<string[]>
    const client = fake({
      storage: {
        [`${C}|0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`]: null,
      },
    })
    await expect(
      resolvePath(client, {
        endpoint: A('f'),
        contract: C,
        path: ['eip1967_admin'],
        roleMap: new Map(),
      }),
    ).rejects.toThrow()
  }, 30_000)
})

describe('SQ-01: a Safe module list longer than one page is read to its end', () => {
  it('21 modules over two pages: all 21 (the 21st was missed, with no gap)', async () => {
    const mods = Array.from({ length: 21 }, (_, i) => '0x' + String(i + 100).padStart(40, '0'))
    const client = fake({
      code: { [SAFE]: '0x6080' },
      reads: {
        ...safeReads(SAFE, 3, [EOA, EOA2, A('c')]),
        [`${SAFE}|getModulesPaginated`]: (args: unknown[]) =>
          String(args[0]).toLowerCase() === SENTINEL
            ? [mods.slice(0, 20), mods[20]]
            : String(args[0]).toLowerCase() === mods[19]
              ? [[mods[20]], SENTINEL]
              : [[], SENTINEL],
      },
      storage: safeStorage(SAFE),
    })
    const c = await classify(client, SAFE)
    expect(c.modules).toHaveLength(21)
  })
  it('a page that fails: modules unread (a read gap), not a short list', async () => {
    const mods = Array.from({ length: 20 }, (_, i) => '0x' + String(i + 100).padStart(40, '0'))
    const client = fake({
      code: { [SAFE]: '0x6080' },
      reads: {
        ...safeReads(SAFE, 3, [EOA, EOA2, A('c')]),
        [`${SAFE}|getModulesPaginated`]: (args: unknown[]) =>
          String(args[0]).toLowerCase() === SENTINEL ? [mods, mods[19]] : httpErr(),
      },
      storage: safeStorage(SAFE),
    })
    const c = await classify(client, SAFE)
    expect(c.modulesUnread).toBe(true)
  }, 30_000)
})

// =====================================================================================================
describe('TL MISSED (admin.mjs:679): timelock code whose getMinDelay was not read', () => {
  it('ranks as an unread timelock (a read gap), not a calm plain contract', async () => {
    const client = fake({ code: { [TL]: TL_CODE }, reads: { [`${TL}|getMinDelay`]: undefined } })
    client.readContract = async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getMinDelay') throw httpErr()
      throw revert()
    }
    const c = await classify(client, TL)
    expect(c.kind).toBe('oz_timelock')
    expect(c.schedulersUnread).toBe(true)
    expect(hasReadFailure(c)).toBe(true)
  }, 30_000)
})

describe('TL-06 / TL-08: a proposer set read only partly is UNREAD', () => {
  const tlReads = (o: Record<string, unknown>) => ({
    [`${TL}|getMinDelay`]: 864_000n,
    [`${TL}|PROPOSER_ROLE`]: PROPOSER,
    [`${TL}|getRoleAdmin`]: ADMIN,
    [`${TL}|hasRole`]: true,
    ...o,
  })
  it('TL-06: count 2, member #1 not read (logs unread too): unread (it ranked as the one member read)', async () => {
    const client = fake({
      code: { [TL]: TL_CODE, [SAFE]: '0x6080' },
      reads: {
        ...tlReads({
          [`${TL}|getRoleMemberCount`]: (a: unknown[]) => (a[0] === PROPOSER ? 2n : 0n),
          [`${TL}|getRoleMember`]: (a: unknown[]) => (a[1] === 0n ? SAFE : httpErr()),
        }),
        ...safeReads(
          SAFE,
          6,
          Array.from({ length: 11 }, (_, i) => A(String((i % 9) + 1))),
        ),
        [`${SAFE}|getModulesPaginated`]: [[], SENTINEL],
      },
      storage: safeStorage(SAFE),
      logs: () => {
        throw new Error('logs down')
      },
    })
    const r = await timelockSchedulers(client, TL, undefined)
    expect(r.unread).toBe(true)
  }, 60_000)
  it('TL-08: the PROPOSER count not read while an admin role count reads: unread (one flag hid it)', async () => {
    setLogClients(null, null)
    // the admin scan saw a Safe granted PROPOSER (a window-limited, partial source)
    setRoleCandidates([
      { event: 'RoleGranted', emitter: TL, args: { role: PROPOSER, account: SAFE } },
    ])
    const client = fake({
      code: { [TL]: TL_CODE, [SAFE]: '0x6080' },
      reads: tlReads({
        [`${TL}|getRoleMemberCount`]: (a: unknown[]) => (a[0] === PROPOSER ? httpErr() : 1n),
        [`${TL}|getRoleMember`]: () => TL,
        ...safeReads(
          SAFE,
          6,
          Array.from({ length: 11 }, (_, i) => A(String((i % 9) + 1))),
        ),
        [`${SAFE}|getModulesPaginated`]: [[], SENTINEL],
      }),
      storage: safeStorage(SAFE),
      logs: () => {
        throw new Error('logs down')
      },
    })
    try {
      const r = await timelockSchedulers(client, TL, undefined)
      expect(r.unread).toBe(true)
    } finally {
      setRoleCandidates([])
    }
  }, 60_000)
})

describe('TL-13: an empty scheduler set and cycles', () => {
  it('TL-13a: no scheduler + an unrestricted EOA bypasser ranks as the EOA (it ranked [2])', () => {
    const c: Controller = {
      kind: 'oz_timelock',
      address: TL,
      delaySec: 864_000,
      schedulers: [],
      bypass: {
        fn: 'bypasserExecuteBatch',
        scope: 'any',
        holders: [EOA],
        holderCtls: [{ kind: 'eoa', address: EOA }],
      },
    }
    expect(controllerRank(c)).toEqual([1])
    expect(isEoaControlled(c)).toBe(true)
  })
  it('TL-13b: a proposer already on the control path is a CYCLE placeholder (ranked as a plain contract), not dropped', async () => {
    const client = fake({
      code: { [TL]: TL_CODE, [C]: '0x6080' },
      reads: {
        [`${TL}|getMinDelay`]: 864_000n,
        [`${TL}|PROPOSER_ROLE`]: PROPOSER,
        [`${TL}|getRoleAdmin`]: ADMIN,
        [`${TL}|hasRole`]: true,
        [`${TL}|getRoleMemberCount`]: (a: unknown[]) => (a[0] === PROPOSER ? 1n : 0n),
        [`${TL}|getRoleMember`]: () => C,
      },
    })
    const r = await timelockSchedulers(client, TL, undefined, 0, new Set([C]))
    expect(r.schedulers).toHaveLength(1)
    expect(r.schedulers[0]).toMatchObject({ kind: 'contract', address: C })
    expect(String(r.schedulers[0].version)).toMatch(/cycle/)
  })
})

describe('TL-10 / TL-11 / CL-05 (1): an unrestricted bypass whose bypassers were not read is never cached', () => {
  it('the BYPASSER member count not read: a read failure (it was cached for good)', async () => {
    const client = fake({
      code: { [TL]: RBAC_CODE },
      reads: {
        [`${TL}|BYPASSER_ROLE`]: keccak256(toHex('BYPASSER_ROLE')),
        [`${TL}|getRoleMemberCount`]: httpErr(),
      },
    })
    const bypass = (await timelockBypass(client, TL, RBAC_CODE, undefined)) as Controller['bypass']
    const c: Controller = {
      kind: 'oz_timelock',
      address: TL,
      delaySec: 864_000,
      schedulers: [{ kind: 'safe', address: SAFE, threshold: 5, signers: 7, modules: [] }],
      bypass,
    }
    expect(hasReadFailure(c)).toBe(true)
  }, 60_000)
  it('hasReadFailure: an unrestricted bypass with no classified bypasser is a read failure', () => {
    const c: Controller = {
      kind: 'oz_timelock',
      address: TL,
      delaySec: 864_000,
      schedulers: [{ kind: 'safe', address: SAFE, threshold: 5, signers: 7, modules: [] }],
      bypass: { fn: 'bypasserExecuteBatch', scope: 'any', holders: [], holderCtls: [] },
    }
    expect(hasReadFailure(c)).toBe(true)
  })
})

// =====================================================================================================
describe('TL-01 / FCB-1 / FCB-2 / ST-05: a code bisection is CONFIRMED before it bounds a log scan or is cached', () => {
  const at = (deploy: number, falseAt: number) => (b?: bigint) =>
    b === undefined
      ? '0x6080'
      : Number(b) === falseAt
        ? '0x'
        : Number(b) >= deploy
          ? '0x6080'
          : '0x'
  const TL1 = A('2')
  it('TL-01: one false "no code" mid-bisection makes the proposer logs UNREAD (it dropped the constructor proposer)', async () => {
    const grant = (acct: string, block: number) => ({
      address: TL1,
      topics: [
        keccak256(toHex('RoleGranted(bytes32,address,address)')),
        PROPOSER,
        pad(acct as Hx, { size: 32 }),
        pad(acct as Hx, { size: 32 }),
      ],
      data: '0x',
      blockNumber: '0x' + block.toString(16),
      logIndex: '0x0',
      transactionHash: '0x' + String(block).padStart(64, '0'),
    })
    const all = [grant(EOA, 100), grant(SAFE, 700)]
    const logs = (q: { fromBlock: string; toBlock: string }) =>
      all.filter(
        (l) =>
          Number(l.blockNumber) >= Number(q.fromBlock) &&
          Number(l.blockNumber) <= Number(q.toBlock),
      )
    // the state ring answers "no code" at block 500 only; the log endpoints answer the truth
    const state = fake({
      code: { [TL1]: at(50, 500), [SAFE]: '0x6080' },
      reads: {
        [`${TL1}|getMinDelay`]: 864_000n,
        [`${TL1}|PROPOSER_ROLE`]: PROPOSER,
        [`${TL1}|getRoleAdmin`]: ADMIN,
        [`${TL1}|hasRole`]: true,
        ...safeReads(
          SAFE,
          6,
          Array.from({ length: 11 }, (_, i) => A(String((i % 9) + 1))),
        ),
        [`${SAFE}|getModulesPaginated`]: [[], SENTINEL],
      },
      storage: safeStorage(SAFE),
      logs,
    })
    const truth = fake({ code: { [TL1]: at(50, -1) }, logs })
    setLogClients(truth, truth)
    const r = await timelockSchedulers(state, TL1, undefined)
    // either the constructor proposer is found, or the set is unread — never "Safe only, read"
    const found = r.schedulers.some((s: Controller) => s.address === EOA)
    expect(found || r.unread).toBe(true)
  }, 60_000)
  it('FCB-2 / ST-05: firstCodeBlocks with confirmation clients leaves an unconfirmed boundary out (it cached a late deploy block)', async () => {
    const state = fake({ code: { [C]: at(50, 500) } })
    const truth = fake({ code: { [C]: at(50, -1) } })
    const out = await (
      firstCodeBlocks as unknown as (
        c: unknown,
        a: string[],
        m: () => number,
        h: number,
        o?: { confirm: unknown[] },
      ) => Promise<Record<string, { firstCode?: number | null }>>
    )(state, [C], () => 0, 2000, { confirm: [truth, truth] })
    expect(out[C]?.firstCode ?? null).not.toBe(501)
    expect([50, null, undefined]).toContain(out[C]?.firstCode)
  }, 60_000)
})

// =====================================================================================================
describe('TV-01 / TV-08 / M1 / TV-13: an Aragon app whose implementation() was not read is a MARKED read gap', () => {
  it('a Voting AppProxy whose implementation() fails on transport: appUnread (it was a calm plain contract, cached)', async () => {
    const client = fake({
      code: { [VOTING]: APP_CODE },
      reads: { [`${VOTING}|implementation`]: httpErr() },
    })
    const c = (await classify(client, VOTING)) as Controller & { appUnread?: boolean }
    expect(c.appUnread).toBe(true)
    expect(rankHasReadGap(c)).toBe(true)
    expect(hasReadFailure(c)).toBe(true)
    expect(nodeReadGaps(c).join()).toMatch(/implementation not read/)
    // a move away from it is never an upgrade
    const v = classifyControllerChange(c, {
      kind: 'safe',
      address: SAFE,
      threshold: 3,
      signers: 5,
      modules: [],
    })
    expect(v.severity).not.toBe('upgrade')
  }, 60_000)
  it('TV-13: a non-zero implementation with no code is "implementation not read", not "not an app"', async () => {
    const client = fake({
      code: { [AGENT]: APP_CODE, [IMPL]: '0x' },
      reads: { [`${AGENT}|implementation`]: IMPL },
    })
    const c = (await classify(client, AGENT)) as Controller & { appUnread?: boolean }
    expect(c.appUnread).toBe(true)
  }, 30_000)
})

describe('TV-09 / M2: an Aragon Agent whose permissions were not read is unconfirmed (never ranked as a revoked candidate without a gap)', () => {
  it('the ACL not read: the Agent keeps its candidates AND a read gap', async () => {
    // candidates: an EOA (revoked) and a Safe 4/7 (held)
    const { setAragonExecCandidates } =
      await import('@/scripts/oracle-registry/config/lib/admin.mjs')
    setAragonExecCandidates(new Map([[AGENT, new Set([EOA, SAFE])]]))
    try {
      const client = fake({
        code: { [AGENT]: APP_CODE, [IMPL]: AGENT_IMPL_CODE, [SAFE]: '0x6080' },
        reads: {
          [`${AGENT}|implementation`]: IMPL,
          [`${AGENT}|acl`]: undefined,
          [`${AGENT}|kernel`]: httpErr(),
          ...safeReads(
            SAFE,
            4,
            Array.from({ length: 7 }, (_, i) => A(String(i + 1))),
          ),
          [`${SAFE}|getModulesPaginated`]: [[], SENTINEL],
        },
        storage: safeStorage(SAFE),
      })
      const c = await classify(client, AGENT)
      expect(rankHasReadGap(c)).toBe(true)
      expect(hasReadFailure(c)).toBe(true)
      const v = classifyControllerChange(c, {
        kind: 'safe',
        address: A('a'),
        threshold: 2,
        signers: 3,
        modules: [],
      })
      expect(v.severity).not.toBe('upgrade')
    } finally {
      setAragonExecCandidates(new Map())
    }
  }, 60_000)
})

// =====================================================================================================
describe('DG-01 / DG-02 / TV-12: Dual Governance reads', () => {
  const dg = (o: Partial<NonNullable<Controller['dg']>> = {}): Controller => ({
    kind: 'aragon_dg',
    address: A('b'),
    delaySec: 259_200,
    schedulers: [{ kind: 'safe', address: SAFE, threshold: 6, signers: 11, modules: [] }],
    dg: {
      afterSubmitDelaySec: 259_200,
      afterScheduleDelaySec: 86_400,
      governance: null,
      adminExecutor: null,
      emergencyGovernance: null,
      activationCommittee: null,
      executionCommittee: null,
      emergencyModeActive: false,
      emergencyProtectionEndsAfter: null,
      ...o,
    },
  })
  it('DG-01: an after-submit delay not read is a READ GAP (it ranked as the proposer with no gap)', () => {
    const c = dg({ afterSubmitDelaySec: null })
    expect(rankHasReadGap(c)).toBe(true)
    expect(treeReadGaps([c]).join()).toMatch(/after-submit delay not read/)
    const v = classifyControllerChange(c, {
      kind: 'safe',
      address: SAFE,
      threshold: 6,
      signers: 11,
      modules: [],
    })
    expect(v.severity).not.toBe('upgrade')
    expect(isRed(v) || v.tags.includes('read_gap')).toBe(true)
  })
  it('DG-02: an after-schedule delay not read is listed and never cached', () => {
    const c = dg({ afterScheduleDelaySec: null })
    expect(hasReadFailure(c)).toBe(true)
    expect(nodeReadGaps(c).join()).toMatch(/after-schedule delay not read/)
  })
  it('DG-07: every proposal id is read (the newest 200 only: an older pending one was dropped as "ok")', async () => {
    const EPT = A('b')
    const client = fake({
      code: {},
      reads: {
        [`${EPT}|getProposalsCount`]: 250n,
        [`${EPT}|getAfterSubmitDelay`]: 259_200,
        [`${EPT}|getAfterScheduleDelay`]: 86_400,
        [`${EPT}|getProposal`]: (a: unknown[]) => [
          {
            id: a[0],
            executor: EOA,
            submittedAt: 1n,
            scheduledAt: 0n,
            status: a[0] === 1n ? 1 : 3,
          },
          [],
        ],
      },
    })
    const r = await readDgProposals(client, EPT, { now: 10 })
    expect(r.status).toBe('ok')
    expect(r.ops.map((o: { id: string }) => o.id)).toContain('1')
  }, 60_000)
})

// =====================================================================================================
describe('TV-03 / TV-14: a token vote read in part is read again, never cached', () => {
  it('a null support threshold is a read failure (it was cached and never read again)', () => {
    const c: Controller = {
      kind: 'aragon_voting',
      address: VOTING,
      delaySec: 259_200,
      voting: {
        voteTimeSec: 259_200,
        objectionPhaseSec: null,
        token: A('f'),
        supportRequiredPct: null,
        minAcceptQuorumPct: '50000000000000000',
      },
    }
    expect(hasReadFailure(c)).toBe(true)
  })
  it('a holder classification with a read failure inside makes the vote a read failure (TV-14)', () => {
    const c: Controller = {
      kind: 'aragon_voting',
      address: VOTING,
      delaySec: 259_200,
      voting: {
        voteTimeSec: 259_200,
        objectionPhaseSec: null,
        token: A('f'),
        supportRequiredPct: '500000000000000000',
        minAcceptQuorumPct: '50000000000000000',
        holders: [
          {
            address: SAFE,
            balance: '1',
            ctl: { kind: 'safe', address: SAFE, threshold: 3, signers: 5, modulesUnread: true },
          },
        ],
      },
    }
    expect(hasReadFailure(c)).toBe(true)
  })
  it('enrichTokenVotes reads the thresholds again when one is null', async () => {
    const node: Controller = {
      kind: 'aragon_voting',
      address: VOTING,
      delaySec: 259_200,
      voting: {
        voteTimeSec: 259_200,
        objectionPhaseSec: null,
        token: A('f'),
        supportRequiredPct: null,
        minAcceptQuorumPct: '50000000000000000',
      },
    }
    const client = fake({
      reads: {
        [`${VOTING}|token`]: A('f'),
        [`${VOTING}|supportRequiredPct`]: 500_000_000_000_000_000n,
        [`${VOTING}|minAcceptQuorumPct`]: 50_000_000_000_000_000n,
      },
    })
    await enrichTokenVotes(
      client,
      { [`${VOTING}@100`]: node },
      {
        head: 200,
        decide: () => ({ kind: 'unread', reason: 'x' }),
        snapshotsFor: async () => new Map(),
        defenseFor: async () => {
          throw new Error('not needed')
        },
      },
    )
    expect(node.voting?.supportRequiredPct).toBe('500000000000000000')
  })
})

// =====================================================================================================
describe('RC-M6: classification on a REMOTE chain never reads Ethereum logs or memos', () => {
  it("a remote timelock's proposers come from the remote chain (never Ethereum's same-address grants)", async () => {
    const GRANTED = keccak256(toHex('RoleGranted(bytes32,address,address)'))
    const ethLogs = () => [
      {
        address: TL,
        topics: [GRANTED, PROPOSER, pad(SAFE, { size: 32 }), pad(SAFE, { size: 32 })],
        data: '0x',
        blockNumber: '0x5',
        logIndex: '0x0',
        transactionHash: '0x' + '1'.repeat(64),
      },
    ]
    const eth = fake({ code: { [TL]: TL_CODE }, logs: ethLogs })
    setLogClients(eth, eth)
    const remote = fake({
      chainId: 56,
      code: { [TL]: TL_CODE, [SAFE]: '0x6080' },
      reads: {
        [`${TL}|getMinDelay`]: 864_000n,
        [`${TL}|PROPOSER_ROLE`]: PROPOSER,
        [`${TL}|getRoleAdmin`]: ADMIN,
        [`${TL}|hasRole`]: true,
      },
      logs: () => [], // the remote chain answers empty, unconfirmable
    })
    const r = await timelockSchedulers(remote, TL, undefined)
    expect(r.unread).toBe(true)
    expect(r.schedulers.some((s: Controller) => s.address === SAFE)).toBe(false)
  }, 60_000)
})

// =====================================================================================================
describe('CC-02 / CC-06: CCIP pool reads', () => {
  const POOL = A('c')
  it('CC-02: a getRebalancer read that failed is marked (it read like "no rebalancer function")', async () => {
    const client = fake({
      reads: {
        [`${POOL}|owner`]: SAFE,
        [`${POOL}|getRebalancer`]: httpErr(),
        [`${POOL}|getSupportedChains`]: [],
      },
    })
    const p = await readCcipPool(client, POOL)
    expect(p).toMatchObject({ rebalancer: null, rebalancerUnread: true })
  }, 30_000)
  it('CC-06: isSiloed not read — the chain rebalancer is still read (it was never read)', async () => {
    const client = fake({
      reads: {
        [`${POOL}|owner`]: SAFE,
        [`${POOL}|getRebalancer`]: undefined,
        [`${POOL}|getSupportedChains`]: [7n],
        [`${POOL}|getCurrentInboundRateLimiterState`]: { isEnabled: true },
        [`${POOL}|getCurrentOutboundRateLimiterState`]: { isEnabled: true },
        [`${POOL}|getRemotePools`]: [],
        [`${POOL}|isSiloed`]: httpErr(),
        [`${POOL}|getChainRebalancer`]: EOA,
      },
    })
    const p = await readCcipPool(client, POOL)
    expect(p.chains[0]).toMatchObject({ siloed: null, rebalancer: EOA })
  }, 60_000)
})

describe('NB-04 / NB-02 (queue): NTT head reads', () => {
  const M = A('a')
  it('NB-04: getMode not read leaves the locked balance UNREAD (it read a 0 balance as locked)', async () => {
    const client = fake({
      reads: {
        [`${M}|getThreshold`]: 2,
        [`${M}|getTransceivers`]: [],
        [`${M}|token`]: A('f'),
        [`${M}|getMode`]: httpErr(),
        [`${A('f')}|balanceOf`]: 0n,
        [`${A('f')}|decimals`]: 18,
      },
    })
    const n = await readNtt(client, M, [], [])
    expect(n.mode).toBeNull()
    expect(n.locked).toBeNull()
  }, 60_000)
  it('the swept chains read as ZERO are recorded (a chain absent from peers is otherwise unread)', async () => {
    const client = fake({
      reads: {
        [`${M}|getThreshold`]: 2,
        [`${M}|getTransceivers`]: [],
        [`${M}|getPeer`]: (a: unknown[]) =>
          a[0] === 4
            ? { peerAddress: pad(EOA, { size: 32 }), tokenDecimals: 18 }
            : { peerAddress: '0x' + '0'.repeat(64), tokenDecimals: 0 },
      },
    })
    const n = await readNtt(client, M, [], [4, 5])
    expect(n.peersReadZero).toEqual([5])
  }, 60_000)
})

// =====================================================================================================
describe('QU-04 / MS-2: who an execute() is simulated from', () => {
  it('the open-executor read failed and no candidate confirmed: NOT confirmed (it simulated from 0x…dEaD and called the op stale)', async () => {
    const client = fake({ reads: { [`${TL}|hasRole`]: httpErr() } })
    const r = await timelockExecutors(client, TL, [])
    expect(r.confirmed).toBe(false)
  }, 60_000)
  it('(control) open execution read true: anyone (0x…dEaD), confirmed', async () => {
    const client = fake({ reads: { [`${TL}|hasRole`]: true } })
    const r = await timelockExecutors(client, TL, [])
    expect(r).toMatchObject({ confirmed: true })
    expect(r.from[0].toLowerCase()).toBe('0x000000000000000000000000000000000000dead')
  })
  it('a candidate whose EXECUTOR_ROLE is confirmed at head is used', async () => {
    const client = fake({
      reads: { [`${TL}|hasRole`]: (a: unknown[]) => String(a[1]).toLowerCase() === EOA },
    })
    const r = await timelockExecutors(client, TL, [EOA2, EOA])
    expect(r).toMatchObject({ confirmed: true, from: [EOA] })
  })
})

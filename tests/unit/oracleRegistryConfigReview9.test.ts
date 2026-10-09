// Config cards — review round 9: the confirmed bugs the two refuters found in the ruling #12-#14
// work (on-chain lens: CB-1..CB-3; rules lens: R-1..R-3). Each test failed on the code before the
// fix (controls are marked). Synthetic fixtures; the on-chain shapes they copy are cited.

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { keccak256, pad, toHex } from 'viem'

import {
  classifyAdminEvents,
  committeePathVia,
  type AdminEventRow,
} from '@/lib/oracleRegistry/config/adminReplay'
import {
  classifyControllerChange,
  compareRank,
  controllerRank,
  describeController,
  isEoaControlled,
  isRed,
} from '@/lib/oracleRegistry/config/rules'
import type { Controller, StateItem } from '@/lib/oracleRegistry/config/types'
import { compareValueAtRisk, valueAtRiskLabel } from '@/lib/oracleRegistry/config/value'
import { breachesOf } from '@/lib/oracleRegistry/config/view'
import { roleHash } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import { classify, timelockSchedulers } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import {
  paramTransitions,
  paramsForSubject,
  scopedParamSpecs,
} from '@/scripts/oracle-registry/config/lib/params.mjs'
import { tokenVote } from './oracleRegistryVoteFixtures'

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const DAY = 86_400
const SAFE = A('6')
const EOA = A('e')
const HC = A('d') // a committee (EtherFiOracle / HashConsensus)
const TL = A('c') // a declared path timelock
const OTHER = A('9')
const EPT = A('7') // Dual Governance timelock
const safe = (a: string, t: number, n: number): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
})
const SAFE_6_11 = safe(SAFE, 6, 11)
const tl = (
  delaySec: number,
  schedulers: Controller[],
  o: Partial<Controller> = {},
): Controller => ({
  kind: 'oz_timelock',
  address: TL,
  delaySec,
  schedulers,
  ...o,
})

// =====================================================================================================
describe('CB-1: mint/redeem params are read under SUBJECT-scoped keys', () => {
  // weETH and wstETH both declare `oracleQuorum`, on different contracts. On chain: EtherFiOracle
  // quorumSize 2 → 3 at 25,626,145; HashConsensus quorum 5 throughout. One pass keyed by `key`
  // alone gave weETH wstETH's 5, and weETH's 2 → 3 row vanished.
  const ETHERFI = A('57')
  const HASHC = A('d6')
  const CHANGE = 625
  const client = {
    multicall: async ({
      contracts,
      blockNumber,
    }: {
      contracts: { address: string }[]
      blockNumber?: bigint
    }) =>
      contracts.map((c) => {
        const a = c.address.toLowerCase()
        const b = Number(blockNumber ?? 1000n)
        if (a === ETHERFI) return { status: 'success', result: b >= CHANGE ? 3n : 2n }
        if (a === HASHC) return { status: 'success', result: 5n }
        return { status: 'failure' }
      }),
  }
  const subjects = [
    {
      key: 'weeth',
      params: [
        {
          key: 'oracleQuorum',
          contract: ETHERFI,
          sig: 'function quorumSize() view returns (uint32)',
        },
      ],
    },
    {
      key: 'wsteth',
      params: [
        {
          key: 'oracleQuorum',
          contract: HASHC,
          sig: 'function getQuorum() view returns (uint256)',
        },
      ],
    },
  ]
  it('each subject reads its own contract: weETH 3 (with its 2 → 3 change), wstETH 5', async () => {
    const all = await paramTransitions(client, scopedParamSpecs(subjects), {
      from: 100,
      head: 1000,
      step: 200,
    })
    const weeth = paramsForSubject(all, 'weeth')
    const wsteth = paramsForSubject(all, 'wsteth')
    expect(weeth.head).toEqual({ oracleQuorum: '3' })
    expect(wsteth.head).toEqual({ oracleQuorum: '5' })
    expect(weeth.transitions).toEqual([
      expect.objectContaining({
        key: 'oracleQuorum',
        contract: ETHERFI,
        block: CHANGE,
        before: '2',
        after: '3',
      }),
    ])
    expect(wsteth.transitions).toEqual([])
  })
  it('the collector reads every subject under the scoped keys (no `key`-only pass left)', () => {
    const src = readFileSync('scripts/oracle-registry/config/collect-config.mjs', 'utf8')
    expect(src).toMatch(/const specs = scopedParamSpecs\(subjects\)/)
    expect(src).toMatch(/params: paramsForSubject\(params, s\.key\)/)
    expect(src).not.toMatch(/subjects\.flatMap\(\(s\) => s\.params\)/)
  })
})

// =====================================================================================================
describe('CB-2: a committee member change is neutral only when the declared path MADE it', () => {
  const TX = ('0xc0d1ec56' + '0'.repeat(56)) as Hx
  const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
    chainId: 1,
    block: 25_626_145,
    logIndex: 0,
    tx: TX,
    emitter: HC,
    event: 'CommitteeMemberAdded',
    args: {},
    ...o,
  })
  const add = (logIndex: number, member: string) =>
    row({ logIndex, event: 'CommitteeMemberAdded', args: { member } })
  // OZ: CallExecuted(id, index, target, value, data) right after each call of the batch
  const exec = (logIndex: number, target: string, member?: string) =>
    row({
      logIndex,
      emitter: TL,
      event: 'CallExecuted',
      args: {
        target,
        data: '0x3b4aea80' + (member ?? OTHER).slice(2).padStart(64, '0'),
      },
    })
  // UQ-19: the path controllers are ranked — a 2-day timelock the Safe 6/11 proposes into; the
  // Dual Governance timelock as a 3-day timelock behind the same Safe (rank shape only)
  const ctx = (o: Record<string, unknown> = {}) => ({
    subject: 'z',
    ctl: (a: string) =>
      a === TL
        ? tl(2 * DAY, [SAFE_6_11])
        : a === EPT
          ? tl(3 * DAY, [SAFE_6_11], { address: EPT })
          : null,
    upgradeTimelocks: {},
    deployBlocks: { [HC]: 10 },
    tokens: [],
    announcement: 'not_checked' as const,
    committeePaths: { [HC]: [TL] },
    ...o,
  })
  it('a member add bundled with a timelock call to ANOTHER contract is red (was neutral)', () => {
    const out = classifyAdminEvents([add(0, EOA), exec(1, OTHER)], ctx())
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(['AD-5'])
    expect(out[0].notes?.join(' ')).toMatch(/did not make this change/)
  })
  it('an out-of-band add placed in front of an unrelated timelocked call to the committee is red', () => {
    // the attacker adds EOA directly, then executes a ready op that adds another member
    const out = classifyAdminEvents([add(0, EOA), add(1, A('b')), exec(2, HC, A('b'))], ctx())
    expect(out[0].red).toBe(true)
  })
  it('control: the ether.fi shape (a Safe calls the timelock; each call targets the committee and names the member) is neutral', () => {
    // tx 0xc0d1ec56 at 25,626,145: logs 280-287, sent to Safe 0x2aca…, not to the timelock
    const rows = [add(280, A('a')), exec(281, HC, A('a')), add(282, A('b')), exec(283, HC, A('b'))]
    const out = classifyAdminEvents(rows, ctx({ txTo: { [TX]: A('2a') } }))
    expect(out[0].red).toBe(false)
    expect(out[0].notes?.join(' ')).toMatch(
      /through the declared delayed governance path: CallExecuted/,
    )
  })
  it('control: a transaction SENT to the declared Dual Governance timelock, executed after the change, is neutral', () => {
    // tx 0x2aac8dd0 at 26,054,464: to = 0xce04 (EmergencyProtectedTimelock), ProposalExecuted last
    const rows = [
      row({ logIndex: 21, event: 'MemberRemoved', args: { addr: A('1') } }),
      row({ logIndex: 23, event: 'MemberAdded', args: { addr: A('f') } }),
      row({ logIndex: 178, emitter: EPT, event: 'ProposalExecuted', args: {} }),
    ]
    const sent = classifyAdminEvents(
      rows,
      ctx({ committeePaths: { [HC]: [EPT] }, txTo: { [TX]: EPT } }),
    )
    expect(sent[0].red).toBe(false)
    // the same logs with the transaction sent elsewhere (or not read): no proof — red
    expect(
      classifyAdminEvents(rows, ctx({ committeePaths: { [HC]: [EPT] }, txTo: { [TX]: OTHER } }))[0]
        .red,
    ).toBe(true)
    expect(classifyAdminEvents(rows, ctx({ committeePaths: { [HC]: [EPT] } }))[0].red).toBe(true)
  })
  it('committeePathVia: the execution event must come AFTER the member events', () => {
    const before = row({ logIndex: 0, emitter: EPT, event: 'ProposalExecuted', args: {} })
    const m = row({ logIndex: 1, event: 'MemberAdded', args: { addr: EOA } })
    expect(committeePathVia([before, m], [m], HC, [EPT], EPT)).toBeNull()
  })
})

// =====================================================================================================
describe('CB-3: the owner of a timelock proposer is read at any depth; an ownership cycle is not followed', () => {
  const PROPOSER = roleHash('PROPOSER_ROLE').toLowerCase()
  const ADMIN = roleHash('TIMELOCK_ADMIN_ROLE').toLowerCase()
  const GRANTED = keccak256(toHex('RoleGranted(bytes32,address,address)'))
  const sel = (sig: string) => keccak256(toHex(sig)).slice(2, 10)
  const TL_CODE =
    '0x6080' +
    [
      'getMinDelay()',
      'getTimestamp(bytes32)',
      'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
      'execute(address,uint256,bytes,bytes32,bytes32)',
      'hashOperation(address,uint256,bytes,bytes32,bytes32)',
    ]
      .map((x) => '63' + sel(x) + '14')
      .join('') +
    '00'
  const revert = () =>
    Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
  /**
   * A chain: contracts with owner(), one OZ timelock `t` (delay `delay`) whose role holders are
   * `holders`. `canCut` = accounts whose eth_call of updateDelay succeeds (RBACTimelock admins).
   */
  const world = (o: {
    t: string
    delay: number
    holders: Record<string, string[]>
    owners: Record<string, string>
    canCut?: string[]
  }) => ({
    getBlockNumber: async () => 1000n,
    getCode: async ({ address }: { address: string }) => {
      const a = address.toLowerCase()
      return a === o.t ? TL_CODE : o.owners[a] !== undefined ? '0x6080' : '0x'
    },
    multicall: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((c) => {
        const a = c.address.toLowerCase()
        if (a === o.t && c.functionName === 'getMinDelay')
          return { status: 'success', result: BigInt(o.delay) }
        if (c.functionName === 'owner' && o.owners[a] !== undefined)
          return { status: 'success', result: o.owners[a] }
        return { status: 'failure' }
      }),
    getStorageAt: async () => '0x' + '0'.repeat(64),
    readContract: async (q: { address: string; functionName: string; args?: unknown[] }) => {
      if (q.address.toLowerCase() !== o.t) throw revert()
      if (q.functionName === 'getRoleAdmin') return ADMIN
      if (q.functionName === 'hasRole')
        return (o.holders[String(q.args![0]).toLowerCase()] ?? []).includes(
          String(q.args![1]).toLowerCase(),
        )
      throw revert()
    },
    call: async ({ account, to }: { account: string; to: string }) => {
      if (to.toLowerCase() === o.t && (o.canCut ?? []).includes(account.toLowerCase())) return {}
      throw revert()
    },
    request: async ({ method, params }: { method: string; params: { address: string }[] }) =>
      method !== 'eth_getLogs' || params[0].address.toLowerCase() !== o.t
        ? []
        : Object.entries(o.holders).flatMap(([role, accts]) =>
            accts.map((acct) => ({
              topics: [GRANTED, role, pad(acct as Hx, { size: 32 }), pad(SAFE, { size: 32 })],
              data: '0x',
              blockNumber: '0x5',
            })),
          ),
  })
  it('ProxyAdmin → 10-day timelock whose only proposer is a contract owned by an EOA: ranks as the EOA (AD-3)', async () => {
    const t = A('b1')
    const pa = A('b2') // ProxyAdmin, owner() = the timelock
    const p = A('b3') // the proposer: Ownable, owner() = an EOA
    const c = await classify(
      world({ t, delay: 10 * DAY, holders: { [PROPOSER]: [p] }, owners: { [pa]: t, [p]: EOA } }),
      pa,
      900,
    )
    expect(c.kind).toBe('contract')
    expect(c.ownedBy?.kind).toBe('oz_timelock')
    expect(c.ownedBy?.schedulers?.[0]).toMatchObject({ address: p, ownedBy: { kind: 'eoa' } })
    expect(controllerRank(c)[0]).toBe(1)
    expect(isEoaControlled(c)).toBe(true)
    // the same power held by a Safe 6/11 before: red
    expect(isRed(classifyControllerChange(SAFE_6_11, c))).toBe(true)
  })
  it('a proposer owned by the timelock it proposes into (Chainlink MCMS) counts the delay credit once', async () => {
    const t = A('b4')
    const m = A('b5') // MCMS, owner() = the timelock
    const c = await classify(
      world({ t, delay: 7 * DAY, holders: { [PROPOSER]: [m] }, owners: { [m]: t } }),
      t,
      900,
    )
    expect(c.schedulers?.[0]).toMatchObject({ kind: 'contract', address: m })
    expect(c.schedulers?.[0].ownedBy).toBeUndefined()
    // a plain contract proposing into a 7-day timelock: [2], one 7-day credit (was two)
    expect(controllerRank(c)).toEqual([2, 0, 0, 7 * DAY])
  })

  // ---- R-2 (rules lens): an RBACTimelock ADMIN_ROLE holder can cut the delay at once --------------
  it('R-2 collector: an admin-role holder whose updateDelay call succeeds is a delay setter; an OZ admin is not', async () => {
    const t = A('b6')
    const rbac = await timelockSchedulers(
      world({
        t,
        delay: 7 * DAY,
        holders: { [PROPOSER]: [SAFE], [ADMIN]: [SAFE] },
        owners: {},
        canCut: [SAFE],
      }),
      t,
      900,
    )
    expect(rbac.delaySetters).toEqual([SAFE])
    const oz = await timelockSchedulers(
      world({
        t: A('b7'),
        delay: 7 * DAY,
        holders: { [PROPOSER]: [SAFE], [ADMIN]: [SAFE] },
        owners: {},
      }),
      A('b7'),
      900,
    )
    expect(oz.delaySetters).toEqual([])
  })
})

// =====================================================================================================
describe('R-1 / R-2: rank fixes in rules.ts', () => {
  const VOTING = A('4')
  it('R-1: an Aragon Voting app with a 0 s or unread vote time ranks as a plain contract (Safe 6/11 → it is RED)', () => {
    const unread: Controller = {
      kind: 'aragon_voting',
      address: VOTING,
      delaySec: 0,
      voting: { voteTimeSec: null, objectionPhaseSec: null },
    }
    expect(controllerRank(unread)).toEqual([2])
    expect(isRed(classifyControllerChange(SAFE_6_11, unread))).toBe(true)
    expect(describeController(unread)).toMatch(/vote time UNREAD/)
    const zero: Controller = { kind: 'aragon_voting', address: VOTING, delaySec: 0 }
    expect(controllerRank(zero)).toEqual([2])
    // control: a read 5-day vote, broadly held (UQ-17: ranked by holder concentration), still
    // ranks as a token-holder vote
    const lido = tokenVote(VOTING, { voteTimeSec: 5 * DAY })
    expect(controllerRank(lido)[0]).toBe(5)
  })
  it('R-2: Safe 6/11 → a 7-day RBACTimelock whose ADMIN and PROPOSER are that Safe is NEUTRAL (was UPGRADE)', () => {
    const rbac = tl(7 * DAY, [SAFE_6_11], { delaySetters: [SAFE] })
    expect(compareRank(controllerRank(rbac), controllerRank(SAFE_6_11))).toBe(0)
    expect(classifyControllerChange(SAFE_6_11, rbac).severity).toBe('neutral')
    expect(describeController(rbac)).toMatch(/which can change the delay at once/)
  })
  it('R-2: Safe 6/11 behind a 3-day OZ timelock → that RBACTimelock is RED (the delay can be cut to 0)', () => {
    const before = tl(3 * DAY, [SAFE_6_11])
    const after = tl(7 * DAY, [SAFE_6_11], { delaySetters: [SAFE], address: A('cd') })
    expect(isRed(classifyControllerChange(before, after))).toBe(true)
    // control: the same 7-day timelock where the Safe cannot cut the delay is an upgrade
    expect(classifyControllerChange(before, tl(7 * DAY, [SAFE_6_11])).severity).toBe('upgrade')
  })
})

// =====================================================================================================
describe('R-3: a floor breach whose value at risk is PARTLY read sorts with the unread ones (ruling #14)', () => {
  const item = (eid: number, v: StateItem['valueAtRisk']): StateItem => ({
    subject: 'z',
    dimension: 'bridge',
    key: `bridge/route/1/${A('85')}/${eid}/receive`,
    chainId: 1,
    block: 1,
    display: `eid ${eid} (x) receive: E=1`,
    breaches: [{ ruleId: 'BR-2', message: 'floor' }],
    valueAtRisk: v,
  })
  const partial = {
    usd: 1_000,
    lockedUsd: 1_000,
    remoteSupplyUsd: null,
    basis: 'locked' as const,
    priceUsd: 1,
    priceBasis: 'x',
    unread: ['remote supply not read'],
  }
  const full = {
    usd: 10e6,
    lockedUsd: 10e6,
    remoteSupplyUsd: 1,
    basis: 'locked' as const,
    priceUsd: 1,
    priceBasis: 'x',
    unread: [],
  }
  it('comparator: nothing read, then partly read, then fully read (highest first within each)', () => {
    expect(compareValueAtRisk(partial, full)).toBeLessThan(0)
    expect(compareValueAtRisk(full, partial)).toBeGreaterThan(0)
    expect(compareValueAtRisk({ usd: null }, partial)).toBeLessThan(0)
    expect(compareValueAtRisk({ ...partial, usd: 5e3 }, partial)).toBeLessThan(0)
  })
  it('the card lists the $1K-read / remote-unread breach before a fully read $10M one, labelled "value unread"', () => {
    const b = breachesOf([item(30110, full), item(30184, partial)])
    expect(b.map((x) => x.valueAtRisk)).toEqual([
      'value unread (remote supply not read) · at least $1K (locked on Ethereum)',
      '$10M at risk (locked on Ethereum)',
    ])
    expect(valueAtRiskLabel(full)).toBe('$10M at risk (locked on Ethereum)')
  })
})

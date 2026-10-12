// Config cards — S2 (2026-10-12, review of R2): two more failed reads judged as plain reds, the
// same class as R2 (classifyControllerChange: a new holder that could not be classified).
//   (a) classifyRoleAdminChange ran its c < 0 check BEFORE the read-gap sides: a null holder ranks
//       lowest ([0]) and a holder whose rank rests on a read gap ranks as a plain contract, so a new
//       admin side that could not be read looked "weaker" and was red AD-3 with no `read_gap` tag —
//       it ended the red before it on the key (markStillInEffect) and its gap was counted nowhere.
//   (b) classifyRoleGrant: a privileged role granted to an account that could not be classified
//       (an OZ RoleGranted, or a Solady RoleSet the collector rewrites to one — abi.mjs roleSetRow)
//       was red AD-4 with no `read_gap` tag, so the failed read was never listed, even with the
//       account in `classifyFailed` (pastReadGaps lists only the lookups of `read_gap` rows).
// Each test failed on the code before the fix unless it is marked (control). Synthetic fixtures.

import { encodeFunctionData, parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'

import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import {
  buildSubject,
  markStillInEffect,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import { judgeCall, type QueueCtx } from '@/lib/oracleRegistry/config/queue'
import {
  classifyRoleAdminChange,
  classifyRoleGrant,
  compareRank,
  controllerRank,
  isRed,
} from '@/lib/oracleRegistry/config/rules'
import type { ConfigChange, ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry, EvalCtx } from '@/lib/oracleRegistry/config/uln'
import { roleSetRow as roleSetRowJs } from '@/scripts/oracle-registry/config/lib/abi.mjs'

import { causeListed } from './oracleRegistryReadGapCause'

// the collector is JavaScript: its inferred parameter type is narrowed here
const roleSetRow = roleSetRowJs as unknown as (row: AdminEventRow) => AdminEventRow

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const n = (b: number) => b.toLocaleString('en-US')
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const H32 = (b: string) => ('0x' + b.repeat(32)) as Hx
const ZERO32 = H32('00')

const EM = A('c1') // an AccessControl contract of the subject
const D = 21_000_000 // its deploy block
const SAFE_ADDR = A('c2')
const EOA_ADDR = A('c3')
const UNK = A('c4') // classification FAILED at the block it is judged at
const SAFE_LOW_ADDR = A('c5')
const TLU_ADDR = A('c6') // a timelock whose proposers were not read
const UNK2 = A('c7') // a Solady RoleSet grantee, classification FAILED

// admin roles of OPERATOR_ROLE, each held by one account (granted in the deploy block)
const R_SAFE = H32('d1')
const R_EOA = H32('d2')
const R_UNK = H32('d3')
const R_LOW = H32('d4')
const R_TLU = H32('d5')
const ROLE_X = H32('e0')
const UPGRADER = H32('e1')

const SAFE: Controller = { kind: 'safe', address: SAFE_ADDR, threshold: 2, signers: 6 }
const SAFE_LOW: Controller = { kind: 'safe', address: SAFE_LOW_ADDR, threshold: 2, signers: 9 }
const EOA: Controller = { kind: 'eoa', address: EOA_ADDR }
const TLU: Controller = {
  kind: 'oz_timelock',
  address: TLU_ADDR,
  delaySec: 2 * 86400,
  schedulersUnread: true,
}

const NAME: Record<string, string> = {
  [R_SAFE]: 'SAFE_ADMIN',
  [R_EOA]: 'EOA_ADMIN',
  [R_UNK]: 'UNK_ADMIN',
  [R_LOW]: 'LOW_ADMIN',
  [R_TLU]: 'TLU_ADMIN',
}
const ev = (
  block: number,
  event: string,
  args: Record<string, unknown>,
  logIndex = 0,
): AdminEventRow => ({
  chainId: 1,
  block,
  logIndex,
  tx: `0x${block.toString(16)}${String(logIndex).padStart(2, '0')}`,
  emitter: EM,
  event,
  args,
})
const grant = (block: number, role: string, account: string, logIndex = 0, roleName?: string) =>
  ev(
    block,
    'RoleGranted',
    { role, account, sender: SAFE_ADDR, ...(roleName ? { roleName } : {}) },
    logIndex,
  )
const adminChanged = (block: number, prev: string, next: string) =>
  ev(block, 'RoleAdminChanged', {
    role: ROLE_X,
    roleName: 'OPERATOR_ROLE',
    previousAdminRole: prev,
    newAdminRole: next,
    previousAdminRoleName: NAME[prev],
    newAdminRoleName: NAME[next],
  })
// the deploy-block grants: one holder per admin role (initialization rows)
const initGrants = [
  grant(D, R_SAFE, SAFE_ADDR, 0),
  grant(D, R_EOA, EOA_ADDR, 1),
  grant(D, R_UNK, UNK, 2),
  grant(D, R_LOW, SAFE_LOW_ADDR, 3),
  grant(D, R_TLU, TLU_ADDR, 4),
]
const actx = (ctl: (a: string, b: number) => Controller | null) => ({
  subject: 's2',
  ctl,
  upgradeTimelocks: {},
  upgradeHoldersAt: {},
  deployBlocks: { [EM]: D },
  tokens: [],
  announcement: 'no_gov_channel' as const,
  verified: () => true,
})
const byAddr: Record<string, Controller> = {
  [SAFE_ADDR]: SAFE,
  [SAFE_LOW_ADDR]: SAFE_LOW,
  [EOA_ADDR]: EOA,
  [TLU_ADDR]: TLU,
}
// in block order (the engine lists its changes newest first)
const roleAdminRows = (out: ConfigChange[]) =>
  out
    .filter((c) => c.key.startsWith('admin/role_admin/'))
    .sort((x, y) => (x.block ?? 0) - (y.block ?? 0))

// =====================================================================================================
describe('S2 (a): a new admin side that could not be read is a read gap, never a plain c < 0 red', () => {
  it('replay: R_SAFE → R_EOA, then R_EOA → an admin role whose holder could not be classified — tagged read_gap, the red before it stays in effect (was tagged [], ended)', () => {
    const out = classifyAdminEvents(
      [...initGrants, adminChanged(D + 100, R_SAFE, R_EOA), adminChanged(D + 200, R_EOA, R_UNK)],
      actx((a) => byAddr[a] ?? null),
    )
    markStillInEffect(out)
    const [safeToEoa, toUnk] = roleAdminRows(out)
    expect(safeToEoa.red).toBe(true)
    expect(safeToEoa.ruleIds).toEqual(['AD-3'])
    expect(safeToEoa.tags).toEqual([])
    expect(toUnk.red).toBe(true)
    expect(toUnk.ruleIds).toEqual(['AD-3'])
    expect(toUnk.tags).toEqual(['read_gap'])
    // a move to an admin role whose holder was not read never ends a red
    expect(roleAdminRows(out).map((c) => !!c.stillInEffect)).toEqual([true, true])
  })

  it('replay: Safe 2/6 → Safe 2/9, then → an admin role held by a timelock whose proposers were not read (ranks below) — tagged read_gap, the red before it stays in effect (was tagged [], ended)', () => {
    // the shape: the new side ranks as a plain contract only because its proposers were not read
    expect(compareRank(controllerRank(TLU), controllerRank(SAFE_LOW))).toBeLessThan(0)
    const out = classifyAdminEvents(
      [...initGrants, adminChanged(D + 100, R_SAFE, R_LOW), adminChanged(D + 200, R_LOW, R_TLU)],
      actx((a) => byAddr[a] ?? null),
    )
    markStillInEffect(out)
    const [safeToLow, toTlu] = roleAdminRows(out)
    expect(safeToLow.red).toBe(true)
    expect(safeToLow.tags).toEqual([])
    expect(toTlu.red).toBe(true)
    expect(toTlu.ruleIds).toEqual(['AD-3'])
    expect(toTlu.tags).toEqual(['read_gap'])
    expect(roleAdminRows(out).map((c) => !!c.stillInEffect)).toEqual([true, true])
  })

  it('rules: a new admin holder not classified — red AD-3 tagged read_gap, the note says it could not be classified (was untagged)', () => {
    const v = classifyRoleAdminChange(
      'OPERATOR_ROLE',
      { name: 'SAFE_ADMIN', holders: [SAFE] },
      { name: 'UNK_ADMIN', holders: [null] },
    )
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toEqual(['AD-3'])
    expect(v.tags).toEqual(['read_gap'])
    expect(v.notes.join(' ')).toContain('1 new admin holder(s) could not be classified')
  })

  it('(control) both sides read: Safe → EOA is a plain red AD-3, no read gap', () => {
    const v = classifyRoleAdminChange(
      'OPERATOR_ROLE',
      { name: 'SAFE_ADMIN', holders: [SAFE] },
      { name: 'EOA_ADMIN', holders: [EOA] },
    )
    expect(v.ruleIds).toEqual(['AD-3'])
    expect(v.tags).toEqual([])
  })
})

// ---- engine: the card lists the failed read and traces it to the row ------------------------------
const registry: DvnRegistry = {
  byChain: { 1: {} },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
const subject = (): ConfigSubject => ({
  key: 's2',
  label: 'S2',
  oracleAssetKey: null,
  class: 'lrt',
  contracts: [
    {
      role: 'config',
      dimension: 'admin',
      chainId: 1,
      address: EM,
      label: short(EM),
      deployBlock: D,
    },
  ],
  lzOApps: [],
  ccipPools: [],
  powers: [],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
})
// every deploy-block holder classified at D (the initialization rows rest on no gap)
const atDeploy = Object.fromEntries([SAFE, SAFE_LOW, EOA, TLU].map((c) => [`${c.address}@${D}`, c]))
const rawOf = (
  events: AdminEventRow[],
  controllers: Record<string, Controller>,
  classifyFailed: string[],
): RawSubject => ({
  version: 1,
  subjectKey: 's2',
  head: { block: D + 100_000, ts: 2000 },
  scan: { from: D, to: D + 100_000 },
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
    controllers: { ...atDeploy, [`${UNK}@${D}`]: { kind: 'eoa', address: UNK }, ...controllers },
    classifyFailed,
    powers: [],
    timelockAdmins: [],
    implHistory: {},
    owners: {},
    delegates: {},
    minDelays: {},
    upgradeHoldersAt: {},
  },
  params: { head: {}, transitions: [] },
  queues: { ops: [], safe: [], safeStatus: [] },
  ccip: { pools: [] },
  warnings: [],
})
const build = (raw: RawSubject) =>
  buildSubject(subject(), raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const unclassifiedLine = (a: string, b: number) =>
  `${short(a)} could not be classified at block ${n(b)} (a history row judged on it is fail closed)`
// the holders read at the admin-change blocks (UNK's classification there FAILED)
const readAt = (b: number) =>
  Object.fromEntries([SAFE, EOA, SAFE_LOW].map((c) => [`${c.address}@${b}`, c]))

describe('S2 (a) engine: the admin holder that could not be classified is listed, the red before stays in effect', () => {
  it('R_SAFE → R_EOA, then R_EOA → R_UNK with UNK in classifyFailed: listed at its block and traced to the row (was not listed; the Safe → EOA red ended)', () => {
    const out = build(
      rawOf(
        [...initGrants, adminChanged(D + 100, R_SAFE, R_EOA), adminChanged(D + 200, R_EOA, R_UNK)],
        { ...readAt(D + 100), ...readAt(D + 200) },
        [`${UNK}@${D + 200}`],
      ),
    )
    const rows = roleAdminRows(out.changes)
    expect(rows.map((c) => c.red)).toEqual([true, true])
    expect(rows[1].tags).toContain('read_gap')
    expect(rows.map((c) => !!c.stillInEffect)).toEqual([true, true])
    const gaps = out.state.readGaps ?? []
    expect(gaps).toContain(unclassifiedLine(UNK, D + 200))
    expect(causeListed(rows[1], gaps)).toBe(true)
  })

  it('R_UNK → R_SAFE with the PREVIOUS admin holder in classifyFailed: the listed line is traced to the row by its note (was listed, but no line named this row)', () => {
    const out = build(
      rawOf([...initGrants, adminChanged(D + 100, R_UNK, R_SAFE)], readAt(D + 100), [
        `${UNK}@${D + 100}`,
      ]),
    )
    const [row] = roleAdminRows(out.changes)
    // unchanged verdict: red AD-3 on a read gap (a downgrade cannot be ruled out)
    expect(row.red).toBe(true)
    expect(row.tags).toContain('read_gap')
    const gaps = out.state.readGaps ?? []
    expect(gaps).toContain(unclassifiedLine(UNK, D + 100))
    expect(row.notes?.join(' ')).toContain('1 previous admin holder(s) could not be classified')
    expect(causeListed(row, gaps)).toBe(true)
  })
})

// =====================================================================================================
describe('S2 (b): a privileged grant to an account that could not be classified is a listed read gap', () => {
  it('rules: red AD-4 tagged read_gap (was untagged)', () => {
    const v = classifyRoleGrant('UPGRADER_ROLE', null, [], true)
    expect(v.ruleIds).toEqual(['AD-4'])
    expect(v.tags).toEqual(['read_gap'])
  })

  it('(control) a role that is not privileged: neutral, no read gap — the verdict does not rest on the grantee', () => {
    const v = classifyRoleGrant('PAUSER_ROLE', null, [], true)
    expect(isRed(v)).toBe(false)
    expect(v.tags).toEqual([])
  })

  it('engine: UPGRADER_ROLE granted to an account in classifyFailed, and a Solady RoleSet to another — both red AD-4 on a read gap, each listed at its block and traced to its row (were listed nowhere)', () => {
    const roleSet = roleSetRow(
      ev(D + 2000, 'RoleSet', { holder: UNK2, role: '4', active: true }) as AdminEventRow,
    )
    // abi.mjs rewrites it to an OZ-shaped RoleGranted with no role name (judged privileged)
    expect(roleSet.event).toBe('RoleGranted')
    const out = build(
      rawOf(
        [
          grant(D, ZERO32, SAFE_ADDR, 0, 'DEFAULT_ADMIN_ROLE'),
          grant(D + 1000, UPGRADER, UNK, 0, 'UPGRADER_ROLE'),
          roleSet,
        ],
        {},
        [`${UNK}@${D + 1000}`, `${UNK2}@${D + 2000}`],
      ),
    )
    const gaps = out.state.readGaps ?? []
    for (const [a, b] of [
      [UNK, D + 1000],
      [UNK2, D + 2000],
    ] as const) {
      const row = out.changes.find((c) => c.block === b && c.key.startsWith('admin/role/'))!
      expect(row.red).toBe(true)
      expect(row.ruleIds).toContain('AD-4')
      expect(row.tags).toContain('read_gap')
      expect(row.after).toBe(a)
      expect(gaps).toContain(unclassifiedLine(a, b))
      expect(causeListed(row, gaps)).toBe(true)
    }
  })

  it('queue: a pending grantRole of UPGRADER_ROLE to an account not classified at head — red AD-4 tagged read_gap (was untagged)', () => {
    const ABI = parseAbi(['function grantRole(bytes32 role, address account)'])
    const ctx: EvalCtx = { registry, code: () => true, useDeprecated: false }
    const q: QueueCtx = {
      subject: 's2',
      announcement: 'not_checked',
      eval: ctx,
      block: D + 100_000,
      endpoint: EP,
      routes: {},
      defaults: {},
      libDirection: () => null,
      ctl: () => null,
      ownerOf: () => null,
      delegateOf: () => null,
      implHistory: {},
      minDelayOf: () => 86400,
      roleName: (h) => (h === UPGRADER ? 'UPGRADER_ROLE' : h),
      contracts: [EM],
      oapps: [],
      verified: () => true,
    }
    const [j] = judgeCall(
      {
        target: EM,
        value: '0',
        data: encodeFunctionData({ abi: ABI, functionName: 'grantRole', args: [UPGRADER, UNK] }),
      },
      q,
      { armed: true },
    )
    expect(j.v.ruleIds).toContain('AD-4')
    expect(j.v.tags).toContain('read_gap')
  })
})

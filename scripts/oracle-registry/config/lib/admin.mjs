// Admin-dimension readers: controller classification at a block, power-path resolution, role
// holders, OZ timelock operations (state + execute simulation), CCIP pool head reads.

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
} from 'viem'
import { FN, SAFE_SLOTS, SLOT, fnAbi, roleHash, roleName, word2addr } from './abi.mjs'
import { codeAt, getLogsAdaptive, isRevertError, pool, retry, tryRead } from './rpc.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const isZero = (a) => !a || /^0x0*$/i.test(a)
const SENTINEL = '0x0000000000000000000000000000000000000001'

const MC = [
  ['getThreshold', FN.getThreshold],
  ['getOwners', FN.getOwners],
  ['VERSION', FN.VERSION],
  ['getMinDelay', FN.getMinDelay],
  ['required', FN.required],
  ['delay', FN.delay],
  ['owner', FN.owner],
  ['authority', 'function authority() view returns (address)'],
]

// ---- what the bytecode dispatches (PUSH4 <selector>) ------------------------------------------
// A controller is classified from what its CODE can do, not from what its view functions say
// about themselves: a contract that only answers getMinDelay() = 365 days is not a timelock.

const sel = (sig) => toFunctionSelector(`function ${sig}`).slice(2)
export const dispatches = (code, sig) => !!code && code.toLowerCase().includes('63' + sel(sig))
const TL_COMMON = ['getMinDelay()', 'getTimestamp(bytes32)']
const TL_OZ = [
  'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'execute(address,uint256,bytes,bytes32,bytes32)',
  'hashOperation(address,uint256,bytes,bytes32,bytes32)',
]
// Chainlink ccip-owner-contracts RBACTimelock: Call[] batches only
const TL_RBAC = [
  'scheduleBatch((address,uint256,bytes)[],bytes32,bytes32,uint256)',
  'executeBatch((address,uint256,bytes)[],bytes32,bytes32)',
]
const MS_CODE = [
  'submitTransaction(address,uint256,bytes)',
  'confirmTransaction(uint256)',
  'executeTransaction(uint256)',
]
/** OZ TimelockController (or RBACTimelock) dispatch table present in the code. */
export const isTimelockCode = (code) =>
  TL_COMMON.every((x) => dispatches(code, x)) &&
  (TL_OZ.every((x) => dispatches(code, x)) || TL_RBAC.every((x) => dispatches(code, x)))
export const isLegacyMultisigCode = (code) => MS_CODE.every((x) => dispatches(code, x))

/** Canonical Safe singletons (mastercopies) on Ethereum, v1.0.0 – v1.5.0 incl. L2 / EIP-155. */
export const SAFE_SINGLETONS = new Set(
  [
    '0xb6029EA3B2c51D09a50B53CA8012FeEB05bDa35A',
    '0x34CfAC646f301356fAa8B21e94227e3583Fe3F5F',
    '0x6851D6fDFAfD08c0295C392436245E5bc78B0185',
    '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552',
    '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
    '0x69f4D1788e39c87893C980c06EdF4b7f686e2938',
    '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
    '0x41675C099F32341bf84BFc5382aF534df5C7461a',
    '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
    '0xFf51A5898e281Db6DfC7855790607438dF2ca44b',
    '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
  ].map((a) => a.toLowerCase()),
)

// Timelock bypass paths: a function that executes around the delay.
const BYPASS_ANY = 'bypasserExecuteBatch((address,uint256,bytes)[])'
const BYPASS_WHITELIST = [
  'executeWhitelisted(address,uint256,bytes)',
  'executeWhitelistedBatch(address[],uint256[],bytes[])',
]
const TOPIC_FUNCTION_WHITELISTED = keccak256(toHex('FunctionWhitelisted(address,bytes4)'))
/** Names of selectors a timelock whitelist commonly carries (unknown ones stay hex). */
const KNOWN_SELECTORS = Object.fromEntries(
  [
    'setPeer(uint32,bytes32)',
    'setDelegate(address)',
    'setEnforcedOptions((uint32,uint16,bytes)[])',
    'setMsgInspector(address)',
    'setPreCrime(address)',
    'setRateLimits((uint32,uint256,uint256)[])',
    'setConfig(address,address,(uint32,uint32,bytes)[])',
    'setSendLibrary(address,uint32,address)',
    'setReceiveLibrary(address,uint32,address,uint256)',
    'setReceiveLibraryTimeout(address,uint32,address,uint256)',
    'transferOwnership(address)',
    'upgradeTo(address)',
    'upgradeToAndCall(address,bytes)',
    'grantRole(bytes32,address)',
    'revokeRole(bytes32,address)',
    'setMaxMintPerBlock(uint256)',
    'setMaxRedeemPerBlock(uint256)',
    'setGlobalMaxMintPerBlock(uint128)',
    'setGlobalMaxRedeemPerBlock(uint128)',
    'pause()',
    'unpause()',
  ].map((f) => ['0x' + sel(f), f]),
)
const wlLogs = new Map() // timelock → Promise<{ target, selector, block }[] | null>
const deployOf = new Map() // address → Promise<number>

async function firstCodeBlock(client, a) {
  if (!deployOf.has(a))
    deployOf.set(
      a,
      (async () => {
        const head = Number(await retry(() => client.getBlockNumber()))
        let lo = 0
        let hi = head
        while (hi - lo > 1) {
          const m = Math.floor((lo + hi) / 2)
          if (await codeAt(client, a, m)) hi = m
          else lo = m
        }
        return hi
      })(),
    )
  return deployOf.get(a)
}

/** FunctionWhitelisted(target, selector) logs of a timelock (null when they could not be read). */
async function whitelistLogs(client, a) {
  if (!wlLogs.has(a))
    wlLogs.set(
      a,
      (async () => {
        try {
          const from = await firstCodeBlock(client, a)
          const head = Number(await retry(() => client.getBlockNumber()))
          const out = []
          for (let b = from; b <= head; b += 1_000_000) {
            const logs = await getLogsAdaptive(client, {
              address: a,
              topics0: [TOPIC_FUNCTION_WHITELISTED],
              fromBlock: b,
              toBlock: Math.min(head, b + 999_999),
            })
            for (const l of logs)
              out.push({
                target: ('0x' + l.topics[1].slice(-40)).toLowerCase(),
                selector: l.topics[2].slice(0, 10).toLowerCase(),
                block: Number(l.blockNumber),
              })
          }
          return out
        } catch {
          return null
        }
      })(),
    )
  return wlLogs.get(a)
}

/**
 * The bypass path of a timelock at `block`, read from its code and state:
 *   bypasserExecuteBatch (RBACTimelock) — unrestricted, held by BYPASSER_ROLE members;
 *   executeWhitelisted (Ethena)         — the (target, selector) pairs whitelisted right now.
 * A bypass that cannot be enumerated is reported as unrestricted (fail closed).
 */
export async function timelockBypass(client, a, code, block) {
  if (dispatches(code, BYPASS_ANY)) {
    const r = await tryRead(
      client,
      a,
      fnAbi('function BYPASSER_ROLE() view returns (bytes32)'),
      'BYPASSER_ROLE',
      [],
      block,
    )
    const role = r.ok ? r.value : keccak256(toHex('BYPASSER_ROLE'))
    const n = await tryRead(
      client,
      a,
      fnAbi('function getRoleMemberCount(bytes32) view returns (uint256)'),
      'getRoleMemberCount',
      [role],
      block,
    )
    if (n.ok && Number(n.value) === 0) return undefined
    const holders = []
    for (let i = 0; n.ok && i < Math.min(Number(n.value), 10); i++) {
      const m = await tryRead(
        client,
        a,
        fnAbi('function getRoleMember(bytes32,uint256) view returns (address)'),
        'getRoleMember',
        [role, BigInt(i)],
        block,
      )
      if (m.ok) holders.push(m.value.toLowerCase())
    }
    return { fn: 'bypasserExecuteBatch', scope: 'any', holders }
  }
  if (BYPASS_WHITELIST.some((x) => dispatches(code, x))) {
    const logs = await whitelistLogs(client, a)
    // The whitelist could not be read: for THIS run the timelock is ranked as a plain contract
    // with no delay (an unrestricted bypass) — owner ruling 2026-10-06; `unread` says why.
    if (!logs) return { fn: 'executeWhitelisted', scope: 'any', unread: true }
    const seen = new Set()
    const targets = {}
    for (const l of logs) {
      if (block !== undefined && l.block > block) continue
      const k = `${l.target}|${l.selector}`
      if (seen.has(k)) continue
      seen.add(k)
      const on = await tryRead(
        client,
        a,
        fnAbi('function isWhitelisted(address,bytes4) view returns (bool)'),
        'isWhitelisted',
        [l.target, l.selector],
        block,
      )
      if (on.ok && !on.value)
        continue // removed since (a failed read keeps it: fail closed)
      ;(targets[l.target] ??= []).push(KNOWN_SELECTORS[l.selector] ?? l.selector)
    }
    return Object.keys(targets).length
      ? { fn: 'executeWhitelisted', scope: 'whitelist', targets }
      : undefined
  }
  return undefined
}

/**
 * Classify `address` at `block` (or head when block is undefined) into a Controller
 * (lib/oracleRegistry/config/types.ts). `depth` bounds the owner() recursion of plain contracts
 * (ProxyAdmin → timelock, WBTC Controller → multisig).
 *
 * A Safe needs a canonical singleton in storage slot 0 (read with eth_getStorageAt: a contract
 * cannot fake its own storage through a view); a timelock / legacy multisig needs the matching
 * dispatch table in its bytecode. Anything else is a plain contract.
 */
export async function classify(client, address, block, depth = 0, seen = new Set()) {
  const a = address.toLowerCase()
  if (isZero(a)) return { kind: 'zero', address: a }
  if (BigInt(a) <= 0x1ffn) return { kind: 'precompile', address: a }
  const code = await codeAt(client, a, block)
  if (!code) return { kind: 'eoa', address: a }
  if (code.startsWith('0xef0100')) return { kind: 'eoa_7702', address: a }
  const res = await retry(() =>
    client.multicall({
      contracts: MC.map(([fn, sig]) => ({ address: a, abi: fnAbi(sig), functionName: fn })),
      allowFailure: true,
      blockNumber: block === undefined ? undefined : BigInt(block),
    }),
  )
  const r = Object.fromEntries(
    MC.map(([fn], i) => [fn, res[i].status === 'success' ? res[i].result : undefined]),
  )
  const storage = async (slot) =>
    word2addr(
      await retry(() =>
        client.getStorageAt({
          address: a,
          slot: toHex(slot, { size: 32 }),
          blockNumber: block === undefined ? undefined : BigInt(block),
        }),
      ),
    )
  // multisig-shaped views behind a non-canonical singleton / without the dispatch table: kept
  // as information (history can still replay the threshold), ranked as a plain contract
  let multisigLike
  if (r.getThreshold !== undefined && Array.isArray(r.getOwners)) {
    const singleton = await storage(SAFE_SLOTS.singleton)
    if (singleton && SAFE_SINGLETONS.has(singleton)) {
      const c = {
        kind: 'safe',
        address: a,
        threshold: Number(r.getThreshold),
        signers: r.getOwners.length,
        // the owner SET (review round 6): a delegatecall can swap owners at the same count
        owners: r.getOwners.map((o) => String(o).toLowerCase()),
        version: r.VERSION ?? undefined,
      }
      const mods = await tryRead(
        client,
        a,
        fnAbi(FN.getModulesPaginated),
        'getModulesPaginated',
        [SENTINEL, 20n],
        block,
      )
      c.modules = mods.ok ? mods.value[0].map((m) => m.toLowerCase()) : []
      c.guard = await storage(SAFE_SLOTS.guard)
      c.moduleGuard = await storage(SAFE_SLOTS.moduleGuard)
      c.fallbackHandler = await storage(SAFE_SLOTS.fallbackHandler)
      c.singleton = singleton
      return c
    }
    // keep slot 0: a Safe whose singleton was swapped to a non-canonical one is still tracked
    // run to run (AD-6 singleton), even though it now ranks as a plain contract
    multisigLike = {
      threshold: Number(r.getThreshold),
      signers: r.getOwners.length,
      version: `not a canonical Safe (singleton ${singleton ?? 'none'})`,
      ...(singleton ? { singleton } : {}),
    }
  }
  if (isDgTimelockCode(code)) return classifyDgTimelock(client, a, block)
  const voting = await aragonVotingOf(client, a, code, block)
  if (voting) return voting
  const agent = await aragonAgentOf(client, a, code, block, depth, seen)
  if (agent) return agent
  if (r.getMinDelay !== undefined && isTimelockCode(code)) {
    const c = { kind: 'oz_timelock', address: a, delaySec: Number(r.getMinDelay) }
    const bypass = await timelockBypass(client, a, code, block)
    if (bypass) c.bypass = bypass
    return c
  }
  if (r.required !== undefined && Array.isArray(r.getOwners)) {
    if (isLegacyMultisigCode(code))
      return {
        kind: 'legacy_multisig',
        address: a,
        threshold: Number(r.required),
        signers: r.getOwners.length,
        owners: r.getOwners.map((o) => String(o).toLowerCase()),
      }
    multisigLike ??= {
      threshold: Number(r.required),
      signers: r.getOwners.length,
      version: 'multisig views without a MultiSigWallet dispatch table',
    }
  }
  if (r.delay !== undefined && r.authority !== undefined)
    return { kind: 'ds_pause', address: a, delaySec: Number(r.delay) }
  const c = { kind: 'contract', address: a, ...(multisigLike ?? {}) }
  if (r.owner && depth < 2 && !isZero(r.owner) && r.owner.toLowerCase() !== a)
    c.ownedBy = await classify(client, r.owner, block, depth + 1)
  return c
}

/** Roles on a declared timelock whose holders belong to the subject's scope (their events too). */
export const TIMELOCK_SCOPE_ROLES = [
  'PROPOSER_ROLE',
  'EXECUTOR_ROLE',
  'CANCELLER_ROLE',
  'TIMELOCK_ADMIN_ROLE',
  'DEFAULT_ADMIN_ROLE',
]

/**
 * Accounts outside the subject's declared contracts whose OWN events belong on its card: every
 * power holder, and every holder of a proposer / executor / canceller / admin role on one of its
 * declared timelocks (review round 6: those Safes were scanned, then dropped by the per-subject
 * filter — weETH's 10-day timelock proposer Safe lost three red AD-1 rows).
 *   subject  { timelocks }       powers  [{ holders }]
 *   roleMap  Map(`${timelock}|${roleHash}` → Set(holder))
 */
export function subjectExtraEmitters(subject, powers, roleMap, hashOf = roleHash) {
  const out = new Set()
  for (const p of powers ?? []) for (const h of p.holders ?? []) out.add(String(h).toLowerCase())
  for (const t of subject.timelocks ?? [])
    for (const role of TIMELOCK_SCOPE_ROLES)
      for (const h of roleMap.get(`${t}|${hashOf(role)}`) ?? []) out.add(String(h).toLowerCase())
  return out
}

/** Role holders per (emitter, role) replayed from RoleGranted / RoleRevoked rows. */
export function roleHoldersFromEvents(rows) {
  const m = new Map()
  for (const r of rows) {
    if (r.event !== 'RoleGranted' && r.event !== 'RoleRevoked') continue
    const k = `${r.emitter}|${String(r.args.role).toLowerCase()}`
    const s = m.get(k) ?? new Set()
    if (r.event === 'RoleGranted') s.add(String(r.args.account).toLowerCase())
    else s.delete(String(r.args.account).toLowerCase())
    m.set(k, s)
  }
  return m
}

async function holdersOf(client, contract, role, roleMap, block) {
  const cands = [...(roleMap.get(`${contract}|${role}`) ?? [])]
  const out = []
  for (const h of cands) {
    const x = await tryRead(client, contract, fnAbi(FN.hasRole), 'hasRole', [role, h], block)
    // an Aragon app has no hasRole: its permissions live in the DAO's ACL (fail closed: a
    // holder whose permission cannot be read is kept)
    if (!x.ok && x.reverted) {
      const acl = await aclOf(client, contract, block)
      if (acl) {
        const p = await tryRead(
          client,
          acl,
          fnAbi(FN.aclHasPermission),
          'hasPermission',
          [h, contract, role],
          block,
        )
        if (!p.ok || p.value) out.push(h)
        continue
      }
    }
    if (!x.ok || x.value) out.push(h)
  }
  // AccessControlEnumerable: the members the contract lists itself (a grant older than the
  // event scan floor — Lido's 2023 oracle contracts — has no event to replay)
  const n = await tryRead(client, contract, fnAbi(FN.getRoleMemberCount), 'getRoleMemberCount', [role], block)
  if (n.ok)
    for (let i = 0; i < Math.min(Number(n.value), 50); i++) {
      const m = await tryRead(client, contract, fnAbi(FN.getRoleMember), 'getRoleMember', [role, BigInt(i)], block)
      if (m.ok && !out.includes(m.value.toLowerCase())) out.push(m.value.toLowerCase())
    }
  return out
}

// ---- Aragon (Lido DAO) ----------------------------------------------------------------------------

const aclMemo = new Map() // `${address}@${block}` → Promise<acl | null>

/**
 * The Aragon ACL that governs `a`: the Kernel answers acl(); an app answers kernel() and its
 * Kernel answers acl(). null = not an Aragon app (or the reads failed).
 */
export async function aclOf(client, a, block) {
  const k = `${a}@${block ?? 'head'}`
  if (!aclMemo.has(k))
    aclMemo.set(
      k,
      (async () => {
        const direct = await tryRead(client, a, fnAbi(FN.acl), 'acl', [], block)
        if (direct.ok && !isZero(direct.value)) return direct.value.toLowerCase()
        const kern = await tryRead(client, a, fnAbi(FN.kernel), 'kernel', [], block)
        if (!kern.ok || isZero(kern.value)) return null
        const acl = await tryRead(client, kern.value, fnAbi(FN.acl), 'acl', [], block)
        return acl.ok && !isZero(acl.value) ? acl.value.toLowerCase() : null
      })(),
    )
  return aclMemo.get(k)
}

/**
 * Aragon Agent powers: whoever holds one can make the Agent call anything (SAFE_EXECUTE: anything
 * but moving its protected tokens).
 */
export const ARAGON_EXEC_ROLES = ['RUN_SCRIPT_ROLE', 'EXECUTE_ROLE', 'SAFE_EXECUTE_ROLE']

// Every account the ACL events ever granted an Agent's execution roles to, per Agent (set by the
// collector from the full ACL replay): the ACL cannot enumerate holders, so the Agent's executor
// at a block is the candidate whose permission hasPermission confirms at that block.
const aragonExec = new Map()
export function setAragonExecCandidates(map) {
  aragonExec.clear()
  for (const [agent, cands] of map)
    aragonExec.set(String(agent).toLowerCase(), new Set([...cands].map((x) => String(x).toLowerCase())))
}

/** Aragon executor candidates per Agent from replayed (ACL-rewritten) role rows. */
export function aragonExecCandidatesFromRows(rows) {
  const m = new Map()
  const want = new Set(ARAGON_EXEC_ROLES.map((r) => roleHash(r)))
  for (const r of rows)
    if (r.event === 'RoleGranted' && r.args?.via === 'ACL' && want.has(String(r.args.role).toLowerCase())) {
      const s = m.get(r.emitter) ?? new Set()
      s.add(String(r.args.account).toLowerCase())
      m.set(r.emitter, s)
    }
  return m
}

/** Resolve a PowerSpec path to holder addresses at head. */
export async function resolvePath(client, { endpoint, contract, path, roleMap, block }) {
  let cur = [contract.toLowerCase()]
  for (const step of path) {
    const next = []
    for (const c of cur) {
      if (step === 'owner') {
        const x = await tryRead(client, c, fnAbi(FN.owner), 'owner', [], block)
        if (x.ok) next.push(x.value.toLowerCase())
      } else if (step === 'eip1967_admin' || step === 'zos_admin') {
        const w = await retry(() =>
          client.getStorageAt({
            address: c,
            slot: step === 'eip1967_admin' ? SLOT.eip1967Admin : SLOT.zosAdmin,
            blockNumber: block === undefined ? undefined : BigInt(block),
          }),
        )
        const a = word2addr(w)
        if (a && !isZero(a)) next.push(a)
      } else if (step === 'lz_delegate') {
        const x = await tryRead(client, endpoint, fnAbi(FN.delegates), 'delegates', [c], block)
        if (x.ok) next.push(x.value.toLowerCase())
      } else if (step.startsWith('call:')) {
        const fn = step.slice(5).replace('()', '')
        const x = await tryRead(
          client,
          c,
          fnAbi(`function ${fn}() view returns (address)`),
          fn,
          [],
          block,
        )
        if (x.ok) next.push(x.value.toLowerCase())
      } else if (step.startsWith('role:')) {
        next.push(...(await holdersOf(client, c, roleHash(step.slice(5)), roleMap, block)))
      } else if (step.startsWith('acl_manager:')) {
        // Aragon: the permission MANAGER of (c, ROLE) — it can grant itself the role at will
        // (Lido revokes APP_MANAGER_ROLE between upgrades; its manager is the standing power)
        const acl = await aclOf(client, c, block)
        if (acl) {
          const x = await tryRead(
            client,
            acl,
            fnAbi(FN.getPermissionManager),
            'getPermissionManager',
            [c, roleHash(step.slice(12))],
            block,
          )
          if (x.ok && !isZero(x.value)) next.push(x.value.toLowerCase())
        }
      } else if (step.startsWith('role_admin:')) {
        const x = await tryRead(client, c, fnAbi(FN.getRoleAdmin), 'getRoleAdmin', [
          roleHash(step.slice(11)),
        ])
        if (x.ok) next.push(...(await holdersOf(client, c, x.value.toLowerCase(), roleMap)))
      }
    }
    cur = [...new Set(next)]
  }
  return cur
}

// ---- OZ timelock operations ----------------------------------------------------------------------

const TL_ABI = {
  execute: fnAbi(
    'function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable',
  ),
  executeBatch: fnAbi(
    'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable',
  ),
  hashOperation: fnAbi(
    'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns (bytes32)',
  ),
  hashOperationBatch: fnAbi(
    'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns (bytes32)',
  ),
}

/** Group CallScheduled / CallSalt rows of one timelock into operations. */
export function opsFromEvents(rows, timelock) {
  const t = timelock.toLowerCase()
  const ops = new Map()
  for (const r of rows) {
    if (r.emitter !== t) continue
    if (r.event === 'CallScheduled') {
      const id = String(r.args.id).toLowerCase()
      const op = ops.get(id) ?? {
        timelock: t,
        id,
        calls: [],
        predecessor: r.args.predecessor,
        delaySec: Number(r.args.delay),
        scheduledBlock: r.block,
        scheduledTs: r.ts,
        scheduledTx: r.tx,
        salt: null,
      }
      op.calls[Number(r.args.index)] = {
        target: String(r.args.target).toLowerCase(),
        value: String(r.args.value),
        data: r.args.data,
      }
      ops.set(id, op)
    } else if (r.event === 'CallSalt') {
      const id = String(r.args.id).toLowerCase()
      if (ops.has(id)) ops.get(id).salt = r.args.salt
      else ops.set(id, { timelock: t, id, calls: [], salt: r.args.salt })
    }
  }
  return [...ops.values()].filter((o) => o.calls.length)
}

const SCHEDULE_ABI = parseAbi([
  'function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
])
const SCHEDULE_SELECTORS = [
  toFunctionSelector('function schedule(address,uint256,bytes,bytes32,bytes32,uint256)').slice(2),
  toFunctionSelector(
    'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  ).slice(2),
]
const ZERO32 = '0x' + '0'.repeat(64)

/** OZ TimelockController.hashOperation / hashOperationBatch, computed locally. */
export function hashOp(op, salt, batch) {
  const pred = op.predecessor ?? ZERO32
  if (batch)
    return keccak256(
      encodeAbiParameters(parseAbiParameters('address[], uint256[], bytes[], bytes32, bytes32'), [
        op.calls.map((c) => c.target),
        op.calls.map((c) => BigInt(c.value)),
        op.calls.map((c) => c.data),
        pred,
        salt,
      ]),
    ).toLowerCase()
  const c = op.calls[0]
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, bytes, bytes32, bytes32'), [
      c.target,
      BigInt(c.value),
      c.data,
      pred,
      salt,
    ]),
  ).toLowerCase()
}

/**
 * Recover an op's salt (and whether it was a batch) from the calldata of the transaction that
 * scheduled it. OZ timelocks before 4.9 emit no CallSalt, so the id cannot be reproduced from
 * the events alone. The schedule / scheduleBatch call sits verbatim inside the input whatever
 * wrapped it (a Safe execTransaction, a MultiSend): every occurrence of the two selectors is
 * decoded, then every 32-byte word is tried; a candidate counts only when it reproduces the id.
 */
export function recoverSalt(input, op) {
  const hex = String(input ?? '')
    .toLowerCase()
    .replace(/^0x/, '')
  const cands = new Set([ZERO32])
  const starts = []
  for (const s of SCHEDULE_SELECTORS)
    for (let i = hex.indexOf(s); i >= 0; i = hex.indexOf(s, i + 1)) {
      if (i % 2) continue
      starts.push(i)
      try {
        const d = decodeFunctionData({ abi: SCHEDULE_ABI, data: '0x' + hex.slice(i) })
        cands.add(String(d.args[4]).toLowerCase())
      } catch {
        /* not a call here */
      }
    }
  for (const st of [0, ...starts])
    for (let i = st + 8; i + 64 <= hex.length; i += 64) cands.add('0x' + hex.slice(i, i + 64))
  const shapes = op.calls.length === 1 ? [false, true] : [true]
  for (const salt of cands)
    for (const batch of shapes) if (hashOp(op, salt, batch) === op.id) return { salt, batch }
  return null
}

/**
 * Head status of operations: getTimestamp, predecessor, and an execute simulation for ready
 * ones. Reads fail CLOSED: a getTimestamp that cannot be read is `null` (never "cancelled"), a
 * predecessor that cannot be read is `null`, and a simulation that could not be built or whose
 * RPC failed (not a revert) is 'not_run' / 'error' — the engine then treats the op as possibly
 * executable instead of stale.
 */
export async function readOps(client, ops, { now, executorsOf }) {
  await pool(ops, 4, async (op) => {
    const ts = await tryRead(client, op.timelock, fnAbi(FN.getTimestamp), 'getTimestamp', [op.id])
    op.timestamp = ts.ok ? Number(ts.value) : null
    const zero = /^0x0*$/i.test(op.predecessor ?? '0x0')
    if (zero) op.predecessorDone = true
    else {
      const d = await tryRead(client, op.timelock, fnAbi(FN.isOperationDone), 'isOperationDone', [
        op.predecessor,
      ])
      op.predecessorDone = d.ok ? !!d.value : null
    }
    op.simulation = 'not_run'
    if (op.timestamp !== null && op.timestamp > 1 && op.timestamp <= now && op.predecessorDone) {
      let found = null
      if (op.salt) {
        const salt = String(op.salt).toLowerCase()
        for (const batch of op.calls.length === 1 ? [false, true] : [true])
          if (!found && hashOp(op, salt, batch) === op.id) found = { salt, batch }
      }
      if (!found && op.scheduledTx) {
        try {
          const tx = await retry(() => client.getTransaction({ hash: op.scheduledTx }))
          found = recoverSalt(tx?.input, op)
        } catch {
          /* the simulation stays not_run */
        }
      }
      if (found) {
        const args = found.batch
          ? [
              op.calls.map((c) => c.target),
              op.calls.map((c) => BigInt(c.value)),
              op.calls.map((c) => c.data),
              op.predecessor,
              found.salt,
            ]
          : [
              op.calls[0].target,
              BigInt(op.calls[0].value),
              op.calls[0].data,
              op.predecessor,
              found.salt,
            ]
        const value = op.calls.reduce((s, c) => s + BigInt(c.value), 0n)
        const data = encodeFunctionData({
          abi: found.batch ? TL_ABI.executeBatch : TL_ABI.execute,
          functionName: found.batch ? 'executeBatch' : 'execute',
          args,
        })
        // Any executor that can run it makes it armed; every executor reverting makes it stale.
        let result = 'revert'
        for (const from of await executorsOf(op.timelock)) {
          try {
            await client.call({ account: from, to: op.timelock, data, value })
            result = 'ok'
            break
          } catch (e) {
            if (!isRevertError(e)) result = 'error'
          }
        }
        op.simulation = result
      }
    }
    delete op.salt
  })
  return ops
}

// ---- CCIP ----------------------------------------------------------------------------------------

export async function readCcipPool(client, poolAddr) {
  const p = poolAddr.toLowerCase()
  const owner = await tryRead(client, p, fnAbi(FN.owner), 'owner')
  const reb = await tryRead(client, p, fnAbi(FN.getRebalancer), 'getRebalancer')
  const chains = await tryRead(client, p, fnAbi(FN.getSupportedChains), 'getSupportedChains')
  const out = {
    pool: p,
    owner: owner.ok ? owner.value.toLowerCase() : null,
    rebalancer: reb.ok ? reb.value.toLowerCase() : null,
    chains: [],
  }
  for (const sel of chains.ok ? chains.value : []) {
    const i = await tryRead(
      client,
      p,
      fnAbi(FN.getCurrentInboundRateLimiterState),
      'getCurrentInboundRateLimiterState',
      [sel],
    )
    const o = await tryRead(
      client,
      p,
      fnAbi(FN.getCurrentOutboundRateLimiterState),
      'getCurrentOutboundRateLimiterState',
      [sel],
    )
    // remote pools the chain accepts now (1.5.1: several; 1.5.0: one) — a second one for an
    // already-served chain is red (CC-1); null = could not be read (fail closed downstream)
    let remotePools = null
    const many = await tryRead(client, p, fnAbi(FN.getRemotePools), 'getRemotePools', [sel])
    if (many.ok) remotePools = many.value.map((x) => String(x).toLowerCase())
    else if (many.reverted) {
      const one = await tryRead(client, p, fnAbi(FN.getRemotePool), 'getRemotePool', [sel])
      if (one.ok) remotePools = /^0x0*$/.test(one.value) ? [] : [String(one.value).toLowerCase()]
    }
    // CCIP 1.6 SiloedLockReleaseTokenPool (review round 5): a siloed chain has its own
    // rebalancer (getChainRebalancer); getRebalancer() is only the unsiloed chains' one. A pool
    // without isSiloed (reverts) is not a siloed pool; a failed read stays null (not read).
    const sil = await tryRead(client, p, fnAbi(FN.isSiloed), 'isSiloed', [sel])
    const siloed = sil.ok ? !!sil.value : sil.reverted ? false : null
    let rebalancer = null
    if (siloed) {
      const cr = await tryRead(client, p, fnAbi(FN.getChainRebalancer), 'getChainRebalancer', [sel])
      rebalancer = cr.ok ? String(cr.value).toLowerCase() : null
    }
    out.chains.push({
      selector: String(sel),
      inboundEnabled: i.ok ? i.value.isEnabled : null,
      outboundEnabled: o.ok ? o.value.isEnabled : null,
      remotePools,
      siloed,
      rebalancer,
    })
  }
  return out
}

// ---- Lido Dual Governance (EmergencyProtectedTimelock) ---------------------------------------------

const DG_CODE = [
  'getAfterSubmitDelay()',
  'getAfterScheduleDelay()',
  'getGovernance()',
  'getProposal(uint256)',
  'execute(uint256)',
]
/** Lido Dual Governance EmergencyProtectedTimelock dispatch table present in the code. */
export const isDgTimelockCode = (code) => DG_CODE.every((x) => dispatches(code, x))

/**
 * A Dual Governance timelock as a Controller (kind 'aragon_dg'). Its delay is the SHORTEST path
 * to execution: the proposers' vote (Aragon Voting's voteTime, when every proposer is one) plus
 * the after-submit delay — the emergency execution committee, in emergency mode, executes a
 * scheduled proposal without the after-schedule delay, which is kept apart for display. An
 * unread after-submit delay is 0 (fail closed: the timelock then ranks as a plain contract).
 */
export async function classifyDgTimelock(client, a, block) {
  const rd = async (sig, to = a) => {
    const fn = sig.match(/function (\w+)/)[1]
    const x = await tryRead(client, to, fnAbi(sig), fn, [], block)
    return x.ok ? x.value : null
  }
  const submit = await rd('function getAfterSubmitDelay() view returns (uint32)')
  const schedule = await rd('function getAfterScheduleDelay() view returns (uint32)')
  const em = await rd(
    'function getEmergencyProtectionDetails() view returns ((uint32 emergencyModeDuration, uint40 emergencyModeEndsAfter, uint40 emergencyProtectionEndsAfter))',
  )
  const addr = async (fn) => {
    const v = await rd(`function ${fn}() view returns (address)`)
    return v ? String(v).toLowerCase() : null
  }
  // Who can submit: every proposer of the governance contract. When each one is an Aragon
  // Voting app, a proposal exists only after a vote of at least its voteTime — the shortest
  // path to execution adds the shortest such vote. Any other proposer (an EOA, a Safe, a
  // TimelockedGovernance after an emergency reset) or an unread list adds nothing (fail closed).
  const governance = await addr('getGovernance')
  let proposerVoteSec = 0
  const proposers = []
  if (governance) {
    const ps = await rd(
      'function getProposers() view returns ((address account, address executor)[])',
      governance,
    )
    const votes = []
    for (const p of ps ?? []) {
      const acct = String(p.account).toLowerCase()
      const v = await aragonVotingOf(client, acct, await codeAt(client, acct, block), block)
      proposers.push(acct)
      votes.push(v ? v.delaySec : 0)
    }
    if (votes.length) proposerVoteSec = Math.min(...votes)
  }
  return {
    kind: 'aragon_dg',
    address: a,
    delaySec: submit === null ? 0 : Number(submit) + proposerVoteSec,
    dg: {
      proposers,
      proposerVoteSec,
      afterSubmitDelaySec: submit === null ? null : Number(submit),
      afterScheduleDelaySec: schedule === null ? null : Number(schedule),
      governance,
      adminExecutor: await addr('getAdminExecutor'),
      emergencyGovernance: await addr('getEmergencyGovernance'),
      activationCommittee: await addr('getEmergencyActivationCommittee'),
      executionCommittee: await addr('getEmergencyExecutionCommittee'),
      emergencyModeActive: (await rd('function isEmergencyModeActive() view returns (bool)')) ?? null,
      emergencyProtectionEndsAfter: em ? Number(em.emergencyProtectionEndsAfter) : null,
    },
  }
}

// An Aragon app is an AppProxy: the dispatch table that says what it can do lives in the
// implementation the Kernel serves for its appId (implementation(), read through the proxy code).
const ARAGON_PROXY_CODE = ['implementation()', 'kernel()', 'appId()']
const ARAGON_VOTING_CODE = ['voteTime()', 'executeVote(uint256)', 'getVote(uint256)']
export const isAragonAppProxyCode = (code) => ARAGON_PROXY_CODE.every((x) => dispatches(code, x))

/**
 * An Aragon Voting app (Lido's LDO vote) as a Controller: kind 'aragon_voting', delay = the vote
 * duration (a vote is on-chain from StartVote and executes no earlier than voteTime later).
 * undefined = not an Aragon Voting app. A vote time that cannot be read is 0 (fail closed).
 */
export async function aragonVotingOf(client, a, code, block) {
  if (!isAragonAppProxyCode(code)) return undefined
  const impl = await tryRead(client, a, fnAbi('function implementation() view returns (address)'), 'implementation', [], block)
  if (!impl.ok || isZero(impl.value)) return undefined
  const implCode = await codeAt(client, impl.value.toLowerCase(), block)
  if (!ARAGON_VOTING_CODE.every((x) => dispatches(implCode, x))) return undefined
  const vt = await tryRead(client, a, fnAbi('function voteTime() view returns (uint64)'), 'voteTime', [], block)
  const op = await tryRead(client, a, fnAbi('function objectionPhaseTime() view returns (uint64)'), 'objectionPhaseTime', [], block)
  return {
    kind: 'aragon_voting',
    address: a,
    delaySec: vt.ok ? Number(vt.value) : 0,
    voting: {
      voteTimeSec: vt.ok ? Number(vt.value) : null,
      objectionPhaseSec: op.ok ? Number(op.value) : null,
    },
  }
}

const ARAGON_AGENT_CODE = ['forward(bytes)', 'execute(address,uint256,bytes)']

/**
 * An Aragon Agent (Lido's treasury and the owner / admin of most Lido contracts) as a Controller:
 * a contract that acts only for the accounts holding its RUN_SCRIPT / EXECUTE / SAFE_EXECUTE
 * permission at `block` (`executors`; the single one is also `ownedBy`, the deferral chain). The
 * ACL cannot list holders: the candidates come from the ACL events (setAragonExecCandidates,
 * replayed from the ACL's deployment) and hasPermission decides at the block; a permission that
 * cannot be read keeps the candidate (fail closed). The rules rank the Agent as its WEAKEST
 * executor. No executor found ranks it as a plain contract and says so. undefined = not an
 * Aragon Agent.
 */
export async function aragonAgentOf(client, a, code, block, depth = 0, seen = new Set()) {
  if (!isAragonAppProxyCode(code)) return undefined
  const impl = await tryRead(client, a, fnAbi('function implementation() view returns (address)'), 'implementation', [], block)
  if (!impl.ok || isZero(impl.value)) return undefined
  const implCode = await codeAt(client, impl.value.toLowerCase(), block)
  if (!ARAGON_AGENT_CODE.every((x) => dispatches(implCode, x))) return undefined
  const acl = await aclOf(client, a, block)
  const holders = []
  for (const cand of aragonExec.get(a) ?? []) {
    let held = false
    for (const role of ARAGON_EXEC_ROLES) {
      const x = acl
        ? await tryRead(client, acl, fnAbi(FN.aclHasPermission), 'hasPermission', [cand, a, roleHash(role)], block)
        : { ok: false }
      if (!x.ok || x.value) held = true
    }
    if (held) holders.push(cand)
  }
  const c = { kind: 'contract', address: a, version: 'Aragon Agent' }
  // the executors are the Agent's controllers: they do not use up the owner-recursion depth
  const executors = []
  for (const h of holders)
    if (!seen.has(h)) executors.push(await classify(client, h, block, depth, new Set([...seen, a])))
  if (executors.length) c.executors = executors
  if (executors.length === 1) c.ownedBy = executors[0]
  else if (!executors.length) c.version = 'Aragon Agent: no executor found — ranked as a plain contract'
  return c
}

const DG_ABI = {
  getProposalsCount: fnAbi('function getProposalsCount() view returns (uint256)'),
  getProposal: fnAbi(
    'function getProposal(uint256) view returns ((uint256 id, address executor, uint256 submittedAt, uint256 scheduledAt, uint8 status) proposalDetails, (address target, uint96 value, bytes payload)[] calls)',
  ),
  execute: fnAbi('function execute(uint256 proposalId)'),
}
/** ExecutableProposals.Status */
export const DG_STATUS = ['not_exist', 'submitted', 'scheduled', 'executed', 'cancelled']

/**
 * One EmergencyProtectedTimelock proposal → a TimelockOp the queue judges (pure):
 *   executed → timestamp 1, cancelled → 0 (skipped downstream);
 *   submitted → ETA = submittedAt + after-submit + after-schedule delay, never earlier than
 *     now + after-schedule (it must still be scheduled, then wait): pending, never armed;
 *   scheduled → ETA = scheduledAt + after-schedule delay; past it, the execute simulation says
 *     armed (anyone can execute) or stale.
 * A delay that could not be read leaves the ETA unread (null): judged as armed (fail closed).
 */
export function dgProposalOp(ept, p, { now, afterSubmitDelaySec, afterScheduleDelaySec }) {
  const status = DG_STATUS[Number(p.status)] ?? 'unknown'
  const sub = Number(p.submittedAt)
  const sch = Number(p.scheduledAt)
  const delays = afterSubmitDelaySec !== null && afterScheduleDelaySec !== null
  let timestamp = null
  if (status === 'executed') timestamp = 1
  else if (status === 'cancelled' || status === 'not_exist') timestamp = 0
  else if (status === 'submitted' && delays)
    timestamp = Math.max(sub + afterSubmitDelaySec + afterScheduleDelaySec, now + afterScheduleDelaySec)
  else if (status === 'scheduled' && afterScheduleDelaySec !== null)
    timestamp = sch + afterScheduleDelaySec
  return {
    kind: 'dg',
    timelock: ept.toLowerCase(),
    id: String(p.id),
    status,
    executor: String(p.executor).toLowerCase(),
    calls: p.calls.map((c) => ({
      target: String(c.target).toLowerCase(),
      value: String(c.value),
      data: c.payload,
    })),
    predecessor: '0x' + '0'.repeat(64),
    delaySec: (afterSubmitDelaySec ?? 0) + (afterScheduleDelaySec ?? 0),
    scheduledTs: sub || undefined,
    timestamp,
    predecessorDone: true,
    simulation: 'not_run',
  }
}

/**
 * Every proposal of a Dual Governance timelock that is not executed or cancelled (the newest
 * `max`, oldest first), as TimelockOps. Returns { status: 'ok', ops } or { status:
 * 'unavailable', note } — never a silent empty queue.
 */
export async function readDgProposals(client, ept, { now, max = 200 } = {}) {
  const a = ept.toLowerCase()
  const n = await tryRead(client, a, DG_ABI.getProposalsCount, 'getProposalsCount')
  if (!n.ok) return { timelock: a, status: 'unavailable', note: n.error, ops: [] }
  const c = await classifyDgTimelock(client, a)
  const count = Number(n.value)
  const ops = []
  for (let id = Math.max(1, count - max + 1); id <= count; id++) {
    const x = await tryRead(client, a, DG_ABI.getProposal, 'getProposal', [BigInt(id)])
    if (!x.ok)
      return { timelock: a, status: 'unavailable', note: `proposal ${id}: ${x.error}`, ops: [] }
    const [d, calls] = x.value
    const op = dgProposalOp(
      a,
      { ...d, calls },
      {
        now,
        afterSubmitDelaySec: c.dg.afterSubmitDelaySec,
        afterScheduleDelaySec: c.dg.afterScheduleDelaySec,
      },
    )
    if (op.timestamp === 0 || op.timestamp === 1) continue
    if (op.status === 'scheduled' && op.timestamp !== null && op.timestamp <= now) {
      // execute(id) is permissionless: any account that can run it makes the proposal armed
      try {
        await client.call({
          account: '0x000000000000000000000000000000000000dEaD',
          to: a,
          data: encodeFunctionData({ abi: DG_ABI.execute, functionName: 'execute', args: [BigInt(id)] }),
        })
        op.simulation = 'ok'
      } catch (e) {
        op.simulation = isRevertError(e) ? 'revert' : 'error'
      }
    }
    ops.push(op)
  }
  return { timelock: a, status: 'ok', ops, count, delays: c.dg }
}

// ---- Wormhole NTT manager (head) --------------------------------------------------------------------

const NTT_ABI = {
  getThreshold: fnAbi('function getThreshold() view returns (uint8)'),
  getTransceivers: fnAbi('function getTransceivers() view returns (address[])'),
  getMode: fnAbi('function getMode() view returns (uint8)'),
  token: fnAbi('function token() view returns (address)'),
  owner: fnAbi('function owner() view returns (address)'),
  pauser: fnAbi('function pauser() view returns (address)'),
  isPaused: fnAbi('function isPaused() view returns (bool)'),
  getPeer: fnAbi('function getPeer(uint16) view returns ((bytes32 peerAddress, uint8 tokenDecimals))'),
  getTransceiverType: fnAbi('function getTransceiverType() view returns (string)'),
  getWormholePeer: fnAbi('function getWormholePeer(uint16) view returns (bytes32)'),
}

/**
 * Head state of a Wormhole NTT manager: threshold, transceivers (and the verifier network each
 * one runs on: getTransceiverType()), peers of the chains its events named, owner / pauser, and
 * the token balance it locks (mode 0 = LOCKING). Unread fields are null (the engine says so).
 */
export async function readNtt(client, manager, chains = []) {
  const m = manager.toLowerCase()
  const rd = async (abi, fn, args = [], to = m) => {
    const x = await tryRead(client, to, abi, fn, args)
    return x.ok ? x.value : null
  }
  const lcA = (v) => (v ? String(v).toLowerCase() : null)
  const threshold = await rd(NTT_ABI.getThreshold, 'getThreshold')
  const txs = await rd(NTT_ABI.getTransceivers, 'getTransceivers')
  const transceivers = []
  for (const t of txs ?? []) {
    const type = await rd(NTT_ABI.getTransceiverType, 'getTransceiverType', [], t)
    const peers = {}
    if (type === 'wormhole')
      for (const ch of chains) {
        const p = await rd(NTT_ABI.getWormholePeer, 'getWormholePeer', [ch], t)
        peers[ch] = p ? String(p).toLowerCase() : null
      }
    transceivers.push({ address: t.toLowerCase(), type: type ? String(type) : null, peers })
  }
  const peers = {}
  for (const ch of chains) {
    const p = await rd(NTT_ABI.getPeer, 'getPeer', [ch])
    peers[ch] = p ? { peer: String(p.peerAddress).toLowerCase(), decimals: Number(p.tokenDecimals) } : null
  }
  const token = lcA(await rd(NTT_ABI.token, 'token'))
  const mode = await rd(NTT_ABI.getMode, 'getMode')
  let locked = null
  if (token && Number(mode) === 0) {
    const b = await rd(fnAbi(FN.balanceOf), 'balanceOf', [m], token)
    const d = await rd(fnAbi(FN.decimals), 'decimals', [], token)
    if (b !== null && d !== null) locked = { raw: String(b), decimals: Number(d) }
  }
  return {
    manager: m,
    token,
    mode: mode === null ? null : Number(mode) === 0 ? 'locking' : 'burning',
    threshold: threshold === null ? null : Number(threshold),
    transceivers: txs === null ? null : transceivers,
    peers,
    owner: lcA(await rd(NTT_ABI.owner, 'owner')),
    pauser: lcA(await rd(NTT_ABI.pauser, 'pauser')),
    paused: await rd(NTT_ABI.isPaused, 'isPaused'),
    locked,
  }
}

// ---- canonical L2 token bridges (L1 side, head) ------------------------------------------------

/**
 * Head state of a canonical rollup token bridge's L1 side (Lido's L1ERC20TokenBridge /
 * L1LidoTokensBridge / Arbitrum gateway, or a rollup-run bridge): the token it locks, deposits /
 * withdrawals switches, the OssifiableProxy admin and whether it is ossified. Unread = null.
 */
export async function readCanonicalBridge(client, bridge, token) {
  const b = bridge.toLowerCase()
  const rd = async (sig, args = [], to = b) => {
    const fn = sig.match(/function (\w+)/)[1]
    const x = await tryRead(client, to, fnAbi(sig), fn, args)
    return x.ok ? x.value : x.reverted ? undefined : null
  }
  const bal = await rd('function balanceOf(address) view returns (uint256)', [b], token)
  const dec = await rd('function decimals() view returns (uint8)', [], token)
  const w = await retry(() => client.getStorageAt({ address: b, slot: SLOT.eip1967Admin })).catch(
    () => null,
  )
  const admin = word2addr(w)
  const flag = (v) => (v === undefined ? undefined : v === null ? null : !!v)
  return {
    bridge: b,
    token: token.toLowerCase(),
    locked:
      bal !== null && bal !== undefined && dec !== null && dec !== undefined
        ? { raw: String(bal), decimals: Number(dec) }
        : null,
    depositsEnabled: flag(await rd('function isDepositsEnabled() view returns (bool)')),
    withdrawalsEnabled: flag(await rd('function isWithdrawalsEnabled() view returns (bool)')),
    ossified: flag(await rd('function proxy__getIsOssified() view returns (bool)')),
    admin: admin && !isZero(admin) ? admin : null,
  }
}

// ---- legacy Gnosis MultiSigWallet submissions ----------------------------------------------------

/**
 * Submitted-but-unexecuted transactions of a MultiSigWallet (pending, observable on-chain).
 * Returns { status: 'ok', rows } or { status: 'unavailable', note } — never a silent empty list.
 */
export async function readMultisigSubmissions(client, multisig) {
  const ms = multisig.toLowerCase()
  const req = await tryRead(client, ms, fnAbi(FN.required), 'required')
  // getTransactionIds(from, to, …) slices the FILTERED list: `to` must be the number of pending
  // transactions (getTransactionCount(true, false)), or the tail is padded with id 0.
  const n = await tryRead(client, ms, fnAbi(FN.getTransactionCount), 'getTransactionCount', [
    true,
    false,
  ])
  if (!n.ok || !req.ok)
    return { multisig: ms, status: 'unavailable', note: n.error ?? req.error, rows: [] }
  const ids = await tryRead(client, ms, fnAbi(FN.getTransactionIds), 'getTransactionIds', [
    0n,
    BigInt(n.value),
    true,
    false,
  ])
  if (!ids.ok) return { multisig: ms, status: 'unavailable', note: ids.error, rows: [] }
  const rows = []
  for (const id of [...new Set(ids.value.map((x) => BigInt(x)))]) {
    const t = await tryRead(client, ms, fnAbi(FN.msTransactions), 'transactions', [id])
    const c = await tryRead(client, ms, fnAbi(FN.getConfirmationCount), 'getConfirmationCount', [
      id,
    ])
    if (!t.ok || !c.ok)
      return {
        multisig: ms,
        status: 'unavailable',
        note: `tx ${id}: ${t.error ?? c.error}`,
        rows: [],
      }
    const [destination, value, data, executed] = t.value
    if (executed) continue // executed meanwhile (read between two calls): not pending
    rows.push({
      multisig: ms,
      txId: Number(id),
      destination: destination.toLowerCase(),
      value: String(value),
      data,
      confirmations: Number(c.value),
      required: Number(req.value),
      executed,
    })
  }
  return { multisig: ms, status: 'ok', rows }
}

export { getAddress, roleName, ZERO }

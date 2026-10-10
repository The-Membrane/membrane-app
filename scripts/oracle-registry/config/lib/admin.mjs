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
import {
  codeAt,
  crossCheckedLogs,
  isRevertError,
  pool,
  retry,
  scrub,
  sleep,
  tryRead,
} from './rpc.mjs'

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
const wlLogs = new Map() // `${chain}|${timelock}` → Promise<{ target, selector, block }[] | null>
const deployOf = new Map() // `${chain}|${address}` → Promise<number>

/**
 * Fail-closed audit (RC-M6): the chain a client reads (1 for Ethereum and for test fakes). Every
 * memo below is keyed by it, and the Ethereum log endpoints serve chain 1 only — a remote
 * timelock's proposers were read from ETHEREUM's logs at the same address.
 */
const chainOf = (client) => Number(client?.chain?.id ?? 1)
const ckey = (client, a) => `${chainOf(client)}|${a}`

/**
 * The first block with code at `a` (the deployment) by bisection, CONFIRMED (fail-closed audit
 * TL-01 / FCB-1 / FCB-2 / ST-05 / MISSED-3/4): code at the result and none one block before, both
 * re-read on every `confirm` client (the two independent log endpoints — archive). One false "no
 * code" mid-bisection (a lagging or pruned ring endpoint) moved the start LATER, so the log scans it
 * bounds skipped the constructor grants and early whitelist entries, and a cached deploy block made
 * a late initialize() look like initialization. Throws when the boundary is not confirmed.
 */
export async function confirmedFirstCode(client, a, { lo = 0, hi, confirm = [] } = {}) {
  const checks = confirm.length ? confirm : [client]
  // code already at the lower bound: deployed at or before it (confirmed there too)
  if (await codeAt(client, a, lo)) {
    for (const c of checks)
      if (!(await codeAt(c, a, lo)))
        throw new Error(`first code of ${a} not confirmed: no code at ${lo} on a second endpoint`)
    return lo
  }
  let top = hi ?? Number(await retry(() => client.getBlockNumber()))
  let bottom = lo
  while (top - bottom > 1) {
    const m = Math.floor((bottom + top) / 2)
    if (await codeAt(client, a, m)) top = m
    else bottom = m
  }
  for (const c of checks) {
    if (!(await codeAt(c, a, top)))
      throw new Error(`first code of ${a} not confirmed: no code at ${top} on a second endpoint`)
    if (top > 0 && (await codeAt(c, a, top - 1)))
      throw new Error(`first code of ${a} not confirmed: code already at ${top - 1}`)
  }
  return top
}

async function firstCodeBlock(client, a) {
  const k = ckey(client, a)
  if (!deployOf.has(k))
    deployOf.set(
      k,
      confirmedFirstCode(client, a, {
        confirm:
          chainOf(client) === 1 && logClients
            ? [logClients.primary, logClients.secondary].filter(Boolean)
            : [],
      }),
    )
  return deployOf.get(k)
}

/** The log endpoints for `client`'s chain: Ethereum's pair, or the client alone (unconfirmable). */
const logPairFor = (client) =>
  chainOf(client) === 1 && logClients ? [logClients.primary, logClients.secondary] : [client, null]

/**
 * FunctionWhitelisted(target, selector) logs of a timelock (null when they could not be read).
 * Review round 12 (on-chain #3): read like the proposer logs (UQ-23) — every EMPTY chunk is
 * cross-checked on the second log endpoint (`crossCheckedLogs`), and an empty answer nothing
 * confirms makes the whitelist UNREAD. It was one unchecked read on the state ring: a false-empty
 * chunk made `timelockBypass` answer "no bypass", and the USDe / sUSDe AD-2 head breaches (the
 * Ethena timelock's whitelisted setPeer) vanished with no read gap. Without log clients (tests,
 * old callers) the one endpoint's empty answer is unconfirmed: unread.
 */
async function whitelistLogs(client, a) {
  const k = ckey(client, a)
  if (!wlLogs.has(k))
    wlLogs.set(
      k,
      (async () => {
        try {
          const from = await firstCodeBlock(client, a)
          const head = Number(await retry(() => client.getBlockNumber()))
          const out = []
          for (let b = from; b <= head; b += ROLE_LOG_CHUNK) {
            const q = {
              address: a,
              topics0: [TOPIC_FUNCTION_WHITELISTED],
              fromBlock: b,
              toBlock: Math.min(head, b + ROLE_LOG_CHUNK - 1),
            }
            const [lp, ls] = logPairFor(client)
            const logs = (await crossCheckedLogs(lp, ls, q)).logs
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
  return wlLogs.get(k)
}

const TOPIC_ROLE_GRANTED = keccak256(toHex('RoleGranted(bytes32,address,address)'))
const roleLogs = new Map() // timelock → Promise<{ role, account, block }[] | null>
// UQ-23 (2026-10-08): the proposer-log reads go to two independent KEYED log endpoints, in
// smaller chunks, and every empty chunk is cross-checked on the second one (`crossCheckedLogs`).
// A chunk that fails without a confirming empty answer makes the whole set UNREAD (the timelock
// then ranks as a plain contract and is a read gap). Unset (tests, old callers): `client` alone.
let logClients = null
export function setLogClients(primary, secondary) {
  logClients = primary ? { primary, secondary: secondary ?? null } : null
  // the run-scoped memos start over with the run's endpoints
  roleLogs.clear()
  wlLogs.clear()
  deployOf.clear()
  notEnumerable.clear()
  proposerRoleMemo.clear()
  aclMemo.clear()
}
export const ROLE_LOG_CHUNK = 500_000
/** RoleGranted(role, account) logs of a timelock from its deployment (null when unread). */
async function roleGrantLogs(client, a) {
  const k = ckey(client, a)
  if (!roleLogs.has(k))
    roleLogs.set(
      k,
      (async () => {
        try {
          const from = await firstCodeBlock(client, a)
          const head = Number(await retry(() => client.getBlockNumber()))
          const out = []
          for (let b = from; b <= head; b += ROLE_LOG_CHUNK) {
            const q = {
              address: a,
              topics0: [TOPIC_ROLE_GRANTED],
              fromBlock: b,
              toBlock: Math.min(head, b + ROLE_LOG_CHUNK - 1),
            }
            // fail-closed audit (TL-02): never an unchecked read — without a second endpoint an
            // empty answer is unconfirmed (the set is unread)
            const [lp, ls] = logPairFor(client)
            const logs = (await crossCheckedLogs(lp, ls, q)).logs
            for (const l of logs)
              out.push({
                role: String(l.topics[1]).toLowerCase(),
                account: ('0x' + String(l.topics[2]).slice(-40)).toLowerCase(),
                block: Number(l.blockNumber),
              })
          }
          return out
        } catch {
          return null
        }
      })(),
    )
  return roleLogs.get(k)
}

// Every account the collector's own admin scan saw granted a role, per contract (set from the
// replayed rows): a cross-check for a false-empty per-timelock log read (the shared RPC ring can
// return empty getLogs chunks).
const roleCands = new Map()
export function setRoleCandidates(rows) {
  roleCands.clear()
  for (const r of rows ?? []) {
    if (r.event !== 'RoleGranted') continue
    const k = `${String(r.emitter).toLowerCase()}|${String(r.args?.role).toLowerCase()}`
    const set = roleCands.get(k) ?? new Set()
    set.add(String(r.args?.account).toLowerCase())
    roleCands.set(k, set)
  }
}

const ROLE_ADMIN_FALLBACK = ['TIMELOCK_ADMIN_ROLE', 'DEFAULT_ADMIN_ROLE', 'ADMIN_ROLE']
// Scheduler classifications are NOT memoized: a memo of a pending promise deadlocks when a
// scheduler's own deferral chain leads back to the timelock (measured 2026-10-08: the run exited
// with an unsettled top-level await). Recursion is bounded by `seen` and MAX_SCHEDULER_DEPTH.
const MAX_SCHEDULER_DEPTH = 4
/**
 * Owner hops followed from a contract (contract → owner → owner's owner). Review round 9: the
 * hops are counted from the last scheduler / executor hop, not from the top of the tree — a
 * timelock's proposers sat at depth 2 under "ProxyAdmin owned by a timelock", so a proposer
 * CONTRACT's owner was never read: one owned by an EOA ranked as a plain contract and its AD-3
 * never fired. A cycle (an owner already on the path, e.g. an MCMS owned by the RBACTimelock it
 * proposes into) is not followed: it ranks as a plain contract instead of counting the
 * timelock's delay credit twice.
 */
const MAX_OWNER_HOPS = 2

/**
 * Multicall3 (0xcA11…CA11) was deployed on Ethereum at this block. Review round 10 (R-7): before
 * it, a batched read returns every entry as failed, so a Safe classified at an older block
 * silently became a plain contract. Such a read is made one eth_call per view instead.
 */
export const MULTICALL3_BLOCK = 14_353_601

/**
 * Round 12 (2026-10-09): a past-block classification is cached across runs because the chain at
 * that block never changes — but a classification in which a READ FAILED is this run's fail-closed
 * answer, not a fact about the block. Cached, one transient RPC failure became permanent: the
 * re-collection cached 24 rsETH timelock classifications (`0x49bd…35b1`) with `schedulersUnread`
 * after its RoleGranted log read failed, and every later run would have reused them. True when
 * any node in the tree carries a read-failure marker (an unread proposer set, module list or
 * bypass whitelist); the collector then uses it for this run only and reads it again next run (a
 * deterministic marker, e.g. a timelock with no proposer, is simply re-read each run). A vote's
 * unread history or holders are not checked here: `enrichTokenVotes` already reads those again.
 */
export function hasReadFailure(c, seen = new Set()) {
  if (!c || typeof c !== 'object' || seen.has(c)) return false
  seen.add(c)
  if (c.schedulersUnread || c.modulesUnread || c.bypass?.unread || c.executorsUnread) return true
  // fail-closed audit: an owner, an Aragon app implementation or an Agent's permissions not read
  if (c.ownerUnread || c.appUnread || c.executorsUnconfirmed) return true
  // Review round 12 (on-chain #4 / rules #9): also an unrestricted bypass whose bypassers were
  // not all classified (a round-9 entry with no `holderCtls` at all — 19 cached entries of WBTC's
  // 0x4483…9449 rendered "bypassers UNREAD" on every run, although the role reads fine), a vote
  // time that was not read, and a Dual Governance read a rank or a breach rests on (an unread
  // after-submit delay drops the delay credit; an unread emergency mode can hide an AD-2).
  const b = c.bypass
  // TL-10 / TL-11: an unrestricted bypass with no classified bypasser (a count of 0 is no bypass
  // at all), an unread count or member, or fewer classified than the members listed
  if (
    b?.scope === 'any' &&
    b.fn === 'bypasserExecuteBatch' &&
    (!b.holderCtls?.length ||
      b.countUnread ||
      b.membersUnread ||
      b.holderCtls.length < (b.holders?.length ?? 0))
  )
    return true
  if (c.voting && c.voting.voteTimeSec === null) return true
  // TV-03: a threshold not read is read again (it was cached, and re-read only when the token or
  // the quorum was missing)
  if (
    c.voting &&
    !c.selfRef &&
    (c.delaySec ?? 0) > 0 &&
    (c.voting.supportRequiredPct == null || c.voting.minAcceptQuorumPct == null)
  )
    return true
  if (
    c.dg &&
    (c.dg.afterSubmitDelaySec === null ||
      c.dg.afterScheduleDelaySec === null ||
      c.dg.emergencyModeActive === null ||
      c.dg.proposerVoteUnread)
  )
    return true
  return [
    c.ownedBy,
    ...(c.executors ?? []),
    ...(c.schedulers ?? []),
    ...(c.bypass?.holderCtls ?? []),
    ...(c.dsAuthority?.callers ?? []),
    // TV-14: a holder of a token vote classified with a read failure inside
    ...(c.voting?.holders ?? []).map((h) => h.ctl),
  ].some((x) => hasReadFailure(x, seen))
}

/**
 * One storage slot as a 32-byte word (fail-closed audit CL-04 / M-2 / PH-06): anything else —
 * null, '0x', a short or non-string answer — THROWS (a node that cannot serve the block), so it
 * is retried and never read as "unset".
 */
export async function storageWord(client, address, slot, block) {
  const w = await client.getStorageAt({
    address,
    slot,
    blockNumber: block === undefined ? undefined : BigInt(block),
  })
  if (typeof w !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(w))
    throw new Error(
      `getStorageAt(${address}, ${slot}) answered ${w === null ? 'null' : typeof w === 'string' ? `"${w.slice(0, 12)}"` : typeof w}`,
    )
  return w
}

/** "The function is not there" (reverts, or returns no / short data) — not a transport failure. */
const isAbsentResult = (e) => {
  if (isRevertError(e)) return true
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++)
    if (
      /ContractFunctionZeroDataError|AbiDecodingZeroDataError|AbiDecodingDataSizeTooSmallError|PositionOutOfBoundsError|InvalidBytesBooleanError/.test(
        String(x.name ?? ''),
      )
    )
      return true
  return false
}

/**
 * The MC views of `a` at `block` as multicall results ({ status, result }). Before Multicall3
 * (R-7) every view is read with its own eth_call: an absent function is a failure, a transport
 * error that persists THROWS (the classification fails — fail closed — rather than reading as
 * "no such view").
 */
async function readViews(client, a, block) {
  const pre = block !== undefined && block < MULTICALL3_BLOCK
  let res = null
  try {
    res = await retry(async () => {
      const r = await client.multicall({
        contracts: MC.map(([fn, sig]) => ({ address: a, abi: fnAbi(sig), functionName: fn })),
        allowFailure: true,
        blockNumber: block === undefined ? undefined : BigInt(block),
      })
      // Fail-closed audit (CL-02 / RC-M5, 2026-10-10): viem turns a REJECTED aggregate3 chunk (a
      // network error, a 429, no Multicall3) into a per-call failure carrying that error and does
      // not throw — every view then read as "not there", and an EOA-owned contract, a Safe 1-of-N
      // or a timelock with an EOA proposer classified as a calm plain contract (cached at past
      // blocks). A failure that is not "the function is not there" is a failed read: retried,
      // then thrown (the classification fails: not classified, a read gap).
      const bad = (r ?? []).find(
        (x) => x.status === 'failure' && x.error && !isAbsentResult(x.error),
      )
      if (bad) throw bad.error
      return r
    })
  } catch (e) {
    if (!pre) throw e
  }
  if (res && (!pre || res.some((x) => x.status === 'success'))) return res
  return Promise.all(
    MC.map(async ([fn, sig]) => {
      for (let i = 0; ; i++) {
        try {
          const result = await client.readContract({
            address: a,
            abi: fnAbi(sig),
            functionName: fn,
            blockNumber: BigInt(block),
          })
          return { status: 'success', result }
        } catch (e) {
          if (isAbsentResult(e)) return { status: 'failure' }
          if (i >= 2) throw e
          await sleep(300 * 2 ** i)
        }
      }
    }),
  )
}
const UPDATE_DELAY_0 = encodeFunctionData({
  abi: parseAbi(['function updateDelay(uint256)']),
  functionName: 'updateDelay',
  args: [0n],
})

/**
 * Review round 9: can `from` change the timelock's delay at once? An eth_call of updateDelay(0)
 * from it at the block: success = yes (a Chainlink RBACTimelock gates it with ADMIN_ROLE); a
 * revert = no (OZ TimelockController: only the timelock itself); any other failure, after two
 * retries = yes (fail closed: the scheduler then gets no delay credit).
 */
async function canSetDelay(client, timelock, from, block) {
  for (let i = 0; i < 3; i++) {
    try {
      await client.call({
        account: from,
        to: timelock,
        data: UPDATE_DELAY_0,
        blockNumber: block === undefined ? undefined : BigInt(block),
      })
      return true
    } catch (e) {
      if (isRevertError(e)) return false
    }
  }
  return true
}
const proposerRoleMemo = new Map() // timelock → Promise<role hash>
const notEnumerable = new Set() // timelocks whose getRoleMemberCount reverted (OZ: not enumerable)

/**
 * One eth_call: a revert answers at once (no retry backoff — OZ TimelockController has no
 * getRoleMemberCount, and the classification runs at hundreds of blocks); any other error goes
 * through tryRead's retries. Same result shape as tryRead.
 */
async function readOnce(client, address, sig, fn, args, block) {
  try {
    const value = await client.readContract({
      address,
      abi: fnAbi(sig),
      functionName: fn,
      args,
      blockNumber: block === undefined ? undefined : BigInt(block),
    })
    return { ok: true, value }
  } catch (e) {
    if (isRevertError(e)) return { ok: false, reverted: true, error: 'reverted' }
    return tryRead(client, address, fnAbi(sig), fn, args, block)
  }
}

/**
 * Who can schedule into an OZ TimelockController / RBACTimelock at `block` (owner ruling
 * 2026-10-08, #12): the PROPOSER_ROLE holders and the holders of the roles that can grant it
 * (getRoleAdmin(PROPOSER_ROLE), and its own admin, up to three levels; TIMELOCK_ADMIN_ROLE /
 * DEFAULT_ADMIN_ROLE / ADMIN_ROLE when getRoleAdmin cannot be read). Candidates come from the
 * timelock's RoleGranted logs since deployment, the collector's admin scan and
 * AccessControlEnumerable; hasRole at the block decides (a failed read keeps the candidate:
 * fail closed). The timelock itself (self-administration) is not a scheduler.
 *   { schedulers: Controller[] }            the set, each classified at the block
 *   { schedulers: [...], unread: true }      no PROPOSER_ROLE candidate at all, or no log read
 *                                            and no enumeration: ranked as a plain contract
 */
export async function timelockSchedulers(client, a, block, depth = 0, seen = new Set()) {
  // nested deeper than this: not read (fail closed — ranked as a plain contract)
  if (depth >= MAX_SCHEDULER_DEPTH) return { schedulers: [], unread: true }
  const rd = (sig, fn, args = []) => readOnce(client, a, sig, fn, args, block)
  const mk = ckey(client, a)
  if (!proposerRoleMemo.has(mk))
    proposerRoleMemo.set(
      mk,
      rd('function PROPOSER_ROLE() view returns (bytes32)', 'PROPOSER_ROLE').then((p) =>
        (p.ok ? String(p.value) : roleHash('PROPOSER_ROLE')).toLowerCase(),
      ),
    )
  const proposerRole = await proposerRoleMemo.get(mk)
  const roles = [proposerRole]
  let adminRead = true
  for (let i = 0; i < 3; i++) {
    const r = await rd(FN.getRoleAdmin, 'getRoleAdmin', [roles[roles.length - 1]])
    if (!r.ok) {
      adminRead = false
      break
    }
    const ar = String(r.value).toLowerCase()
    if (roles.includes(ar)) break
    roles.push(ar)
  }
  if (!adminRead)
    for (const n of ROLE_ADMIN_FALLBACK) {
      const h = (n === 'DEFAULT_ADMIN_ROLE' ? '0x' + '0'.repeat(64) : roleHash(n)).toLowerCase()
      if (!roles.includes(h)) roles.push(h)
    }
  const logs = await roleGrantLogs(client, a)
  const holders = new Set()
  const adminHolders = new Set() // holders of a role that administers PROPOSER (not PROPOSER)
  let proposerCands = 0
  // Fail-closed audit (TL-06 / TL-08, 2026-10-10): whether EACH role's holders were read. A role is
  // read when its RoleGranted logs were read, or when the contract enumerated it COMPLETELY (the
  // count read, every member read, at most 50). One `enumerated` flag for all roles let an admin
  // role's count stand in for an unread PROPOSER count, and a member that failed was skipped —
  // either way a proposer (an EOA: AD-3) vanished with no gap. The admin scan's candidates are a
  // partial, window-limited cross-check, never a read.
  const unreadRoles = []
  for (const role of roles) {
    const cands = new Set([
      ...(logs ?? [])
        .filter((l) => l.role === role && (block === undefined || l.block <= block))
        .map((l) => l.account),
      ...(chainOf(client) === 1 ? (roleCands.get(`${a}|${role}`) ?? []) : []),
    ])
    const n = notEnumerable.has(mk)
      ? { ok: false }
      : await rd(FN.getRoleMemberCount, 'getRoleMemberCount', [role])
    if (!n.ok && n.reverted) notEnumerable.add(mk)
    let complete = false
    if (n.ok) {
      complete = Number(n.value) <= 50
      for (let i = 0; i < Math.min(Number(n.value), 50); i++) {
        const m = await rd(FN.getRoleMember, 'getRoleMember', [role, BigInt(i)])
        if (m.ok) cands.add(String(m.value).toLowerCase())
        else complete = false
      }
    }
    if (!logs && !complete) unreadRoles.push(role)
    if (role === proposerRole) proposerCands = cands.size
    for (const h of cands) {
      if (h === a) continue
      const x = await rd(FN.hasRole, 'hasRole', [role, h])
      if (!x.ok || x.value) {
        holders.add(h)
        if (role !== proposerRole) adminHolders.add(h)
      }
    }
  }
  const unread = unreadRoles.length > 0 || proposerCands === 0
  const schedulers = []
  const delaySetters = []
  for (const h of holders) {
    // TL-13b: a scheduler already on this control path (an MCMS the timelock owns) is a CYCLE —
    // ranked as a plain contract, as an owner / bypasser cycle is. It was dropped, so the
    // timelock ranked as its other (stronger) schedulers.
    if (seen.has(h)) {
      schedulers.push({
        kind: 'contract',
        address: h,
        version: 'already on this control path (a cycle): ranked as a plain contract',
      })
      continue
    }
    schedulers.push(await classify(client, h, block, depth + 1, new Set([...seen, a]), 0))
    // review round 9: an admin-role holder that can change the delay at once gets no credit
    if (adminHolders.has(h) && (await canSetDelay(client, a, h, block))) delaySetters.push(h)
  }
  return { schedulers, unread, delaySetters }
}

/**
 * Fail-closed audit (PH-13 / EV-07, 2026-10-10): the holders of a declared timelock's admin roles
 * (AD-7) at head — the candidates the admin scan replayed (`cands`), its own RoleGranted logs
 * (cross-checked on the second endpoint), and its enumeration where it has one, each confirmed by
 * hasRole at head (a failed read keeps the candidate: fail closed). `unread` when neither the logs
 * nor a complete enumeration was read for a role: the AD-7 holder list was then the admin scan
 * alone (a lost RoleGranted dropped the holder, and its AD-7, with no gap).
 */
export async function timelockAdminHolders(client, timelock, roleNames, cands = []) {
  const a = timelock.toLowerCase()
  const logs = await roleGrantLogs(client, a)
  const holders = new Set()
  let unread = false
  for (const name of roleNames) {
    const role = (
      name === 'DEFAULT_ADMIN_ROLE' ? '0x' + '0'.repeat(64) : roleHash(name)
    ).toLowerCase()
    const set = new Set([
      ...cands.map((x) => String(x).toLowerCase()),
      ...(logs ?? []).filter((l) => l.role === role).map((l) => l.account),
    ])
    let complete = false
    const n = await readOnce(client, a, FN.getRoleMemberCount, 'getRoleMemberCount', [role])
    if (n.ok) {
      complete = Number(n.value) <= 50
      for (let i = 0; i < Math.min(Number(n.value), 50); i++) {
        const m = await readOnce(client, a, FN.getRoleMember, 'getRoleMember', [role, BigInt(i)])
        if (m.ok) set.add(String(m.value).toLowerCase())
        else complete = false
      }
    }
    if (!logs && !complete) unread = true
    for (const h of set) {
      if (h === a) continue
      const x = await readOnce(client, a, FN.hasRole, 'hasRole', [role, h])
      if (!x.ok || x.value) holders.add(h)
    }
  }
  return { holders: [...holders], unread }
}

/**
 * The bypass path of a timelock at `block`, read from its code and state:
 *   bypasserExecuteBatch (RBACTimelock) — unrestricted, held by BYPASSER_ROLE members;
 *   executeWhitelisted (Ethena)         — the (target, selector) pairs whitelisted right now.
 * A bypass that cannot be enumerated is reported as unrestricted (fail closed).
 */
export async function timelockBypass(client, a, code, block, depth = 0, seen = new Set()) {
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
    let membersUnread = false
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
      else membersUnread = true
    }
    // Fail-closed audit (TL-10 / TL-11 / CL-05): an unread count or member is MARKED, so the
    // past-block cache never keeps it (with no holders read, `holderCtls.length < holders.length`
    // was 0 < 0: the gap was cached for good, and a red history row could never appear)
    const marks = {
      ...(n.ok ? { count: Number(n.value) } : { countUnread: true }),
      ...(membersUnread ? { membersUnread: true } : {}),
    }
    // UQ-24: the bypassers, classified at the block — the bypass ranks as the weakest of them.
    // An unread member count, a member that could not be read, or one that could not be
    // classified leaves `holderCtls` short of the count: a read gap (plain contract).
    const holderCtls = []
    if (n.ok && holders.length === Math.min(Number(n.value), 10) && Number(n.value) <= 10)
      for (const h of holders) {
        // Review round 12 (on-chain #4): a bypasser already on this control path (WBTC's CCIP
        // RBACTimelock 0x4483…9449: its bypasser 0x117e…aadc is owned by it) or the timelock
        // itself is a CYCLE — ranked as a plain contract, as an owner cycle is. It was skipped,
        // which left `holderCtls` short: a permanent "bypassers UNREAD" read gap on every run.
        if (seen.has(h) || h === a) {
          holderCtls.push({
            kind: 'contract',
            address: h,
            version: 'already on this control path (a cycle): ranked as a plain contract',
          })
          continue
        }
        try {
          holderCtls.push(await classify(client, h, block, depth + 1, new Set([...seen, a]), 0))
        } catch {
          /* not classified: holderCtls stays short — a read gap */
        }
      }
    return { fn: 'bypasserExecuteBatch', scope: 'any', holders, holderCtls, ...marks }
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
export async function classify(client, address, block, depth = 0, seen = new Set(), ownerHops = 0) {
  const a = address.toLowerCase()
  // UQ-17: the token vote whose holders are being ranked — a holder whose control leads back to
  // it is MARKED, not followed (it acts only after that vote passed: no independent voter)
  if (seen.has(VOTE_SELF + a)) return { kind: 'aragon_voting', address: a, selfRef: true }
  if (isZero(a)) return { kind: 'zero', address: a }
  if (BigInt(a) <= 0x1ffn) return { kind: 'precompile', address: a }
  const code = await codeAt(client, a, block)
  if (!code) return { kind: 'eoa', address: a }
  if (code.startsWith('0xef0100')) return { kind: 'eoa_7702', address: a }
  const res = await readViews(client, a, block)
  const r = Object.fromEntries(
    MC.map(([fn], i) => [fn, res[i].status === 'success' ? res[i].result : undefined]),
  )
  // fail-closed audit (CL-04 / M-2): only a 32-byte word is an answer — a null or short answer (a
  // node that cannot serve the block) read as "unset": a Safe whose slot 0 was not served became a
  // plain contract (its 1-of-N EOA rank lost), and a guard read as "none"
  const storage = async (slot) =>
    word2addr(await retry(() => storageWord(client, a, toHex(slot, { size: 32 }), block)))
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
      // review round 8: a module read that failed is NOT "no modules" — the Safe then ranks as a
      // plain contract and the engine reports a read gap (a module executes without signatures).
      // Fail-closed audit (SQ-01): the list is read to its END (pages of 20, each from the LAST
      // module returned — Safe 1.3.0's `next` is the first EXCLUDED one), at most 5 pages; a page
      // that fails, or a list longer than that, is unread (one page read 20 and called it whole).
      const modules = []
      let start = SENTINEL
      let pages = 0
      for (;;) {
        const mods = await tryRead(
          client,
          a,
          fnAbi(FN.getModulesPaginated),
          'getModulesPaginated',
          [start, 20n],
          block,
        )
        if (!mods.ok || ++pages > 5) {
          c.modulesUnread = true
          break
        }
        const page = mods.value[0].map((m) => String(m).toLowerCase())
        modules.push(...page.filter((m) => !modules.includes(m)))
        const next = String(mods.value[1] ?? '').toLowerCase()
        if (!page.length || next === SENTINEL || isZero(next)) break
        start = page[page.length - 1]
      }
      if (!c.modulesUnread) c.modules = modules
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
  if (isDgTimelockCode(code)) return classifyDgTimelock(client, a, block, depth, seen)
  const voting = await aragonVotingOf(client, a, code, block)
  if (voting) return voting
  const agent = await aragonAgentOf(client, a, code, block, depth, seen)
  if (agent) return agent
  // fail-closed audit (TL MISSED admin.mjs:679): timelock CODE whose getMinDelay view did not
  // answer is re-read; still unread, it is an UNREAD timelock (a read gap), never a calm plain
  // contract with no schedulers and no bypass
  if (r.getMinDelay === undefined && isTimelockCode(code)) {
    const d = await tryRead(client, a, fnAbi(FN.getMinDelay), 'getMinDelay', [], block)
    if (d.ok) r.getMinDelay = d.value
    else
      return {
        kind: 'oz_timelock',
        address: a,
        delaySec: 0,
        schedulers: [],
        schedulersUnread: true,
        version: 'getMinDelay not read',
      }
  }
  if (r.getMinDelay !== undefined && isTimelockCode(code)) {
    const c = { kind: 'oz_timelock', address: a, delaySec: Number(r.getMinDelay) }
    const bypass = await timelockBypass(client, a, code, block, depth, seen)
    if (bypass) c.bypass = bypass
    // ruling #12: the timelock ranks as its weakest scheduler (read gap when unread)
    const sch = await timelockSchedulers(client, a, block, depth, seen)
    c.schedulers = sch.schedulers
    if (sch.unread) c.schedulersUnread = true
    if (sch.delaySetters?.length) c.delaySetters = sch.delaySetters
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
  if (r.delay !== undefined && r.authority !== undefined) {
    // ruling #12: DSAuth lets the owner plot — the pause ranks as its owner. UQ-24: it also lets
    // whoever the AUTHORITY permits (`canCall`) plot; those callers are not enumerable from a
    // generic DSAuthority, so a non-zero authority is a read gap (ranked as a plain contract).
    const c = { kind: 'ds_pause', address: a, delaySec: Number(r.delay), schedulers: [] }
    const owner = r.owner ? String(r.owner).toLowerCase() : null
    if (owner && !isZero(owner) && owner !== a && !seen.has(owner))
      c.schedulers.push(await classify(client, owner, block, depth + 1, new Set([...seen, a]), 0))
    const auth = String(r.authority).toLowerCase()
    if (!isZero(auth) && auth !== a) c.dsAuthority = { address: auth }
    if (r.owner === undefined) c.schedulersUnread = true
    return c
  }
  const c = { kind: 'contract', address: a, ...(multisigLike ?? {}) }
  // fail-closed audit (CL-03): an owner() the code dispatches that the batch did not answer is
  // read again directly (a transport failure throws there; inside aggregate3 an out-of-gas looks
  // like a revert); still not read = `ownerUnread` (a read gap, never cached) — it was a plain
  // contract with no owner and no marker, so an EOA owner's AD-3 / AD-4 / MR-2 vanished
  if (r.owner === undefined && dispatches(code, 'owner()')) {
    try {
      const x = await pathRead(client, a, FN.owner, 'owner', [], block)
      if (x.ok) r.owner = x.value
    } catch {
      c.ownerUnread = true
    }
  }
  const owner = r.owner ? String(r.owner).toLowerCase() : null
  if (owner && !isZero(owner) && owner !== a && !seen.has(owner)) {
    if (ownerHops < MAX_OWNER_HOPS)
      c.ownedBy = await classify(
        client,
        owner,
        block,
        depth + 1,
        new Set([...seen, a]),
        ownerHops + 1,
      )
    // review round 10 (R-6): past the hop limit the owner is recorded, not followed — the rules
    // rank the contract as a plain contract AND a read gap (it ranked [2] silently, even when
    // the chain ended at an EOA)
    else c.ownerNotFollowed = owner
  }
  return c
}

/**
 * Fail-closed review (2026-10-10, rules #7): the address-shaped words of a queued op's calls (the
 * grantees, new owners and providers the queue judges at head). A call index that was never seen
 * (QU-05: a lost CallScheduled log) leaves a HOLE in `calls` — `for (const c of o.calls) c.data`
 * threw a TypeError and stopped the whole run while the gap lasted. Holes are skipped.
 */
export function callAddressArgs(calls) {
  const out = []
  for (const c of calls ?? []) {
    if (!c) continue
    for (const m of String(c.data ?? '')
      .slice(10)
      .match(/.{64}/g) ?? [])
      if (/^0{24}[0-9a-f]{40}$/.test(m)) out.push('0x' + m.slice(24))
  }
  return out
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
 * power holder and every intermediate hop of a power path (a ProxyAdmin — review round 7), and
 * every holder of a proposer / executor / canceller / admin role on one of its
 * declared timelocks (review round 6: those Safes were scanned, then dropped by the per-subject
 * filter — weETH's 10-day timelock proposer Safe lost three red AD-1 rows).
 *   subject  { timelocks }       powers  [{ holders, via? }]
 *   roleMap  Map(`${timelock}|${roleHash}` → Set(holder))
 */
export function subjectExtraEmitters(subject, powers, roleMap, hashOf = roleHash) {
  const out = new Set()
  for (const p of powers ?? [])
    for (const h of [...(p.holders ?? []), ...(p.via ?? [])]) out.add(String(h).toLowerCase())
  for (const t of subject.timelocks ?? [])
    for (const role of TIMELOCK_SCOPE_ROLES)
      for (const h of roleMap.get(`${t}|${hashOf(role)}`) ?? []) out.add(String(h).toLowerCase())
  return out
}

/**
 * The co-holders a ranked role grant is judged against, to classify at the grant block (review
 * round 8: a privileged grant is ranked against the other holders of the role). Returns the keys
 * `${holder}@${block}` to classify (`want`) and the ones answered without a read (`reuse`).
 *
 * Review round 12 (on-chain #5): a co-holder that was an EOA at its own grant block is an EOA at
 * every later block (an address with a known key never gets contract code; an EIP-7702 delegation
 * still ranks as an EOA), so it is not read again — but it IS recorded at the later block. It was
 * skipped and left unrecorded: the engine then found no classification there and kept rsETH's
 * MANAGER grant at 18,759,607 red in effect "not read", blaming a read that never failed
 * (`0x7aad…af47` was an EOA MANAGER at 18,759,606).
 *   rows        admin event rows (RoleGranted / RoleRevoked are used)
 *   atCache     past-block classifications by `${address}@${block}`
 *   rankedRole  (row) → the grant is ranked against its co-holders
 */
export function coHolderReads(rows, atCache, rankedRole) {
  const lcs = (x) => String(x ?? '').toLowerCase()
  const held = new Map()
  const grantedAt = new Map()
  const want = new Set()
  const reuse = {}
  for (const r of [...rows].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    if (r.event !== 'RoleGranted' && r.event !== 'RoleRevoked') continue
    const k = `${lcs(r.emitter)}|${lcs(r.args?.role)}`
    const acct = lcs(r.args?.account)
    const set = held.get(k) ?? new Set()
    if (r.event === 'RoleGranted' && rankedRole(r))
      for (const h of set) {
        if (h === acct) continue
        const own = atCache[`${h}@${grantedAt.get(`${k}|${h}`)}`]
        if (own && (own.kind === 'eoa' || own.kind === 'eoa_7702')) {
          reuse[`${h}@${r.block}`] = own
          continue
        }
        want.add(`${h}@${r.block}`)
      }
    if (r.event === 'RoleGranted') {
      set.add(acct)
      if (!grantedAt.has(`${k}|${acct}`)) grantedAt.set(`${k}|${acct}`, r.block)
    } else {
      set.delete(acct)
      grantedAt.delete(`${k}|${acct}`)
    }
    held.set(k, set)
  }
  return { want: [...want], reuse }
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

/**
 * Review round 12 (on-chain #1): one view of a power path, read at `block`. Answers
 *   { ok: true, value }      the read succeeded;
 *   { ok: false, absent }    the function is not there (it reverts, or returns no / short data —
 *                            an EOA, a Safe asked for owner()): a FACT about the contract;
 * and THROWS on any other failure, after retries — a transport error is never "no holder" (it was
 * read as one: the power got `holders: []` with no error, so its AD-3 was dropped with no read
 * gap). The collector turns the throw into `power.error`, a read gap the UQ-30 carry follows.
 */
async function pathRead(client, address, sig, fn, args, block) {
  for (let i = 0; ; i++) {
    try {
      const value = await client.readContract({
        address,
        abi: fnAbi(sig),
        functionName: fn,
        args,
        blockNumber: block === undefined ? undefined : BigInt(block),
      })
      return { ok: true, value }
    } catch (e) {
      if (isAbsentResult(e)) return { ok: false, absent: true }
      if (i >= 2)
        throw new Error(
          `${fn}() on ${address} not read: ${scrub(e?.shortMessage || e?.message || e)}`,
        )
      await sleep(300 * 2 ** i)
    }
  }
}

async function holdersOf(client, contract, role, roleMap, block) {
  const cands = [...(roleMap.get(`${contract}|${role}`) ?? [])]
  // Fail-closed audit (PH-03, 2026-10-10): on a contract that cannot list its members the holders
  // came ONLY from the run's admin scan (a lost RoleGranted dropped a holder, and its AD-3, with
  // no gap). Its own RoleGranted logs for this role are read too (cross-checked on the second
  // endpoint); a read that cannot be confirmed THROWS (power.error: a read gap the carry follows).
  const enumerable = await pathRead(
    client,
    contract,
    FN.getRoleMemberCount,
    'getRoleMemberCount',
    [role],
    block,
  )
  if (!enumerable.ok && logClients && chainOf(client) === 1) {
    const from = await firstCodeBlock(client, contract).catch(() => {
      throw new Error(
        `the deployment block of ${contract} was not confirmed (RoleGranted not read)`,
      )
    })
    const to = block ?? Number(await retry(() => client.getBlockNumber()))
    for (let b = from; b <= to; b += ROLE_LOG_CHUNK) {
      const q = {
        address: contract,
        topics0: [TOPIC_ROLE_GRANTED],
        fromBlock: b,
        toBlock: Math.min(to, b + ROLE_LOG_CHUNK - 1),
      }
      const { logs } = await crossCheckedLogs(logClients.primary, logClients.secondary, q)
      for (const l of logs)
        if (String(l.topics?.[1]).toLowerCase() === role) {
          const acct = ('0x' + String(l.topics[2]).slice(-40)).toLowerCase()
          if (!cands.includes(acct)) cands.push(acct)
        }
    }
  }
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
  // event scan floor — Lido's 2023 oracle contracts — has no event to replay). Review round 12:
  // a count or member read that FAILS (not "not enumerable") throws — a silently skipped member
  // is a holder lost with no read gap.
  const n = enumerable
  // MS-5: more members than read is never "the members read" — it throws (power.error)
  if (n.ok && Number(n.value) > 200)
    throw new Error(`${contract}: ${n.value} members of role ${role} — more than the 200 read`)
  if (n.ok)
    for (let i = 0; i < Number(n.value); i++) {
      const m = await pathRead(
        client,
        contract,
        FN.getRoleMember,
        'getRoleMember',
        [role, BigInt(i)],
        block,
      )
      if (!m.ok) throw new Error(`getRoleMember(${i}) on ${contract} returned no data`)
      if (!out.includes(m.value.toLowerCase())) out.push(m.value.toLowerCase())
    }
  return out
}

// ---- Aragon (Lido DAO) ----------------------------------------------------------------------------

const aclMemo = new Map() // `${chain}|${address}@${block}` → Promise<{ acl, unread }>

/**
 * The Aragon ACL that governs `a`: the Kernel answers acl(); an app answers kernel() and its
 * Kernel answers acl(). Fail-closed audit (TV-09): { acl, unread } — `unread` when a read FAILED
 * (not a revert / a zero answer): it was null, the same as "not an Aragon app", so an Agent's
 * executors were never confirmed and nothing said so.
 */
export async function aclRead(client, a, block) {
  const k = `${ckey(client, a)}@${block ?? 'head'}`
  if (!aclMemo.has(k))
    aclMemo.set(
      k,
      (async () => {
        const failed = (x) => !x.ok && !x.reverted
        const direct = await tryRead(client, a, fnAbi(FN.acl), 'acl', [], block)
        if (direct.ok && !isZero(direct.value))
          return { acl: direct.value.toLowerCase(), unread: false }
        const kern = await tryRead(client, a, fnAbi(FN.kernel), 'kernel', [], block)
        if (!kern.ok || isZero(kern.value))
          return { acl: null, unread: failed(direct) || failed(kern) }
        const acl = await tryRead(client, kern.value, fnAbi(FN.acl), 'acl', [], block)
        return acl.ok && !isZero(acl.value)
          ? { acl: acl.value.toLowerCase(), unread: false }
          : { acl: null, unread: failed(acl) || acl.ok }
      })(),
    )
  return aclMemo.get(k)
}

/** The ACL of `a`, or null (not an Aragon app, or not read — `aclRead` says which). */
export async function aclOf(client, a, block) {
  return (await aclRead(client, a, block)).acl
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
    aragonExec.set(
      String(agent).toLowerCase(),
      new Set([...cands].map((x) => String(x).toLowerCase())),
    )
}

/** Aragon executor candidates per Agent from replayed (ACL-rewritten) role rows. */
export function aragonExecCandidatesFromRows(rows) {
  const m = new Map()
  const want = new Set(ARAGON_EXEC_ROLES.map((r) => roleHash(r)))
  for (const r of rows)
    if (
      r.event === 'RoleGranted' &&
      r.args?.via === 'ACL' &&
      want.has(String(r.args.role).toLowerCase())
    ) {
      const s = m.get(r.emitter) ?? new Set()
      s.add(String(r.args.account).toLowerCase())
      m.set(r.emitter, s)
    }
  return m
}

/**
 * Resolve a PowerSpec path to holder addresses at head. `trail` (a Set, optional) collects the
 * intermediate hops — the ProxyAdmin of an `eip1967_admin` step before its `owner` — whose own
 * events and queued calls belong to the subject (review round 7).
 *
 * Review round 12 (on-chain #1, HIGH): every step fails CLOSED. A read that fails (transport,
 * timeout, rate limit) THROWS — the collector records `power.error`, a read gap the UQ-30 carry
 * follows — instead of dropping that hop: 59 of 76 declared powers used a step that silently
 * yielded `holders: []`, which dropped the power's AD-3 with no read gap. What a step answers:
 *   owner         the owner; at an intermediate hop with NO owner() (an EOA or a Safe as the
 *                 proxy admin — it reverts or returns no data) the hop itself holds the power;
 *                 on the declared contract itself a missing owner() is an error (misdeclared);
 *   eip1967_admin the admin slot (zero = no admin: nothing);
 *   lz_delegate / call:<fn> / role_admin:<ROLE>   the value; a missing function is an error;
 *   role:<ROLE>   the holders (a count or member read that fails throws, see holdersOf);
 *   acl_manager   the ACL's permission manager (an ACL that cannot be found is an error; a
 *                 zero manager is no holder).
 */
export async function resolvePath(client, { endpoint, contract, path, roleMap, block, trail }) {
  let cur = [contract.toLowerCase()]
  for (const [si, step] of path.entries()) {
    if (si > 0 && trail) for (const c of cur) trail.add(c)
    const next = []
    for (const c of cur) {
      if (step === 'owner') {
        const x = await pathRead(client, c, FN.owner, 'owner', [], block)
        if (x.ok) next.push(x.value.toLowerCase())
        else if (si > 0)
          next.push(c) // an ownerless hop (EOA / Safe admin) acts itself
        else throw new Error(`owner() not present on ${c} (declared path ${path.join('>')})`)
      } else if (step === 'eip1967_admin' || step === 'zos_admin') {
        // fail-closed audit (PH-06): only a 32-byte word answers; a null / short one THROWS (it was
        // "no admin": no holder, no AD-3, no gap)
        const w = await retry(() =>
          storageWord(
            client,
            c,
            step === 'eip1967_admin' ? SLOT.eip1967Admin : SLOT.zosAdmin,
            block,
          ),
        )
        const a = word2addr(w)
        if (a && !isZero(a)) next.push(a)
      } else if (step === 'lz_delegate') {
        const x = await pathRead(client, endpoint, FN.delegates, 'delegates', [c], block)
        if (!x.ok) throw new Error(`delegates(${c}) not present on the endpoint ${endpoint}`)
        next.push(x.value.toLowerCase())
      } else if (step.startsWith('call:')) {
        const fn = step.slice(5).replace('()', '')
        const x = await pathRead(
          client,
          c,
          `function ${fn}() view returns (address)`,
          fn,
          [],
          block,
        )
        if (!x.ok) throw new Error(`${fn}() not present on ${c} (declared path ${path.join('>')})`)
        next.push(x.value.toLowerCase())
      } else if (step.startsWith('role:')) {
        next.push(...(await holdersOf(client, c, roleHash(step.slice(5)), roleMap, block)))
      } else if (step.startsWith('acl_manager:')) {
        // Aragon: the permission MANAGER of (c, ROLE) — it can grant itself the role at will
        // (Lido revokes APP_MANAGER_ROLE between upgrades; its manager is the standing power)
        const acl = await aclOf(client, c, block)
        if (!acl) throw new Error(`the Aragon ACL of ${c} was not read`)
        const x = await pathRead(
          client,
          acl,
          FN.getPermissionManager,
          'getPermissionManager',
          [c, roleHash(step.slice(12))],
          block,
        )
        if (!x.ok) throw new Error(`getPermissionManager not present on the ACL ${acl}`)
        if (!isZero(x.value)) next.push(x.value.toLowerCase())
      } else if (step.startsWith('role_admin:')) {
        // review round 12: read at the block (it read head at every block)
        const x = await pathRead(
          client,
          c,
          FN.getRoleAdmin,
          'getRoleAdmin',
          [roleHash(step.slice(11))],
          block,
        )
        if (!x.ok) throw new Error(`getRoleAdmin not present on ${c}`)
        next.push(...(await holdersOf(client, c, x.value.toLowerCase(), roleMap, block)))
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
  // fail-closed audit (QU-05): an op whose CallScheduled rows have HOLES (a call index never seen —
  // a lost log) is marked: judged on the calls seen, flagged, and never a re-derivation that
  // resolves its previous rows
  const out = [...ops.values()].filter((o) => o.calls.length)
  for (const o of out) {
    const seen = o.calls.filter(Boolean).length
    if (seen !== o.calls.length) o.callsIncomplete = true
  }
  return out
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
 * Who an OZ timelock's execute() is simulated from (fail-closed audit QU-04 / MS-2, 2026-10-10):
 *   { from: [0x…dEaD], confirmed: true }   EXECUTOR_ROLE is open (hasRole(EXECUTOR, 0) READ true);
 *   { from: [h…], confirmed: true }        the candidates whose EXECUTOR_ROLE hasRole confirms at
 *                                          head (`cands`: the replayed EXECUTOR holders);
 *   { from: [], confirmed: false }         neither could be read / confirmed.
 * It fell back to 0x…dEaD when the open-role read failed: the simulation reverted and an ARMED op
 * read "stale — not executable" (no AD-8, out of the pending count). An unconfirmed set is never
 * simulated: the op is "could not be simulated" (armed, fail closed).
 */
export async function timelockExecutors(client, timelock, cands = []) {
  const EXECUTOR = roleHash('EXECUTOR_ROLE')
  const open = await tryRead(client, timelock, fnAbi(FN.hasRole), 'hasRole', [EXECUTOR, ZERO])
  if (open.ok && open.value)
    return { from: ['0x000000000000000000000000000000000000dEaD'], confirmed: true }
  const from = []
  for (const h of cands) {
    const x = await tryRead(client, timelock, fnAbi(FN.hasRole), 'hasRole', [EXECUTOR, h])
    if (x.ok && x.value) from.push(h)
  }
  return from.length ? { from, confirmed: true } : { from: [], confirmed: false }
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
    // Fail-closed review (2026-10-10, rules #7): an op with a call index never seen (QU-05) cannot
    // be hashed or simulated — its calls array has a HOLE (`op.calls[0].target` threw). It stays
    // 'not_run': past its ETA it is treated as executable (armed, unverified)
    if (
      !op.callsIncomplete &&
      op.timestamp !== null &&
      op.timestamp > 1 &&
      op.timestamp <= now &&
      op.predecessorDone
    ) {
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
        // Fail-closed audit (QU-04): only CONFIRMED executors make a revert mean "stale"; an
        // executor set that was not confirmed is "could not be simulated" (armed, fail closed).
        const ex = await executorsOf(op.timelock)
        const set = Array.isArray(ex) ? { from: ex, confirmed: true } : ex
        let result = set.confirmed && set.from.length ? 'revert' : 'error'
        for (const from of set.confirmed ? set.from : []) {
          try {
            await client.call({ account: from, to: op.timelock, data, value })
            result = 'ok'
            break
          } catch (e) {
            if (!isRevertError(e)) result = 'error'
          }
        }
        op.simulation = result
        op.simulatedFrom = set.from
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
    // fail-closed audit (CC-02): a getRebalancer that FAILED (not a revert: a BurnMint pool has
    // none) is marked — it read exactly like "no rebalancer function"
    ...(!reb.ok && !reb.reverted ? { rebalancerUnread: true } : {}),
    chains: [],
  }
  // Review round 12 (rules #3): a chain list that could not be read is not "no chain" — marked,
  // so the card counts a read gap and a rate-limiter / silo breach of the last run is carried
  if (!chains.ok) out.chainsUnread = true
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
    // fail-closed audit (CC-06): whether the chain is siloed was not read — its chain rebalancer
    // is read anyway (it reverts harmlessly on an unsiloed pool), so it can still be judged
    if (siloed || siloed === null) {
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
export async function classifyDgTimelock(client, a, block, depth = 0, seen = new Set()) {
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
  let proposerVoteUnread = false
  const proposers = []
  // ruling #12: the declared proposers are the timelock's schedulers, classified at the block
  // (an Aragon Voting is a token-holder vote; anything else is classified like any controller)
  const schedulers = []
  let schedulersUnread = !governance
  if (governance) {
    const ps = await rd(
      'function getProposers() view returns ((address account, address executor)[])',
      governance,
    )
    if (ps === null) schedulersUnread = true
    const votes = []
    for (const p of ps ?? []) {
      const acct = String(p.account).toLowerCase()
      // UQ-17: the vote being ranked by its holders, met again as a proposer (the Agent's DG
      // path): a reference back, not a fresh classification
      if (seen.has(VOTE_SELF + acct)) {
        proposers.push(acct)
        schedulers.push({ kind: 'aragon_voting', address: acct, selfRef: true })
        continue
      }
      const v = await aragonVotingOf(client, acct, await codeAt(client, acct, block), block)
      proposers.push(acct)
      // fail-closed audit (TV-12): a proposer whose Voting check could not be decided (its
      // implementation not read) is the unread marker AND the vote time is unread
      if (v?.appUnread) {
        proposerVoteUnread = true
        votes.push(0)
        schedulers.push(v)
        continue
      }
      votes.push(v ? v.delaySec : 0)
      if (v) schedulers.push(v)
      else if (seen.has(acct))
        // a proposer already on the control path is a CYCLE (ranked as a plain contract), never
        // dropped (fail-closed audit, TL-13b's Dual Governance twin)
        schedulers.push({
          kind: 'contract',
          address: acct,
          version: 'already on this control path (a cycle): ranked as a plain contract',
        })
      else schedulers.push(await classify(client, acct, block, depth + 1, new Set([...seen, a]), 0))
    }
    if (votes.length) proposerVoteSec = Math.min(...votes)
  }
  // the governance contract's committees and state (undefined when there is no governance read)
  const onGov = async (sig) => (governance ? rd(sig, governance) : null)
  const govAddr = async (fn) => {
    const v = await onGov(`function ${fn}() view returns (address)`)
    return v ? String(v).toLowerCase() : null
  }
  const tb = await onGov(
    'function getTiebreakerDetails() view returns ((bool isTie, address tiebreakerCommittee, uint32 tiebreakerActivationTimeout, address[] sealableWithdrawalBlockers))',
  )
  const st = await onGov('function getEffectiveState() view returns (uint8)')
  return {
    kind: 'aragon_dg',
    address: a,
    schedulers,
    ...(schedulersUnread ? { schedulersUnread: true } : {}),
    delaySec: submit === null ? 0 : Number(submit) + proposerVoteSec,
    dg: {
      proposers,
      proposerVoteSec,
      ...(proposerVoteUnread ? { proposerVoteUnread: true } : {}),
      afterSubmitDelaySec: submit === null ? null : Number(submit),
      afterScheduleDelaySec: schedule === null ? null : Number(schedule),
      governance,
      adminExecutor: await addr('getAdminExecutor'),
      emergencyGovernance: await addr('getEmergencyGovernance'),
      activationCommittee: await addr('getEmergencyActivationCommittee'),
      executionCommittee: await addr('getEmergencyExecutionCommittee'),
      emergencyModeActive:
        (await rd('function isEmergencyModeActive() view returns (bool)')) ?? null,
      emergencyProtectionEndsAfter: em ? Number(em.emergencyProtectionEndsAfter) : null,
      resealCommittee: await govAddr('getResealCommittee'),
      tiebreakerCommittee: tb?.tiebreakerCommittee
        ? String(tb.tiebreakerCommittee).toLowerCase()
        : null,
      proposalsCanceller: await govAddr('getProposalsCanceller'),
      state: st === null ? null : (DG_STATES[Number(st)] ?? `state ${st}`),
    },
  }
}

/** DualGovernance `State` enum (getEffectiveState). */
export const DG_STATES = [
  'Unset',
  'Normal',
  'VetoSignalling',
  'VetoSignallingDeactivation',
  'VetoCooldown',
  'RageQuit',
]

/** Committee fields of a Dual Governance timelock's `dg` (display names, in card order). */
export const DG_COMMITTEES = [
  ['activationCommittee', 'Emergency Activation Committee'],
  ['executionCommittee', 'Emergency Execution Committee'],
  ['resealCommittee', 'Reseal Committee'],
  ['tiebreakerCommittee', 'Tiebreaker Committee'],
  ['proposalsCanceller', 'Proposals canceller'],
]

/**
 * Every Dual Governance committee / canceller address reachable from a controller (through its
 * deferral chain and an Aragon Agent's executors): the collector classifies them at head so the
 * card shows them and their Safe fields are diffed run to run (they hold no declared power, so
 * the power paths never reach them).
 */
export function dgCommitteeAddresses(c, out = new Set(), seen = new Set()) {
  if (!c || typeof c !== 'object' || seen.has(c)) return out
  seen.add(c)
  if (c.kind === 'aragon_dg' && c.dg)
    for (const [k] of DG_COMMITTEES) {
      const a = c.dg[k]
      if (typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a) && !/^0x0{40}$/i.test(a))
        out.add(a.toLowerCase())
    }
  dgCommitteeAddresses(c.ownedBy, out, seen)
  for (const e of c.executors ?? []) dgCommitteeAddresses(e, out, seen)
  return out
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
/**
 * The implementation an Aragon AppProxy serves (fail-closed audit TV-01 / TV-08 / TV-13 / M1):
 *   { absent: true }           not an AppProxy, or implementation() reverts / is zero;
 *   { unread: reason }         the read FAILED (not a revert), or a non-zero implementation with
 *                              no code — it was "not an Aragon app": the Lido Voting / Agent
 *                              classified as a calm plain contract (cached at past blocks), and
 *                              wstETH's AD-3 head breaches through the Agent dropped with no gap;
 *   { impl, implCode }         read.
 */
async function aragonAppImpl(client, a, code, block) {
  if (!isAragonAppProxyCode(code)) return { absent: true }
  const impl = await tryRead(
    client,
    a,
    fnAbi('function implementation() view returns (address)'),
    'implementation',
    [],
    block,
  )
  if (!impl.ok) return impl.reverted ? { absent: true } : { unread: impl.error ?? 'read failed' }
  if (isZero(impl.value)) return { absent: true }
  const implCode = await codeAt(client, impl.value.toLowerCase(), block)
  if (!implCode) return { unread: 'its implementation has no code at the block' }
  return { impl: impl.value.toLowerCase(), implCode }
}

/** The marker of an Aragon app whose implementation was not read (a read gap, never cached). */
const appUnreadNode = (a, why) => ({
  kind: 'contract',
  address: a,
  version: `Aragon app: implementation not read (${String(why).slice(0, 60)})`,
  appUnread: true,
})

export async function aragonVotingOf(client, a, code, block) {
  const app = await aragonAppImpl(client, a, code, block)
  if (app.absent) return undefined
  if (app.unread) return appUnreadNode(a, app.unread)
  const implCode = app.implCode
  if (!ARAGON_VOTING_CODE.every((x) => dispatches(implCode, x))) return undefined
  const vt = await tryRead(
    client,
    a,
    fnAbi('function voteTime() view returns (uint64)'),
    'voteTime',
    [],
    block,
  )
  const op = await tryRead(
    client,
    a,
    fnAbi('function objectionPhaseTime() view returns (uint64)'),
    'objectionPhaseTime',
    [],
    block,
  )
  return {
    kind: 'aragon_voting',
    address: a,
    delaySec: vt.ok ? Number(vt.value) : 0,
    voting: {
      voteTimeSec: vt.ok ? Number(vt.value) : null,
      objectionPhaseSec: op.ok ? Number(op.value) : null,
      // UQ-17: the token and thresholds at the block (holders: `enrichTokenVotes`)
      ...(await votingParams(client, a, block)),
    },
  }
}

/** Marker in a classification's `seen` set: the vote whose holders are being classified. */
export const VOTE_SELF = 'vote-self:'

/**
 * UQ-17: an Aragon Voting app's token and thresholds at `block` (1e18 = 100%, decimal strings).
 * A threshold that cannot be read is null (the holder concentration is then unread: fail closed).
 */
export async function votingParams(client, a, block) {
  // one eth_call each: a revert (no such view) answers at once
  const rd = (sig) => readOnce(client, a, sig, sig.match(/function (\w+)/)[1], [], block)
  const tok = await rd('function token() view returns (address)')
  const sup = await rd('function supportRequiredPct() view returns (uint64)')
  const quo = await rd('function minAcceptQuorumPct() view returns (uint64)')
  return {
    ...(tok.ok && !isZero(tok.value) ? { token: String(tok.value).toLowerCase() } : {}),
    supportRequiredPct: sup.ok ? String(sup.value) : null,
    minAcceptQuorumPct: quo.ok ? String(quo.value) : null,
  }
}

/** UQ-25: the trailing window of votes a token vote's opposition is averaged over (365 days). */
export const DEFENSE_WINDOW_SEC = 365 * 86_400
/**
 * Aragon Voting `getVote`, static head only: Lido's Voting returns an extra trailing `phase`
 * word after the dynamic `script`, which decoding the first nine words ignores — one ABI for both.
 */
export const GET_VOTE_SIG =
  'function getVote(uint256) view returns (bool open, bool executed, uint64 startDate, uint64 snapshotBlock, uint64 supportRequired, uint64 minAcceptQuorum, uint256 yea, uint256 nay, uint256 votingPower)'
const VOTE_BATCH = 25

/** getVote(id) at `block` for each id → [{ id, startDate, nay }]; any failure THROWS (fail closed). */
async function readVotes(client, app, ids, block) {
  const abi = fnAbi(GET_VOTE_SIG)
  // review round 11 (RV11-2): a vote's stakes cannot exceed its own voting power (the supply at
  // its snapshot); more is a misread (a word or unit mix-up) — refused, the history is unread
  const one = (r, id) => {
    const yea = BigInt(r[6])
    const nay = BigInt(r[7])
    if (yea + nay > BigInt(r[8])) throw new Error(`getVote(${id}): stakes exceed its voting power`)
    return { id, startDate: Number(r[2]), nay }
  }
  if (block === undefined || block >= MULTICALL3_BLOCK) {
    const res = await retry(() =>
      client.multicall({
        contracts: ids.map((id) => ({
          address: app,
          abi,
          functionName: 'getVote',
          args: [BigInt(id)],
        })),
        allowFailure: true,
        blockNumber: block === undefined ? undefined : BigInt(block),
      }),
    )
    return res.map((x, i) => {
      if (x.status !== 'success') throw new Error(`getVote(${ids[i]}) failed`)
      return one(x.result, ids[i])
    })
  }
  // before Multicall3 (review round 10, R-7): one eth_call per vote
  const out = []
  for (const id of ids) {
    const r = await retry(
      () =>
        client.readContract({
          address: app,
          abi,
          functionName: 'getVote',
          args: [BigInt(id)],
          blockNumber: BigInt(block),
        }),
      3,
      300,
    )
    out.push(one(r, id))
  }
  return out
}

/**
 * Owner ruling 2026-10-09 (UQ-25): the AVERAGE OPPOSITION of an Aragon Voting app's trailing
 * year at `block` (timestamp `blockTs`): every vote STARTED in (blockTs − window, blockTs], its
 * nay stake read at the block (getVote; a vote still open counts with its nays so far — fewer
 * nays, the fail-closed side), and their mean D (a vote with no nays counts as 0; no vote in the
 * window = 0, fail closed). Vote ids rise with their start dates, so the votes are read newest
 * first until one started before the window. Any read that fails THROWS: the caller records the
 * history as unread (a read gap).
 */
export async function voteDefense(client, app, block, blockTs, windowSec = DEFENSE_WINDOW_SEC) {
  if (!Number.isFinite(blockTs) || blockTs <= 0) throw new Error('block timestamp not read')
  const len = await readOnce(
    client,
    app,
    'function votesLength() view returns (uint256)',
    'votesLength',
    [],
    block,
  )
  if (!len.ok) throw new Error(`votesLength not read (${len.error})`)
  const n = Number(len.value)
  const fromTs = blockTs - windowSec
  let naySum = 0n
  let votes = 0
  let firstId = null
  let lastId = null
  outer: for (let hi = n - 1; hi >= 0; hi -= VOTE_BATCH) {
    const ids = []
    for (let id = hi; id >= Math.max(0, hi - VOTE_BATCH + 1); id--) ids.push(id)
    for (const v of await readVotes(client, app, ids, block)) {
      if (v.startDate <= fromTs) break outer
      if (v.startDate > blockTs) throw new Error(`vote ${v.id} starts after the block`)
      naySum += v.nay
      votes++
      lastId ??= v.id
      firstId = v.id
    }
  }
  return {
    windowSec,
    fromTs,
    toTs: blockTs,
    votes,
    naySum: String(naySum),
    mean: String(votes ? naySum / BigInt(votes) : 0n),
    ...(votes ? { firstId, lastId } : {}),
  }
}

/** Every Aragon Voting node (not a back-reference) in a controller tree. */
export function votingNodes(c, out = [], seen = new Set()) {
  if (!c || typeof c !== 'object' || seen.has(c)) return out
  seen.add(c)
  if (c.kind === 'aragon_voting' && !c.selfRef) out.push(c)
  for (const x of [
    c.ownedBy,
    ...(c.executors ?? []),
    ...(c.schedulers ?? []),
    ...(c.bypass?.holderCtls ?? []),
    ...(c.dsAuthority?.callers ?? []),
  ])
    votingNodes(x, out, seen)
  return out
}

/**
 * UQ-17 (owner ruling 2026-10-08): give every Aragon Voting node in `controllers` (keyed
 * `${address}@${block}` or `${address}@head`) its HOLDER CONCENTRATION at that block: the
 * voting token's supply and largest holders (`snapshotsFor(token, blocks)` → Map(block → snap)),
 * each holder classified at the block with the vote marked (a holder whose control leads back to
 * the vote is a back-reference: no independent voter). Holders are examined largest first until
 * `decide` (rules.ts `tokenVoteDecision`) settles the decision — review round 10 (R-1): past
 * the top k, until a holder is examined that is in no passing set of k (the vote ranks as the
 * WEAKEST such set), or, for k = 1, a key passes alone; at head (`exactK`) a broad vote until k
 * itself is found, so it can be reported. A failure is recorded as `holdersUnread` (a read gap,
 * fail closed); a holder whose classification fails is kept without `ctl` (a read gap where it
 * decides the rank). A node that already carries holders (a cached past-block classification)
 * is left as it is unless `needsHolders(node)` (rules.ts `tokenVoteNeedsHolders`): not settled
 * under the current rule, or a holder that decides the rank not classified — read again.
 *
 * Owner ruling 2026-10-09 (UQ-25): before its holders, each vote gets its trailing-year
 * opposition (`defenseFor(app, block)` → rules `voting.defense`, the mean nay stake D of the
 * votes started in the 365 days before the block); a failure is recorded as `defenseUnread` (a
 * read gap). A cached node without it is read again; the holders it had already classified at
 * that block are reused (a classification at a block does not depend on the vote rule).
 */
export async function enrichTokenVotes(
  client,
  controllers,
  {
    head,
    snapshotsFor,
    decide,
    needsHolders = null,
    // (app, block) => Promise<VoteDefense>; typed for the TS callers (allowJs infers `null`)
    defenseFor = /** @type {any} */ (null),
    log = () => {},
  },
) {
  const jobs = []
  // holder classifications already made at a block for a vote (cached nodes being re-read)
  const known = new Map()
  for (const [k, c] of Object.entries(controllers)) {
    const at = k.endsWith('@head') ? head : Number(k.split('@')[1])
    if (!Number.isFinite(at)) continue
    for (const v of votingNodes(c))
      // a cached node keeps its holders only while they still decide k under the current rules
      // (a rule change that needs more holders re-reads them instead of reading as a gap)
      if (
        (v.delaySec ?? 0) > 0 &&
        (!v.voting?.holders ||
          decide(v).kind === 'unread' ||
          (needsHolders ? needsHolders(v) : unsettled(decide(v))) ||
          // TV-14: a holder classified with a read failure inside is read again
          v.voting.holders.some((h) => h.ctl && hasReadFailure(h.ctl)))
      ) {
        for (const h of v.voting?.holders ?? [])
          if (h.ctl && !hasReadFailure(h.ctl)) known.set(`${h.address}@${at}@${v.address}`, h.ctl)
        if (v.voting)
          for (const f of ['holders', 'truncated', 'holdersUnread', 'defense', 'defenseUnread'])
            delete v.voting[f]
        jobs.push({ v, at, head: k.endsWith('@head') })
      }
  }
  if (!jobs.length) return 0
  // token + thresholds (a cached classification predates them: read at the block)
  for (const j of jobs) {
    if (!j.v.voting) j.v.voting = { voteTimeSec: j.v.delaySec ?? null, objectionPhaseSec: null }
    // TV-03: either threshold missing is read again (a null support threshold was never re-read)
    if (
      !j.v.voting.token ||
      j.v.voting.minAcceptQuorumPct == null ||
      j.v.voting.supportRequiredPct == null
    )
      Object.assign(j.v.voting, await votingParams(client, j.v.address, j.at))
    // UQ-25: the opposition the holders are judged against (unread = a read gap, fail closed)
    if (!defenseFor) j.v.voting.defenseUnread = 'no vote-history reader'
    else
      try {
        j.v.voting.defense = await defenseFor(j.v.address, j.at)
      } catch (e) {
        j.v.voting.defenseUnread = String(e?.message ?? e).slice(0, 80)
      }
  }
  const byToken = new Map()
  for (const j of jobs) {
    if (!j.v.voting.token) {
      j.v.voting.holdersUnread = 'voting token not read'
      continue
    }
    // UQ-25: no holder snapshot for a vote whose history is unread (a read gap either way — a
    // new block would cost a full pass over the token's Transfer logs for nothing)
    if (j.v.voting.defenseUnread) continue
    const t = j.v.voting.token
    byToken.set(t, [...(byToken.get(t) ?? []), j])
  }
  for (const [token, js] of byToken) {
    let snaps
    try {
      snaps = await snapshotsFor(
        token,
        js.map((j) => j.at),
      )
    } catch (e) {
      for (const j of js)
        j.v.voting.holdersUnread = `holder snapshots failed (${String(e?.message ?? e).slice(0, 80)})`
      continue
    }
    // one classification per (holder, block, vote)
    const memo = new Map()
    for (const j of js) {
      const snap = snaps.get(j.at)
      if (!snap || snap.error) {
        j.v.voting.holdersUnread = snap?.error ?? 'holder snapshot missing'
        continue
      }
      const vt = j.v.voting
      vt.supply = snap.supply
      vt.holderCount = snap.holderCount
      // UQ-25: with the vote history unread no holder set decides the rank (a read gap either
      // way) — classifying the whole top-50 at the block would buy nothing
      if (vt.defenseUnread) continue
      vt.holders = []
      vt.truncated = true
      for (const [i, [addr, bal]] of snap.top.entries()) {
        const mk = `${addr}@${j.at}@${j.v.address}`
        if (!memo.has(mk))
          memo.set(
            mk,
            known.has(mk)
              ? Promise.resolve(known.get(mk))
              : classify(client, addr, j.at, 0, new Set([VOTE_SELF + j.v.address]), 0).catch(
                  () => undefined,
                ),
          )
        const ctl = await memo.get(mk)
        vt.holders.push({ address: addr, balance: bal, ...(ctl ? { ctl } : {}) })
        vt.truncated = i < snap.top.length - 1 || snap.holderCount > snap.top.length
        const d = decide(j.v)
        // review round 10 (R-1): k found is not enough — until the WEAKEST passing set is settled
        if ((d.kind === 'one' || d.kind === 'few') && d.settled !== false) break
        if (d.kind === 'broad' && (d.k !== null || !j.head)) break
      }
    }
    log(`  token vote ${token.slice(0, 10)}…: ${js.length} classification(s) given holder data`)
  }
  return jobs.length
}

/** A one / few decision whose weakest passing set is not settled (or a holder in it unclassified). */
const unsettled = (d) =>
  (d.kind === 'one' || d.kind === 'few') &&
  (d.settled === false || (d.holders ?? []).some((h) => !h.ctl))

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
  const app = await aragonAppImpl(client, a, code, block)
  if (app.absent) return undefined
  if (app.unread) return appUnreadNode(a, app.unread)
  const implCode = app.implCode
  if (!ARAGON_AGENT_CODE.every((x) => dispatches(implCode, x))) return undefined
  const { acl } = await aclRead(client, a, block)
  const holders = []
  // fail-closed audit (TV-09 / M2): a permission that could not be read keeps its candidate (the
  // head side stays as weak) AND marks the Agent unconfirmed — a read gap, so a change FROM it is
  // never an upgrade and the classification is never cached (a revoked candidate kept silently
  // made a move away from the Agent read UPGRADE)
  let unconfirmed = !acl
  for (const cand of chainOf(client) === 1 ? (aragonExec.get(a) ?? []) : []) {
    let held = false
    for (const role of ARAGON_EXEC_ROLES) {
      const x = acl
        ? await tryRead(
            client,
            acl,
            fnAbi(FN.aclHasPermission),
            'hasPermission',
            [cand, a, roleHash(role)],
            block,
          )
        : { ok: false }
      if (!x.ok) unconfirmed = true
      if (!x.ok || x.value) held = true
    }
    if (held) holders.push(cand)
  }
  const c = { kind: 'contract', address: a, version: 'Aragon Agent' }
  if (unconfirmed && holders.length) c.executorsUnconfirmed = true
  // the executors are the Agent's controllers: they do not use up the owner-recursion depth
  const executors = []
  for (const h of holders)
    if (!seen.has(h)) executors.push(await classify(client, h, block, depth, new Set([...seen, a])))
  if (executors.length) c.executors = executors
  if (executors.length === 1) c.ownedBy = executors[0]
  else if (!executors.length) {
    c.version = 'Aragon Agent: no executor found — ranked as a plain contract'
    // Review round 12 (rules #4): no executor FOUND is not "nobody can execute" — the candidates
    // come from the ACL event scan, which can lose a chunk. A read gap (fail closed), as a
    // timelock with no proposer candidate is; it was a plain contract with no gap, so on wstETH
    // (≈ 40 of 42 head breaches go through Agent 0x3e40…) one lost scan dropped them silently.
    // An executor that is only on this control path (a cycle) is not a read failure.
    if (!holders.length) c.executorsUnread = true
  }
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
    timestamp = Math.max(
      sub + afterSubmitDelaySec + afterScheduleDelaySec,
      now + afterScheduleDelaySec,
    )
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
export async function readDgProposals(client, ept, { now } = {}) {
  const a = ept.toLowerCase()
  const n = await tryRead(client, a, DG_ABI.getProposalsCount, 'getProposalsCount')
  if (!n.ok) return { timelock: a, status: 'unavailable', note: n.error, ops: [] }
  // Fail-closed audit (DG-07, 2026-10-10): the two delays are read directly (a proposer
  // classification that threw aborted the run), and EVERY proposal id is read — the newest 200
  // only returned status 'ok' while an older proposal still submitted / scheduled was dropped,
  // and its red queue row with it. A delay not read leaves the ETA unread (fail closed).
  const delay = async (fn) => {
    const x = await tryRead(client, a, fnAbi(`function ${fn}() view returns (uint32)`), fn)
    return x.ok ? Number(x.value) : null
  }
  const c = {
    dg: {
      afterSubmitDelaySec: await delay('getAfterSubmitDelay'),
      afterScheduleDelaySec: await delay('getAfterScheduleDelay'),
    },
  }
  const count = Number(n.value)
  const ops = []
  for (let id = 1; id <= count; id++) {
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
          data: encodeFunctionData({
            abi: DG_ABI.execute,
            functionName: 'execute',
            args: [BigInt(id)],
          }),
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
  getPeer: fnAbi(
    'function getPeer(uint16) view returns ((bytes32 peerAddress, uint8 tokenDecimals))',
  ),
  getTransceiverType: fnAbi('function getTransceiverType() view returns (string)'),
  getWormholePeer: fnAbi('function getWormholePeer(uint16) view returns (bytes32)'),
}

/**
 * Head state of a Wormhole NTT manager: threshold, transceivers (and the verifier network each
 * one runs on: getTransceiverType()), peers of the chains its events named, owner / pauser, and
 * the token balance it locks (mode 0 = LOCKING). Unread fields are null (the engine says so).
 */
/**
 * `chains` = the Wormhole chains the PeerUpdated scan named (every one is kept, zero peers
 * included); `sweep` = more chains read whatever the scan found (review round 8: a false-empty
 * getLogs chunk left `peers` empty and switched the floor off) — a sweep chain is kept only when
 * its peer is set or could not be read (an unread peer is a read gap, never "no route").
 */
export async function readNtt(client, manager, chains = [], sweep = []) {
  const m = manager.toLowerCase()
  const rd = async (abi, fn, args = [], to = m) => {
    const x = await tryRead(client, to, abi, fn, args)
    return x.ok ? x.value : null
  }
  const lcA = (v) => (v ? String(v).toLowerCase() : null)
  const threshold = await rd(NTT_ABI.getThreshold, 'getThreshold')
  const txs = await rd(NTT_ABI.getTransceivers, 'getTransceivers')
  const peers = {}
  // fail-closed audit (queue setPeer, NB-02): the swept chains READ as zero are recorded — a chain
  // absent from `peers` is then known to be read, never assumed "no peer"
  const peersReadZero = []
  const named = new Set(chains.map(Number))
  for (const ch of [...named, ...sweep.map(Number).filter((c) => !named.has(c))]) {
    const p = await rd(NTT_ABI.getPeer, 'getPeer', [ch])
    const v = p
      ? { peer: String(p.peerAddress).toLowerCase(), decimals: Number(p.tokenDecimals) }
      : null
    if (!named.has(ch) && v && /^0x0*$/.test(v.peer)) {
      peersReadZero.push(ch)
      continue
    }
    peers[ch] = v
  }
  const transceivers = []
  for (const t of txs ?? []) {
    const type = await rd(NTT_ABI.getTransceiverType, 'getTransceiverType', [], t)
    const tPeers = {}
    if (type === 'wormhole')
      for (const ch of Object.keys(peers).map(Number)) {
        const p = await rd(NTT_ABI.getWormholePeer, 'getWormholePeer', [ch], t)
        tPeers[ch] = p ? String(p).toLowerCase() : null
      }
    transceivers.push({ address: t.toLowerCase(), type: type ? String(type) : null, peers: tPeers })
  }
  const token = lcA(await rd(NTT_ABI.token, 'token'))
  const mode = await rd(NTT_ABI.getMode, 'getMode')
  let locked = null
  // fail-closed audit (NB-04): Number(null) === 0 read an unread mode as LOCKING, and a balance of
  // 0 as the value at risk (fully read, tier 2) — an unread mode leaves the balance unread
  if (token && mode !== null && Number(mode) === 0) {
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
    peersReadZero,
  }
}

// ---- Wormhole NTT: the remote side of a route (another chain, public RPC, head) -----------------

/** Ethereum's Wormhole chain id (the remote manager's peer for Ethereum is read under it). */
export const WORMHOLE_ETHEREUM = 2
/**
 * Wormhole chain id → EVM chain id (wormhole-foundation/wormhole, sdk constants). A peer on a
 * chain not listed here is NOT read (remote_unread, says why): never guessed.
 */
export const WORMHOLE_EVM_CHAINS = Object.freeze({
  2: 1,
  4: 56,
  5: 137,
  6: 43114,
  10: 250,
  14: 42220,
  16: 1284,
  23: 42161,
  24: 10,
  30: 8453,
  34: 534352,
  35: 5000,
  36: 81457,
  38: 59144,
})

/**
 * The EVM chains of the live peers of an NTT manager read at head: [{ wormholeChainId, chainId,
 * peer }] (chainId null = not an EVM chain this module maps). Zeroed peers are not routes.
 */
export function nttRemoteTargets(ntt) {
  return Object.entries(ntt?.peers ?? {})
    .filter(([, p]) => p && !/^0x0*$/i.test(p.peer))
    .map(([wc, p]) => ({
      wormholeChainId: Number(wc),
      chainId: WORMHOLE_EVM_CHAINS[Number(wc)] ?? null,
      peer: String(p.peer).toLowerCase(),
    }))
}

/**
 * Head state of the REMOTE side of a Wormhole NTT route (the peer manager on another chain),
 * read with that chain's client: its threshold and transceivers (the floor binds there too: a
 * message forged on the remote side mints there, and the remote owner can upgrade the remote
 * manager / transceivers into emitting messages the Ethereum side releases on), its peer back to
 * Ethereum, owner / pauser classified ON THAT CHAIN, and the bridged supply of its token
 * (burning mode: totalSupply — the severity rank, owner ruling #9). Never throws for a read
 * failure: an unread side is { status: 'remote_unread', reason }.
 */
export async function readNttRemote(rc, { wormholeChainId, chainId, chainKey, peer }) {
  const base = { wormholeChainId, chainId, chainKey: chainKey ?? null }
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(String(peer)))
    return { ...base, status: 'remote_unread', reason: 'peer is not a right-aligned EVM address' }
  const manager = '0x' + String(peer).slice(-40).toLowerCase()
  const n = await readNtt(rc, manager, [WORMHOLE_ETHEREUM])
  if (n.threshold === null && n.transceivers === null && n.owner === null)
    return {
      ...base,
      manager,
      status: 'remote_unread',
      reason: 'every remote read failed (public RPCs)',
    }
  let supply = null
  let supplyNote
  if (n.token && n.mode === 'burning') {
    const s = await tryRead(rc, n.token, fnAbi(FN.totalSupply), 'totalSupply')
    const d = s.ok ? await tryRead(rc, n.token, fnAbi(FN.decimals), 'decimals') : null
    if (s.ok && d?.ok) supply = { raw: String(s.value), decimals: Number(d.value) }
    else supplyNote = `token supply not read (${s.ok ? d?.error : s.error})`
  } else
    supplyNote =
      n.mode === 'locking'
        ? 'the remote manager LOCKS (hub side): its supply is not the bridged amount'
        : 'token / mode not read'
  const cls = async (a) => {
    if (!a) return null
    try {
      return await classify(rc, a)
    } catch {
      // fail-closed audit (RC-09): a NOT CLASSIFIED marker the rules know (a read gap, ranked as a
      // plain contract) — it was a calm plain contract: no AD-3, no gap, the carry dropped it
      return {
        kind: 'contract',
        address: a.toLowerCase(),
        version: `not classified on ${chainKey ?? chainId}`,
      }
    }
  }
  return {
    ...base,
    status: 'ok',
    manager,
    token: n.token,
    mode: n.mode,
    threshold: n.threshold,
    transceivers: n.transceivers,
    peerBack: n.peers[WORMHOLE_ETHEREUM] ?? null,
    owner: await cls(n.owner),
    pauser: await cls(n.pauser),
    paused: n.paused,
    supply,
    ...(supplyNote ? { supplyNote } : {}),
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

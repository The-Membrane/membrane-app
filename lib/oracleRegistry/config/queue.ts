// Pending and proposed changes: OZ timelock operations (on-chain, PENDING / ARMED) and Safe
// Transaction Service proposals (off-chain, PROPOSED), decoded call by call and judged by the
// same rules as executed history — against the HEAD state the call would change.
//
// getTimestamp(id): 0 = unset/cancelled, 1 = executed, ≤ now = ready, > now = pending.
// A ready op counts as ARMED only when its predecessor is done AND an eth_call of
// execute/executeBatch from an executor succeeds (critique fix: removes false reds among
// stale ops). Only an ARMED op can trigger AD-8; an op whose execute REVERTS is tagged.
// Reads fail CLOSED: a getTimestamp that could not be read keeps the op listed (never
// "cancelled"), and a ready op whose execute could not be simulated (salt not recovered, RPC
// error — not a revert) counts as armed, tagged not_simulated.
//
// The calls of one op / proposal are judged IN ORDER against a working copy of head: a batch
// that moves a closed route back to a library and then weakens that library's config is seen
// as the reopening it is (each call against the state the previous calls left).

import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  type Hex as VHex,
} from 'viem'
import type {
  AnnouncementStatus,
  ChangeTag,
  ConfigChange,
  Controller,
  ParamSpec,
  RouteState,
  Stage,
  UlnConfigRaw,
} from './types'
import { compareRoute, routeDiffers } from './bridgeRules'
import {
  compactRoute,
  peerText,
  routeChangeDisplays,
  routeInputsFromState,
  type LzReplayState,
} from './lzReplay'
import {
  MINT_ROLES,
  PAUSE_ROLES,
  applyGrantPattern,
  classifyCcip,
  classifyControllerChange,
  classifyDelayChange,
  classifyMultisigChange,
  classifyNttThreshold,
  classifyNttTransceiverAdded,
  classifyParamChange,
  classifyPeerChange,
  classifyPauserChange,
  classifyRoleGrant,
  classifySafeModuleChange,
  classifyWhitelistChange,
  describeController,
  down,
  grantPattern,
  isEoaControlled,
  isRed,
  neutral,
  nttEffective,
  tag,
  up,
  verificationRule,
  type GrantRecord,
  type Verdict,
  type WhitelistReach,
} from './rules'
import {
  evaluateRoute,
  isZeroPeer,
  lc,
  mergeUln,
  routeVerifies,
  ZERO_ADDRESS,
  type EvalCtx,
  type RouteInputs,
} from './uln'
import { formatParamAmount } from './value'

const ABI = parseAbi([
  'function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)',
  'function setPeer(uint32 eid, bytes32 peer)',
  'function setDelegate(address delegate)',
  'function upgradeTo(address impl)',
  'function upgradeToAndCall(address impl, bytes data)',
  'function upgrade(address proxy, address impl)',
  'function upgradeAndCall(address proxy, address impl, bytes data)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function transferOwnership(address newOwner)',
  'function updateDelay(uint256 newDelay)',
  'function setProvider(address provider)',
  'function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)',
  'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)',
  'function multiSend(bytes transactions)',
  // timelock bypass paths (execute with no delay): Ethena whitelist, Chainlink RBACTimelock
  'function executeWhitelisted(address target, uint256 value, bytes data)',
  'function executeWhitelistedBatch(address[] targets, uint256[] values, bytes[] payloads)',
  'function bypasserExecuteBatch((address target, uint256 value, bytes data)[] calls)',
  // EndpointV2 (called by the OApp's delegate; the OApp is the first argument)
  'function setSendLibrary(address oapp, uint32 eid, address newLib)',
  'function setReceiveLibrary(address oapp, uint32 eid, address newLib, uint256 gracePeriod)',
  'function setReceiveLibraryTimeout(address oapp, uint32 eid, address lib, uint256 expiry)',
  // Safe OwnerManager / ModuleManager / GuardManager / FallbackManager (self-calls)
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function changeThreshold(uint256 _threshold)',
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function setGuard(address guard)',
  'function setModuleGuard(address moduleGuard)',
  'function setFallbackHandler(address handler)',
  // legacy Gnosis MultiSigWallet self-calls (WBTC Controller / Members owners)
  'function addOwner(address owner)',
  'function removeOwner(address owner)',
  'function replaceOwner(address owner, address newOwner)',
  'function changeRequirement(uint256 _required)',
  // CCIP token pool 1.5.1: a remote pool ADDED to a chain (several are accepted at once)
  'function addRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)',
  // CCIP token pools 1.5.0 / 1.5.1 / 1.6 and the TokenAdminRegistry (review round 5: an armed
  // re-point, rate-limiter switch-off or rebalancer move read "call not decoded")
  'function removeRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)',
  'function setRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)',
  'function setChainRateLimiterConfig(uint64 remoteChainSelector, (bool isEnabled, uint128 capacity, uint128 rate) outboundConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundConfig)',
  'function setChainRateLimiterConfigs(uint64[] remoteChainSelectors, (bool isEnabled, uint128 capacity, uint128 rate)[] outboundConfigs, (bool isEnabled, uint128 capacity, uint128 rate)[] inboundConfigs)',
  'function applyChainUpdates(uint64[] remoteChainSelectorsToRemove, (uint64 remoteChainSelector, bytes[] remotePoolAddresses, bytes remoteTokenAddress, (bool isEnabled, uint128 capacity, uint128 rate) outboundRateLimiterConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundRateLimiterConfig)[] chainsToAdd)',
  'function applyChainUpdates((uint64 remoteChainSelector, bool allowed, bytes remotePoolAddress, bytes remoteTokenAddress, (bool isEnabled, uint128 capacity, uint128 rate) outboundRateLimiterConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundRateLimiterConfig)[] chains)',
  'function setRebalancer(address rebalancer)',
  'function setSiloRebalancer(uint64 remoteChainSelector, address newRebalancer)',
  'function updateSiloDesignations(uint64[] removes, (uint64 remoteChainSelector, address rebalancer)[] adds)',
  'function setPool(address localToken, address pool)',
  'function transferAdminRole(address localToken, address newAdmin)',
  'function renounceRole(bytes32 role, address account)',
  // review round 6: a ProxyAdmin handing a proxy to a new admin; a contract registry re-point
  // (Kelp LRTConfig.setContract); the Ethena timelock's no-delay whitelist
  'function changeProxyAdmin(address proxy, address newAdmin)',
  'function setContract(bytes32 contractKey, address contractAddress)',
  'function addToWhitelist(address target, bytes4 selector)',
  'function removeFromWhitelist(address target, bytes4 selector)',
  // Aragon (Lido DAO): the Agent runs an EVMScript (forward) or one call (execute); the ACL and
  // the Kernel calls a Dual Governance proposal makes through it
  'function forward(bytes evmScript)',
  'function execute(address target, uint256 ethValue, bytes data)',
  'function grantPermission(address entity, address app, bytes32 role)',
  'function revokePermission(address entity, address app, bytes32 role)',
  'function createPermission(address entity, address app, bytes32 role, address manager)',
  'function setPermissionManager(address newManager, address app, bytes32 role)',
  'function setApp(bytes32 namespace, bytes32 appId, address app)',
  // review round 8: Wormhole NTT manager / transceiver admin calls (an armed threshold cut, a
  // transceiver removed or a peer re-point read "call not decoded") and the NTT one-argument
  // upgrade; Safe <= 1.1.1 singleton swap
  'function setThreshold(uint8 threshold)',
  'function setTransceiver(address transceiver)',
  'function removeTransceiver(address transceiver)',
  'function setPeer(uint16 peerChainId, bytes32 peerContract, uint8 decimals, uint256 inboundLimit)',
  'function setWormholePeer(uint16 chainId, bytes32 peerContract)',
  'function setAxelarChainId(uint16 chainId, string axelarChainId, string transceiverAddress)',
  'function upgrade(address newImplementation)',
  'function changeMasterCopy(address _masterCopy)',
])
const ROLE_ABI = parseAbi([
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function upgradeTo(address impl)',
])
/** Aragon Kernel namespace of app implementations (keccak256("base")). */
const ARAGON_BASE_NS = '0xf1f3eb40f5bc1ad1344716ced8b8a0431d840b5783aea1fd01786bc26f35ac0f'

/**
 * Aragon EVMScript, CallsScript spec 1 (what the Agent's forward(bytes) and Aragon votes run):
 * 0x00000001, then per call the target (20 bytes), the calldata length (uint32) and the
 * calldata. null when the script is not spec 1 or is truncated (never a partial list).
 */
export function decodeEvmScript(script: string): Call[] | null {
  const h = String(script ?? '')
    .toLowerCase()
    .replace(/^0x/, '')
  if (!h.startsWith('00000001')) return null
  const calls: Call[] = []
  let i = 8
  while (i < h.length) {
    if (i + 48 > h.length) return null
    const target = '0x' + h.slice(i, i + 40)
    const len = parseInt(h.slice(i + 40, i + 48), 16)
    const start = i + 48
    if (start + len * 2 > h.length) return null
    calls.push({ target, value: '0', data: '0x' + h.slice(start, start + len * 2) })
    i = start + len * 2
  }
  return calls
}

/**
 * Aragon ACL / Kernel calls → the calls the queue already judges, on the APP they act on:
 * grantPermission / createPermission → grantRole on the app, revokePermission → revokeRole, and
 * Kernel setApp(base, appId, impl) → upgradeTo(impl) on every app proxy with that appId
 * (`appProxies`; a setApp for another app stays as it is). Pure.
 */
export function aragonCalls(
  calls: Call[],
  appProxies: Record<string, string[]> = {},
  /**
   * Fail-closed audit (TV-10): the app mapping is INCOMPLETE (a kernel() / appId() read failed):
   * a setApp(base) whose appId maps to no known proxy is judged as an upgrade on the Kernel (an
   * upgrade of an unknown app — AD-9 / AD-8), never a plain "setApp" call (neutral).
   */
  opts: { unmappedAsUpgrade?: boolean } = {},
): Call[] {
  const out: Call[] = []
  for (const c of calls) {
    const d = decodeCall(c.data)
    if (
      d &&
      (d.fn === 'grantPermission' || d.fn === 'createPermission' || d.fn === 'revokePermission')
    ) {
      const [entity, app, role] = d.args as [string, string, string]
      out.push({
        target: lc(app),
        value: '0',
        data: encodeFunctionData({
          abi: ROLE_ABI,
          functionName: d.fn === 'revokePermission' ? 'revokeRole' : 'grantRole',
          args: [role as VHex, entity as VHex],
        }),
      })
    } else if (d && d.fn === 'setApp' && lc(d.args[0] as string) === ARAGON_BASE_NS) {
      const proxies = appProxies[lc(d.args[1] as string)] ?? []
      if (!proxies.length)
        out.push(
          opts.unmappedAsUpgrade
            ? {
                target: lc(c.target),
                value: '0',
                data: encodeFunctionData({
                  abi: ROLE_ABI,
                  functionName: 'upgradeTo',
                  args: [d.args[2] as VHex],
                }),
              }
            : c,
        )
      for (const p of proxies)
        out.push({
          target: lc(p),
          value: '0',
          data: encodeFunctionData({
            abi: ROLE_ABI,
            functionName: 'upgradeTo',
            args: [d.args[2] as VHex],
          }),
        })
    } else out.push(c)
  }
  return out
}
const ENDPOINT_FNS = new Set([
  'setConfig',
  'setSendLibrary',
  'setReceiveLibrary',
  'setReceiveLibraryTimeout',
])
const ULN_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'confirmations', type: 'uint64' },
      { name: 'requiredDVNCount', type: 'uint8' },
      { name: 'optionalDVNCount', type: 'uint8' },
      { name: 'optionalDVNThreshold', type: 'uint8' },
      { name: 'requiredDVNs', type: 'address[]' },
      { name: 'optionalDVNs', type: 'address[]' },
    ],
  },
] as const

/** `operation` (Safe): 0 CALL, 1 DELEGATECALL (runs the target's code AS the Safe); absent = unknown. */
export type Call = { target: string; value: string; data: string; operation?: number }

/**
 * Libraries a Safe DELEGATECALLs as a matter of course (Safe deployments on Ethereum): MultiSend /
 * MultiSendCallOnly 1.1.1–1.4.1 and SignMessageLib. A delegatecall to anything else runs foreign
 * code as the Safe — it can rewrite the singleton, owners, modules or guard (the Bybit pattern).
 */
export const SAFE_DELEGATE_LIBS = new Set(
  [
    '0x8d29be29923b68abfdd21e541b9374737b49cdad',
    '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761',
    '0x998739bfdaadde7c933b942a68053933098f9eda',
    '0x40a2accbd92bca938b02010e17a5b8929b49130d',
    '0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b',
    '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526',
    '0x9641d764fc13c8b624c04430c7356c1c7c8102e2',
    '0xa65387f16b013cf2af4605ad8aa5ec25a2cba3a2',
    '0x98ffbbf51bb33a056b08ddf711f289936aaff717',
    '0xd53cd0ab83d845ac265be939c57f53ad838012c9',
  ].map((a) => a.toLowerCase()),
)

export type DecodedCall = { fn: string; args: readonly unknown[] } | null

export function decodeCall(data: string): DecodedCall {
  try {
    const d = decodeFunctionData({ abi: ABI, data: data as VHex })
    return { fn: d.functionName, args: d.args ?? [] }
  } catch {
    return null
  }
}

/** Safe MultiSend packed bytes → calls (operation byte, to, value, dataLength, data). */
export function decodeMultiSend(packed: string): Call[] {
  const h = packed.replace(/^0x/, '')
  const out: Call[] = []
  let i = 0
  while (i + 2 + 40 + 64 + 64 <= h.length) {
    const operation = parseInt(h.slice(i, i + 2), 16)
    i += 2
    const to = '0x' + h.slice(i, i + 40)
    i += 40
    const value = BigInt('0x' + h.slice(i, i + 64)).toString()
    i += 64
    const len = Number(BigInt('0x' + h.slice(i, i + 64)))
    i += 64
    out.push({ target: to.toLowerCase(), value, data: '0x' + h.slice(i, i + len * 2), operation })
    i += len * 2
  }
  return out
}

/**
 * Unwrap a Safe proposal: timelock schedule/scheduleBatch, execute/executeBatch, the timelock
 * BYPASS paths (executeWhitelisted / executeWhitelistedBatch / bypasserExecuteBatch — instant)
 * and MultiSend become their inner calls, so a call routed around the delay is judged like any
 * other instead of reading "undecoded".
 */
export function unwrapCalls(call: Call): {
  calls: Call[]
  via?: 'schedule' | 'execute' | 'bypass' | 'multisend'
} {
  const d = decodeCall(call.data)
  if (!d) return { calls: [call] }
  if (d.fn === 'schedule') {
    const [target, value, data] = d.args as [string, bigint, string]
    return { calls: [{ target: lc(target), value: String(value), data }], via: 'schedule' }
  }
  if (d.fn === 'scheduleBatch') {
    const [targets, values, payloads] = d.args as [string[], bigint[], string[]]
    return {
      calls: targets.map((t, i) => ({
        target: lc(t),
        value: String(values[i]),
        data: payloads[i],
      })),
      via: 'schedule',
    }
  }
  if (d.fn === 'execute') {
    const [target, value, data] = d.args as [string, bigint, string]
    return { calls: [{ target: lc(target), value: String(value), data }], via: 'execute' }
  }
  if (d.fn === 'executeBatch') {
    const [targets, values, payloads] = d.args as [string[], bigint[], string[]]
    return {
      calls: targets.map((t, i) => ({
        target: lc(t),
        value: String(values[i]),
        data: payloads[i],
      })),
      via: 'execute',
    }
  }
  if (d.fn === 'executeWhitelisted') {
    const [target, value, data] = d.args as [string, bigint, string]
    return { calls: [{ target: lc(target), value: String(value), data }], via: 'bypass' }
  }
  if (d.fn === 'executeWhitelistedBatch') {
    const [targets, values, payloads] = d.args as [string[], bigint[], string[]]
    return {
      calls: targets.map((t, i) => ({
        target: lc(t),
        value: String(values[i]),
        data: payloads[i],
      })),
      via: 'bypass',
    }
  }
  if (d.fn === 'bypasserExecuteBatch') {
    const [calls] = d.args as [readonly { target: string; value: bigint; data: string }[]]
    return {
      calls: calls.map((c) => ({ target: lc(c.target), value: String(c.value), data: c.data })),
      via: 'bypass',
    }
  }
  if (d.fn === 'forward') {
    // an Aragon Agent running an EVMScript: its calls, each unwrapped in turn
    const inner = decodeEvmScript(d.args[0] as string)
    if (!inner) return { calls: [call] }
    const un = inner.map((c) => unwrapCalls(c))
    return {
      calls: un.flatMap((u) => u.calls),
      via: un.some((u) => u.via === 'bypass') ? 'bypass' : 'execute',
    }
  }
  if (d.fn === 'multiSend') {
    const inner = decodeMultiSend(d.args[0] as string).map((c) => unwrapCalls(c))
    return {
      calls: inner.flatMap((u) => u.calls),
      // a bypass inside the MultiSend still executes with no delay: say so
      via: inner.some((u) => u.via === 'bypass') ? 'bypass' : 'multisend',
    }
  }
  return { calls: [call] }
}

// ---- head context ---------------------------------------------------------------------------------

export type QueueCtx = {
  subject: string
  announcement: AnnouncementStatus
  eval: EvalCtx
  block: number
  endpoint: string
  /** Head route states keyed `${oapp}|${eid}|${direction}`. */
  routes: Record<string, RouteState>
  /** Head library defaults (raw) keyed `${lib}|${eid}`, for merging a proposed override. */
  defaults: Record<string, UlnConfigRaw>
  /** Library → direction (from the LZ allowlist). */
  libDirection: (lib: string) => 'send' | 'receive' | null
  /** Controller of an address at head (owners, delegates, role grantees, providers…). */
  ctl: (address: string) => Controller | null
  /** Current owner / delegate of a contract at head (for transferOwnership / setDelegate). */
  ownerOf: (contract: string) => string | null
  delegateOf: (oapp: string) => string | null
  /** proxy → implementations it ever had (Upgraded history, oldest first) and the current one. */
  implHistory: Record<string, { impls: { impl: string; block: number }[]; current: string | null }>
  minDelayOf: (timelock: string) => number | null
  roleName: (hash: string) => string
  /** The subject's contracts (incl. its timelocks) and OApps: calls elsewhere belong to another card. */
  contracts: string[]
  oapps: string[]
  /** Safes of the subject's power graph: their self-calls (owners, threshold, modules…) belong here. */
  safes?: string[]
  /** Event-replayed LZ state at head: routes not read at head (closed / zero peer), other libraries. */
  lz?: LzReplayState
  /** Exact evaluateRoute inputs of every head read (incl. the grace library's config). */
  routeInputs?: Record<string, RouteInputs>
  /** Raw app override per `${lib}|${oapp}|${eid}` read at head (getAppUlnConfig). */
  headOverrides?: Record<string, UlnConfigRaw>
  /** Last state of each route direction that could verify (replay), for reopen comparisons. */
  lastVerifying?: Record<string, RouteState>
  /** Current holders of a role on a contract, and everyone who ever held it (event replay). */
  roleHolders?: (contract: string, roleHash: string) => string[]
  roleEverHolders?: (contract: string, roleHash: string) => string[]
  /** Every executed grant of a role on a contract (block order) and the roles that administer others (ruling #4). */
  roleGrants?: (contract: string, roleHash: string) => GrantRecord[]
  roleAdmins?: (contract: string) => ReadonlySet<string>
  /** Mint/redeem getters (for setProvider: which param, and its head value). */
  params?: ParamSpec[]
  paramHead?: Record<string, unknown>
  /** Source verification of an implementation / provider: true, false, or null (not read). */
  verified?: (address: string) => boolean | null
  /**
   * Every remote pool a token pool's chain EVER accepted (RemotePoolSet / RemotePoolAdded
   * replayed), oldest first: a queued re-add after an executed removal is a re-point (review
   * round 7: the queue compared only with head).
   */
  ccipEverRemotePools?: (pool: string, selector: string) => string[]
  /**
   * A selector the subject declares on a contract (a power's `bypassExclude`): its signature,
   * and whether it is declared restrict-only there (review round 7). null = not declared.
   */
  declaredSelectors?: (
    contract: string,
    selector: string,
  ) => { signature: string; restrictOnly: boolean } | null
  /** CCIP remote pools a token pool accepts for a chain at head; null = not read. */
  ccipRemotePools?: (pool: string, selector: string) => string[] | null
  /**
   * The remote pools a chain accepted the LAST time it served any (replay; review round 8): a
   * re-add of any other pool — an older one included — is a re-point. [] = never served.
   */
  ccipLastRemotePools?: (pool: string, selector: string) => string[]
  /** Was the chain's rate limiter on when it was last configured (replay)? null = never seen. */
  ccipLastLimiterOn?: (pool: string, selector: string) => boolean | null
  /**
   * Wormhole NTT managers read at head (review round 8): an armed setThreshold /
   * removeTransceiver / setPeer is judged against them instead of reading "call not decoded".
   */
  ntt?: NttQueueHead[]
  /** Last NON-ZERO peer of each route direction (replay): a reopening to another peer is BR-6. */
  lastPeer?: Record<string, string>
  /** CCIP pools as read at head (rebalancers, rate limiters, remote pools per chain). */
  ccipPools?: CcipPoolHead[]
  /** Last NON-ZERO value of each address param (replay): a setter A → 0 → B is a replacement. */
  paramLastNonZero?: Record<string, string>
  /**
   * Whether a (target, selector) put on a timelock's no-delay whitelist exercises a declared power
   * (AD-2); absent / 'unknown' ⇒ judged as reaching one (fail closed).
   */
  whitelistReach?: (target: string, selector: string) => WhitelistReach
  /** The subject's tokens and CCIP pools (TokenAdminRegistry calls for other tokens are not its). */
  tokens?: string[]
  subjectCcipPools?: string[]
  /** Current CCIP token administrator of a token (event replay); null = not known. */
  ccipTokenAdmin?: (token: string) => string | null
  /** Aragon appId → the subject's app proxies with it (a queued Kernel setApp is their upgrade). */
  aragonAppProxies?: Record<string, string[]>
  /** Aragon: the permission manager of (app, role) at head; null = not read. */
  permissionManagerOf?: (app: string, role: string) => string | null
  /**
   * Fail-closed audit (2026-10-10). Head reads that FAILED, so a queued change on them is judged
   * fail closed (never against the event replay, never "previous holder unknown: neutral"):
   *   unreadRoutes      `${oapp}|${eid}|${dir}` LayerZero route sides not read at head;
   *   unreadOverrides   `${lib}|${oapp}|${eid}` app configs (getAppUlnConfig) not read;
   *   ownersUnread / delegatesUnread   contracts whose owner() / delegates() read failed;
   *   unclassified      addresses whose head classification FAILED;
   *   nttKnownTransceivers  every transceiver any read or replay attached to the subject's NTT.
   */
  unreadRoutes?: string[]
  unreadOverrides?: string[]
  ownersUnread?: string[]
  delegatesUnread?: string[]
  unclassified?: string[]
  nttKnownTransceivers?: string[]
  /** Declared power holders read at head (fallback for an owner / delegate not read). */
  powerHolderOf?: (contract: string, kind: 'owner' | 'lz_delegate') => string | null
  /** An Aragon app mapping that is incomplete (a kernel() / appId() read failed). */
  aragonAppsIncomplete?: boolean
}

/** A Wormhole NTT manager as read at head (the shape of engine.ts NttHead the queue needs). */
export type NttQueueHead = {
  manager: string
  threshold: number | null
  transceivers:
    | { address: string; type: string | null; peers?: Record<string, string | null> }[]
    | null
  /** Wormhole chain id → the manager's peer there; null = not read. */
  peers: Record<string, { peer: string } | null>
  /** Fail-closed audit (NB-02): swept chains READ as zero (a chain absent from `peers` is unread). */
  peersReadZero?: number[]
}

/** One CCIP token pool as the collector read it at head. */
export type CcipPoolHead = {
  pool: string
  owner: string | null
  rebalancer: string | null
  /** Fail-closed audit (CC-02 / CC-08): getRebalancer / getSupportedChains FAILED. */
  rebalancerUnread?: boolean
  chainsUnread?: boolean
  chains: {
    selector: string
    inboundEnabled: boolean | null
    outboundEnabled: boolean | null
    remotePools?: string[] | null
    /** 1.6 SiloedLockReleaseTokenPool: the chain is siloed (null = not read / not a siloed pool). */
    siloed?: boolean | null
    /** getChainRebalancer(selector) for a siloed chain. */
    rebalancer?: string | null
  }[]
}

/** Does this call touch the subject (a shared timelock or Safe also queues other assets' calls)? */
export function callIsForSubject(call: Call, q: QueueCtx): boolean {
  const t = lc(call.target)
  if (q.contracts.includes(t)) return true
  if ((q.safes ?? []).map(lc).includes(t)) return true
  // review round 8: a transceiver of the subject's NTT manager is the subject's
  if ((q.ntt ?? []).some((n) => (n.transceivers ?? []).some((x) => lc(x.address) === t)))
    return true
  // fail-closed audit (NB-01): a transceiver the replay or an earlier run attached — still the
  // subject's when this run's transceiver list was not read
  if ((q.nttKnownTransceivers ?? []).map(lc).includes(t)) return true
  const d = decodeCall(call.data)
  // A ProxyAdmin acts on the proxy named in its call (review round 7): an upgrade or admin
  // change of one of the subject's proxies routed through a ProxyAdmin that is not declared
  // is this card's — before, only the call's target was matched and it was invisible.
  if (d && PROXY_ADMIN_FNS.has(d.fn) && q.contracts.includes(lc(d.args[0] as string))) return true
  if (t !== lc(q.endpoint)) return false
  return !!d && ENDPOINT_FNS.has(d.fn) && q.oapps.includes(lc(d.args[0] as string))
}

/** ProxyAdmin functions whose first argument is the proxy acted on. */
const PROXY_ADMIN_FNS = new Set(['upgrade', 'upgradeAndCall', 'changeProxyAdmin'])

type Judged = {
  key: string
  title: string
  v: Verdict
  before?: unknown
  after?: unknown
  beforeDisplay?: string
  afterDisplay?: string
  dimension: ConfigChange['dimension']
  route?: ConfigChange['route']
}

// ---- working copy of head (one per op / proposal) -----------------------------------------------

const isZeroAddr = (a: string | undefined | null) => !a || /^0x0{40}$/i.test(a)
const rk = (oapp: string, eid: number | string, dir: 'send' | 'receive') =>
  `${lc(oapp)}|${eid}|${dir}`
const cloneInputs = (x: RouteInputs): RouteInputs => ({
  ...x,
  grace: x.grace ? { ...x.grace } : undefined,
})

/** LayerZero routes as the calls so far would leave them (starts at the head reads). */
class LzSim {
  private inputs = new Map<string, RouteInputs>()
  private overrides = new Map<string, UlnConfigRaw>()
  constructor(private q: QueueCtx) {}

  private seed(oapp: string, eid: number, dir: 'send' | 'receive'): RouteInputs {
    const k = rk(oapp, eid, dir)
    const exact = this.q.routeInputs?.[k]
    if (exact) return cloneInputs({ ...exact, block: this.q.block })
    const head = this.q.routes[k]
    if (head)
      return {
        chainId: 1,
        oapp: lc(oapp),
        eid,
        direction: dir,
        block: this.q.block,
        peer: head.peer,
        lib: head.lib,
        libIsDefault: head.libIsDefault,
        config: head.config,
        grace: undefined,
        defaultConfirmations: head.defaultConfirmations,
      }
    if (this.q.lz) return routeInputsFromState(this.q.lz, oapp, eid, dir, this.q.block)
    return {
      chainId: 1,
      oapp: lc(oapp),
      eid,
      direction: dir,
      block: this.q.block,
      peer: '0x',
      lib: ZERO_ADDRESS,
      libIsDefault: true,
      config: mergeUln(undefined, undefined),
    }
  }
  get(oapp: string, eid: number, dir: 'send' | 'receive'): RouteInputs {
    const k = rk(oapp, eid, dir)
    if (!this.inputs.has(k)) this.inputs.set(k, this.seed(oapp, eid, dir))
    return this.inputs.get(k)!
  }
  /** The route as head read it (or as replayed when it was not read), never the working copy. */
  headState(oapp: string, eid: number, dir: 'send' | 'receive'): RouteState | undefined {
    return this.q.routes[rk(oapp, eid, dir)]
  }
  state(inp: RouteInputs): RouteState {
    return evaluateRoute(inp, this.q.eval)
  }
  private overrideOf(lib: string, oapp: string, eid: number): UlnConfigRaw | undefined {
    const k = `${lc(lib)}|${lc(oapp)}|${eid}`
    return (
      this.overrides.get(k) ??
      this.q.headOverrides?.[k] ??
      this.q.lz?.overrides[lc(lib)]?.[lc(oapp)]?.[String(eid)]
    )
  }
  defaultOf(lib: string, eid: number): UlnConfigRaw | undefined {
    return this.q.defaults[`${lc(lib)}|${eid}`] ?? this.q.lz?.defaults[lc(lib)]?.[String(eid)]
  }
  configOf(lib: string, oapp: string, eid: number) {
    return mergeUln(this.overrideOf(lib, oapp, eid), this.defaultOf(lib, eid))
  }
  /**
   * Fail-closed audit (MISSED-QUEUE-LIBSWITCH / LZ-08): why the config `lib` would apply to the
   * route is NOT KNOWN — its app override was not read at head (and no call of this op set one),
   * or the library has neither a known default nor an override (a library the replay never
   * scanned). null = known. It merged undefined into "blocked (no_dvn)": a liveness event.
   */
  configUnknown(lib: string, oapp: string, eid: number): string | null {
    if (/^0x0{40}$/i.test(lib)) return null
    const k = `${lc(lib)}|${lc(oapp)}|${eid}`
    if (this.overrides.has(k)) return null
    if ((this.q.unreadOverrides ?? []).map(lc).includes(k))
      return `the app config of ${lc(lib).slice(0, 10)}… was not read at head`
    if (!this.overrideOf(lib, oapp, eid) && !this.defaultOf(lib, eid))
      return `library ${lc(lib).slice(0, 10)}… has no known default or app config (never read)`
    return null
  }
  setOverride(lib: string, oapp: string, eid: number, c: UlnConfigRaw) {
    this.overrides.set(`${lc(lib)}|${lc(oapp)}|${eid}`, c)
  }
  defaultLib(eid: number, dir: 'send' | 'receive'): string | undefined {
    const m = dir === 'send' ? this.q.lz?.defaultSendLib : this.q.lz?.defaultRecvLib
    return m?.[String(eid)]
  }
}

const closedOr = (r: RouteState) => (routeVerifies(r) ? `E=${r.Eeff}` : 'blocked')

/** Merge the verdicts of both directions of one call (setPeer moves send and receive). */
function mergeVerdicts(vs: Verdict[]): Verdict {
  const v = neutral()
  for (const x of vs) {
    if (x.severity === 'downgrade') v.severity = 'downgrade'
    else if (x.severity === 'upgrade' && v.severity === 'neutral') v.severity = 'upgrade'
    v.floorBreach ||= x.floorBreach
    for (const r of x.ruleIds) if (!v.ruleIds.includes(r)) v.ruleIds.push(r)
    for (const t of x.tags) tag(v, t)
    for (const n of x.notes) if (!v.notes.includes(n)) v.notes.push(n)
  }
  return v
}

type JudgeOpts = { armed: boolean; scheduledBlock?: number }

/** Mutate the route(s) one LayerZero call touches; judge each direction that changed. */
function judgeLz(
  fn: string,
  args: readonly unknown[],
  t: string,
  q: QueueCtx,
  sim: LzSim,
): Judged[] | null {
  // Fail-closed audit (MISSED-QUEUE-UNREAD-SEED / MISSED-QUEUE-LIBSWITCH / LZ-08): a route NOT READ
  // at head, or an after-state whose config is unknown, cannot be judged — BR-1 down, tagged
  // `read_gap`, and never skipped as "unchanged" (the replay it fell back to may be the stale one)
  const step = (
    oapp: string,
    eid: number,
    dir: 'send' | 'receive',
    mutate: (x: RouteInputs) => string | null | void,
  ) => {
    const inp = sim.get(oapp, eid, dir)
    const before = sim.state(inp)
    const why = mutate(inp) || null
    const after = sim.state(inp)
    const headUnread = (q.unreadRoutes ?? []).includes(rk(oapp, eid, dir))
    const unread = [headUnread ? 'the route was not read at head' : null, why].filter(
      (x): x is string => !!x,
    )
    return { before, after, changed: routeDiffers(before, after) || unread.length > 0, dir, unread }
  }
  const failClosed = (v: Verdict, unread: string[]) => {
    for (const u of unread) down(v, 'BR-1', `${u}: the change cannot be judged (fail closed)`)
    if (unread.length) tag(v, 'read_gap')
    return v
  }
  const operatorOf = (x: string) => q.eval.registry.byChain[1]?.[lc(x)]?.id
  const judged = (
    oapp: string,
    eid: number,
    r: { before: RouteState; after: RouteState; dir: 'send' | 'receive'; unread?: string[] },
    title: string,
  ): Judged => {
    const v = compareRoute(
      r.before,
      r.after,
      q.lastVerifying?.[rk(oapp, eid, r.dir)],
      q.lastPeer?.[rk(oapp, eid, r.dir)],
    )
    failClosed(v, r.unread ?? [])
    // lines that say what moved (review round 7: same-operator DVN swaps read X → X)
    const disp = routeChangeDisplays(r.before, r.after, operatorOf)
    v.notes.push(...disp.notes)
    if (disp.dvnRotation && v.severity !== 'downgrade' && !v.floorBreach) tag(v, 'rotation')
    return {
      key: `bridge/lz/1/${lc(oapp)}/${eid}/${r.dir}`,
      title,
      v,
      before: compactRoute(r.before),
      after: compactRoute(r.after),
      beforeDisplay: disp.before,
      afterDisplay: disp.after,
      dimension: 'bridge',
      route: { chainId: 1, oapp: lc(oapp), eid, direction: r.dir },
    }
  }
  const switchLib = (x: RouteInputs, oapp: string, eid: number, newLib: string): string | null => {
    if (isZeroAddr(newLib)) {
      x.libIsDefault = true
      x.lib = sim.defaultLib(eid, x.direction) ?? x.lib
    } else {
      x.libIsDefault = false
      x.lib = lc(newLib)
    }
    const unknown = sim.configUnknown(x.lib, oapp, eid)
    x.config = sim.configOf(x.lib, oapp, eid)
    const d = sim.defaultOf(x.lib, eid)
    x.defaultConfirmations = d ? mergeUln(undefined, d).confirmations : undefined
    return unknown
  }
  switch (fn) {
    case 'setConfig': {
      const [oapp, lib, params] = args as [
        string,
        string,
        { eid: number; configType: number; config: string }[],
      ]
      const dir = q.libDirection(lc(lib))
      const out: Judged[] = []
      for (const p of params) {
        if (Number(p.configType) !== 2) continue
        // LZ-13 (queue): a ULN config for a library whose direction is unknown (not in the
        // metadata) is never skipped silently — a row, judged fail closed
        if (!dir) {
          out.push({
            key: `bridge/lz/1/${lc(oapp)}/${Number(p.eid)}/config`,
            title: `config eid ${Number(p.eid)} on library ${lc(lib).slice(0, 10)}… (direction unknown)`,
            v: tag(
              down(
                neutral(),
                'BR-1',
                `library ${lc(lib)} is not in the LayerZero metadata: its direction is unknown and the config cannot be judged (fail closed)`,
              ),
              'read_gap',
            ),
            dimension: 'bridge',
          })
          continue
        }
        const raw = decodeAbiParameters(ULN_PARAMS, p.config as VHex)[0]
        const eid = Number(p.eid)
        sim.setOverride(lib, oapp, eid, {
          confirmations: String(raw.confirmations),
          requiredDVNCount: Number(raw.requiredDVNCount),
          optionalDVNCount: Number(raw.optionalDVNCount),
          optionalDVNThreshold: Number(raw.optionalDVNThreshold),
          requiredDVNs: raw.requiredDVNs.map(lc),
          optionalDVNs: raw.optionalDVNs.map(lc),
        })
        // The override takes effect while this library is the route's library (or the old
        // library of a receive grace period); otherwise it waits for a later library switch.
        const r = step(oapp, eid, dir, (x) => {
          if (isZeroAddr(x.lib)) {
            x.lib = lc(lib)
            x.libIsDefault = false
          }
          if (lc(x.lib) === lc(lib)) x.config = sim.configOf(lib, oapp, eid)
          if (x.grace && lc(x.grace.lib) === lc(lib))
            x.grace = { ...x.grace, config: sim.configOf(lib, oapp, eid) }
          return null
        })
        if (!r.changed) continue
        out.push(
          judged(
            oapp,
            eid,
            r,
            `${dir === 'receive' ? 'Receive' : 'Send'} config eid ${eid}: ${closedOr(r.before)} → ${closedOr(r.after)}`,
          ),
        )
      }
      return out
    }
    case 'setSendLibrary':
    case 'setReceiveLibrary': {
      const [oapp, eidRaw, newLib, grace] = args as [string, number, string, bigint?]
      const eid = Number(eidRaw)
      const dir = fn === 'setSendLibrary' ? 'send' : 'receive'
      const r = step(oapp, eid, dir, (x) => {
        const old = x.lib
        // LZ-08: the old library in grace keeps the config it HAS (the head read / the working
        // copy) — recomputing it from a possibly unread override and the default lifted E
        const oldCfg = x.config
        const why = switchLib(x, oapp, eid, newLib)
        if (dir === 'receive')
          x.grace =
            grace && grace > 0n && !isZeroAddr(old)
              ? {
                  lib: old,
                  expiry: q.block + Number(grace),
                  config: oldCfg,
                }
              : undefined
        return why
      })
      if (!r.changed) return []
      return [
        judged(
          oapp,
          eid,
          r,
          `${dir} library eid ${eid} → ${isZeroAddr(newLib) ? 'the default' : lc(newLib)}: ${closedOr(r.before)} → ${closedOr(r.after)}`,
        ),
      ]
    }
    case 'setReceiveLibraryTimeout': {
      const [oapp, eidRaw, lib, expiry] = args as [string, number, string, bigint]
      const eid = Number(eidRaw)
      const r = step(oapp, eid, 'receive', (x) => {
        x.grace =
          expiry === 0n
            ? undefined
            : { lib: lc(lib), expiry: Number(expiry), config: sim.configOf(lib, oapp, eid) }
        return expiry === 0n ? null : sim.configUnknown(lib, oapp, eid)
      })
      if (!r.changed) return []
      return [
        judged(
          oapp,
          eid,
          r,
          `receive library timeout eid ${eid}: ${lc(lib)} until block ${expiry}: ${closedOr(r.before)} → ${closedOr(r.after)}`,
        ),
      ]
    }
    case 'setPeer': {
      const [eidRaw, peer] = args as [number, string]
      const eid = Number(eidRaw)
      const rs = (['receive', 'send'] as const).map((d) =>
        step(t, eid, d, (x) => {
          x.peer = lc(peer)
          return null
        }),
      )
      const recv = rs[0]
      const v = mergeVerdicts(
        rs.map((r) =>
          failClosed(
            compareRoute(
              r.before,
              r.after,
              q.lastVerifying?.[rk(t, eid, r.dir)],
              q.lastPeer?.[rk(t, eid, r.dir)],
            ),
            r.unread,
          ),
        ),
      )
      if (isZeroPeer(peer)) tag(v, 'route_removed')
      // A peer serves BOTH directions (review round 7): the row shows the peer it moves, not the
      // receive route's config on both sides, and the send side's plumbing tag is dropped.
      v.tags = v.tags.filter((x) => x !== 'send_side')
      const routeNow = (r: { before: RouteState }) => `${r.before.direction} ${closedOr(r.before)}`
      return [
        {
          key: `bridge/lz/1/${t}/${eid}/peer`,
          title: `peer for eid ${eid} → ${isZeroPeer(peer) ? '0 (route closed)' : peerText(lc(peer))}`,
          v,
          before: recv.before.peer,
          after: lc(peer),
          beforeDisplay: `peer ${peerText(recv.before.peer)} (${rs.map(routeNow).join(', ')})`,
          afterDisplay: `peer ${peerText(lc(peer))}${isZeroPeer(peer) ? ' (both directions closed)' : ''}`,
          dimension: 'bridge',
          route: { chainId: 1, oapp: t, eid, direction: 'receive' },
        },
      ]
    }
    default:
      return null
  }
}

// ---- Wormhole NTT manager / transceiver calls (review round 8) ------------------------------------

const NTT_FNS = new Set([
  'setThreshold',
  'setTransceiver',
  'removeTransceiver',
  'setPeer',
  'setWormholePeer',
  'setAxelarChainId',
])

/**
 * Judge an NTT admin call against the manager as read at head (BR-1 / BR-2 / BR-6 / BR-7, the
 * same rules as the executed events). null = not an NTT call. A call on a contract that is not a
 * known NTT manager / transceiver stays "not decoded" (never read as calm).
 */
function judgeNtt(fn: string, args: readonly unknown[], t: string, q: QueueCtx): Judged[] | null {
  if (!NTT_FNS.has(fn)) return null
  // the LayerZero setPeer(uint32, bytes32) has two arguments
  if (fn === 'setPeer' && args.length !== 4) return null
  const mgr = (q.ntt ?? []).find((n) => lc(n.manager) === t)
  const tx = mgr
    ? null
    : ((q.ntt ?? [])
        .flatMap((n) => (n.transceivers ?? []).map((x) => ({ n, x })))
        .find(({ x }) => lc(x.address) === t) ?? null)
  const short = `${t.slice(0, 10)}…`
  const peerFn = fn === 'setWormholePeer' || fn === 'setAxelarChainId'
  // a manager call on a transceiver (or the reverse), or a contract that is no NTT of this card:
  // not judged, and never read as calm
  // fail-closed audit (NB-01): a transceiver call while a manager's transceiver list was NOT read —
  // the target may be its transceiver: BR-6 fail closed (it was "not a Wormhole NTT contract of this
  // card": neutral, or not this card's at all)
  const listUnread = (q.ntt ?? []).find((n) => n.transceivers === null)
  if (!mgr && !tx && peerFn && listUnread) {
    const chain = String(Number(args[0]))
    return [
      {
        key: `bridge/ntt/${lc(listUnread.manager)}/peer/${chain}`,
        title: `${fn} on ${short} (an NTT transceiver list was not read)`,
        v: tag(
          down(
            neutral(),
            'BR-6',
            `${fn} for chain ${chain} on ${t}: the transceiver list of ${lc(listUnread.manager)} was not read at head — this may be its transceiver's peer (fail closed)`,
          ),
          'read_gap',
        ),
        dimension: 'bridge',
      },
    ]
  }
  if ((!mgr && !tx) || (tx && !peerFn) || (mgr && peerFn))
    return [
      {
        key: `call/${t}/${fn}`,
        title: `${fn} on ${short} (${mgr || tx ? 'not judged on this NTT contract' : 'not a Wormhole NTT contract of this card'})`,
        v: tag(neutral(), 'undecoded'),
        dimension: 'admin',
      },
    ]
  const one = (key: string, title: string, v: Verdict, before?: unknown, after?: unknown) => [
    { key, title, v, before, after, dimension: 'bridge' as const },
  ]
  const unread = (v: Verdict, what: string) =>
    down(v, 'BR-1', `${what} not read at head: the change cannot be judged (fail closed)`)
  if (tx) {
    // a transceiver's own peer: BR-6 on a re-point (strict, like every peer)
    const [chainRaw, peerRaw] = args as [number, string, string?]
    const chain = String(Number(chainRaw))
    const next =
      fn === 'setAxelarChainId'
        ? `${String(args[1])}:${String(args[2]).toLowerCase()}`
        : lc(String(peerRaw))
    const prev = fn === 'setWormholePeer' ? tx.x.peers?.[chain] : undefined
    const v =
      typeof prev === 'string'
        ? classifyPeerChange(prev, next)
        : down(
            neutral(),
            'BR-6',
            `${fn === 'setAxelarChainId' ? 'Axelar' : 'Wormhole'} transceiver peer for chain ${chain} → ${next}; the peer it has now was not read (fail closed)`,
          )
    return one(
      `bridge/ntt/${lc(tx.n.manager)}/peer/${chain}`,
      `${fn === 'setAxelarChainId' ? 'Axelar' : 'Wormhole'} transceiver ${short}: peer for chain ${chain} → ${next.length > 42 && next.startsWith('0x') ? `0x…${next.slice(-40)}` : next}`,
      v,
      prev ?? undefined,
      next,
    )
  }
  const m = mgr!
  const types = m.transceivers ? m.transceivers.map((x) => x.type) : null
  const peers = Object.values(m.peers)
  // live unless every peer is read and zero (an unread peer may be live: fail closed)
  const live = peers.some((p) => !p || !/^0x0*$/i.test(p.peer))
  const key = `bridge/ntt/${t}/verification`
  const floorOff = (v: Verdict) => {
    if (live || !v.floorBreach) return v
    v.floorBreach = false
    v.ruleIds = v.ruleIds.filter((x) => x !== 'BR-2')
    v.notes = v.notes.filter((n) => !n.startsWith('FLOOR'))
    v.notes.push('no peer set: the route is not live (the floor is judged when it opens)')
    return v
  }
  switch (fn) {
    case 'setThreshold': {
      const next = Number(args[0])
      if (m.threshold === null || !types)
        return one(
          key,
          `NTT ${short}: threshold → ${next}`,
          unread(neutral(), 'threshold / transceivers'),
        )
      const v = floorOff(classifyNttThreshold(m.threshold, next, types, types))
      return one(key, `NTT ${short}: threshold ${m.threshold} → ${next}`, v, m.threshold, next)
    }
    case 'removeTransceiver': {
      const a = lc(String(args[0]))
      if (m.threshold === null || !m.transceivers)
        return one(
          key,
          `NTT ${short}: transceiver ${a.slice(0, 10)}… removed`,
          unread(neutral(), 'threshold / transceivers'),
        )
      const after = m.transceivers.filter((x) => lc(x.address) !== a)
      // NttManager lowers the threshold to the transceivers left when it would exceed them
      const next = Math.min(m.threshold, after.length)
      const v = floorOff(
        classifyNttThreshold(
          m.threshold,
          next,
          after.map((x) => x.type),
          types ?? undefined,
        ),
      )
      return one(
        key,
        `NTT ${short}: transceiver ${a.slice(0, 10)}… removed · threshold ${next} of ${after.length}`,
        v,
        m.threshold,
        next,
      )
    }
    case 'setTransceiver': {
      const a = lc(String(args[0]))
      const known = m.transceivers?.find((x) => lc(x.address) === a)
      if (m.threshold === null || !m.transceivers)
        return one(
          key,
          `NTT ${short}: transceiver ${a.slice(0, 10)}… set`,
          unread(neutral(), 'threshold / transceivers'),
        )
      if (known)
        return one(
          key,
          `NTT ${short}: transceiver ${a.slice(0, 10)}… set (already registered)`,
          neutral(),
        )
      // a new transceiver's verifier network is not read before it is registered: unknown ⇒ BR-7
      const next = m.threshold === 0 ? 1 : m.threshold
      const v = floorOff(classifyNttTransceiverAdded(null, types ?? [], m.threshold, next))
      return one(
        key,
        `NTT ${short}: transceiver ${a.slice(0, 10)}… added · threshold ${next} of ${m.transceivers.length + 1}`,
        v,
      )
    }
    case 'setPeer': {
      const [chainRaw, peerRaw] = args as [number, string]
      const chain = String(Number(chainRaw))
      const next = lc(peerRaw)
      const cur = m.peers[chain]
      // fail-closed audit (NB-02): a chain absent from the head peers is NOT READ unless the sweep
      // read it as zero — it was "a new route" (neutral) whatever the peer actually was
      const readZero = (m.peersReadZero ?? []).map(Number).includes(Number(chain))
      const v =
        cur === null || (cur === undefined && !readZero)
          ? tag(
              down(
                neutral(),
                'BR-6',
                `NTT peer for chain ${chain} → ${next}; the peer it has now was not read (fail closed)`,
              ),
              'read_gap',
            )
          : classifyPeerChange(cur?.peer ?? null, next)
      if (cur === undefined && readZero)
        v.notes.push(`the peer for chain ${chain} was read as zero at head: a new route`)
      // a peer that opens a route under the floor is BR-2 (as the executed PeerUpdated)
      const eff = nttEffective(m.threshold, types ?? [])
      if (!/^0x0*$/i.test(next) && (!types || m.threshold === null || eff.E < 2)) {
        v.floorBreach = true
        if (!v.ruleIds.includes('BR-2')) v.ruleIds.push('BR-2')
        if (v.severity !== 'downgrade') v.severity = 'downgrade'
        v.notes.push(
          !types || m.threshold === null
            ? 'FLOOR: threshold / transceivers not read at head — the route cannot be shown to meet the floor (fail closed)'
            : `FLOOR: the route has ${eff.E} effective verifier network(s) (threshold ${m.threshold} over ${eff.distinct} distinct)`,
        )
      }
      return one(
        `bridge/ntt/${t}/peer/${chain}`,
        `NTT manager ${short}: peer for chain ${chain} → 0x…${next.slice(-40)}`,
        v,
        cur?.peer,
        next,
      )
    }
  }
  return null
}

/** Safe self-calls (owners, threshold, modules, guards, fallback handler) against a working copy. */
function judgeSafe(
  fn: string,
  args: readonly unknown[],
  t: string,
  q: QueueCtx,
  safes: Map<string, Controller | null>,
  /** Signers added to each Safe by the earlier calls of this op (incl. swaps), cumulative. */
  addedBy: Map<string, number> = new Map(),
): Judged[] | null {
  const SAFE_FNS = [
    'addOwnerWithThreshold',
    'removeOwner',
    'swapOwner',
    'changeThreshold',
    'enableModule',
    'disableModule',
    'setGuard',
    'setModuleGuard',
    'setFallbackHandler',
    // Safe <= 1.1.1: the singleton is a self-call away (review round 8)
    'changeMasterCopy',
    // legacy MultiSigWallet (its removeOwner takes one argument: decoded as the Safe one fails)
    'addOwner',
    'replaceOwner',
    'changeRequirement',
  ]
  if (!SAFE_FNS.includes(fn)) return null
  if (!safes.has(t)) {
    const c = q.ctl(t)
    safes.set(t, c ? { ...c, modules: [...(c.modules ?? [])] } : null)
  }
  const prev = safes.get(t) ?? null
  const next: Controller | null = prev ? { ...prev, modules: [...(prev.modules ?? [])] } : null
  const key = (f: string) => `admin/safe/${t}/${f}`
  const one = (
    k: string,
    title: string,
    v: Verdict,
    before?: unknown,
    after?: unknown,
  ): Judged[] => {
    safes.set(t, next)
    return [{ key: k, title, v, before, after, dimension: 'admin' }]
  }
  const adds = (n: number) => addedBy.set(t, (addedBy.get(t) ?? 0) + n)
  const ms = (title: string, swap = false) => {
    if (!prev || !next) {
      // not classified at head: the threshold change cannot be judged — never read as calm
      const v = down(
        neutral(),
        'AD-1',
        'Safe threshold / owners not read at head: change not judged',
      )
      return one(`admin/multisig/${t}`, title, v)
    }
    // judged on the signers added by the whole op so far (review round 6: three swapOwner calls
    // on a 3-of-5 read as three calm rotations)
    const v = classifyMultisigChange(prev, next, addedBy.get(t) ?? 0)
    if (swap && !isRed(v)) tag(v, 'rotation')
    return one(
      `admin/multisig/${t}`,
      `${title}: ${prev.threshold}-of-${prev.signers} → ${next.threshold}-of-${next.signers}`,
      v,
      `${prev.threshold}/${prev.signers}`,
      `${next.threshold}/${next.signers}`,
    )
  }
  const a0 = lc(String(args[0] ?? ''))
  switch (fn) {
    case 'addOwnerWithThreshold':
      if (next) {
        next.signers = (next.signers ?? 0) + 1
        next.threshold = Number(args[1])
      }
      adds(1)
      return ms(`Safe ${t.slice(0, 10)}…: add owner ${a0.slice(0, 10)}…`)
    case 'removeOwner':
      if (args.length === 1) {
        // legacy MultiSigWallet: the requirement drops only when it would exceed the owners
        if (next) {
          next.signers = Math.max(0, (next.signers ?? 0) - 1)
          next.threshold = Math.min(next.threshold ?? 0, next.signers)
        }
        return ms(`multisig ${t.slice(0, 10)}…: remove owner ${a0.slice(0, 10)}…`)
      }
      if (next) {
        next.signers = Math.max(0, (next.signers ?? 0) - 1)
        next.threshold = Number(args[2])
      }
      return ms(`Safe ${t.slice(0, 10)}…: remove owner ${lc(String(args[1])).slice(0, 10)}…`)
    case 'changeThreshold':
      if (next) next.threshold = Number(args[0])
      return ms(`Safe ${t.slice(0, 10)}…: change threshold`)
    case 'addOwner':
      if (next) next.signers = (next.signers ?? 0) + 1
      adds(1)
      return ms(`multisig ${t.slice(0, 10)}…: add owner ${a0.slice(0, 10)}…`)
    case 'changeRequirement':
      if (next) next.threshold = Number(args[0])
      return ms(`multisig ${t.slice(0, 10)}…: change requirement`)
    case 'replaceOwner':
    case 'swapOwner': {
      const [o, n] = fn === 'replaceOwner' ? [args[0], args[1]] : [args[1], args[2]]
      adds(1)
      return ms(
        `${fn === 'replaceOwner' ? 'multisig' : 'Safe'} ${t.slice(0, 10)}…: swap owner ${lc(String(o)).slice(0, 10)}… → ${lc(String(n)).slice(0, 10)}…`,
        true,
      )
    }
    case 'enableModule':
      next?.modules?.push(a0)
      return one(
        key('module_enabled'),
        `Safe ${t.slice(0, 10)}…: enable module ${a0.slice(0, 10)}…`,
        classifySafeModuleChange('module_enabled', undefined, a0),
        undefined,
        a0,
      )
    case 'disableModule': {
      const m = lc(String(args[1]))
      if (next) next.modules = (next.modules ?? []).filter((x) => x !== m)
      return one(
        key('module_disabled'),
        `Safe ${t.slice(0, 10)}…: disable module ${m.slice(0, 10)}…`,
        classifySafeModuleChange('module_disabled', m),
        m,
      )
    }
    case 'changeMasterCopy': {
      // AD-6 singleton: the Safe's code is replaced (the delegatecall-takeover path, by vote)
      const from = prev?.singleton ?? undefined
      if (next) next.singleton = a0
      const v = classifySafeModuleChange('singleton', from, a0)
      if (from === undefined) v.notes.push("the Safe's current singleton was not read at head")
      return one(
        key('singleton'),
        `Safe ${t.slice(0, 10)}…: singleton (master copy) → ${a0.slice(0, 10)}…`,
        v,
        from,
        a0,
      )
    }
    case 'setGuard':
    case 'setModuleGuard':
    case 'setFallbackHandler': {
      const field =
        fn === 'setGuard' ? 'guard' : fn === 'setModuleGuard' ? 'module_guard' : 'fallback_handler'
      const prop =
        fn === 'setGuard' ? 'guard' : fn === 'setModuleGuard' ? 'moduleGuard' : 'fallbackHandler'
      const from = prev?.[prop] ?? undefined
      if (next) next[prop] = a0
      // Review round 6: the Safe (or this field) was not read at head — the previous guard is
      // unknown, so a replacement cannot be ruled out: red, never "guard added" (fail closed).
      const v =
        from === undefined
          ? down(
              neutral(),
              'AD-6',
              `${field.replace('_', ' ')} → ${a0}; the Safe's current ${field.replace('_', ' ')} was not read at head: a replacement cannot be ruled out (fail closed)`,
            )
          : classifySafeModuleChange(field, from, a0)
      return one(
        key(field),
        `Safe ${t.slice(0, 10)}…: ${field.replace('_', ' ')} → ${a0.slice(0, 10)}…`,
        v,
        from,
        a0,
      )
    }
  }
  return null
}

/**
 * Judge the calls of one op / proposal IN ORDER, each against the state the earlier calls
 * left (LayerZero routes and Safe owners/modules are simulated; everything else is judged
 * against head). Returns one list of judged changes per call. `armed` + `scheduledBlock` feed
 * AD-8 (stale rollback).
 */
export function judgeCalls(calls: Call[], q: QueueCtx, opts: JudgeOpts): Judged[][] {
  const sim = new LzSim(q)
  const w: Working = {
    safes: new Map(),
    roles: new Map(),
    addedBy: new Map(),
    grants: new Map(),
  }
  // rules #7 (fail-closed review): a call index never read (QU-05) is a hole — or null once the raw
  // file went through JSON — and is skipped, never a crash (the op is flagged `callsIncomplete`)
  return calls.map((call) => (call ? judgeOne(call, q, opts, sim, w) : []))
}

/** What the earlier calls of one op / proposal changed (each call is judged against it). */
type Working = {
  safes: Map<string, Controller | null>
  roles: Map<string, Set<string>>
  /** Signers added per Safe by the earlier calls (swaps included). */
  addedBy: Map<string, number>
  /** Grants per `${contract}|${role}` made by the earlier calls (the burst counts them). */
  grants: Map<string, GrantRecord[]>
}

const isAddrStr = (x: unknown): x is string =>
  typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x)

/**
 * A queued call to a DECLARED parameter's setter (review round 6): judged like the executed
 * transition, against the value read at head. Null when the call is no declared setter.
 */
function judgeParamSetter(call: Call, q: QueueCtx): Judged[] | null {
  const t = lc(call.target)
  for (const spec of q.params ?? []) {
    if (!spec.setter || lc(spec.contract) !== t) continue
    let args: readonly unknown[]
    try {
      const sig = spec.setter.sig.trim().startsWith('function ')
        ? spec.setter.sig
        : `function ${spec.setter.sig}`
      const item = parseAbiItem(sig)
      args = decodeFunctionData({ abi: [item] as never, data: call.data as VHex }).args ?? []
    } catch {
      continue
    }
    // a setter keyed by an argument (asset): only the call for THIS parameter's key
    const match = spec.setter.match ?? []
    if (match.some((ai, gi) => lc(String(args[ai])) !== lc(String(spec.args?.[gi] ?? '')))) continue
    const raw = args[spec.setter.value]
    const next: unknown = typeof raw === 'bigint' ? raw.toString() : isAddrStr(raw) ? lc(raw) : raw
    const prevRaw = q.paramHead?.[spec.key]
    const prev: unknown = isAddrStr(prevRaw) ? lc(prevRaw) : prevRaw
    const addr = isAddrStr(next) ? next : null
    const v = classifyParamChange(spec, prev ?? null, next, addr ? q.ctl(addr) : null, {
      prevCtl: isAddrStr(prev) ? q.ctl(prev) : null,
      nextVerified: addr ? (q.verified?.(addr) ?? null) : null,
      lastNonZero: q.paramLastNonZero?.[spec.key] ?? null,
      // PO-05: the current value not read at head is judged fail closed, never "nothing before"
      prevUnread: prev === undefined,
    })
    if (prev === undefined) v.notes.push(`${spec.label}: the current value was not read at head`)
    return [
      {
        key: `mint/${spec.key}`,
        title: `${spec.label} → ${addr ? describeController(q.ctl(addr)) : (formatParamAmount(next, spec.unit) ?? String(next))}`,
        v,
        before: prev,
        after: next,
        dimension: 'mint_redeem',
      },
    ]
  }
  return null
}

/** Judge one decoded call against head. `armed` + `scheduledBlock` feed AD-8 (stale rollback). */
export function judgeCall(call: Call, q: QueueCtx, opts: JudgeOpts): Judged[] {
  return judgeCalls([call], q, opts)[0]
}

function judgeOne(call: Call, q: QueueCtx, opts: JudgeOpts, sim: LzSim, w: Working): Judged[] {
  const { safes, roles } = w
  const ps = judgeParamSetter(call, q)
  if (ps) return ps
  const d = decodeCall(call.data)
  const t = lc(call.target)
  // Role holders as the calls so far would leave them (starts at the head holders; null = the
  // holders were not read — never counted as "none left").
  const holdersOf = (role: string): Set<string> | null => {
    const k = `${t}|${lc(role)}`
    if (!roles.has(k)) {
      const h = q.roleHolders?.(t, lc(role))
      if (!h) return null
      roles.set(k, new Set(h.map(lc)))
    }
    return roles.get(k)!
  }
  if (!d) {
    // Review round 7: a selector the subject declares (a power's bypassExclude) is named, and a
    // function declared restrict-only on this contract is not a loud CALL NOT DECODED.
    const sel = call.data.slice(0, 10).toLowerCase()
    const known = q.declaredSelectors?.(t, sel) ?? null
    if (known?.restrictOnly)
      return [
        {
          key: `call/${t}/${sel}`,
          title: `${known.signature} on ${t.slice(0, 10)}…`,
          v: (() => {
            const v = neutral()
            v.notes.push(
              `${known.signature}: declared restrict-only for this contract (bypassExclude) — arguments not judged`,
            )
            return v
          })(),
          dimension: 'admin',
        },
      ]
    return [
      {
        key: `call/${t}/${sel}`,
        title: `${known ? known.signature : `call ${sel}`} on ${t.slice(0, 10)}…`,
        v: tag(neutral(), 'undecoded'),
        dimension: 'admin',
      },
    ]
  }
  // review round 8: NTT manager / transceiver admin calls (before the LayerZero setPeer, whose
  // name the NTT four-argument setPeer shares)
  const nt = judgeNtt(d.fn, d.args, t, q)
  if (nt) return nt
  const lz = judgeLz(d.fn, d.args, t, q, sim)
  if (lz) return lz
  const sf = judgeSafe(d.fn, d.args, t, q, safes, w.addedBy)
  if (sf) return sf
  switch (d.fn) {
    case 'setDelegate':
    case 'transferOwnership': {
      const next = lc(d.args[0] as string)
      // fail-closed audit (LZ-02 / LZ-03 / MS-1): the current owner / delegate as read at head,
      // else the declared power's holder read at head; neither = NOT READ (red AD-3, read gap —
      // it was "previous holder not read: neutral")
      const kind = d.fn === 'setDelegate' ? 'lz_delegate' : 'owner'
      const prev =
        (d.fn === 'setDelegate' ? q.delegateOf(t) : q.ownerOf(t)) ??
        q.powerHolderOf?.(t, kind) ??
        null
      const prevCtl = prev ? q.ctl(prev) : null
      const what = d.fn === 'setDelegate' ? 'LZ delegate' : 'owner'
      const v = classifyControllerChange(prevCtl, q.ctl(next), {
        prevUnread: !prev
          ? `the current ${what} of ${t.slice(0, 10)}… was not read at head`
          : !prevCtl
            ? `the current ${what} ${prev.slice(0, 10)}… could not be classified at head`
            : undefined,
      })
      return [
        {
          key: `admin/${d.fn === 'setDelegate' ? 'lz-delegate' : 'owner'}/${t}`,
          title: `${what} of ${t.slice(0, 10)}… → ${describeController(q.ctl(next))}`,
          v,
          before: prev,
          after: next,
          dimension: 'admin',
        },
      ]
    }
    case 'upgradeTo':
    case 'upgradeToAndCall':
    case 'upgrade':
    case 'upgradeAndCall': {
      // upgradeTo / upgradeToAndCall and the NTT one-argument upgrade(impl) act on the target;
      // a ProxyAdmin's upgrade / upgradeAndCall name the proxy first
      const onTarget = d.fn.startsWith('upgradeTo') || (d.fn === 'upgrade' && d.args.length === 1)
      const proxy = onTarget ? t : lc(d.args[0] as string)
      const impl = lc((onTarget ? d.args[0] : d.args[1]) as string)
      const h = q.implHistory[proxy]
      const v = tag(neutral(), 'logic_change')
      const cur = h?.current ?? null
      const installed = h?.impls.find((x) => x.impl === cur)?.block
      // Stale rollback: the op would install an implementation other than the current one,
      // and was scheduled before the current one was installed (or names a past one).
      const past = !!h?.impls.some((x) => x.impl === impl) && impl !== cur
      const staleBySchedule =
        opts.scheduledBlock !== undefined &&
        installed !== undefined &&
        opts.scheduledBlock < installed &&
        impl !== cur
      if (past || staleBySchedule) {
        tag(v, 'stale_rollback')
        if (opts.armed)
          down(
            v,
            'AD-8',
            `would replace the current implementation ${cur} with ${impl} (${past ? 'a past implementation' : 'scheduled before the current one was installed'})`,
          )
      } else if (opts.armed && impl !== cur && (!h || installed === undefined)) {
        // Fail-closed audit (QU-08): the implementation history is incomplete (no Upgraded row, or
        // none for the current implementation — a lost event chunk): a stale rollback cannot be
        // ruled out for an op that may execute now
        down(
          v,
          'AD-8',
          `upgrade history of ${proxy} incomplete${cur ? ` (the install of the current implementation ${cur} was not read)` : ''} — a stale rollback cannot be ruled out (fail closed)`,
        )
        tag(v, 'read_gap')
      }
      verificationRule(v, impl, q.verified?.(impl) ?? null)
      const upgraded: Judged = {
        key: `admin/implementation/${proxy}`,
        title: `upgrade ${proxy.slice(0, 10)}… → ${impl.slice(0, 10)}…`,
        v,
        before: cur,
        after: impl,
        dimension: 'admin',
      }
      // Review round 8: the call an upgradeToAndCall / upgradeAndCall makes on the proxy after
      // the upgrade runs as the proxy's admin — an onlyOwner transferOwnership hidden there (to
      // the same implementation, even) is judged like the call queued on its own.
      const inner =
        d.fn === 'upgradeToAndCall'
          ? (d.args[1] as string)
          : d.fn === 'upgradeAndCall'
            ? (d.args[2] as string)
            : null
      if (!inner || inner === '0x') return [upgraded]
      const via = d.fn === 'upgradeToAndCall' ? 'upgradeToAndCall' : 'ProxyAdmin upgradeAndCall'
      const calls = judgeOne({ target: proxy, value: '0', data: inner }, q, opts, sim, w).map(
        (j) => {
          j.v.notes.push(`called on ${proxy} by ${via} (runs right after the upgrade)`)
          return { ...j, title: `${j.title} (inside ${via})` }
        },
      )
      return [upgraded, ...calls]
    }
    case 'setPermissionManager': {
      // Aragon: the manager of (app, role) grants and revokes it at will (AD-3 on who it is)
      const [next, app, role] = (d.args as string[]).map(lc)
      const prev = q.permissionManagerOf?.(app, role) ?? null
      // only the current manager can call it: none known = NOT READ (fail closed)
      const v = classifyControllerChange(prev ? q.ctl(prev) : null, q.ctl(next), {
        prevUnread: !prev
          ? 'the current permission manager was not read (no event set it in the scan)'
          : !q.ctl(prev)
            ? `the current permission manager ${prev.slice(0, 10)}… could not be classified at head`
            : undefined,
      })
      return [
        {
          key: `admin/permission_manager/${app}/${q.roleName(role)}`,
          title: `permission manager of ${q.roleName(role)} on ${app.slice(0, 10)}… → ${describeController(q.ctl(next))}`,
          v,
          before: prev,
          after: next,
          dimension: 'admin',
        },
      ]
    }
    case 'grantRole': {
      const [role, account] = d.args as [string, string]
      const name = q.roleName(lc(role))
      // fail-closed audit (PH-10 / CL-08): a co-holder not classified at head is counted as NOT
      // READ (never a calm plain contract the grantee easily outranks)
      const coIds = q.roleHolders?.(t, lc(role)) ?? []
      const holders = coIds.map((h) => q.ctl(h)).filter((c): c is Controller => !!c)
      const ever = q.roleEverHolders?.(t, lc(role))
      const admins = q.roleAdmins?.(t) ?? new Set<string>()
      const v = classifyRoleGrant(
        name,
        q.ctl(lc(account)),
        holders,
        MINT_ROLES.has(name) && ever ? ever.includes(lc(account)) : true,
        { administersRoles: admins.has(name), unclassifiedHolders: coIds.length - holders.length },
      )
      holdersOf(role)?.add(lc(account))
      // judged as if it executed now (head block) against the executed grant history — and the
      // grants of the same role made by the EARLIER calls of this op (review round 6: a pending
      // batch of four bot grants was judged one grant at a time)
      const gk = `${t}|${lc(role)}`
      const sib = w.grants.get(gk) ?? []
      applyGrantPattern(
        v,
        name,
        grantPattern(
          name,
          q.ctl(lc(account)),
          q.block,
          q.roleGrants?.(t, lc(role)) ?? [],
          admins,
          sib,
        ),
      )
      w.grants.set(gk, [
        ...sib,
        { block: q.block, account: lc(account), noCode: q.ctl(lc(account))?.kind === 'eoa' },
      ])
      return [
        {
          key: `admin/role/${t}/${name}`,
          title: `grant ${name} to ${describeController(q.ctl(lc(account)))}`,
          v,
          after: lc(account),
          dimension: MINT_ROLES.has(name) ? 'mint_redeem' : 'admin',
        },
      ]
    }
    case 'revokeRole':
    case 'renounceRole': {
      const [role, account] = d.args as [string, string]
      const name = q.roleName(lc(role))
      const hs = holdersOf(role)
      hs?.delete(lc(account))
      // MR-1 (review round 5): a pending revoke of the LAST pauser leaves nobody able to pause —
      // judged against the holders the earlier calls of the op left.
      const v = PAUSE_ROLES.has(name) && hs ? classifyPauserChange(hs.size) : neutral()
      return [
        {
          key: `admin/role/${t}/${name}`,
          title: `${d.fn === 'renounceRole' ? 'renounce' : 'revoke'} ${name} from ${lc(account).slice(0, 10)}…`,
          v,
          before: lc(account),
          dimension: 'admin',
        },
      ]
    }
    case 'updateDelay': {
      const next = Number(d.args[0])
      const prev = q.minDelayOf(t)
      // the current delay was not read: a shortening cannot be ruled out (fail closed)
      const v =
        prev === null
          ? down(neutral(), 'AD-2', `delay → ${next}s; the current delay could not be read`)
          : classifyDelayChange(prev, next)
      return [
        {
          key: `admin/timelock_delay/${t}`,
          title: `timelock delay → ${next}s`,
          v,
          before: prev,
          after: next,
          dimension: 'admin',
        },
      ]
    }
    case 'setProvider': {
      const next = lc(d.args[0] as string)
      const spec: ParamSpec = q.params?.find(
        (p) => lc(p.contract) === t && (p.rule === 'rate_provider' || p.rule === 'price_oracle'),
      ) ?? {
        key: `provider/${t}`,
        contract: t,
        sig: '',
        rule: 'rate_provider',
        label: 'rate provider',
      }
      const prevRaw = q.paramHead?.[spec.key]
      const prev = typeof prevRaw === 'string' ? lc(prevRaw) : null
      // PO-06: no declared spec (the fallback key is never read) or the head value not read: the
      // current provider is unknown — judged as a replacement (fail closed)
      const v = classifyParamChange(spec, prev, next, q.ctl(next), {
        prevCtl: prev ? q.ctl(prev) : null,
        nextVerified: q.verified?.(next) ?? null,
        lastNonZero: q.paramLastNonZero?.[spec.key] ?? null,
        prevUnread: prev === null,
      })
      return [
        {
          key: `mint/${spec.key}`,
          title: `${spec.label} of ${t.slice(0, 10)}… → ${describeController(q.ctl(next))}`,
          v,
          before: prev,
          after: next,
          dimension: 'mint_redeem',
        },
      ]
    }
    case 'changeProxyAdmin': {
      // a ProxyAdmin hands `proxy` to a new admin: AD-3 on the ProxyAdmin vs the new admin
      const [proxy, admin] = d.args as [string, string]
      const next = lc(admin)
      return [
        {
          key: `admin/proxy_admin/${lc(proxy)}`,
          title: `proxy admin of ${lc(proxy).slice(0, 10)}… → ${describeController(q.ctl(next))}`,
          // fail-closed review (2026-10-10, OC-3 twin): the ProxyAdmin not classified at head is
          // NOT READ (red AD-3, read gap), never "previous holder not read: neutral"
          v: classifyControllerChange(q.ctl(t), q.ctl(next), {
            prevUnread: q.ctl(t)
              ? undefined
              : `the ProxyAdmin ${t.slice(0, 10)}… could not be classified at head`,
          }),
          before: t,
          after: next,
          dimension: 'admin',
        },
      ]
    }
    case 'setContract': {
      // a contract registry entry (Kelp LRTConfig: the oracle, the deposit pool…) re-pointed:
      // a logic change of whatever the protocol calls through it — MR-2 to an account an EOA
      // controls, AD-9 when the new code is not verified (fail closed)
      const [k, addr] = d.args as [string, string]
      const next = lc(addr)
      const c = q.ctl(next)
      const v = tag(neutral(), 'logic_change')
      if (isEoaControlled(c))
        down(v, 'MR-2', `contract registry entry ${k.slice(0, 10)}… → ${describeController(c)}`)
      else if (!c && !isZeroAddr(next)) {
        // fail-closed audit (CL-08): the new entry could not be classified at head
        down(
          v,
          'MR-2',
          `contract registry entry ${k.slice(0, 10)}… → ${next}: not classified at head (fail closed)`,
        )
        tag(v, 'read_gap')
      } else {
        const ver = q.verified?.(next) ?? null
        if (ver === true) v.notes.push(`registry entry → ${next}: verified source`)
        else {
          tag(v, ver === false ? 'unverified' : 'verification_unread')
          down(
            v,
            'AD-9',
            `contract registry entry ${k.slice(0, 10)}… → ${next}: ${ver === false ? 'source not verified on Sourcify or Blockscout (Etherscan not checked)' : 'source verification could not be read'}`,
          )
        }
      }
      return [
        {
          key: `admin/registry/${t}/${lc(k)}`,
          title: `registry entry ${k.slice(0, 10)}… of ${t.slice(0, 10)}… → ${describeController(c ?? { kind: 'contract', address: next })}`,
          v,
          after: next,
          dimension: 'admin',
        },
      ]
    }
    case 'addToWhitelist':
    case 'removeFromWhitelist': {
      const [target, sel] = d.args as [string, string]
      const added = d.fn === 'addToWhitelist'
      const v = classifyWhitelistChange(
        added,
        lc(target),
        lc(sel),
        q.whitelistReach?.(lc(target), lc(sel)) ?? 'unknown',
      )
      return [
        {
          key: `admin/timelock_whitelist/${t}/${lc(target)}/${lc(sel)}`,
          title: `timelock ${t.slice(0, 10)}…: ${lc(sel)} on ${lc(target).slice(0, 10)}… ${added ? 'whitelisted (no delay)' : 'removed from the whitelist'}`,
          v,
          dimension: 'admin',
        },
      ]
    }
    case 'addRemotePool': {
      const [sel, pool] = d.args as [bigint, string]
      const selector = String(sel)
      const next = lc(pool)
      const cur = q.ccipRemotePools?.(t, selector)
      const v =
        cur === null || cur === undefined
          ? down(
              neutral(),
              'CC-1',
              `remote pool for chain ${selector} added; the pools the chain has now could not be read (fail closed)`,
            )
          : cur.map(lc).includes(next)
            ? neutral()
            : cur.length
              ? down(
                  neutral(),
                  'CC-1',
                  `second remote pool for an already-served chain ${selector}: ${cur.join(', ')} + ${next} (both accepted)`,
                )
              : (reAdd(q, t, selector, [next]) ?? tag(neutral(), 'route_created'))
      return [
        {
          key: `bridge/ccip/${t}/${selector}`,
          title: `CCIP remote pool for chain ${selector} → ${next.slice(0, 12)}…`,
          v,
          before: cur ?? undefined,
          after: next,
          dimension: 'bridge',
        },
      ]
    }
    default: {
      const cc = judgeCcip(d.fn, d.args, t, q)
      if (cc) return cc
      return [
        {
          key: `call/${t}/${d.fn}`,
          title: `${d.fn} on ${t.slice(0, 10)}…`,
          v: neutral(),
          dimension: 'admin',
        },
      ]
    }
  }
}

// ---- CCIP pool / TokenAdminRegistry calls (review round 5) ---------------------------------------

type RL = { isEnabled: boolean; capacity: bigint; rate: bigint }

/**
 * A chain the pool does not serve at head gets remote pools again: a pool it never accepted
 * before is a re-point (CC-1, strict like BR-6 through a zeroed peer) — the history replay
 * already says so for executed events (review round 7). null = a fresh chain, or the same pool.
 */
function reAdd(q: QueueCtx, pool: string, selector: string, next: string[]): Verdict | null {
  // Review round 8: compared with the pools the chain had LAST (an older pool it once had is a
  // roll-back, a re-point all the same); every pool it ever had only when the replay is absent.
  const last = (
    q.ccipLastRemotePools?.(pool, selector) ??
    q.ccipEverRemotePools?.(pool, selector) ??
    []
  ).map(lc)
  const fresh = next.map(lc).filter((x) => !/^0x0*$/i.test(x) && !last.includes(x))
  if (!last.length || !fresh.length) return null
  return down(
    neutral(),
    'CC-1',
    `remote pool for chain ${selector} re-pointed after a removal: ${last.join(', ')} → ${fresh.join(', ')}`,
  )
}

/** Judge one decoded CCIP call against the pools as read at head; null = not a CCIP call. */
function judgeCcip(fn: string, args: readonly unknown[], t: string, q: QueueCtx): Judged[] | null {
  const pool = q.ccipPools?.find((p) => lc(p.pool) === t)
  const chainOf = (sel: string) => pool?.chains.find((c) => c.selector === sel)
  const ctlOrNull = (a: string | null | undefined) => (a && !isZeroAddr(a) ? q.ctl(lc(a)) : null)
  const one = (key: string, title: string, v: Verdict, before?: unknown, after?: unknown) => [
    { key, title, v, before, after, dimension: 'bridge' as const },
  ]
  const limiter = (sel: string, outb: RL, inb: RL, title: string): Judged => {
    const c = chainOf(sel)
    const v = neutral()
    const off = [!outb.isEnabled && 'outbound', !inb.isEnabled && 'inbound'].filter(Boolean)
    // A limiter switched off that is on now is CC-2; with the pool's head state unread, fail
    // closed. A chain the pool does not serve yet has no limiter to switch off (like an executed
    // ChainAdded): noted, not red.
    // Review round 8: a chain the pool does not serve now whose limiter was ON when it was last
    // configured (removed, then re-added with it off) switches it off too.
    const reAddedOff = !c && q.ccipLastLimiterOn?.(t, sel) === true
    // fail-closed audit (MISSED-1): the chain list not read — the chain may be served with its
    // limiter on (setChainRateLimiterConfig reverts for a chain not served)
    const wasOn =
      !pool ||
      (!c && !!pool.chainsUnread) ||
      reAddedOff ||
      (!!c &&
        ((!outb.isEnabled && c.outboundEnabled !== false) ||
          (!inb.isEnabled && c.inboundEnabled !== false)))
    if (off.length && wasOn)
      down(
        v,
        'CC-2',
        `rate limiter ${off.join(' + ')} disabled for chain ${sel}${!pool || (!c && pool.chainsUnread) ? ' (head state not read)' : ''}${reAddedOff ? ' (re-added after a removal; it was on before)' : ''}`,
      )
    else if (off.length) v.notes.push(`rate limiter ${off.join(' + ')} off for new chain ${sel}`)
    return { key: `bridge/ccip/${t}/${sel}/rate_limit`, title, v, dimension: 'bridge' }
  }
  // Fail-closed audit (MISSED-2): why the CURRENT rebalancer is unknown — the pool not read, its
  // getRebalancer failed, the chain list or the chain's silo flag not read, or a silo rebalancer
  // not read; a known address whose controller was not classified at head counts too
  const rebalancerUnread = (sel: string | null, cur: string | null): string | undefined => {
    if (!pool) return 'the pool was not read at head'
    if (sel === null) {
      if (pool.rebalancerUnread) return 'getRebalancer was not read at head'
    } else {
      const c = chainOf(sel)
      if (!c) return pool.chainsUnread ? 'the supported chains were not read at head' : undefined
      if (c.siloed === null) return `whether chain ${sel} is siloed was not read at head`
      if (c.siloed && (c.rebalancer === null || c.rebalancer === undefined))
        return `the silo rebalancer of chain ${sel} was not read at head`
    }
    if (cur && !isZeroAddr(cur) && !q.ctl(lc(cur)))
      return `the current rebalancer ${lc(cur).slice(0, 10)}… could not be classified at head`
    return undefined
  }
  // the remote pools a chain accepts now: [] = the pool does not serve the chain; null = unread
  const remotePoolsNow = (sel: string): string[] | null => {
    // CC-08: a chain list not read is not "the pool does not serve it"
    if (pool?.chainsUnread && !chainOf(sel)) return null
    if (q.ccipRemotePools) return q.ccipRemotePools(t, sel)
    if (!pool) return null
    const c = chainOf(sel)
    return c ? (c.remotePools ?? null) : []
  }
  switch (fn) {
    case 'removeRemotePool': {
      const [sel, rp] = args as [bigint, string]
      return one(
        `bridge/ccip/${t}/${sel}`,
        `CCIP remote pool for chain ${sel} removed`,
        tag(neutral(), 'route_removed'),
        lc(rp),
      )
    }
    case 'setRemotePool': {
      // 1.5.0: one remote pool per chain — a different one is a re-point (CC-1); the pool the
      // chain has now unread ⇒ fail closed
      const [sel, rp] = args as [bigint, string]
      const selector = String(sel)
      const cur = remotePoolsNow(selector)
      const next = lc(rp)
      const v =
        cur === null
          ? down(
              neutral(),
              'CC-1',
              `remote pool for chain ${selector} set to ${next}; the pool it has now could not be read (fail closed)`,
            )
          : cur.length
            ? classifyCcip('remote_pool_set', { prev: cur[0], next })
            : (reAdd(q, t, selector, [next]) ?? classifyCcip('remote_pool_set', { next }))
      return one(
        `bridge/ccip/${t}/${selector}`,
        `CCIP remote pool for chain ${selector} → ${next.slice(0, 12)}…`,
        v,
        cur ?? undefined,
        next,
      )
    }
    case 'setChainRateLimiterConfig': {
      const [sel, outb, inb] = args as [bigint, RL, RL]
      return [limiter(String(sel), outb, inb, `CCIP rate limiter for chain ${sel}`)]
    }
    case 'setChainRateLimiterConfigs': {
      const [sels, outs, ins] = args as [bigint[], RL[], RL[]]
      return sels.map((s, i) =>
        limiter(String(s), outs[i], ins[i], `CCIP rate limiter for chain ${s}`),
      )
    }
    case 'applyChainUpdates': {
      const out: Judged[] = []
      // 1.5.1+: (removes, adds with bytes[] pools); 1.5.0: one list with `allowed` and one pool
      const v15 = args.length === 1
      const removes = v15 ? [] : (args[0] as bigint[]).map(String)
      type Add = {
        remoteChainSelector: bigint
        remotePoolAddresses?: readonly string[]
        remotePoolAddress?: string
        allowed?: boolean
        outboundRateLimiterConfig: RL
        inboundRateLimiterConfig: RL
      }
      const adds = (v15 ? args[0] : args[1]) as readonly Add[]
      for (const sel of removes)
        out.push({
          key: `bridge/ccip/${t}/${sel}`,
          title: `CCIP chain ${sel} removed`,
          v: tag(neutral(), 'route_removed'),
          dimension: 'bridge',
        })
      for (const a of adds) {
        const sel = String(a.remoteChainSelector)
        if (v15 && a.allowed === false) {
          out.push({
            key: `bridge/ccip/${t}/${sel}`,
            title: `CCIP chain ${sel} removed`,
            v: tag(neutral(), 'route_removed'),
            dimension: 'bridge',
          })
          continue
        }
        const next = (
          a.remotePoolAddresses ?? (a.remotePoolAddress ? [a.remotePoolAddress] : [])
        ).map(lc)
        const cur = remotePoolsNow(sel)
        // A chain the pool serves now (or served: it is removed and re-added in this call) that
        // gets a pool it does not accept now is a re-point — CC-1, strict like BR-6.
        const served = (cur?.length ?? 0) > 0
        const fresh = next.filter((x) => !(cur ?? []).map(lc).includes(x))
        let v: Verdict
        if (cur === null)
          v = down(
            neutral(),
            'CC-1',
            `chain ${sel} (re)added with remote pools ${next.join(', ')}; the pools it has now could not be read (fail closed)`,
          )
        else if (served && fresh.length)
          v = down(
            neutral(),
            'CC-1',
            `remote pool for chain ${sel} re-pointed: ${cur.join(', ')} → ${next.join(', ')}`,
          )
        else if (!served) v = reAdd(q, t, sel, next) ?? tag(neutral(), 'route_created')
        else v = tag(neutral(), 'rotation')
        out.push({
          key: `bridge/ccip/${t}/${sel}`,
          title: `CCIP chain ${sel} added (remote pools ${next.map((x) => x.slice(0, 12) + '…').join(', ')})`,
          v,
          before: cur ?? undefined,
          after: next,
          dimension: 'bridge',
        })
        out.push(
          limiter(
            sel,
            a.outboundRateLimiterConfig,
            a.inboundRateLimiterConfig,
            `CCIP rate limiter for chain ${sel} (on add)`,
          ),
        )
      }
      return out
    }
    case 'setRebalancer':
    case 'setSiloRebalancer': {
      const silo = fn === 'setSiloRebalancer'
      const sel = silo ? String(args[0]) : null
      const next = lc((silo ? args[1] : args[0]) as string)
      const cur = silo ? (chainOf(sel!)?.rebalancer ?? null) : (pool?.rebalancer ?? null)
      const v = classifyCcip('rebalancer', {
        prevCtl: ctlOrNull(cur),
        nextCtl: q.ctl(next),
        prevUnread: rebalancerUnread(silo ? sel : null, cur),
        nextUnread:
          !isZeroAddr(next) && !q.ctl(next) ? `${next} (not classified at head)` : undefined,
      })
      return one(
        `bridge/ccip/${t}/rebalancer${sel ? `/${sel}` : ''}`,
        `CCIP ${sel ? `silo rebalancer for chain ${sel}` : 'rebalancer'} (can withdraw locked liquidity) → ${describeController(q.ctl(next))}`,
        v,
        cur ?? undefined,
        next,
      )
    }
    case 'updateSiloDesignations': {
      const [, adds] = args as [
        bigint[],
        readonly { remoteChainSelector: bigint; rebalancer: string }[],
      ]
      return adds.map((a) => {
        const sel = String(a.remoteChainSelector)
        const next = lc(a.rebalancer)
        return {
          key: `bridge/ccip/${t}/rebalancer/${sel}`,
          title: `CCIP chain ${sel} siloed, rebalancer → ${describeController(q.ctl(next))}`,
          v: classifyCcip('rebalancer', {
            prevCtl: ctlOrNull(chainOf(sel)?.rebalancer),
            nextCtl: q.ctl(next),
            prevUnread: rebalancerUnread(sel, chainOf(sel)?.rebalancer ?? null),
            nextUnread:
              !isZeroAddr(next) && !q.ctl(next) ? `${next} (not classified at head)` : undefined,
          }),
          after: next,
          dimension: 'bridge' as const,
        }
      })
    }
    case 'setPool':
    case 'transferAdminRole': {
      // TokenAdminRegistry: only this subject's tokens belong on its card
      const [token, who] = args as [string, string]
      if (!(q.tokens ?? []).map(lc).includes(lc(token))) return []
      const next = lc(who)
      if (fn === 'setPool') {
        const cur = (q.subjectCcipPools ?? []).map(lc)
        const v =
          cur.includes(next) || isZeroAddr(next)
            ? isZeroAddr(next)
              ? tag(neutral(), 'route_removed')
              : neutral()
            : down(
                neutral(),
                'CC-1',
                `CCIP pool for ${lc(token)} replaced: ${cur.join(', ') || 'unknown'} → ${next}`,
              )
        return one(
          `bridge/ccip/pool/${lc(token)}`,
          `CCIP pool for ${lc(token).slice(0, 10)}… → ${next.slice(0, 10)}…`,
          v,
          cur,
          next,
        )
      }
      const prev = q.ccipTokenAdmin?.(lc(token)) ?? null
      return [
        {
          key: `admin/ccip_token_admin/${lc(token)}`,
          title: `CCIP token administrator → ${describeController(q.ctl(next))} (pending acceptance)`,
          // only the current administrator can call it: none known = NOT READ (fail closed)
          v: classifyControllerChange(prev ? q.ctl(prev) : null, q.ctl(next), {
            prevUnread: !prev
              ? 'the current CCIP token administrator was not read (no event set it in the scan)'
              : !q.ctl(prev)
                ? `the current administrator ${prev.slice(0, 10)}… could not be classified at head`
                : undefined,
          }),
          before: prev ?? undefined,
          after: next,
          dimension: 'admin',
        },
      ]
    }
    default:
      return null
  }
}

// ---- OZ timelock ops ----------------------------------------------------------------------------------

export type TimelockOp = {
  /** 'dg' = a Lido Dual Governance proposal (EmergencyProtectedTimelock); default an OZ op. */
  kind?: 'oz' | 'dg'
  /** DG: submitted | scheduled (an OZ op has no status: its state is getTimestamp). */
  status?: string
  timelock: string
  id: string
  calls: Call[]
  predecessor: string
  delaySec: number
  scheduledBlock: number
  scheduledTs?: number
  scheduledTx: string
  /** getTimestamp(id) at head: 0 unset/cancelled, 1 executed, else ETA (unix s); null = not read. */
  timestamp: number | null
  /** isOperationDone(predecessor); null = the read failed (never read as "cannot execute"). */
  predecessorDone: boolean | null
  /**
   * eth_call execute/executeBatch from an executor at head: 'revert' = the call reverted;
   * 'not_run' = could not be built (salt not recovered); 'error' = the RPC failed (not a revert).
   */
  simulation: 'ok' | 'revert' | 'not_run' | 'error'
  /** Fail-closed audit (QU-05): a call index of the op was never seen (a lost CallScheduled). */
  callsIncomplete?: boolean
  /** Fail-closed audit (QU-04): the accounts the execute() simulation ran from. */
  simulatedFrom?: string[]
}

export type OpStatus =
  | 'cancelled'
  | 'executed'
  | 'pending'
  | 'armed'
  | 'armed_unverified'
  | 'ready_unexecutable'
  | 'unread'

export function opStatus(op: TimelockOp, now: number): OpStatus {
  if (op.timestamp === null || op.timestamp === undefined) return 'unread'
  if (op.timestamp === 0) return 'cancelled'
  if (op.timestamp === 1) return 'executed'
  if (op.timestamp > now) return 'pending'
  // only a predecessor READ as not done blocks the op; an unread one (null) fails closed
  if (op.predecessorDone === false) return 'ready_unexecutable'
  if (op.simulation === 'ok') return 'armed'
  if (op.simulation === 'revert') return 'ready_unexecutable'
  // could not be simulated: never assume it cannot execute
  return 'armed_unverified'
}

function toChange(
  j: Judged,
  base: Partial<ConfigChange> & { id: string; state: ConfigChange['state']; stage: Stage },
  q: QueueCtx,
  extraTags: ChangeTag[] = [],
): ConfigChange {
  for (const t of extraTags) tag(j.v, t)
  return {
    subject: q.subject,
    dimension: j.dimension,
    key: j.key,
    title: j.title,
    before: j.before,
    after: j.after,
    beforeDisplay: j.beforeDisplay,
    afterDisplay: j.afterDisplay,
    severity: j.v.severity,
    floorBreach: j.v.floorBreach,
    red: isRed(j.v),
    ruleIds: j.v.ruleIds,
    tags: j.v.tags as ChangeTag[],
    unannounced: null,
    announcement: q.announcement,
    chainId: 1,
    route: j.route,
    notes: j.v.notes.length ? j.v.notes : undefined,
    ...base,
  }
}

export function timelockChanges(ops: TimelockOp[], q: QueueCtx, now: number): ConfigChange[] {
  const out: ConfigChange[] = []
  for (const op of ops) {
    const st = opStatus(op, now)
    if (st === 'cancelled' || st === 'executed') continue
    const armed = st === 'armed' || st === 'armed_unverified'
    const dg = op.kind === 'dg'
    // A Dual Governance proposal's calls run from its executor: an Aragon Agent forward(script)
    // is unwrapped into the script's calls, and ACL / Kernel calls become the role grants and
    // upgrades they are (judged on the app they act on).
    const calls = dg
      ? aragonCalls(
          op.calls.filter(Boolean).flatMap((c) => unwrapCalls(c).calls),
          q.aragonAppProxies,
          { unmappedAsUpgrade: !!q.aragonAppsIncomplete },
        )
      : op.calls
    // An op whose state could not be read may be executable right now: judge its calls as
    // armed (AD-8, stale rollback) — fail closed — while its stage stays "scheduled".
    const judgeArmed = armed || st === 'unread'
    const judged = judgeCalls(calls, q, {
      armed: judgeArmed,
      scheduledBlock: op.scheduledBlock,
    })
    calls.forEach((c, i) => {
      if (!c || !callIsForSubject(c, q)) return
      for (const [k, j] of judged[i].entries()) {
        // AD-8: an ARMED op whose call would break any rule (or one whose state is unread).
        if (judgeArmed && j.v.severity === 'downgrade' && !j.v.ruleIds.includes('AD-8'))
          down(j.v, 'AD-8', armed ? 'executable now' : 'state unread: may be executable now')
        if (st === 'armed_unverified')
          j.v.notes.push(
            'past its ETA; the execute simulation could not be run (salt not recovered or RPC error) — treated as executable',
          )
        if (st === 'unread')
          j.v.notes.push(
            dg
              ? 'the Dual Governance delays could not be read at head: the proposal may be executable'
              : 'getTimestamp could not be read at head: the op may be pending, ready or done',
          )
        if (dg)
          j.v.notes.push(
            `Dual Governance proposal #${op.id} ${op.status ?? ''}: ${op.status === 'submitted' ? 'not yet scheduled — veto signalling by stETH holders can extend the wait' : 'scheduled'}; execute() is permissionless once the after-schedule delay passes`,
          )
        if (op.callsIncomplete) {
          tag(j.v, 'read_gap')
          j.v.notes.push(
            'some calls of this op were not read (a CallScheduled log is missing): the op is judged on the calls seen',
          )
        }
        out.push(
          toChange(
            j,
            {
              id: `${op.timelock}:${op.id}:${i}${k ? `:${k}` : ''}`,
              state: 'pending',
              // past its ETA but cannot execute (predecessor missing / execute reverts): stale.
              // Fail-closed audit (DG-02): a state that was not read may be executable now — counted
              // with the armed ops (it was "scheduled": plain pending)
              stage:
                armed || st === 'unread'
                  ? 'armed'
                  : st === 'ready_unexecutable'
                    ? 'stale'
                    : 'scheduled',
              block: op.scheduledBlock,
              ts: op.scheduledTs,
              tx: op.scheduledTx,
              eta: op.timestamp ?? undefined,
              queue: {
                kind: dg ? 'dg_timelock' : 'oz_timelock',
                address: op.timelock,
                opId: op.id,
              },
            },
            q,
            st === 'ready_unexecutable'
              ? ['not_executable']
              : st === 'armed_unverified'
                ? ['not_simulated']
                : st === 'unread'
                  ? ['state_unread']
                  : [],
          ),
        )
      }
    })
  }
  return out
}

// ---- Safe Transaction Service -----------------------------------------------------------------------

export type SafeProposal = {
  safe: string
  nonce: number
  to: string
  value: string
  data: string | null
  confirmations: number
  confirmationsRequired: number
  submissionDate?: string
  safeTxHash: string
  /** 0 CALL, 1 DELEGATECALL (Safe Tx Service `operation`); absent = not read. */
  operation?: number
}

/** A Safe DELEGATECALL to code other than a known Safe library: red AD-6 (the Bybit pattern). */
function delegatecallJudged(safeAddr: string, c: Call): Judged {
  const v = tag(neutral(), 'delegatecall')
  down(
    v,
    'AD-6',
    `DELEGATECALL to ${c.target} (${c.data.slice(0, 10)}): its code runs AS the Safe and can rewrite the singleton, owners, modules or guard`,
  )
  return {
    key: `admin/safe/${lc(safeAddr)}/delegatecall`,
    title: `Safe ${lc(safeAddr).slice(0, 10)}…: DELEGATECALL to ${c.target.slice(0, 10)}… (${c.data.slice(0, 10)})`,
    v,
    after: c.target,
    dimension: 'admin',
  }
}

export function safeProposalChanges(rows: SafeProposal[], q: QueueCtx): ConfigChange[] {
  const out: ConfigChange[] = []
  for (const p of rows) {
    // fail-closed audit (M-3): an empty-calldata DELEGATECALL runs the target's fallback AS the
    // Safe — never skipped as "no call"
    if ((!p.data || p.data === '0x') && p.operation !== 1) continue
    const to = lc(p.to)
    // Review round 6 (AD-6): a DELEGATECALL runs the target's code AS the Safe. Only a MultiSend
    // library is unwrapped (its entries carry their own operation); anything else is one red row,
    // whatever the target — the call data says nothing about what that code does.
    const top: Call = { target: to, value: p.value, data: p.data || '0x', operation: p.operation }
    const viaLib = p.operation === 1 && SAFE_DELEGATE_LIBS.has(to)
    const { calls, via } =
      p.operation === 1 && !viaLib ? { calls: [top], via: undefined } : unwrapCalls(top)
    // Fully signed (review round 5): anyone can submit execTransaction with the collected
    // signatures now — ARMED, like a confirmed MultiSigWallet transaction.
    const armed = p.confirmationsRequired > 0 && p.confirmations >= p.confirmationsRequired
    const isDelegate = (c: Call) => c.operation === 1 && !SAFE_DELEGATE_LIBS.has(lc(c.target))
    // the other calls are judged in order against one working copy
    const inOrder = judgeCalls(
      calls.filter((c) => !isDelegate(c)),
      q,
      { armed },
    )
    let n = 0
    const judged = calls.map((c) =>
      isDelegate(c) ? [delegatecallJudged(p.safe, c)] : inOrder[n++],
    )
    calls.forEach((c, i) => {
      // a call to the proposing Safe itself (owners, threshold, modules) is always this card's;
      // so is a DELEGATECALL (it runs as the Safe)
      if (!isDelegate(c) && !callIsForSubject(c, q) && lc(c.target) !== lc(p.safe)) return
      for (const [k, j] of judged[i].entries()) {
        if (via === 'bypass') tag(j.v, 'timelock_bypass')
        if (armed && j.v.severity === 'downgrade' && !j.v.ruleIds.includes('AD-8'))
          down(j.v, 'AD-8', 'fully signed, not executed: anyone can execute it now')
        j.v.notes.push(
          `Safe ${p.safe.slice(0, 10)}… nonce ${p.nonce}: ${p.confirmations}/${p.confirmationsRequired} signatures${armed ? ' (enough — executable now)' : ''}${via === 'schedule' ? ' (schedules a timelock op)' : via === 'bypass' ? ' (timelock BYPASS: executes with no delay)' : ''}`,
        )
        out.push(
          toChange(
            j,
            {
              // M-5: competing proposals at one nonce keep distinct ids (the safeTxHash)
              id: `safe:${lc(p.safe)}:${p.nonce}:${String(p.safeTxHash ?? '').slice(0, 10)}:${i}${k ? `:${k}` : ''}`,
              state: 'proposed',
              stage: armed ? 'armed' : 'safe_queued',
              ts: p.submissionDate ? Math.floor(Date.parse(p.submissionDate) / 1000) : undefined,
              queue: { kind: 'safe', address: lc(p.safe), opId: p.safeTxHash },
            },
            q,
          ),
        )
      }
    })
  }
  return out
}

// ---- legacy Gnosis MultiSigWallet submissions -----------------------------------------------------
//
// A MultiSigWallet (WBTC's Controller / Members owners) stores each submitted transaction
// on-chain until enough owners confirm it, so its pending changes ARE observable (default the
// owner did not object to, 2026-10-06): every submitted-but-unexecuted transaction is PENDING.
// There is no minimum delay — the last confirmation executes it at once — so a fully confirmed
// transaction that is still unexecuted (its execution failed) is ARMED: any owner can execute it.

export type MultisigSubmission = {
  multisig: string
  txId: number
  destination: string
  value: string
  data: string | null
  confirmations: number
  required: number
  executed: boolean
  /** Block / time of the Submission event, when found. */
  block?: number
  ts?: number
  tx?: string
}

export function multisigSubmissionChanges(rows: MultisigSubmission[], q: QueueCtx): ConfigChange[] {
  const out: ConfigChange[] = []
  for (const p of rows) {
    if (p.executed || !p.data || p.data === '0x') continue
    const { calls, via } = unwrapCalls({ target: lc(p.destination), value: p.value, data: p.data })
    const armed = p.confirmations >= p.required
    const judged = judgeCalls(calls, q, { armed })
    calls.forEach((c, i) => {
      // a call to the multisig itself (owners, requirement) is always this card's
      if (!callIsForSubject(c, q) && lc(c.target) !== lc(p.multisig)) return
      for (const [k, j] of judged[i].entries()) {
        if (via === 'bypass') tag(j.v, 'timelock_bypass')
        if (armed && j.v.severity === 'downgrade' && !j.v.ruleIds.includes('AD-8'))
          down(j.v, 'AD-8', 'fully confirmed, not executed: any owner can execute it now')
        j.v.notes.push(
          `MultiSigWallet ${p.multisig.slice(0, 10)}… tx ${p.txId}: ${p.confirmations}/${p.required} confirmations${armed ? ' (enough — executable now)' : ''}${via === 'schedule' ? ' (schedules a timelock op)' : via === 'bypass' ? ' (timelock BYPASS: executes with no delay)' : ''}`,
        )
        out.push(
          toChange(
            j,
            {
              id: `multisig:${lc(p.multisig)}:${p.txId}:${i}${k ? `:${k}` : ''}`,
              state: 'pending',
              stage: armed ? 'armed' : 'submitted',
              block: p.block,
              ts: p.ts,
              tx: p.tx,
              queue: { kind: 'legacy_multisig', address: lc(p.multisig), opId: String(p.txId) },
            },
            q,
          ),
        )
      }
    })
  }
  return out
}

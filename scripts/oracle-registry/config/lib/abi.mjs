// Event and function ABIs for the config-card collector, plus pure log decoders.
//
// Several events exist in two shapes with the same topic0 (an argument indexed in one version
// and not in another: Safe 1.3 vs 1.4.1 AddedOwner, FiatToken's non-indexed
// OwnershipTransferred). decodeLog tries every variant and keeps the one whose topic count fits.
// Pure: no network, no filesystem — unit-tested in tests/unit/oracleRegistryConfigCollector.test.ts.

import {
  decodeEventLog,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  toHex,
} from 'viem'

const ULN =
  '(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)'
const RL = '(bool isEnabled, uint128 capacity, uint128 rate)'

/** name → one or more human-readable event signatures (variants share topic0). */
export const EVENT_SIGS = {
  // LayerZero OApp / EndpointV2 / ULN libraries / DVNs
  PeerSet: ['event PeerSet(uint32 eid, bytes32 peer)'],
  UlnConfigSet: [`event UlnConfigSet(address oapp, uint32 eid, ${ULN} config)`],
  DefaultUlnConfigsSet: [`event DefaultUlnConfigsSet((uint32 eid, ${ULN} config)[] params)`],
  SendLibrarySet: ['event SendLibrarySet(address sender, uint32 eid, address newLib)'],
  ReceiveLibrarySet: ['event ReceiveLibrarySet(address receiver, uint32 eid, address newLib)'],
  ReceiveLibraryTimeoutSet: [
    'event ReceiveLibraryTimeoutSet(address receiver, uint32 eid, address oldLib, uint256 timeout)',
  ],
  DefaultSendLibrarySet: ['event DefaultSendLibrarySet(uint32 eid, address newLib)'],
  DefaultReceiveLibrarySet: ['event DefaultReceiveLibrarySet(uint32 eid, address newLib)'],
  DefaultReceiveLibraryTimeoutSet: [
    'event DefaultReceiveLibraryTimeoutSet(uint32 eid, address oldLib, uint256 expiry)',
  ],
  DelegateSet: ['event DelegateSet(address sender, address delegate)'],
  UpdateSigner: ['event UpdateSigner(address _signer, bool _active)'],
  UpdateQuorum: ['event UpdateQuorum(uint64 _quorum)'],
  // proxies / ownership / roles
  Upgraded: [
    'event Upgraded(address indexed implementation)',
    'event Upgraded(address implementation)',
  ],
  AdminChanged: ['event AdminChanged(address previousAdmin, address newAdmin)'],
  BeaconUpgraded: ['event BeaconUpgraded(address indexed beacon)'],
  OwnershipTransferred: [
    'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
    'event OwnershipTransferred(address previousOwner, address newOwner)',
  ],
  RoleGranted: [
    'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  ],
  RoleRevoked: [
    'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
  ],
  RoleAdminChanged: [
    'event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)',
  ],
  // Solady EnumerableRoles (ether.fi RoleRegistry, review round 6): one event for grant and revoke
  RoleSet: [
    'event RoleSet(address indexed holder, uint256 indexed role, bool indexed active)',
    'event RoleSet(address indexed holder, uint256 indexed role, bool active)',
    'event RoleSet(address holder, uint256 role, bool active)',
  ],
  // OZ TimelockController
  MinDelayChange: ['event MinDelayChange(uint256 oldDuration, uint256 newDuration)'],
  CallScheduled: [
    'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
  ],
  CallExecuted: [
    'event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)',
  ],
  CallSalt: ['event CallSalt(bytes32 indexed id, bytes32 salt)'],
  Cancelled: ['event Cancelled(bytes32 indexed id)'],
  // Ethena timelock no-delay whitelist (executeWhitelisted) — review round 6, AD-2
  FunctionWhitelisted: [
    'event FunctionWhitelisted(address indexed target, bytes4 indexed selector)',
    'event FunctionWhitelisted(address target, bytes4 selector)',
  ],
  FunctionRemovedFromWhitelist: [
    'event FunctionRemovedFromWhitelist(address indexed target, bytes4 indexed selector)',
    'event FunctionRemovedFromWhitelist(address target, bytes4 selector)',
  ],
  // Safe
  AddedOwner: ['event AddedOwner(address indexed owner)', 'event AddedOwner(address owner)'],
  RemovedOwner: ['event RemovedOwner(address indexed owner)', 'event RemovedOwner(address owner)'],
  ChangedThreshold: ['event ChangedThreshold(uint256 threshold)'],
  ChangedGuard: ['event ChangedGuard(address indexed guard)', 'event ChangedGuard(address guard)'],
  ChangedModuleGuard: [
    'event ChangedModuleGuard(address indexed moduleGuard)',
    'event ChangedModuleGuard(address moduleGuard)',
  ],
  EnabledModule: [
    'event EnabledModule(address indexed module)',
    'event EnabledModule(address module)',
  ],
  DisabledModule: [
    'event DisabledModule(address indexed module)',
    'event DisabledModule(address module)',
  ],
  ChangedFallbackHandler: [
    'event ChangedFallbackHandler(address indexed handler)',
    'event ChangedFallbackHandler(address handler)',
  ],
  // legacy Gnosis MultiSigWallet
  OwnerAddition: ['event OwnerAddition(address indexed owner)'],
  OwnerRemoval: ['event OwnerRemoval(address indexed owner)'],
  RequirementChange: ['event RequirementChange(uint256 required)'],
  // a legacy MultiSigWallet transaction submitted (its block = when a pending one was queued;
  // scanned per multisig, not in the admin scan — review round 7)
  Submission: ['event Submission(uint256 indexed transactionId)'],
  // FiatToken (cbBTC)
  MasterMinterChanged: ['event MasterMinterChanged(address indexed newMasterMinter)'],
  PauserChanged: ['event PauserChanged(address indexed newAddress)'],
  BlacklisterChanged: ['event BlacklisterChanged(address indexed newBlacklister)'],
  MinterConfigured: ['event MinterConfigured(address indexed minter, uint256 minterAllowedAmount)'],
  MinterRemoved: ['event MinterRemoved(address indexed oldMinter)'],
  // CCIP
  PoolSet: [
    'event PoolSet(address indexed token, address indexed previousPool, address indexed newPool)',
  ],
  AdministratorTransferred: [
    'event AdministratorTransferred(address indexed token, address indexed newAdmin)',
  ],
  RemotePoolSet: [
    'event RemotePoolSet(uint64 indexed remoteChainSelector, bytes previousPoolAddress, bytes remotePoolAddress)',
  ],
  RemotePoolAdded: [
    'event RemotePoolAdded(uint64 indexed remoteChainSelector, bytes remotePoolAddress)',
  ],
  RemotePoolRemoved: [
    'event RemotePoolRemoved(uint64 indexed remoteChainSelector, bytes remotePoolAddress)',
  ],
  ChainConfigured: [
    `event ChainConfigured(uint64 remoteChainSelector, ${RL} outboundRateLimiterConfig, ${RL} inboundRateLimiterConfig)`,
  ],
  ChainAdded: [
    `event ChainAdded(uint64 remoteChainSelector, bytes remoteToken, ${RL} outboundRateLimiterConfig, ${RL} inboundRateLimiterConfig)`,
  ],
  ChainRemoved: ['event ChainRemoved(uint64 remoteChainSelector)'],
  RebalancerSet: ['event RebalancerSet(address oldRebalancer, address newRebalancer)'],
  // CCIP 1.6 SiloedLockReleaseTokenPool (review round 5): per-chain (siloed) and shared rebalancers
  SiloRebalancerSet: [
    'event SiloRebalancerSet(uint64 indexed remoteChainSelector, address oldRebalancer, address newRebalancer)',
  ],
  UnsiloedRebalancerSet: [
    'event UnsiloedRebalancerSet(address oldRebalancer, address newRebalancer)',
  ],
  ChainSiloed: ['event ChainSiloed(uint64 remoteChainSelector, address rebalancer)'],
  // Aragon (Lido DAO): ACL permissions and Kernel app upgrades. Rows are rewritten before the
  // engine sees them (aragonRows): SetPermission → RoleGranted / RoleRevoked on the APP,
  // ChangePermissionManager → PermissionManagerChanged on the app, SetApp(base) → Upgraded on
  // every app proxy with that appId.
  SetPermission: [
    'event SetPermission(address indexed entity, address indexed app, bytes32 indexed role, bool allowed)',
  ],
  ChangePermissionManager: [
    'event ChangePermissionManager(address indexed app, bytes32 indexed role, address indexed manager)',
  ],
  SetApp: ['event SetApp(bytes32 indexed namespace, bytes32 indexed appId, address app)'],
  // Lido Dual Governance: the EmergencyProtectedTimelock (delays, committees, governance) and
  // the DualGovernance contract (proposers, canceller, reseal / tiebreaker committees). Durations
  // are uint32 seconds, timestamps uint40.
  GovernanceSet: ['event GovernanceSet(address newGovernance)'],
  AdminExecutorSet: ['event AdminExecutorSet(address newAdminExecutor)'],
  AfterSubmitDelaySet: ['event AfterSubmitDelaySet(uint32 newAfterSubmitDelay)'],
  AfterScheduleDelaySet: ['event AfterScheduleDelaySet(uint32 newAfterScheduleDelay)'],
  EmergencyGovernanceSet: ['event EmergencyGovernanceSet(address newEmergencyGovernance)'],
  EmergencyActivationCommitteeSet: [
    'event EmergencyActivationCommitteeSet(address newActivationCommittee)',
  ],
  EmergencyExecutionCommitteeSet: [
    'event EmergencyExecutionCommitteeSet(address newExecutionCommittee)',
  ],
  EmergencyModeDurationSet: ['event EmergencyModeDurationSet(uint32 newEmergencyModeDuration)'],
  EmergencyProtectionEndDateSet: [
    'event EmergencyProtectionEndDateSet(uint40 newEmergencyProtectionEndDate)',
  ],
  EmergencyModeActivated: ['event EmergencyModeActivated()'],
  EmergencyModeDeactivated: ['event EmergencyModeDeactivated()'],
  // AD-5's twin for a Dual Governance timelock: an upgrade it executed carries this in the tx
  ProposalExecuted: [
    'event ProposalExecuted(uint256 indexed id)',
    'event ProposalExecuted(uint256 id)',
  ],
  // Oracle committee members (owner ruling 2026-10-08, #13 — closes KG-1): replayed as admin
  // events and judged by the path that made them. Lido HashConsensus (signatures measured on
  // 0xd624…b288, 2026-10-08: the totals after each change are in the data) and ether.fi
  // EtherFiOracle (verified source of 0x0565…2b9e behind 0x57aa…6a41).
  MemberAdded: [
    'event MemberAdded(address indexed addr, uint256 newTotalMembers, uint256 newQuorum)',
  ],
  MemberRemoved: [
    'event MemberRemoved(address indexed addr, uint256 newTotalMembers, uint256 newQuorum)',
  ],
  CommitteeMemberAdded: ['event CommitteeMemberAdded(address indexed member)'],
  CommitteeMemberRemoved: ['event CommitteeMemberRemoved(address indexed member)'],
  CommitteeMemberUpdated: ['event CommitteeMemberUpdated(address indexed member, bool enabled)'],
  // An Aragon Voting executed a passed vote: marks a transaction as made through the vote (the
  // delayed path of a Lido committee before Dual Governance)
  ExecuteVote: ['event ExecuteVote(uint256 indexed voteId)'],
  ProposerRegistered: [
    'event ProposerRegistered(address indexed proposer, address indexed executor)',
  ],
  ProposerExecutorSet: [
    'event ProposerExecutorSet(address indexed proposer, address indexed executor)',
  ],
  ProposerUnregistered: ['event ProposerUnregistered(address indexed proposer)'],
  ProposalsCancellerSet: ['event ProposalsCancellerSet(address proposalsCanceller)'],
  ResealCommitteeSet: ['event ResealCommitteeSet(address resealCommittee)'],
  TiebreakerCommitteeSet: ['event TiebreakerCommitteeSet(address newTiebreakerCommittee)'],
  ConfigProviderSet: ['event ConfigProviderSet(address newConfigProvider)'],
  // Wormhole Native Token Transfers (NttManager 1.x and its transceivers). Signatures measured on
  // the wstETH → BNB manager 0xb948a938… (2026-10-07): none of the arguments is indexed except
  // PeerUpdated's chain id and PauserTransferred's two addresses.
  ThresholdChanged: ['event ThresholdChanged(uint8 oldThreshold, uint8 threshold)'],
  TransceiverAdded: [
    'event TransceiverAdded(address transceiver, uint256 transceiversNum, uint8 threshold)',
  ],
  TransceiverRemoved: ['event TransceiverRemoved(address transceiver, uint8 threshold)'],
  PeerUpdated: [
    'event PeerUpdated(uint16 indexed chainId_, bytes32 oldPeerContract, uint8 oldPeerDecimals, bytes32 peerContract, uint8 peerDecimals)',
  ],
  PauserTransferred: [
    'event PauserTransferred(address indexed oldPauser, address indexed newPauser)',
  ],
  SetWormholePeer: ['event SetWormholePeer(uint16 chainId, bytes32 peerContract)'],
  AxelarChainIdSet: [
    'event AxelarChainIdSet(uint16 chainId, string axelarChainId, string transceiverAddress)',
  ],
}

const ITEMS = Object.fromEntries(
  Object.entries(EVENT_SIGS).map(([k, sigs]) => [k, sigs.map((s) => parseAbiItem(s))]),
)
export const TOPIC = Object.fromEntries(
  Object.entries(ITEMS).map(([k, items]) => [k, toEventSelector(items[0])]),
)
const BY_TOPIC = new Map(Object.entries(ITEMS).map(([k, items]) => [TOPIC[k], { name: k, items }]))

export const LZ_TOPICS = [
  'PeerSet',
  'UlnConfigSet',
  'DefaultUlnConfigsSet',
  'SendLibrarySet',
  'ReceiveLibrarySet',
  'ReceiveLibraryTimeoutSet',
  'DefaultSendLibrarySet',
  'DefaultReceiveLibrarySet',
  'DefaultReceiveLibraryTimeoutSet',
  'DelegateSet',
].map((k) => TOPIC[k])
export const DVN_TOPICS = ['UpdateSigner', 'UpdateQuorum'].map((k) => TOPIC[k])
export const ADMIN_TOPICS = Object.keys(EVENT_SIGS)
  .filter(
    (k) =>
      ![
        'PeerSet',
        'UlnConfigSet',
        'DefaultUlnConfigsSet',
        'SendLibrarySet',
        'ReceiveLibrarySet',
        'ReceiveLibraryTimeoutSet',
        'DefaultSendLibrarySet',
        'DefaultReceiveLibrarySet',
        'DefaultReceiveLibraryTimeoutSet',
        'DelegateSet',
        'UpdateSigner',
        'UpdateQuorum',
        'Submission',
      ].includes(k),
  )
  .map((k) => TOPIC[k])

const plain = (v) => {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase()
  return v
}

/** Every choice of `t` of the indices 0..n−1, in order. */
function choose(n, t, from = 0, acc = [], out = []) {
  if (acc.length === t) return (out.push([...acc]), out)
  for (let i = from; i < n; i++) choose(n, t, i + 1, [...acc, i], out)
  return out
}

/**
 * Decode one raw log into { event, args } (bigints → decimal strings, addresses lower-case).
 * Fail-closed audit (EV-02, 2026-10-10): the same event signature with a DIFFERENT indexing (an
 * OwnershipTransferred with one indexed argument; an AdminChanged with both) is the same
 * semantic event — it decoded to null and the scan dropped it (a lost ownership or proxy-admin
 * transfer). After the declared shapes, every choice of (topics − 1) indexed parameters is tried,
 * with strict data length. null = it does not decode at all (the scan then reports it).
 */
export function decodeLog(log) {
  const hit = BY_TOPIC.get(log.topics?.[0])
  if (!hit) return null
  const tryItem = (item) => {
    try {
      const d = decodeEventLog({ abi: [item], data: log.data, topics: log.topics, strict: true })
      // an event with no parameters (Dual Governance EmergencyModeActivated()) decodes to no args
      return { event: hit.name, args: plain(d.args ?? {}) }
    } catch {
      return null
    }
  }
  for (const item of hit.items) {
    const d = tryItem(item)
    if (d) return d
  }
  const base = hit.items[0]
  const n = base.inputs?.length ?? 0
  const t = (log.topics?.length ?? 1) - 1
  if (t < 0 || t > n) return null
  for (const idx of choose(n, t)) {
    const item = {
      ...base,
      inputs: base.inputs.map((x, i) => ({ ...x, indexed: idx.includes(i) })),
    }
    const d = tryItem(item)
    if (d) return d
  }
  return null
}

const ulnOf = (c) => ({
  confirmations: String(c.confirmations),
  requiredDVNCount: Number(c.requiredDVNCount),
  optionalDVNCount: Number(c.optionalDVNCount),
  optionalDVNThreshold: Number(c.optionalDVNThreshold),
  requiredDVNs: c.requiredDVNs.map((a) => a.toLowerCase()),
  optionalDVNs: c.optionalDVNs.map((a) => a.toLowerCase()),
})

/**
 * A decoded LayerZero config log → LzEvent rows (lib/oracleRegistry/config/lzReplay.ts).
 * `oapps` (lower-case set) filters per-OApp events; global (default) events are always kept.
 */
export function lzEventsOf(row, oapps) {
  const base = {
    chainId: row.chainId,
    block: row.block,
    logIndex: row.logIndex,
    tx: row.tx,
    ts: row.ts,
  }
  const a = row.args
  const want = (o) => !oapps || oapps.has(String(o).toLowerCase())
  switch (row.event) {
    case 'PeerSet':
      return want(row.emitter)
        ? [
            {
              ...base,
              kind: 'peer',
              oapp: row.emitter,
              eid: Number(a.eid),
              peer: a.peer.toLowerCase(),
            },
          ]
        : []
    case 'UlnConfigSet':
      return want(a.oapp)
        ? [
            {
              ...base,
              kind: 'uln',
              lib: row.emitter,
              oapp: a.oapp,
              eid: Number(a.eid),
              config: ulnOf(a.config),
            },
          ]
        : []
    case 'DefaultUlnConfigsSet':
      return a.params.map((p, sub) => ({
        ...base,
        sub,
        kind: 'uln_default',
        lib: row.emitter,
        eid: Number(p.eid),
        config: ulnOf(p.config),
      }))
    case 'SendLibrarySet':
      return want(a.sender)
        ? [{ ...base, kind: 'send_lib', oapp: a.sender, eid: Number(a.eid), lib: a.newLib }]
        : []
    case 'ReceiveLibrarySet':
      return want(a.receiver)
        ? [{ ...base, kind: 'recv_lib', oapp: a.receiver, eid: Number(a.eid), lib: a.newLib }]
        : []
    case 'ReceiveLibraryTimeoutSet':
      return want(a.receiver)
        ? [
            {
              ...base,
              kind: 'recv_timeout',
              oapp: a.receiver,
              eid: Number(a.eid),
              lib: a.oldLib,
              expiry: Number(a.timeout),
            },
          ]
        : []
    case 'DefaultSendLibrarySet':
      return [{ ...base, kind: 'default_send_lib', eid: Number(a.eid), lib: a.newLib }]
    case 'DefaultReceiveLibrarySet':
      return [{ ...base, kind: 'default_recv_lib', eid: Number(a.eid), lib: a.newLib }]
    case 'DefaultReceiveLibraryTimeoutSet':
      return [
        {
          ...base,
          kind: 'default_recv_timeout',
          eid: Number(a.eid),
          lib: a.oldLib,
          expiry: Number(a.expiry),
        },
      ]
    case 'DelegateSet':
      return want(a.sender)
        ? [{ ...base, kind: 'delegate', oapp: a.sender, delegate: a.delegate }]
        : []
    default:
      return []
  }
}

// ---- function ABIs ----------------------------------------------------------------------------

export const FN = {
  owner: 'function owner() view returns (address)',
  peers: 'function peers(uint32) view returns (bytes32)',
  delegates: 'function delegates(address) view returns (address)',
  getSendLibrary: 'function getSendLibrary(address,uint32) view returns (address)',
  getReceiveLibrary:
    'function getReceiveLibrary(address,uint32) view returns (address lib, bool isDefault)',
  receiveLibraryTimeout:
    'function receiveLibraryTimeout(address,uint32) view returns (address lib, uint256 expiry)',
  defaultReceiveLibraryTimeout:
    'function defaultReceiveLibraryTimeout(uint32) view returns (address lib, uint256 expiry)',
  isDefaultSendLibrary: 'function isDefaultSendLibrary(address,uint32) view returns (bool)',
  getConfig: 'function getConfig(address,address,uint32,uint32) view returns (bytes)',
  getAppUlnConfig: `function getAppUlnConfig(address,uint32) view returns (${ULN})`,
  getUlnConfig: `function getUlnConfig(address,uint32) view returns (${ULN})`,
  getRegisteredLibraries: 'function getRegisteredLibraries() view returns (address[])',
  quorum: 'function quorum() view returns (uint64)',
  signerSize: 'function signerSize() view returns (uint256)',
  // controllers
  getThreshold: 'function getThreshold() view returns (uint256)',
  getOwners: 'function getOwners() view returns (address[])',
  VERSION: 'function VERSION() view returns (string)',
  getModulesPaginated:
    'function getModulesPaginated(address,uint256) view returns (address[] array, address next)',
  getStorageAt: 'function getStorageAt(uint256,uint256) view returns (bytes)',
  getMinDelay: 'function getMinDelay() view returns (uint256)',
  required: 'function required() view returns (uint256)',
  delay: 'function delay() view returns (uint256)',
  hasRole: 'function hasRole(bytes32,address) view returns (bool)',
  getRoleMemberCount: 'function getRoleMemberCount(bytes32) view returns (uint256)',
  getRoleMember: 'function getRoleMember(bytes32,uint256) view returns (address)',
  getRoleAdmin: 'function getRoleAdmin(bytes32) view returns (bytes32)',
  getTimestamp: 'function getTimestamp(bytes32) view returns (uint256)',
  isOperationDone: 'function isOperationDone(bytes32) view returns (bool)',
  hashOperation:
    'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns (bytes32)',
  nonce: 'function nonce() view returns (uint256)',
  // CCIP
  getPool: 'function getPool(address) view returns (address)',
  getRebalancer: 'function getRebalancer() view returns (address)',
  isSiloed: 'function isSiloed(uint64) view returns (bool)',
  getChainRebalancer: 'function getChainRebalancer(uint64) view returns (address)',
  getSupportedChains: 'function getSupportedChains() view returns (uint64[])',
  getRemotePools: 'function getRemotePools(uint64) view returns (bytes[])',
  getRemotePool: 'function getRemotePool(uint64) view returns (bytes)',
  // legacy Gnosis MultiSigWallet (submissions are stored on-chain until confirmed)
  transactionCount: 'function transactionCount() view returns (uint256)',
  getTransactionCount:
    'function getTransactionCount(bool pending, bool executed) view returns (uint256)',
  getTransactionIds:
    'function getTransactionIds(uint256 from, uint256 to, bool pending, bool executed) view returns (uint256[])',
  msTransactions:
    'function transactions(uint256) view returns (address destination, uint256 value, bytes data, bool executed)',
  getConfirmationCount: 'function getConfirmationCount(uint256) view returns (uint256)',
  // value at risk (severity rank of floor breaches)
  token: 'function token() view returns (address)',
  balanceOf: 'function balanceOf(address) view returns (uint256)',
  totalSupply: 'function totalSupply() view returns (uint256)',
  decimals: 'function decimals() view returns (uint8)',
  getCurrentInboundRateLimiterState:
    'function getCurrentInboundRateLimiterState(uint64) view returns ((uint128 tokens, uint32 lastUpdated, bool isEnabled, uint128 capacity, uint128 rate))',
  getCurrentOutboundRateLimiterState:
    'function getCurrentOutboundRateLimiterState(uint64) view returns ((uint128 tokens, uint32 lastUpdated, bool isEnabled, uint128 capacity, uint128 rate))',
  // Aragon (Lido DAO)
  acl: 'function acl() view returns (address)',
  kernel: 'function kernel() view returns (address)',
  appId: 'function appId() view returns (bytes32)',
  aclHasPermission: 'function hasPermission(address,address,bytes32) view returns (bool)',
  getPermissionManager: 'function getPermissionManager(address,bytes32) view returns (address)',
}
export const fnAbi = (sig) => parseAbi([sig])

// Safe storage slots (read through Safe.getStorageAt so delegatecall edits show up at head).
export const SAFE_SLOTS = {
  singleton: 0n,
  guard: BigInt(keccak256(toHex('guard_manager.guard.address'))),
  moduleGuard: BigInt(keccak256(toHex('module_manager.module_guard.address'))),
  fallbackHandler: BigInt(keccak256(toHex('fallback_manager.handler.address'))),
}
export const SLOT = {
  eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  eip1967Impl: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  zosAdmin: '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b',
  zosImpl: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
}

/** Lido OracleReportSanityChecker limit managers (each sets a rate bound: admin-level, #11). */
export const LIDO_LIMIT_ROLES = [
  'ALL_LIMITS_MANAGER_ROLE',
  'ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE',
  'APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE',
  'EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE',
  'EXTERNAL_PENDING_BALANCE_CAP_MANAGER_ROLE',
  'MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE',
  'MAX_CL_BALANCE_DECREASE_MANAGER_ROLE',
  'MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE',
  'MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE',
  'MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE',
  'MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE',
  'REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE',
  'SECOND_OPINION_MANAGER_ROLE',
  'SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE',
]

export const ROLE_HASHES = Object.fromEntries(
  [
    'TIMELOCK_ADMIN_ROLE',
    'PROPOSER_ROLE',
    'EXECUTOR_ROLE',
    'CANCELLER_ROLE',
    'MINTER_ROLE',
    'BURNER_ROLE',
    'MANAGER',
    'MANAGER_ROLE',
    'UPGRADER_ROLE',
    'PAUSER_ROLE',
    'UNPAUSER_ROLE',
    'OPERATOR_ROLE',
    'GATEKEEPER_ROLE',
    'COLLATERAL_MANAGER_ROLE',
    'REDEEMER_ROLE',
    // Chainlink RBACTimelock (WBTC CCIP pool owner), Ethena timelock, StakedUSDe
    'ADMIN_ROLE',
    'BYPASSER_ROLE',
    'WHITELISTED_EXECUTOR_ROLE',
    'FULL_RESTRICTED_STAKER_ROLE',
    'SOFT_RESTRICTED_STAKER_ROLE',
    'BLACKLIST_MANAGER_ROLE',
    'REWARDER_ROLE',
    // named for display only: its powers are not known, so the rules judge it PRIVILEGED (#8)
    'GUARDIAN',
    // Aragon (Lido DAO): Kernel / ACL / Agent permissions, replayed from the ACL as roles
    'APP_MANAGER_ROLE',
    'CREATE_PERMISSIONS_ROLE',
    'RUN_SCRIPT_ROLE',
    'EXECUTE_ROLE',
    // Lido stETH (Aragon app) and the PausableUntil contracts
    'PAUSE_ROLE',
    'RESUME_ROLE',
    'STAKING_PAUSE_ROLE',
    'STAKING_CONTROL_ROLE',
    'UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE',
    // Lido canonical L2 token bridges (L1 side)
    'DEPOSITS_ENABLER_ROLE',
    'DEPOSITS_DISABLER_ROLE',
    'WITHDRAWALS_ENABLER_ROLE',
    'WITHDRAWALS_DISABLER_ROLE',
    // Lido oracle path: HashConsensus, AccountingOracle, OracleReportSanityChecker (limits)
    'MANAGE_MEMBERS_AND_QUORUM_ROLE',
    'DISABLE_CONSENSUS_ROLE',
    'MANAGE_FRAME_CONFIG_ROLE',
    'MANAGE_FAST_LANE_CONFIG_ROLE',
    'MANAGE_REPORT_PROCESSOR_ROLE',
    'MANAGE_CONSENSUS_CONTRACT_ROLE',
    'MANAGE_CONSENSUS_VERSION_ROLE',
    ...LIDO_LIMIT_ROLES,
    // named for display only (judged PRIVILEGED, #8): treasury / signing powers of the Aragon
    // Agent and the oracle report submitter
    'TRANSFER_ROLE',
    'SAFE_EXECUTE_ROLE',
    'ADD_PRESIGNED_HASH_ROLE',
    'DESIGNATE_SIGNER_ROLE',
    'SUBMIT_DATA_ROLE',
    'BUFFER_RESERVE_MANAGER_ROLE',
    // Lido WithdrawalQueue (named for display only, judged PRIVILEGED, #8): finalization, the
    // oracle hook (bunker mode) and the NFT metadata
    'FINALIZE_ROLE',
    'ORACLE_ROLE',
    'MANAGE_TOKEN_URI_ROLE',
    // Aragon Voting (Lido): changes the vote time — a delay on the Dual Governance path
    'UNSAFELY_MODIFY_VOTE_TIME_ROLE',
    // Linea TokenBridge config (Linea-run): message service, remote bridge, reserved / custom tokens
    'SECURITY_COUNCIL_ROLE',
    'SET_MESSAGE_SERVICE_ROLE',
    'SET_REMOTE_TOKENBRIDGE_ROLE',
    'SET_RESERVED_TOKEN_ROLE',
    'REMOVE_RESERVED_TOKEN_ROLE',
    'SET_CUSTOM_CONTRACT_ROLE',
    // Linea TokenBridge PauseManager (the Linea-run bridge wstETH uses)
    'PAUSE_ALL_ROLE',
    'UNPAUSE_ALL_ROLE',
    'PAUSE_INITIATE_TOKEN_BRIDGING_ROLE',
    'UNPAUSE_INITIATE_TOKEN_BRIDGING_ROLE',
    'PAUSE_COMPLETE_TOKEN_BRIDGING_ROLE',
    'UNPAUSE_COMPLETE_TOKEN_BRIDGING_ROLE',
  ].map((n) => [keccak256(toHex(n)), n]),
)
ROLE_HASHES['0x' + '0'.repeat(64)] = 'DEFAULT_ADMIN_ROLE'
// Lido's L2 bridges hash their roles with a namespace (BridgingManager.sol): same names, same rules
for (const n of [
  'DEPOSITS_ENABLER_ROLE',
  'DEPOSITS_DISABLER_ROLE',
  'WITHDRAWALS_ENABLER_ROLE',
  'WITHDRAWALS_DISABLER_ROLE',
])
  ROLE_HASHES[keccak256(toHex(`BridgingManager.${n}`))] = n
// Lido V3 (VaultHub and the other PausableUntilWithRoles contracts) namespaces its roles: the
// pause / resume switches keep their names and rules; the VaultHub's own roles are named for
// display only (judged PRIVILEGED, #8)
ROLE_HASHES[keccak256(toHex('PausableUntilWithRoles.PauseRole'))] = 'PAUSE_ROLE'
ROLE_HASHES[keccak256(toHex('PausableUntilWithRoles.ResumeRole'))] = 'RESUME_ROLE'
ROLE_HASHES[keccak256(toHex('vaults.VaultHub.BadDebtMasterRole'))] = 'BAD_DEBT_MASTER_ROLE'
ROLE_HASHES[keccak256(toHex('vaults.VaultHub.ValidatorExitRole'))] = 'VALIDATOR_EXIT_ROLE'
ROLE_HASHES[keccak256(toHex('vaults.VaultHub.RedemptionMasterRole'))] = 'REDEMPTION_MASTER_ROLE'
ROLE_HASHES[keccak256(toHex('vaults.VaultHub.VaultMasterRole'))] = 'VAULT_MASTER_ROLE'
export const roleName = (h) => ROLE_HASHES[String(h).toLowerCase()] ?? String(h).toLowerCase()
export const roleHash = (name) =>
  name === 'DEFAULT_ADMIN_ROLE'
    ? '0x' + '0'.repeat(64)
    : name.startsWith('0x')
      ? name
      : keccak256(toHex(name))

/**
 * A Solady `RoleSet(holder, role, active)` row → the OZ-shaped RoleGranted / RoleRevoked row the
 * engine replays (the uint256 role as a bytes32 hash; `account` = the holder).
 */
export function roleSetRow(row) {
  if (row.event !== 'RoleSet') return row
  const a = row.args ?? {}
  const role =
    '0x' +
    BigInt(String(a.role ?? 0))
      .toString(16)
      .padStart(64, '0')
  const active = a.active === true || a.active === 'true'
  return {
    ...row,
    event: active ? 'RoleGranted' : 'RoleRevoked',
    args: { role, account: String(a.holder ?? '').toLowerCase(), sender: null, via: 'RoleSet' },
  }
}

export const word2addr = (w) =>
  typeof w === 'string' && w.length >= 42 ? getAddress('0x' + w.slice(-40)).toLowerCase() : null

// ---- Aragon (Lido DAO) ---------------------------------------------------------------------------

/** Aragon Kernel namespaces (KernelConstants): app implementations, default app addresses, core. */
export const ARAGON_NS = {
  base: keccak256(toHex('base')),
  app: keccak256(toHex('app')),
  core: keccak256(toHex('core')),
}

/**
 * Rewrite Aragon ACL / Kernel rows into the shapes the engine replays (pure):
 *   SetPermission(entity, app, role, allowed) → RoleGranted / RoleRevoked emitted by the APP
 *     (an Aragon permission IS a role on the app: the roleMap, power paths and AD-4 reuse it);
 *   ChangePermissionManager(app, role, manager) → PermissionManagerChanged on the app (the
 *     manager grants and revokes that role: AD-3 on who it is);
 *   SetApp(base, appId, impl) → Upgraded(impl) on every declared app proxy with that appId
 *     (`appIds`: appId → proxies; an appId no declared proxy uses is another app's: dropped);
 *   SetApp(core, …, impl)     → Upgraded(impl) on the Kernel itself;
 *   SetApp(app, appId, addr)  → AppAddressSet on the Kernel (a default app re-pointed: the ACL
 *     the Kernel consults is one of them).
 * Every other row passes through unchanged. Returns a flat list (SetApp can fan out).
 */
export function aragonRows(rows, appIds = {}, { incomplete = false } = {}) {
  const ids = Object.fromEntries(
    Object.entries(appIds).map(([k, v]) => [
      String(k).toLowerCase(),
      v.map((a) => a.toLowerCase()),
    ]),
  )
  const out = []
  for (const row of rows) {
    const a = row.args ?? {}
    if (row.event === 'SetPermission') {
      const allowed = a.allowed === true || a.allowed === 'true'
      out.push({
        ...row,
        emitter: String(a.app).toLowerCase(),
        event: allowed ? 'RoleGranted' : 'RoleRevoked',
        args: {
          role: String(a.role).toLowerCase(),
          account: String(a.entity).toLowerCase(),
          sender: null,
          via: 'ACL',
          acl: row.emitter,
        },
      })
    } else if (row.event === 'ChangePermissionManager') {
      out.push({
        ...row,
        emitter: String(a.app).toLowerCase(),
        event: 'PermissionManagerChanged',
        args: {
          role: String(a.role).toLowerCase(),
          manager: String(a.manager).toLowerCase(),
          acl: row.emitter,
        },
      })
    } else if (row.event === 'SetApp') {
      const ns = String(a.namespace).toLowerCase()
      const appId = String(a.appId).toLowerCase()
      const app = String(a.app).toLowerCase()
      // fail-closed audit (TV-10): with the appId mapping INCOMPLETE (a kernel() / appId() read
      // failed) a base SetApp for an unmapped appId may be one of the subject's apps — it stays on
      // the Kernel as an upgrade marked `appUnread` (it was dropped: the upgrade history lost)
      if (ns === ARAGON_NS.base && incomplete && !(ids[appId] ?? []).length)
        out.push({
          ...row,
          event: 'Upgraded',
          args: { implementation: app, via: 'SetApp', appId, kernel: row.emitter, appUnread: true },
        })
      if (ns === ARAGON_NS.base)
        for (const proxy of ids[appId] ?? [])
          out.push({
            ...row,
            emitter: proxy,
            event: 'Upgraded',
            args: { implementation: app, via: 'SetApp', appId, kernel: row.emitter },
          })
      else if (ns === ARAGON_NS.core)
        out.push({
          ...row,
          event: 'Upgraded',
          args: { implementation: app, via: 'SetApp', appId, kernel: row.emitter },
        })
      else if (ns === ARAGON_NS.app)
        out.push({ ...row, event: 'AppAddressSet', args: { appId, app, kernel: row.emitter } })
    } else out.push(row)
  }
  return out
}

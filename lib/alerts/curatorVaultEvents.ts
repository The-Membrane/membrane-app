import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddress,
  parseAbi,
  type Hex,
} from 'viem'

// Candidate evidence only. A caller must separately prove the vault was made by
// the reviewed factory, the receipt succeeded, the block finalized, and the
// runtime identity matches before a candidate can become a user notice.
export const CURATOR_VAULT_ACTION_ABI = parseAbi([
  'event PendingCapSubmitted(address indexed venue, uint256 cap, uint64 validAt)',
  'event PendingCapRevoked(address indexed venue)',
  'event CapSet(address indexed venue, uint256 cap)',
  'event Reallocated(address indexed caller, uint256 totalWithdrawn, uint256 totalSupplied)',
  'event SupplyQueueSet(address indexed caller, address[] queue)',
  'event WithdrawQueueSet(address indexed caller, address[] queue)',
  'event ProtocolRateDeclared(uint256 rateWad)',
])

export type CuratorVaultActionName =
  | 'PendingCapSubmitted'
  | 'PendingCapRevoked'
  | 'CapSet'
  | 'Reallocated'
  | 'SupplyQueueSet'
  | 'WithdrawQueueSet'
  | 'ProtocolRateDeclared'

export type CandidateCuratorVaultAction = {
  status: 'candidate_unfinalized'
  chainId: 1
  vault: string
  action: CuratorVaultActionName
  // ABI-decoded values are evidence, not a recipient or a user-facing claim.
  args: Record<string, unknown>
  transactionHash: string
  logIndex: number
  blockNumber: number
  blockHash: string
}

export type RawCuratorVaultLog = {
  chainId: unknown
  address: unknown
  topics: unknown
  data: unknown
  transactionHash: unknown
  logIndex: unknown
  blockNumber: unknown
  blockHash: unknown
  removed?: unknown
}

const HASH = /^0x[0-9a-fA-F]{64}$/
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/
const ACTIONS = new Set<CuratorVaultActionName>([
  'PendingCapSubmitted',
  'PendingCapRevoked',
  'CapSet',
  'Reallocated',
  'SupplyQueueSet',
  'WithdrawQueueSet',
  'ProtocolRateDeclared',
])

function canonicalData(action: CuratorVaultActionName, args: Record<string, unknown>): Hex | null {
  if (action === 'PendingCapRevoked') return '0x'
  if (action === 'PendingCapSubmitted') {
    return encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint64' }],
      [args.cap as bigint, args.validAt as bigint],
    )
  }
  if (action === 'CapSet') {
    return encodeAbiParameters([{ type: 'uint256' }], [args.cap as bigint])
  }
  if (action === 'Reallocated') {
    return encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [args.totalWithdrawn as bigint, args.totalSupplied as bigint],
    )
  }
  if (action === 'SupplyQueueSet' || action === 'WithdrawQueueSet') {
    return encodeAbiParameters([{ type: 'address[]' }], [args.queue as `0x${string}`[]])
  }
  if (action === 'ProtocolRateDeclared') {
    return encodeAbiParameters([{ type: 'uint256' }], [args.rateWad as bigint])
  }
  return null
}

function safeNumber(value: unknown, positive = false): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value
  return typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    (positive ? number > 0 : number >= 0)
    ? number
    : null
}

/** Decode exact manager-action event shapes from one explicitly nominated vault. */
export function decodeCandidateCuratorVaultAction(
  raw: RawCuratorVaultLog,
  expectedVault: string,
): CandidateCuratorVaultAction | null {
  const blockNumber = raw && safeNumber(raw.blockNumber, true)
  const logIndex = raw && safeNumber(raw.logIndex)
  if (
    !raw ||
    raw.chainId !== 1 ||
    (raw.removed !== undefined && raw.removed !== false) ||
    !isAddress(expectedVault) ||
    typeof raw.address !== 'string' ||
    !isAddress(raw.address) ||
    getAddress(raw.address) !== getAddress(expectedVault) ||
    !Array.isArray(raw.topics) ||
    raw.topics.length < 1 ||
    raw.topics.length > 2 ||
    !raw.topics.every((topic) => typeof topic === 'string' && HASH.test(topic)) ||
    typeof raw.data !== 'string' ||
    !DATA.test(raw.data) ||
    typeof raw.transactionHash !== 'string' ||
    !HASH.test(raw.transactionHash) ||
    typeof raw.blockHash !== 'string' ||
    !HASH.test(raw.blockHash) ||
    blockNumber === null ||
    logIndex === null
  )
    return null

  try {
    const decoded = decodeEventLog({
      abi: CURATOR_VAULT_ACTION_ABI,
      data: raw.data as Hex,
      topics: raw.topics as [Hex, ...Hex[]],
      strict: true,
    }) as { eventName: string; args: Record<string, unknown> }
    if (!ACTIONS.has(decoded.eventName as CuratorVaultActionName)) return null
    const action = decoded.eventName as CuratorVaultActionName
    const args = decoded.args as Record<string, unknown>
    if (canonicalData(action, args)?.toLowerCase() !== raw.data.toLowerCase()) return null
    return {
      status: 'candidate_unfinalized',
      chainId: 1,
      vault: getAddress(raw.address).toLowerCase(),
      action,
      args,
      transactionHash: raw.transactionHash.toLowerCase(),
      logIndex,
      blockNumber,
      blockHash: raw.blockHash.toLowerCase(),
    }
  } catch {
    return null
  }
}

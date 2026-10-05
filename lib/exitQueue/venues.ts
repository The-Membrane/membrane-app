import { parseAbiItem, toEventSelector, type AbiEvent } from 'viem'

import type { VenueKey } from './types'

/**
 * Venue registry for the exit-queue ledger, in the priority order of the DeFi Dojo
 * data-need ranking (LST/LRT + beacon exit queue first, then vault withdrawal queues).
 *
 * Every address and event signature below was checked on 2026-10-05 against mainnet:
 *   - proxies resolved through the EIP-1967 implementation slot;
 *   - event ABIs taken from the verified implementation source (Sourcify full match for
 *     ether.fi impl 0x41617d01…4a7e and Kelp impl 0x0ecde3f4…2c19; GitHub source for Lido
 *     WithdrawalQueueBase, Ethena StakedUSDeV2 and Maple withdrawal-manager-queue);
 *   - each topic0 seen in live eth_getLogs output for that address, except the rare
 *     parameter events, which were checked against a known transaction (sUSDe
 *     CooldownDurationUpdated in tx 0x05856199…f9 at block 24,669,809: 604800 → 86400).
 * tests/unit/exitQueue.decode.test.ts pins the topic0 hashes, so an ABI typo fails CI.
 */

const ev = (sig: string) => parseAbiItem(sig) as AbiEvent

export const ABI = {
  lido: {
    requested: ev(
      'event WithdrawalRequested(uint256 indexed requestId, address indexed requestor, address indexed owner, uint256 amountOfStETH, uint256 amountOfShares)',
    ),
    finalized: ev(
      'event WithdrawalsFinalized(uint256 indexed from, uint256 indexed to, uint256 amountOfETHLocked, uint256 sharesToBurn, uint256 timestamp)',
    ),
    claimed: ev(
      'event WithdrawalClaimed(uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 amountOfETH)',
    ),
    bunkerOn: ev('event BunkerModeEnabled(uint256 _sinceTimestamp)'),
    bunkerOff: ev('event BunkerModeDisabled()'),
    paused: ev('event Paused(uint256 duration)'),
    resumed: ev('event Resumed()'),
  },
  etherfi: {
    created: ev(
      'event WithdrawRequestCreated(uint32 indexed requestId, uint256 amountOfEEth, uint256 shareOfEEth, address owner)',
    ),
    claimed: ev(
      'event WithdrawRequestClaimed(uint32 indexed requestId, uint256 amountOfEEth, uint256 shareOfEEth, address owner)',
    ),
    invalidated: ev('event WithdrawRequestInvalidated(uint32 indexed requestId)'),
    paused: ev('event Paused(address account)'),
    unpaused: ev('event Unpaused(address account)'),
  },
  kelp: {
    queued: ev(
      'event AssetWithdrawalQueued(address indexed withdrawer, address indexed asset, uint256 rsETHUnstaked, uint256 indexed userNonce)',
    ),
    finalized: ev(
      'event AssetWithdrawalFinalized(address indexed withdrawer, address indexed asset, uint256 amountBurned, uint256 amountReceived)',
    ),
    unlocked: ev(
      'event AssetUnlocked(address indexed asset, uint256 rsEthAmount, uint256 assetAmount, uint256 rsEThPrice, uint256 assetPrice)',
    ),
    delayBlocks: ev('event WithdrawalDelayBlocksUpdated(uint256 withdrawalDelayBlocks)'),
    instantFee: ev('event InstantWithdrawalFeeUpdated(uint256 feeBasisPoints)'),
    minAmount: ev(
      'event MinAmountToWithdrawUpdated(address asset, uint256 minRsEthAmountToWithdraw)',
    ),
    paused: ev('event Paused(address account)'),
    unpaused: ev('event Unpaused(address account)'),
  },
  ethena: {
    withdraw: ev(
      'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
    ),
    cooldown: ev('event CooldownDurationUpdated(uint24 previousDuration, uint24 newDuration)'),
    transfer: ev('event Transfer(address indexed from, address indexed to, uint256 value)'),
  },
  maple: {
    created: ev(
      'event RequestCreated(uint256 indexed requestId, address indexed owner, uint256 shares)',
    ),
    processed: ev(
      'event RequestProcessed(uint256 indexed requestId, address indexed owner, uint256 shares, uint256 assets)',
    ),
    removed: ev('event RequestRemoved(uint256 indexed requestId)'),
    manual: ev(
      'event ManualSharesIncreased(uint256 indexed requestId, address indexed owner, uint256 sharesAdded)',
    ),
  },
  erc7540: {
    redeemRequest: ev(
      'event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares)',
    ),
    withdraw: ev(
      'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
    ),
  },
} as const

export const topic = (e: AbiEvent): string => toEventSelector(e)

export type VenueKind = 'lido' | 'beacon' | 'etherfi' | 'kelp' | 'ethena' | 'maple' | 'erc7540'

export interface VenueDef {
  key: VenueKey
  label: string
  kind: VenueKind
  /** Lower = earlier in the data-need ranking. */
  priority: number
  unit: { symbol: string; decimals: number }
  contracts: Record<string, `0x${string}`>
  /** The advertised wait, if the venue has one on-chain. */
  cooldown: { param: string; toSeconds: 'seconds' | 'blocks_x12' } | null
  /** Cross-references to other datasets' venue ids. */
  aliases?: Record<string, string>
  /** One-line mechanism note shown under the card row. */
  mechanism: string
}

export const VENUES: VenueDef[] = [
  {
    key: 'lido-steth',
    label: 'Lido stETH',
    kind: 'lido',
    priority: 1,
    unit: { symbol: 'stETH', decimals: 18 },
    contracts: { queue: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1' },
    cooldown: null,
    mechanism: 'Finalized in ranges by Lido oracle reports; no on-chain cooldown parameter.',
  },
  {
    key: 'beacon-exit',
    label: 'Ethereum validator exits',
    kind: 'beacon',
    priority: 2,
    unit: { symbol: 'ETH', decimals: 9 },
    contracts: {},
    cooldown: null,
    mechanism:
      'Exit epochs assigned by the churn limit; +256 epochs (~27.3h) to withdrawable, then the sweep.',
  },
  {
    key: 'etherfi-weeth',
    label: 'ether.fi eETH',
    kind: 'etherfi',
    priority: 3,
    unit: { symbol: 'eETH', decimals: 18 },
    contracts: { queue: '0x7d5706f6ef3F89B3951E23e557CDFBC3239D4E2c' },
    cooldown: null,
    mechanism:
      'Admin advances lastFinalizedRequestId (no event); finalization time located by bisection.',
  },
  {
    key: 'kelp-rseth',
    label: 'Kelp rsETH',
    kind: 'kelp',
    priority: 4,
    unit: { symbol: 'rsETH', decimals: 18 },
    contracts: { queue: '0x62De59c08eB5dAE4b7E6F7a8cAd3006d6965ec16' },
    cooldown: { param: 'withdrawalDelayBlocks', toSeconds: 'blocks_x12' },
    mechanism: 'Per-asset nonce queue; unlockQueue advances nextLockedNonce; users claim FIFO.',
  },
  {
    key: 'ethena-susde',
    label: 'Ethena sUSDe',
    kind: 'ethena',
    priority: 5,
    unit: { symbol: 'USDe', decimals: 18 },
    contracts: {
      vault: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
      silo: '0x7FC7c91D556B400AFa565013E3F32055a0713425',
      usde: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
    },
    cooldown: { param: 'cooldownDuration', toSeconds: 'seconds' },
    aliases: { venueRecorder: 'sUSDe' },
    mechanism:
      'One cooldown bucket per owner; a new cooldown resets the whole bucket. Duration changes apply only to new requests.',
  },
  {
    key: 'maple-syrupusdc',
    label: 'Maple syrupUSDC',
    kind: 'maple',
    priority: 6,
    unit: { symbol: 'syrupUSDC', decimals: 6 },
    contracts: {
      pool: '0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b',
      // pool.manager() = 0x7aD5fFa5…158F → withdrawalManager() at block 26,123,626.
      // The recorder re-resolves it every run and flags drift.
      queue: '0x1bc47a0Dd0FdaB96E9eF982fdf1F34DC6207cfE3',
    },
    cooldown: null,
    mechanism:
      'FIFO queue processed by the pool delegate; processing pays out in the same transaction.',
  },
]

/**
 * ERC-7540 async-redeem vaults. Empty until a vault is chosen and its fulfilment
 * event is verified: the standard has no fulfilment event, so the generic decoder
 * measures request → claim only.
 */
export const ERC7540_VAULTS: Array<{
  address: `0x${string}`
  label: string
  unit: VenueDef['unit']
}> = []

export const erc7540Venue = (v: (typeof ERC7540_VAULTS)[number], priority = 7): VenueDef => ({
  key: `erc7540:${v.address.toLowerCase()}`,
  label: v.label,
  kind: 'erc7540',
  priority,
  unit: v.unit,
  contracts: { vault: v.address },
  cooldown: null,
  mechanism:
    'ERC-7540 async redeem; fulfilment is vault-specific, so only request → claim is measured.',
})

export const allVenues = (): VenueDef[] => [
  ...VENUES,
  ...ERC7540_VAULTS.map((v, i) => erc7540Venue(v, 7 + i)),
]

export const venueByKey = (key: string): VenueDef | undefined =>
  allVenues().find((v) => v.key === key)

/** Advertised cooldown in seconds from a raw parameter value. */
export function cooldownSeconds(def: VenueDef, raw: unknown): number | null {
  if (!def.cooldown || raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return def.cooldown.toSeconds === 'blocks_x12' ? n * 12 : n
}

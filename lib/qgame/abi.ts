// Hand-extracted minimal ABIs for the on-chain Q-Racing game (membrane-solidity
// q-racing/src). Only the functions, views and events the app actually calls are
// declared — no codegen artifact, no new dependency. `as const` is load-bearing: it
// lets viem infer arg/return types at every readContract / writeContract / parseEventLogs
// call site.
//
// The ERC-20 surface (approve/allowance/balanceOf/decimals) and the UniswapV2 router
// surface are already declared in lib/payments/abi.ts — reuse those, don't duplicate.

/**
 * PocketGP — the game hub. Owner-signed: createPet, grantSession, revokeSession.
 * Session-accessible (owner OR a live session key): feed, train, trainBatch, race,
 * runDaily. petPrice CDT is pulled via transferFrom on createPet (approve first).
 */
export const pocketGPAbi = [
  {
    type: 'function',
    name: 'createPet',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'petPrice',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'grantSession',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'address' },
      { name: 'expiry', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeSession',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sessionOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner_', type: 'address' }],
    outputs: [
      { name: 'key', type: 'address' },
      { name: 'expiry', type: 'uint64' },
    ],
  },
  {
    type: 'function',
    name: 'feed',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'train',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'tierIdx', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'trainBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'tierIdx', type: 'uint8' },
      { name: 'count', type: 'uint16' },
    ],
    outputs: [{ name: 'finishes', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'race',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'tierIdx', type: 'uint8' },
      { name: 'seed', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'runDaily',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      { name: 'finished', type: 'bool' },
      { name: 'steps', type: 'uint16' },
    ],
  },
  {
    type: 'function',
    name: 'today',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'dailyClaimed',
    stateMutability: 'view',
    inputs: [
      { name: 'day', type: 'uint32' },
      { name: 'who', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'dailyTrackOf',
    stateMutability: 'view',
    inputs: [{ name: 'day', type: 'uint32' }],
    // NOTE: raw value is trackId + 1; 0 = not rolled yet. Callers subtract 1.
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'healthOfToken',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'event',
    name: 'SessionGranted',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'key', type: 'address', indexed: true },
      { name: 'expiry', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SessionRevoked',
    inputs: [{ name: 'owner', type: 'address', indexed: true }],
  },
  {
    type: 'event',
    name: 'DailyRun',
    inputs: [
      { name: 'player', type: 'address', indexed: true },
      { name: 'day', type: 'uint32', indexed: false },
      { name: 'finished', type: 'bool', indexed: false },
      { name: 'rank', type: 'uint8', indexed: false },
    ],
  },
  // GhostChallenge — settleGhost()'s result log, PocketGP.sol:342 / emitted :718. Fires
  // on every settlement (win or loss), not only wins — lib/game/chainIndexer.ts filters
  // to won && paidToday before treating a row as a paid ghost-board result. No payout
  // field is emitted directly; the indexer derives it as stake * multPct / 100.
  {
    type: 'event',
    name: 'GhostChallenge',
    inputs: [
      { name: 'player', type: 'address', indexed: true },
      { name: 'tier', type: 'uint8', indexed: false },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'multPct', type: 'uint16', indexed: false },
      { name: 'won', type: 'bool', indexed: false },
      { name: 'paidToday', type: 'bool', indexed: false },
    ],
  },
] as const

/**
 * PetNFT — ERC-721 pets. No enumerable extension exists: enumerate a wallet's pets by
 * looping 1..totalMinted() and matching ownerOf, or by indexing Transfer logs. createPet
 * emits only PetNFT.Transfer(address(0), to, id) — that is how a fresh tokenId is recovered.
 */
export const petNftAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalMinted',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const

/** BYTES — the race-winnings token (whole units: decimals() reads 0). */
export const bytesAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

/**
 * PetLens.getPetCard — the aggregate pet-stats view. The Card tuple field order below
 * mirrors PetLens.sol:63-79 exactly (includes derived satiation/chainNow/mood/eps).
 */
export const petLensAbi = [
  {
    type: 'function',
    name: 'getPetCard',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'exists', type: 'bool' },
          { name: 'name', type: 'string' },
          { name: 'paint', type: 'uint8' },
          { name: 'paintsOwned', type: 'uint16' },
          { name: 'fedTs', type: 'uint64' },
          { name: 'satiation', type: 'uint64' },
          { name: 'chainNow', type: 'uint64' },
          { name: 'streak', type: 'uint16' },
          { name: 'upgrades', type: 'uint8[3]' },
          { name: 'trainRaces', type: 'uint32' },
          { name: 'races', type: 'uint32' },
          { name: 'wins', type: 'uint32' },
          { name: 'moodLvl', type: 'uint8' },
          { name: 'raceEpsPct', type: 'uint8' },
          { name: 'trainEpsPct', type: 'uint8' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'ownerOfToken',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

/** Standings — per-tier leaderboards, pre-sorted ascending (lower steps = better). */
export const standingsAbi = [
  {
    type: 'function',
    name: 'leaderboard',
    stateMutability: 'view',
    inputs: [{ name: 'tier', type: 'uint8' }],
    outputs: [
      { name: 'who', type: 'address[]' },
      { name: 'steps', type: 'uint16[]' },
    ],
  },
  // NewRecord — Standings.sol:16, emitted by submit() (Standings.sol:34,40) only when a
  // race IMPROVES a player's personal best on that tier's board — not on every finish.
  // lib/game/chainIndexer.ts's 'ladder_time' board is sourced from this event.
  {
    type: 'event',
    name: 'NewRecord',
    inputs: [
      { name: 'tier', type: 'uint8', indexed: true },
      { name: 'who', type: 'address', indexed: true },
      { name: 'steps', type: 'uint16', indexed: false },
    ],
  },
] as const

/** Number of racing tiers (Deploy.s.sol sets tiers 0..4). */
export const TIER_COUNT = 5
/** Names for the 5 tiers, index-aligned to on-chain tierIdx. */
export const TIER_NAMES = ['Rookie', 'Street', 'Pro', 'Elite', 'Legend'] as const

/**
 * CDT is conventionally 18-decimal in the game (petPrice = 3e18), even though the mock
 * MockCDT inherits BYTES and its on-chain decimals() misleadingly reads 0. Always treat
 * game CDT as 18 decimals for display/format — never call decimals() on it.
 */
export const CDT_DECIMALS = 18

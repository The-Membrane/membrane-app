// Drizzle schema for the offchain Q-Racing game loop.
// See docs/OFFCHAIN_QRACING_PLAN.md (Phase 0 + Phase 2) for the design this implements.
//
// Trust rule from the plan: BYTE becomes on-chain money at mint, so byte_ledger is
// append-only (balance = SUM(delta)) and every credit is server-decided, never client-posted.

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const petStatusEnum = pgEnum('pet_status', ['offchain', 'claim_pending', 'minted'])

export const byteLedgerReasonEnum = pgEnum('byte_ledger_reason', [
  'race_win',
  'rps_win',
  'mint_debit',
  'admin',
])

export const mintClaimStatusEnum = pgEnum('mint_claim_status', [
  'issued',
  'fee_paid',
  'minted',
  'expired',
])

// race lifecycle: opened by /race/start, closed by /race/submit (or aged out to 'expired').
export const raceStatusEnum = pgEnum('race_status', ['open', 'submitted', 'expired'])

// ---------------------------------------------------------------------------
// players — the root identity. The session cookie holds only players.id.
// ---------------------------------------------------------------------------

export const players = pgTable('players', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// player_wallets — optional early, required at mint. One verified address per row.
// ---------------------------------------------------------------------------

export const playerWallets = pgTable(
  'player_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    chainId: integer('chain_id').notNull(),
    sig: text('sig').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('player_wallets_address_idx').on(table.address),
    index('player_wallets_player_id_idx').on(table.playerId),
  ],
)

// ---------------------------------------------------------------------------
// pets — the offchain-to-onchain lifecycle: offchain -> claim_pending -> minted.
// ---------------------------------------------------------------------------

export const pets = pgTable(
  'pets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    attributes: jsonb('attributes').notNull(),
    // Server-picked xorshift32 seed used to derive `attributes` (via generateTraits in
    // types/racingTraits.ts). Stored so the client can re-derive the exact same pet.
    attrSeed: integer('attr_seed').notNull().default(0),
    status: petStatusEnum('status').notNull().default('offchain'),
    tokenId: text('token_id'),
    mintTx: text('mint_tx'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('pets_player_id_idx').on(table.playerId)],
)

// ---------------------------------------------------------------------------
// races — one row per attempt. verified is set only after server-side maze replay.
// ---------------------------------------------------------------------------

export const races = pgTable(
  'races',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    petId: uuid('pet_id').references(() => pets.id, { onDelete: 'set null' }),
    mazeSeed: text('maze_seed').notNull(),
    // 1-5; drives maze size in lib/game/maze.ts. Stored so submit can regenerate the maze.
    difficulty: integer('difficulty').notNull().default(1),
    submittedPath: jsonb('submitted_path'),
    verified: boolean('verified').notNull().default(false),
    status: raceStatusEnum('status').notNull().default('open'),
    // Race time in TICKS (moves consumed), never milliseconds — mirrors the on-chain
    // convention (services/q-racing.ts). Set only after server-side replay verification.
    timeTicks: integer('time_ticks'),
    byteAwarded: bigint('byte_awarded', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('races_player_id_idx').on(table.playerId)],
)

// ---------------------------------------------------------------------------
// byte_ledger — append-only. Never update or delete a row; balance = SUM(delta).
// ---------------------------------------------------------------------------

export const byteLedger = pgTable(
  'byte_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    delta: bigint('delta', { mode: 'bigint' }).notNull(),
    reason: byteLedgerReasonEnum('reason').notNull(),
    raceId: uuid('race_id').references(() => races.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('byte_ledger_player_id_idx').on(table.playerId)],
)

// ---------------------------------------------------------------------------
// energy — one row per player. Server-side so it survives reload (fixes the
// in-memory energy reset bug in components/Racing/hooks/useRacingState.ts).
// ---------------------------------------------------------------------------

export const energy = pgTable('energy', {
  playerId: uuid('player_id')
    .primaryKey()
    .references(() => players.id, { onDelete: 'cascade' }),
  value: integer('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// mint_claims — the lazy-mint voucher lifecycle (Phase 4). nonce is unique so a
// voucher can never be replayed or double-issued.
// ---------------------------------------------------------------------------

export const mintClaims = pgTable(
  'mint_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    petId: uuid('pet_id')
      .notNull()
      .references(() => pets.id, { onDelete: 'cascade' }),
    byteAmount: bigint('byte_amount', { mode: 'bigint' }).notNull(),
    nonce: text('nonce').notNull(),
    voucher: jsonb('voucher').notNull(),
    status: mintClaimStatusEnum('status').notNull().default('issued'),
    feeTx: text('fee_tx'),
    mintTx: text('mint_tx'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mint_claims_nonce_idx').on(table.nonce),
    index('mint_claims_player_id_idx').on(table.playerId),
  ],
)

// ---------------------------------------------------------------------------
// rate_limits — Phase 3 abuse limits. DB-backed fixed-window counter (Vercel serverless
// has no shared memory between invocations, so in-memory rate limiting is a no-op there).
// `key` is caller-namespaced, e.g. 'submit:1.2.3.4' or 'pet:1.2.3.4'. One row per key; the
// window resets in place via the atomic upsert in lib/game/rateLimit.ts — never read-then-write.
// Appended at the end of the file (Phase 3) to keep the diff's merge surface small.
// ---------------------------------------------------------------------------

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
  count: integer('count').notNull().default(0),
})

// ---------------------------------------------------------------------------
// app_points_ledger — Phase 5 ("Connect the database to the rest of the app").
// Append-only, same philosophy as byte_ledger: balance = SUM(delta), never update
// or delete a row. This is a SEPARATE namespace from the on-chain PointsSystem.sol /
// MBRN-claimable points (services/chain/points.ts, rendered in
// components/Nav/PointsLevel.tsx) — it is engagement points for the offchain game
// (race wins today; more sources land here incrementally, see lib/game/points.ts).
// Appended at the end of the file (Phase 5) to keep the diff's merge surface small.
// ---------------------------------------------------------------------------

export const appPointsLedger = pgTable(
  'app_points_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    delta: bigint('delta', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('app_points_ledger_player_id_idx').on(table.playerId)],
)

// ---------------------------------------------------------------------------
// app_sessions — Phase 5. Server-side replacement for
// persisted-state/useSessionTrackingState.ts's localStorage-only session tracking.
// One row per session; a session is "active" while heartbeats keep landing inside the
// idle window (see lib/game/config.ts / pages/api/game/session/heartbeat.ts), otherwise
// the next heartbeat opens a new row. `pages` is a heartbeat count, not a page list.
// ---------------------------------------------------------------------------

export const appSessions = pgTable(
  'app_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    pages: integer('pages').notNull().default(0),
  },
  (table) => [index('app_sessions_player_id_idx').on(table.playerId)],
)

// ---------------------------------------------------------------------------
// onchain_results — rows land here from the chain indexer (built later against
// lib/qgame ABIs), never from a public POST route. See lib/game/indexerSeam.ts for the
// only write path (ingestOnchainResult). `wallet` is the source of truth identity here —
// there is no players.id FK because on-chain racers may never have an offchain player
// row. `board` mirrors the leaderboard board keys used by pages/api/game/leaderboard.ts:
// 'ladder_time' | 'daily_time' | 'ghost_win' | 'byte_earned'. `value` is board-typed
// (ticks for the time boards, wins for ghost, raw 6-decimal BYTE for byte_earned) — see
// the board docs in lib/game/indexerSeam.ts for the exact unit per board. The unique
// index on (board, tx_hash) is what makes re-running the indexer over the same block
// range idempotent; tx_hash is nullable only for boards where a single tx can't be the
// natural key (kept out of the unique constraint's NULLS DISTINCT default, which is fine
// here since ingestOnchainResult always requires a tx_hash today).
// ---------------------------------------------------------------------------

export const onchainResults = pgTable(
  'onchain_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    wallet: text('wallet').notNull(),
    displayName: text('display_name'),
    board: text('board').notNull(),
    value: bigint('value', { mode: 'bigint' }).notNull(),
    meta: jsonb('meta'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    txHash: text('tx_hash'),
  },
  (table) => [
    uniqueIndex('onchain_results_board_tx_hash_idx').on(table.board, table.txHash),
    index('onchain_results_board_value_idx').on(table.board, table.value),
  ],
)

// ---------------------------------------------------------------------------
// daily_firsts — one row per UTC day, the wallet that reached the day's daily-run
// finish line first on-chain. Written only by lib/game/indexerSeam.ts's
// ingestDailyFirst, same indexer-only rule as onchain_results. `display_name` is the
// raw value the indexer read on-chain (wallet-chosen, unmoderated); `clean_name` is
// cleanDisplayName(display_name).clean (lib/game/cleanName.ts), computed once at
// ingest and the ONLY of the two ever served publicly — see GET /api/game/ticker.
// ---------------------------------------------------------------------------

export const dailyFirsts = pgTable('daily_firsts', {
  day: text('day').primaryKey(), // YYYY-MM-DD, UTC
  wallet: text('wallet'),
  displayName: text('display_name').notNull(),
  cleanName: text('clean_name').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  txHash: text('tx_hash'),
})

// ---------------------------------------------------------------------------
// indexer_cursor — one row per named on-chain indexer job (today: just 'qgame'),
// tracking how far lib/game/chainIndexer.ts has scanned and a claim timestamp used to
// throttle concurrent serverless instances. `block` is the last FULLY scanned block
// (inclusive); the next run starts at block + 1. `last_run` is a claim stamp: a run
// atomically claims the row via `INSERT ... ON CONFLICT DO UPDATE ... WHERE last_run
// is null or stale` before doing any chain work (see claimCursor() in chainIndexer.ts),
// so a losing concurrent instance sees zero rows returned and skips silently instead of
// double-running. NOT pushed via `drizzle-kit push` — see chainIndexer.ts's header
// comment for the DDL applied directly against dev, pending a proper migration.
// ---------------------------------------------------------------------------

export const indexerCursor = pgTable('indexer_cursor', {
  key: text('key').primaryKey(),
  block: bigint('block', { mode: 'bigint' }).notNull().default(0n),
  lastRun: timestamp('last_run', { withTimezone: true }),
})

// ---------------------------------------------------------------------------
// pet_wraps — player-made car wraps from the on-chain Pocket GP UI (the
// q-racing/ui build in membrane-solidity, a separate origin with NO app
// session cookie). One row per (chain_id, token_id): the wrap image itself as
// a tiny JPEG dataURL (≤ 12KB, client-downscaled to 96×48) plus the distilled
// trim colors. Writes are EIP-191 signature-verified against the pet's
// on-chain owner (see pages/api/game/wrap.ts — no requirePlayer, auth IS the
// signature); reads are public (wraps are shown to rivals by design). NOT
// pushed via `drizzle-kit push` — applied via manual DDL like indexer_cursor
// (see the CREATE TABLE in pages/api/game/wrap.ts's header comment).
// ---------------------------------------------------------------------------

export const petWraps = pgTable(
  'pet_wraps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: integer('chain_id').notNull(),
    tokenId: text('token_id').notNull(),
    ownerAddress: text('owner_address').notNull(), // lowercased 0x…
    skin: text('skin').notNull(), // data:image/jpeg;base64 dataURL
    body: text('body'),
    accent: text('accent'),
    glow: text('glow'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pet_wraps_chain_token_idx').on(table.chainId, table.tokenId),
    index('pet_wraps_owner_idx').on(table.ownerAddress),
  ],
)

// ===========================================================================
// Venue withdrawal-ability recorder (owner-approved). Three tables that record
// external-venue (Ethena/Aave on Ethereum mainnet) withdrawal liquidity over
// time, so the carry-trader "3-band" capacity signal (instant/cooling/stranded)
// and a Brier-scored prediction track-record can be built from REALIZED data.
//
// ALL THREE are applied by scripts/apply-venue-recorder-ddl.mjs (manual DDL,
// IF NOT EXISTS), NOT by `drizzle-kit push` — same precedent as pet_wraps /
// indexer_cursor, so a schema drift elsewhere can't turn these into a
// destructive diff. These drizzle definitions are the source-of-truth mirror
// of that DDL; keep them in lockstep.
// ---------------------------------------------------------------------------

// venue_snapshots — one row per observation of a venue's withdrawal state.
// INSERT-ONLY: a snapshot is a point-in-time reading, never mutated after write.
// The recorder writes source='observed'; backfill-venue-history.mjs writes
// source='backfilled' (reconstructed state at a historical block).
export const venueSnapshots = pgTable(
  'venue_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venue: text('venue').notNull(), // config `name`, e.g. 'sUSDe'
    chain: text('chain').notNull().default('ethereum'),
    block: bigint('block', { mode: 'bigint' }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    instantUsd: numeric('instant_usd'), // nullable: null = not honestly derivable (see params.instant_note)
    coolingUsd: numeric('cooling_usd'),
    strandedUsd: numeric('stranded_usd'),
    params: jsonb('params').notNull(), // raw reads: cooldownDuration, totalAssets, totalSupply, underlyingBalance, silo, notes…
    source: text('source').notNull().default('observed'), // 'observed' | 'backfilled'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('venue_snapshots_venue_observed_idx').on(table.venue, table.observedAt)],
)

// venue_events — the venue "news tracker": records STATE CHANGES between
// consecutive observed snapshots (a cooldownDuration change, a >20% instant-
// liquidity shift), not headlines. INSERT-ONLY, append-only ledger. Written
// ONLY by the recorder (observed pass); backfill inserts none.
export const venueEvents = pgTable(
  'venue_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venue: text('venue').notNull(),
    kind: text('kind').notNull(), // e.g. 'cooldown_duration_changed', 'instant_liquidity_shift'
    prev: jsonb('prev'),
    next: jsonb('next'),
    note: text('note'),
    snapshotId: uuid('snapshot_id'), // the newer snapshot this change was detected on
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('venue_events_venue_observed_idx').on(table.venue, table.observedAt)],
)

// venue_predictions — the Brier / track-record substrate. Per BADASS_RULESET.md
// §7.2 / §9.3, confidence may come ONLY from realized outcomes. A row is INSERTED
// at prediction time with (realized, scored_at, hit) NULL; exactly ONE later
// scoring UPDATE fills those three columns once the horizon has elapsed
// (realized = the metric's value at scoring time, hit = band_low <= realized <=
// band_high). No other mutation is permitted.
export const venuePredictions = pgTable(
  'venue_predictions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venue: text('venue').notNull(),
    metric: text('metric').notNull(), // 'instant_usd' | 'total_assets'
    madeAt: timestamp('made_at', { withTimezone: true }).notNull().defaultNow(),
    horizonHours: integer('horizon_hours').notNull(),
    bandLow: numeric('band_low').notNull(),
    bandHigh: numeric('band_high').notNull(),
    model: text('model').notNull(), // e.g. 'persistence-v0'
    realized: numeric('realized'), // set once, by the scoring UPDATE
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    hit: boolean('hit'),
  },
  (table) => [index('venue_predictions_venue_made_idx').on(table.venue, table.madeAt)],
)

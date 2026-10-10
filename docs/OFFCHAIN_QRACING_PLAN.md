# Offchain Q-Racing Plan — Play First, Mint Later

**Status:** PROPOSED (Sep 1, 2026)
**Goal:** Let users play Q-Racing fully offchain with no wallet. They earn BYTE and raise a pet.
Later, they pay the mint fee once to mint the pet NFT and their accumulated BYTE balance on-chain.
Game state lives in a real database, not cookies. The database also becomes the backend for the
rest of the app (points, sessions, leaderboards).

---

## Why now (current-state facts)

- The on-chain racing path is **inert** on `evm-migration`: `useMintCar` and `useRunRace` return
  empty `EvmCall[]` because the racing contracts have no Solidity port yet
  (`components/Racing/hooks/useMintCar.ts:35-56`, `useRunRace.ts:25-30`).
- Reads still query the old Neutron CosmWasm contracts (`hooks/useQRacing.ts`,
  `services/q-racing.ts`) — `car`, `byteMinter`, `rpsEngine` in `config/contracts.json:21-26`.
- The app has **no database and no server auth**. The only server writes go to GitHub
  (`pages/api/feedback.ts`). All game state is zustand/localStorage. Energy is in-memory only
  (`components/Racing/hooks/useRacingState.ts`) and resets on reload.
- Deployment is self-hosted Docker (`Dockerfile`, node:18-alpine, pnpm), not Vercel.

So the offchain parallel is the primary play path until racing contracts are ported. The mint
bridge is the only new Solidity work.

---

## Architecture in one view

```
Browser (no wallet needed)
  │  httpOnly cookie = signed player_id ONLY (a key, not data)
  ▼
Next.js API routes (pages/api/game/*)        ← server-authoritative
  │  Drizzle ORM
  ▼
Postgres (Neon)                              ← all game data
  │
  │  at mint time:
  ▼
POST /api/mint/voucher → EIP-712 signature (MINT_SIGNER_KEY, server-only)
  ▼
MintClaim.sol (membrane-solidity)  — verifies voucher, takes fee,
                                     mints PetNFT + BYTE ERC-20 in one tx
```

**Trust rule:** BYTE becomes on-chain money at mint. Therefore the server, not the client,
decides every BYTE credit. The client never POSTs a balance. It POSTs *actions* (a race
result) and the server verifies and credits.

---

## Phase 0 — Database setup (~30 min, with walkthrough)

**Recommendation: Neon (serverless Postgres) + Drizzle ORM.**

- Neon free tier is enough to start (0.5 GB, autosuspend). Paid tier is ~$19/mo when needed.
- Postgres because the rest of the app will want relational queries (leaderboards, ledgers,
  joins on wallet↔player).
- Drizzle because it is TypeScript-first, lightweight, and has no codegen step like Prisma.
- Alternatives, for the record:
  - **Supabase** — same Postgres, plus a dashboard, auth, and realtime. Pick this instead if
    you want realtime leaderboards soon. Everything in this plan works on it unchanged.
  - **Postgres container in docker-compose** — $0, but you own backups. Fine for prod later;
    worse for dev ergonomics now.

Steps (I do 3–6; you do 1–2):

1. Create an account at neon.tech. Create a project `membrane-app`, region closest to your
   Docker host. Copy the connection string.
2. Add to `.env.local` (server-only — no `NEXT_PUBLIC_` prefix, matching the
   `FEEDBACK_GITHUB_TOKEN` convention):
   ```
   DATABASE_URL=postgres://...
   SESSION_SECRET=<random 32 bytes>       # signs the player cookie
   MINT_SIGNER_KEY=<later, Phase 4>       # EIP-712 voucher signer
   ```
3. `pnpm add drizzle-orm @neondatabase/serverless jose` and `pnpm add -D drizzle-kit`
   (Neon serverless driver + Drizzle's `neon-http` adapter — required on Vercel, where
   serverless functions would exhaust plain TCP connections; works identically in local dev.
   `jose` = JWT signing for the session cookie).
4. New files: `db/schema.ts`, `db/index.ts` (client singleton), `drizzle.config.ts`.
5. `pnpm drizzle-kit push` to create tables.
6. Health check: `pages/api/game/health.ts` returns `select 1`. Verify with curl.

**Production target is Vercel.** Secrets never live in the repo or the image:

- Install the **Neon integration from the Vercel marketplace** — it injects `DATABASE_URL`
  into the Vercel project automatically and can create a separate Neon branch per preview
  deployment (isolated test data for every PR).
- Add `SESSION_SECRET` (and later `MINT_SIGNER_KEY`) in Vercel → Project → Settings →
  Environment Variables, scoped to Production (mark Sensitive). Or `vercel env add NAME
  production`, typing the value at the prompt so it never enters shell history.
- Local dev then *pulls* from Vercel: `vercel env pull .env.local`. Set secrets once in
  Vercel; no hand-copying of connection strings anywhere.
- The Dockerfile/docker-compose path becomes legacy; the `.dockerignore` env exclusion
  stays as a safety net.

---

## Phase 1 — Identity without a wallet

The cookie holds only a pointer. All data is in Postgres.

- `POST /api/game/player` — first visit creates a `players` row, sets an httpOnly, signed,
  `SameSite=Lax` cookie containing `{ playerId }` (JWT via `jose`, `SESSION_SECRET`).
- Wallet link (optional early, required at mint):
  `GET /api/game/wallet/nonce` → user signs a SIWE-style message with wagmi `signMessage` →
  `POST /api/game/wallet/verify` recovers the address with viem and writes `player_wallets`.
- If the wallet is already linked to a different player, offer merge (move pets + ledger)
  or switch. Merge is a single transaction; keep it boring.

This is the app's first real auth layer. It is reusable by every future feature.

## Phase 2 — Schema + offchain game loop

```
players         id uuid PK, username, created_at
player_wallets  player_id FK, address UNIQUE, chain_id, sig, verified_at
pets            id PK, player_id FK, name, attributes JSONB,
                status ENUM(offchain | claim_pending | minted),
                token_id NULL, mint_tx NULL, created_at
byte_ledger     id PK, player_id FK, delta BIGINT,
                reason ENUM(race_win | rps_win | mint_debit | admin),
                race_id NULL, created_at            -- append-only, balance = SUM(delta)
races           id PK, player_id, pet_id, maze_seed, submitted_path JSONB,
                verified BOOL, time_ms, byte_awarded, created_at
energy          player_id PK, value, updated_at     -- fixes today's reset-on-reload bug
mint_claims     id PK, player_id, pet_id, byte_amount, nonce UNIQUE,
                voucher JSONB, status ENUM(issued | fee_paid | minted | expired),
                fee_tx NULL, mint_tx NULL, created_at
```

API routes (all read `playerId` from the cookie, never from the request body):

- `POST /api/game/pet` — create the offchain pet (name, generated attributes).
- `POST /api/game/race/start` — server picks a maze seed, opens a `races` row, spends energy.
- `POST /api/game/race/submit` — client sends its move path. **The server replays the path
  against the seeded maze.** A maze solution is cheap to verify, so this is real anti-cheat,
  not a heuristic. On success: set `verified`, compute `time_ms`, insert `byte_ledger` credit
  (amount mirrors the `byteMinter` `mint_amount` config the UI already displays).
- `GET /api/game/state` — pet, BYTE balance, energy, recent races, in one payload.
- RPS/PvP wins credit through the same ledger with `reason='rps_win'`, rate-capped.

Frontend: add `hooks/useOffchainRacing.ts` (react-query against these routes, following the
`hook-query-patterns` skill). Existing components read from it when the pet is offchain and
from chain hooks when minted. Keep zustand for UI-only state (tutorial, modals). New UI
follows Living Typeface — do not copy the legacy Press-Start-2P styling in `MintPanel.tsx`.

Per the V20 demo-first rule: this page now exceeds demo-first — with no wallet the game is
*real*, not fixture data. The banner reads "Offchain — mint to make it permanent", and every
mint CTA is an intent-preserving connect.

## Phase 3 — Abuse limits

Offchain BYTE becomes real money at mint, so cap the faucet:

- Energy is server-side; races cost energy; energy refills on a timer.
- Per-player daily BYTE cap; per-IP rate limit on `race/submit`.
- Maze replay verification (Phase 2) already blocks fabricated wins.
- The append-only ledger means any incident is auditable and reversible (`admin` entries).

## Phase 4 — The mint bridge (lazy mint via EIP-712 voucher)

New Solidity in `membrane-solidity` (the only contract work in this plan):

- `PetNFT` (ERC-721), `ByteToken` (ERC-20, mint-restricted).
- `MintClaim`: `claim(Voucher v, bytes sig) payable` where
  `Voucher = { to, petAttrsHash, byteAmount, nonce, deadline }`.
  Verifies the EIP-712 signature against the trusted backend signer, collects the mint fee,
  mints the NFT + BYTE to `msg.sender`, marks the nonce used, emits `Claimed`.

Flow:

1. User taps Mint → confirm sheet shows pet + BYTE amount + fee. No wallet? The button is
   "Connect wallet" and the same sheet re-opens after connect (V20).
2. `POST /api/mint/voucher` — server checks the pet is `offchain`, snapshots the ledger
   balance, writes `mint_claims (issued)`, signs the voucher with `MINT_SIGNER_KEY`.
3. Wallet sends `claim()` with the fee. One tx mints both the pet and the BYTE.
4. Client posts the tx hash; server verifies the receipt + `Claimed` event with viem, then:
   `mint_claims → minted`, `pets → minted (token_id, mint_tx)`, ledger debit `mint_debit`.
5. After mint, new BYTE keeps accruing offchain and is claimable in batches through the same
   voucher path (nonce-based, no new machinery).

Open decision: the fee asset. The old options (50 TAB / 1 USDC / 20 NTRN in
`usePaymentSelection.ts:42-64`) are Cosmos-era. On EVM, native gas token or USDC is simplest.

## Phase 5 — Connect the database to the rest of the app

Same `players`/`player_wallets` identity, same patterns:

- Move `totalPoints` (`useAppState`) and session tracking (`useSessionTrackingState`) to
  server ledgers → cross-device, and real instead of self-reported.
- Real leaderboards (top times, BYTE earned) as SQL views — replaces localStorage-only stats.
- The points & sacrifice system mocks get a real store when that ships.

---

## Order and rough effort

| Phase | What | Effort |
|---|---|---|
| 0 | Neon + Drizzle + health check | half a day |
| 1 | Player cookie + SIWE wallet link | 1 day |
| 2 | Schema + game routes + `useOffchainRacing` | 2–3 days |
| 3 | Caps + rate limits | half a day |
| 4 | Solidity claim contracts + voucher route + mint UI | 2–3 days |
| 5 | Points/sessions/leaderboards migration | incremental, later |

Phases 0–2 ship a playable offchain game with durable state. Phase 4 can trail behind it.

## Decisions needed from you

1. **Provider:** Neon (lean) vs Supabase (dashboard/realtime/auth built in). Plan assumes Neon.
2. **Mint fee asset on EVM** (native vs USDC vs TAB-equivalent).
3. **Post-mint accrual:** keep earning BYTE offchain with batch claims (planned), or stop
   offchain accrual once minted.

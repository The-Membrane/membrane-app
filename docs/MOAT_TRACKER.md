# Moat Tracker — the seven layers

Living progress log for how far the app has moved along each layer of the
"publish the conclusion free, make acting on it live only inside Membrane" model.
Our data is public on-chain, so the moat is **curation + execution**, not access.

**How to use this file.** Update the layer's row and its section in the same
commit that moves it. Every status claim cites a file. Dated entries go at the
bottom of the layer's section, newest last. A layer is HIT only when the thing
works on live data for a real user; a mock, a fixture or a demo wallet is at
most PARTIAL.

Last full scan: **2026-09-25** · build pass on feat/moat-layers **2026-09-26** (landing simulator, Radar, Strats, Carry, Position,
Seniority, Evidence, Venue pages; route reachability).

| # | Layer | Status | One-line state | Next step |
|---|---|---|---|---|
| 1 | Reporting as marketing | PARTIAL+ | Radar permalinks (indexable only for Strats addresses), per-result/venue/finding social cards, venue CTA 'Run this on your wallet', attribution, /glossary | Blog/finding pages of their own; sitemap |
| 2 | Execution in one flow | **BACKLOG** | Carry `ExecSheet` is a mock chain; no path reaches a signed tx | Held until contracts deploy on-chain (owner, 2026-09-25) |
| 3 | Infrastructure after deployment | PARTIAL | /risk desk: per-asset LTV glide + waterfall on local anvil; Position page still fixtures | Position page on the EVM LiquidationEngine timer after deploy |
| 4 | Bonded curators | PARTIAL (local chain) | /curators + profiles read CuratorRegistry on local anvil; BondCoverage live hook ready | Wire BondCoverage on the landing; 'curated by' on Strats; follow a curator |
| 5 | Standard reference data | HIT | 'cooldown' everywhere; public /glossary with 18 citable anchors + JSON-LD | Link /glossary from nav |
| 6 | Belts and practice | PARTIAL | /practice v1: Oct-10 tape, 3 pauses, you vs Membrane vs Aave-style | Belts (v2); link from the simulator |
| 7 | Speed and alerts | PARTIAL+ | Per-address alerts, RSS, Telegram bot (@MembraneAlertBot), data-quality fixes | Merge to evm-migration so the live tick sends; first real /start test |

---

## 1. Reporting as marketing — PARTIAL

The article is the sample; the simulator against a live position is the Terminal.

**Have**
- `/evidence` — indexable Oct-10 backtest page, links into the simulator (`components/Evidence/DesireRouter.tsx:93`).
- `/venue/[name]` — per-venue permalinks, built as the distribution page for venue headlines (`pages/[chain]/venue/[name].tsx`).
- Provenance stamps everywhere (`components/Simulator/Stamp.tsx`); every landing figure imports from a tested artefact.
- Radar share line + share-card PNG of the reader's own result (`components/Radar/Radar.tsx:382-420`).
- Strats board — public list of tracked carry positions with returns and verdicts (`components/Strats/StratsBoard.tsx`).
- The $1.07B multi-year liquidation corpus renders in the landing band (`lib/position-sim/oct10Totals.ts`).

**Missing**
- One static OG image for the whole site (`scripts/og-card.mjs` → `public/og.png`); no card per finding, venue or Radar result.
- Radar is `seoClass="app"` ⇒ noindex (`pages/[chain]/radar.tsx:10`), and a scanned result has no permalink.
- Venue pages link to Radar/Carry, never to the simulator with a wallet prompt (`components/Venue/VenuePage.tsx:235,246`).
- The corpus finding has no page of its own; it lives only inside the landing band.
- No "Data compiled by Membrane" attribution line on public pages (the RSS feed now carries one).

## 2. Execution in one flow — BACKLOG

**Owner ruling 2026-09-25:** backlogged until the contracts are deployed on-chain.
Do not start real transaction wiring before then.

- Carry `ExecSheet` runs the sign → pending → done sequence on timers, labelled "mock chain" (`components/Carry/ExecSheet.tsx:38`).
- The simulator, Radar and Strats are read-only by design; Strats → Carry passes no context.
- When unblocked: simulator → Carry handoff must carry the address, venue and size, and `ExecSheet` must call real contract writes.

## 3. Infrastructure after deployment — PARTIAL

Once a position runs on Membrane's unwind flow, leaving means giving up the protection.

- Position page renders LTV window, headroom and per-intent countdowns from fixtures (`components/Position/fixtures.ts`); countdowns are decorative (`components/Position/utils.ts:173-203`).
- Live recall reads exist only for Cosmos (`components/NeutronMint/hooks/useCapitalRecall.ts`); no EVM `LiquidationEngine` address or read in `config/evm/contracts.ts`.
- Position sits under "coming soon" in the nav.
- Depends on layer 2's deploy; can be built against anvil earlier.

## 4. Bonded curators — MISS in the app, BUILT on-chain

- On-chain primitives in `membrane-solidity/contracts/CuratorRegistry.sol`: `bondOf`, `postBond`, `beginUnbond`/`completeUnbond`, `rampOf` (reputation clock), `bucketOf`/`bucketMembers`/`pokeRank`, `slash`, `trailingPayments`, `realizedRate`.
- App: `components/Seniority/BondCoverage.tsx:3` renders a mock because the registry address is not in config.
- Strats rows carry a free-text `label`, no author or curator identity (`db/schema.ts` `strat_watches`).
- Target: curator profile page (bond, ramp, realized rate, slash history), Strats "curated by" column, follow a curator (reuse the watch + alerts path from layer 7).

## 5. Standard reference data — PARTIAL

- Radar/Strats: stress prongs **instant / cooldown / flow**, verdicts **clear / caution / exposed** (`components/Radar/radarLogic.ts:14-52`).
- Carry capacity bands: **instant / cooling / stranded** (`components/Carry/utils.ts:135-144`).
- Venue-log labels: "instant swap-out depth" etc. (`components/Carry/venueLogLogic.ts` LABEL map).
- Missing: one vocabulary across pages, and a public glossary page that defines each term so others can cite it.

## 6. Belts and practice — MISS

- Levels, tutorials and points progression exist but are q-racing / points-game only (`pages/[chain]/levels`, `components/Racing/Guidance/*`, `components/Points/*`).
- Nothing trains a borrower on the real mechanism: crossing the 4% band, the 8h window, recall.
- Candidate: a practice mode in the simulator that replays a real crossing (Oct-10) and scores the reader's decisions.

## 7. Speed and alerts — PARTIAL

The data is public, so no one gets it first; computed signals can still arrive first.

**Have**
- Hourly recorder (launchd `com.membrane.venue-recorder`, `scripts/recorder-tick.sh`) → alarm checker (`scripts/check-venue-alarms.mjs`) → `venue_alarms`. Rules: gate_change, drawdown_fast, net_outflow_streak, headroom_thin, utilization, depth_skew, depth_collapse (`scripts/lib/alarmRules.mjs`).
- Operator notification only: Telegram or macOS (`scripts/lib/notify.mjs`).
- Public structured feed `/api/venues/alarms`; alarms also appear in the venue log.
- **2026-09-25 — per-address alerts shipped (step 1 of the plan below).** `GET /api/radar/alerts/[address]` joins `strat_watches` (held venues) × `venue_alarms`; `?format=rss` serves a subscribable feed with no account. Radar shows the list + feed link under "Track this strat". Logic: `components/Radar/alertLogic.ts`, tests `tests/unit/radarAlerts.test.ts`. Verified against the live DB: a watched sUSDS holder receives the open sUSDS alarm.

**Known defects feeding this layer**
- **FIXED 2026-09-25 — terms-page hash noise.** Cause: sky.money/susds renders a live rate ("3.60% apy") and live supply ("4.46b"); the supply figure flipped the v1 hash 75 times in 19 days, holding sUSDS `gate_change` open permanently. The watcher now hashes visible text with live market figures masked: APY/APR rates, k/m/b amounts, the copyright year (`scripts/lib/termsNormalize.mjs`, which documents what counts as a terms change). Fees, durations, caps and wording still count. Hashes are versioned (`v2:`); the upgrade re-baselined all 4 venues with no event, and a second run read all 4 unchanged. The open sUSDS `gate_change` clears itself on the first tick after 2026-09-26 12:14 UTC, when the last flap leaves the 24h window. The 75 historical flap events stay in the venue log; the watcher never stored page text, so they cannot be re-checked.
- **FIXED 2026-09-25 — zero-depth reads.** Four snapshots (2026-09-06 sUSDS; 2026-09-13 sUSDe, sUSDS, scrvUSD) stored depth_usd = 0 with every reserve read failed. They fired 3 false `depth_collapse` alarms and 4 "depth → $0" venue events. The reader now stores null on a failed read (`readDepthMarkets` `complete` guard, live since 2026-09-25 04:29:56 UTC; that edit is still uncommitted in another session's working tree). The alarm rules drop null readings instead of coercing them to zero, and ignore pre-guard zeros (`isUnreadDepthZero`, `scripts/lib/alarmRules.mjs`). Alerts and the venue log exclude the pre-guard artefacts at read time (`components/Radar/alertLogic.ts`). No stored row was modified: snapshots, events and alarms are insert-only history. A post-guard zero still fires, since it can only come from successful reads of an empty pool.
- `alarmConsequence` had no sentence for utilization / depth_skew / depth_collapse and printed raw JSON; fixed 2026-09-25 (`components/Carry/venueLogLogic.ts`).
- **FIXED 2026-09-25 — blind-spot list drift.** The venue log footer and `/api/venues/alarms` kept hand-written copies that claimed blindness to depth-vs-book and terms changes (both now covered) and omitted instant-exit headroom (blind at sUSDe, sUSDS, scrvUSD). Now `coverageFor(cfg, { hasInstant })` and `uncoveredFooter()` in `scripts/lib/alarmRules.mjs` are the one source. The checker, venue summary, alarms feed, venue log and per-address alerts all call them (TS via `pages/api/_lib/uncovered.ts`). A unit test fails if a copy reappears. Verified live: all five surfaces print the checker's own list.
- `scripts/lib/alarmRules.mjs` contains a stray non-UTF-8 byte, so plain `grep` treats it as binary; use `grep -a`.

---

## Owner decisions (2026-09-25) — build to these without asking

1. **Push channel = Telegram bot.** Build it gated on `TELEGRAM_ALERTS_BOT_TOKEN` + `TELEGRAM_ALERTS_BOT_USERNAME` in `.env.local` (a bot SEPARATE from the operator's `TELEGRAM_BOT_TOKEN`). Subscribe = deep link `t.me/<bot>?start=<token>` from Radar's alert block, keyed to a watched address; unsubscribe = `/stop`. Until the token exists the code ships dark and the tests run against a stubbed Telegram API.
2. **Taxonomy = align shared words.** Two concepts stay: exit LEGS (instant / cooldown / flow) and size TIERS (instant / cooldown / stranded). "cooling" is renamed "cooldown" everywhere. A public `/glossary` defines both.
3. **Pre-deploy on-chain surfaces = local anvil deploy**, stamped "local chain"; mainnet is a config swap. Applies to the risk desk, curator profiles, position protection.
4. **Branch = own worktree** `feat/moat-layers` off `evm-migration`; never touch the other session's files. The owner merges.
5. **Execution (layer 2) stays backlogged** until the on-chain deploy.

**Defaults the builder applies (no question needed)**
- Radar permalinks: indexable only for addresses already public on Strats; any other scanned address stays noindex.
- New public copy follows the landing rules (measured or deleted, no caveat inside a claim, every change has a window, fewer words). Every new public sentence is listed under "Copy added" below for review.
- "Data compiled by Membrane" goes on public data pages and feeds; "Run this on your wallet" is the CTA into the simulator.
- Borrower practice mode (step 10): design memo first, then a v1 that replays the Oct-10 crossing.
- Nothing is pushed. Nothing on-chain is deployed except to local anvil.

## Plan — step by step

| Step | Layer | What | Status |
|---|---|---|---|
| 1 | 7 | Per-address alerts: watched address × open alarm → JSON + RSS + Radar list | **DONE 2026-09-25** |
| 2 | 7 | **DONE 2026-09-25.** Alarm data quality before anyone relies on the feed: (a) terms-page hash noise — normalize away dynamic numbers or diff by section, re-baseline sUSDS, so its `gate_change` can clear; needs a ruling on what counts as a terms change. (b) zero-depth reads — store null on a failed read, skip zero points in `evalDepthCollapse` | done |
| 3 | 7 | **DONE 2026-09-25.** One blind-spot source (`coverageFor` / `uncoveredFooter`) for every surface; no copies | done |
| 4 | 1 | Radar result permalinks + per-result OG card; flip Radar to indexable for the landing view | | **DONE 2026-09-25** (9b742f57) |
| 5 | 1 | Per-venue and per-finding OG cards; "run this on your wallet" CTA on every venue page into the simulator | **DONE 2026-09-25** (9b742f57, window labels df5a3260) |
| 6 | 5 | Align words ("cooling" → "cooldown"); legs instant/cooldown/flow, tiers instant/cooldown/stranded; public `/glossary` | **DONE 2026-09-25** (17a97995) |
| 7 | 7 | Telegram bot: deep-link subscribe keyed to a watched address, subscriptions table, sender in the recorder tick; ships dark until the bot token exists | **DONE 2026-09-25** (e25632f9); bot token set; sends once merged |
| 8 | 4 | Wire `CuratorRegistry` into `config/evm` (local anvil first); BondCoverage goes live; curator profile page | **DONE 2026-09-26** (d601c80e, df5a3260) on local anvil |
| 9 | 3/risk | **Risk desk page** (see below), on local anvil | **DONE 2026-09-25** (6b9282b9) |
| 10 | 6 | Borrower practice mode on the simulator | design |
| — | 2, 3 | Real execution + live position protection | BACKLOG until on-chain deploy |

### Step 9 — the risk desk page (replaces the orphaned `/ltv-dashboard`)

Owner direction 2026-09-25: `/ltv-dashboard` is the only orphaned route worth an
inbound link, and its content may be better merged into a page where risk
managers and borrowers congregate.

- **What moves there.** The LTV dashboard's content: the status of risk managers' decisions and the process of change each asset's LTV is going through (current, pending, direction). Today it runs on Neutron mock data (`components/LTVDashboard/LTVDashboard.tsx:25`, stamped "mock — not live").
- **What joins it.** Per-asset bad-debt waterfall coverage. Existing pieces: `components/Disco/DiscoPageWaterfall*.tsx`, `components/Seniority/Waterfall.tsx`, `components/Seniority/BondCoverage.tsx`.
- **Why the pairing works.** Both are per-asset, and both answer the borrower's question "how safe is this collateral and who is changing its terms".
- **Facts to respect.** Each asset's max LTV is capped at listing and can never be raised above that cap; a decrease has no notice period today (the 14-day delay is ruled but unbuilt). See `membrane-solidity/docs/LTV-CHANGE-PARITY-AUDIT.md`.
- **Link-in.** From the Position page, the simulator's fine print, and curator profiles once layer 4 lands.

## Route notes (2026-09-25)

- Orphaned and intentionally left: acquisition-dashboard, acquisition-sim, control-room, isolated, nft, lockdrop, tournament.
- `/ltv-dashboard`: fold into the risk desk page (step 9), then give that page its inbound links.
- Venue pages are linked from Radar, Strats and Carry, not from Evidence or the simulator.

## Build pass 2026-09-25/26 (feat/moat-layers) — what was verified and how

- **Verified live (dev server + real DB/chain):** route status/redirects/robots for /glossary, /practice, /curators, /risk, /ltv-dashboard→/risk, Radar permalinks (Strats address indexable, other noindex, bad address → scanner), venue + evidence; the four OG cards render PNG; alerts API returns the Telegram link; /risk renders live anvil data (glide window, target source). Telegram DDL applied; one real getUpdates poll clean.
- **Verified from node, not in the browser:** curator pages (service returns 5 vaults @ block 133 via the page's own client). The embedded browser stalled on the boot splash (known hydration trap), so /curators and /practice in-browser rendering is UNVERIFIED.
- **Not yet exercised:** a real Telegram /start → subscription → alert (needs a human Telegram user).
- **Build prerequisite found:** committed evm-migration does not build without the other session's untracked files (hooks/useAcquisition.ts and 8 more). The worktree uses them as an uncommitted overlay for testing only.

## Copy added (for owner review)

- Venue page: "Run this on your wallet →" · "Data compiled by Membrane." — evidence page attribution.
- Social cards: "4%." mark; "Data compiled by Membrane"; radar "carry radar" · total / venues held / weakest verdict; venue "TVL · worst 1-day outflow · 90 d · worst 7-day outflow · 90 d · open flags"; finding "Collateral a 4% window would have kept over 3.6 years of Aave V3" ($1.2B from liquidation-corpus.json).
- Glossary: 18 definitions, each sourced from radarLogic.ts / Carry utils / alarmRules.mjs thresholds.
- Telegram bot (revised 2026-09-26 on owner review): welcome = "Watching <addr>. It holds <venues>." · "Right now: no alarm on <venues>." (or the open alarms) · "This chat gets a message when an alarm starts or ends on <venues>:" + a plain list of what is watched (lending line only for Aave holders) · "Radar profile: <link>" · "Data compiled by Membrane · /stop to unsubscribe · /list to see what this chat watches"; no blind-spot line in Telegram. Avatar: the cell mark (public/images/telegram-bot-avatar.png). "Track this address on Radar first: <link>", "This chat already watches 25 addresses. /stop to reset.", alert header "<addr> holds <venue>".
- Practice (revised 2026-09-26, 'crossing'/'tape' jargon removed): "Practice Oct 10"; "Hold a loan through the real Oct 10 2025 crash, minute by minute. When it crosses its liquidation line, Membrane gives it 8 hours instead of selling. The replay pauses so you can act."; presets "worst dip stays inside the window" / "worst dip breaks past the window"; "Start the replay"; pause eyebrows "Window started" / "Halfway through the window" / "Near the break line". Owner wants to judge placement on the live page.
- Risk desk: "Collateral terms, and who pays for bad debt"; "The max LTV moves at most 5 percentage points per 14-day window, in either direction, and can never exceed the listing cap."; target source sentence; "Curator bonds are not in this cascade and are not assigned to assets."

## Open findings from the build

- `lib/position-sim/guarantee.ts` `GUARANTEE.noDials` claims a 14-day notice and 5%/window LTV cap that exist only on the unmerged `feat/ltv-change-cap`; not rendered today.
- The risk desk's LTV-change process exists only on `feat/ltv-change-cap` (unmerged); master has a live ratio with no glide.
- The senior haircut hole has no per-asset view (global only). Curator bonds are not in the bad-debt waterfall, so they need no per-asset view (owner, 2026-09-26).
- The Oct-10 prices never reach the practice "halfway through the window" pause: every in-band breach recovered within minutes. Not a data fault; a slower real episode from the liquidation corpus would exercise it (belts v2).
- Local anvil needs `--disable-block-gas-limit` for DeployFullSystem (two creations at 13.7M/14.9M gas stall otherwise).

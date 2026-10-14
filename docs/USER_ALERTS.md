# User threshold alerts ("Alert me at X")

**Status:** shipped dark until the owner applies the DDL. Telegram stays dark until the owner sets `TELEGRAM_ALERTS_WEBHOOK_SECRET`.

## What it does

A user sets one threshold on a live value. They pick the direction (above or below) and must tick the opt-in box. They get back a private RSS feed link. The feed records a **crossed** event when the value reaches the line. It records a **cleared** event when the value moves back past the line by more than the hysteresis band.

| Metric | Subjects (live config) | Source | Stale after |
|---|---|---|---|
| price | `asset:ETH`, `asset:BTC` | Chainlink ETH / USD and BTC / USD on mainnet. Decimals and description are re-checked on every read. | 2h (2 × the 1h heartbeat) |
| utilization | enabled recorder venues with a `variableDebtToken` (today: `aave-v3-usde`) | the recorder's latest observed `venue_snapshots.params.utilization_pct`, the venue page's stat | 2h (2 × the hourly tick) |
| apr | enabled recorder venues that the net-APY registry also reads (today: `aave-v3-usde`) | supply APR now, from the net-APY chain read at the finalized block | read older than 240s, or finalized block older than 38 min |

- **Stale or unavailable value:** the threshold is not evaluated. Nothing crosses and nothing clears, and the feed says "not checked".
- **Hysteresis (`lib/userAlerts/metrics.ts`):**
  - Price: 0.5% of the threshold, which equals the Chainlink deviation trigger.
  - Utilization and APR: 0.5 pp.
- **When values are evaluated:** on every feed read. There is no schedule. The operator's existing hourly alarm tick also evaluates the feeds linked to a Telegram chat, but only once Telegram is on.

## Storage model

Five tables, applied by `scripts/apply-alert-thresholds-ddl.mjs`. They are mirrored in `db/schema.ts`.

- **`user_alert_owners`:** one row per **feed**.
  - Holds `owner_kind` (`address`, or `telegram` reserved), `owner_key` (a lower-cased 0x address) and `feed_token`.
  - `feed_token` is 32 random bytes in hex and is UNIQUE.
  - The token is stored once per owner, so a single unique index holds it.
- **`user_alert_thresholds`:** one opt-in threshold.
  - Holds metric, subject, direction, threshold, `opted_in_at`, `stopped_at`, `last_value`, `last_evaluated_at` and `crossed_at`.
  - `crossed_at` is the start of the current crossing.
  - The API caps a feed at 25 active thresholds.
- **`user_alert_events`:** one row per transition.
  - Holds the value, its source and the source's as-of.
  - UNIQUE `(threshold_id, kind, crossing_at)`. With compare-and-set updates, this records each transition once, however many reads race.
- **`user_alert_chat_links`:** a Telegram chat linked to a feed by `/start th_<token>`. It is a link, not a copy, so stopping a threshold on the web also stops its messages.
- **`user_alert_deliveries`:** the Telegram ledger. Each (event, chat) pair is sent at most once. A claim is taken before the send and released if the send fails.

## Privacy rule, as implemented

- **The feed token is the only way to read thresholds.** `GET /api/alerts/feed/<token>` returns that feed's thresholds and events only, with `Cache-Control: private, no-store`. An unknown token returns 404.
- **The token is per feed, not per address.** The address is not authenticated, because Radar pastes it with no signature.
  - A POST without a token creates a **new** feed.
  - A POST with a token adds to that feed only if the feed belongs to the same address.
  - A wrong token and someone else's token get the same 404.
  - So knowing an address never yields its feed.
- **No listing endpoints.** No endpoint lists thresholds by address, by subject or in aggregate. `POST /api/alerts` returns only the new id, its feed URL and, when Telegram is on, its deep link.
- **Logs** carry counts and error names only. A threshold never appears in a log next to an owner key.
- **The browser keeps its own token.** It stores the feed token in `localStorage` per address, so the next alert joins the same feed. This is a convenience: if storage is cleared, the next alert starts a new feed.
- **Known limits:**
  - Anyone with database read access can join `owner_key` to thresholds.
  - Request logs on the host contain feed URLs, which include the token.
  - The per-IP rate limit runs in memory per instance, so it slows spam but does not stop it.

## Future aggregate "intent map": a requirement, not built

**PROPOSED, owner to rule.** Any aggregate view of thresholds must meet all of these:

- **Coarse buckets:** no finer than 5% of price, and no finer than 5 pp of utilization or APR.
- **Delay:** at least 7 days.
- **Minimum owners:** at least 20 distinct owners per bucket. Count distinct `owner_key`, not feeds, because one address can hold several feeds. Buckets below that are suppressed.
- **No per-address breakdown,** ever.

Until the owner rules, nothing reads these tables in aggregate.

## Applying the DDL

The owner runs `pnpm alerts:ddl` from the membrane-app root. It reads `DATABASE_URL_UNPOOLED` or `DATABASE_URL` from `.env.local`, uses IF NOT EXISTS throughout, and is safe to re-run.

Until it has run, `GET /api/alerts/status` answers `storage: false` and the control stays hidden.

## Telegram

Telegram stays dark until `TELEGRAM_ALERTS_WEBHOOK_SECRET` is set, together with `TELEGRAM_ALERTS_BOT_TOKEN` and `TELEGRAM_ALERTS_BOT_USERNAME`. While it is dark:

- the status reports `telegram: false`;
- the API returns no Telegram link and the UI shows none;
- `/start th_…` gets the help reply;
- `sendThresholdAlerts` returns before any query or fetch.

The deep link carries the feed token as base64url (`th_` + 43 characters), because Telegram limits a start payload to 64 characters.

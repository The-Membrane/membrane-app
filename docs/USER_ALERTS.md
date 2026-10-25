# User threshold alerts ("Alert me at X")

**Status:** shipped dark until the owner applies the DDL. Telegram stays dark until the owner sets `TELEGRAM_ALERTS_WEBHOOK_SECRET`.

## What it does

A user sets one alert on a live value. They pick the direction (above or below) and the number, and press **Set alert**. The press is the opt-in: nothing is stored before it. Then the control says where the alert arrives: Telegram (only when it is on) and **Your alerts page**, `/alerts/<token>`, to bookmark. RSS is a second layer. The store records a **crossed** event when the value reaches the line. It records a **cleared** event when the value moves back past the line by more than the hysteresis band.

On the alerts page the user can **edit** an alert's number and direction, or **stop** it ([Editing an alert](#editing-an-alert)).

## The control (owner review, 2026-10-16)

One mental model: "set an alert → where you'll get it". The first layer never says "feed", "store" or "threshold". Every string is pinned in `tests/unit/alertMeAtLogic.test.ts` and `tests/unit/manageAlertsLogic.test.ts`.

- **One filled action.** "Set alert" is the only filled button (an ink fill, full width at 390px). Everything else is a hairline or a quiet text button. Every target is at least 44px. There is never a row of three buttons.
- **Groups, with air between them:** the address field; then the number (which number, on the venue page; direction; value; distance from now; as-of); then the action.
- **The consent line beside the button:** "We keep this number so we can alert you. Only you get the link." There is no opt-in checkbox. The API still requires `optIn: true`, which the control sends only on the press.
- **Venue page:** one control. Where the venue has both utilization and supply APR, a switch picks between them, so the card has one "Set alert".
- **After the press:** "Alert set." and the alert in words. Under "where you'll get it": "Get it in Telegram" (only when Telegram is on), then "Your alerts page" with "Bookmark it. It shows when your number is reached. Anyone with this link can read these alerts." Then "More ways to get alerts", a disclosure that holds the RSS link and "Copy RSS link". Quiet actions: "Set another" and "Stop this alert".
- **A full page:** "You have 25 alerts, the most one link holds. Remove one on your alerts page to add another." The number is the API's `max` (else `MAX_ACTIVE_PER_OWNER`). Actions: "Your alerts page", and a quiet "Start a second alerts page".
- **Stale value:** no prefill and no distance line. The stamp says "The live number is out of date. Alerts are not checked until it updates."
- **The alerts page** says "Bookmark this page. Anyone with this link can read these alerts." Each alert has quiet **Edit** and **Stop** actions. The RSS link sits behind the same "More ways to get alerts" disclosure.

| Metric | Subjects (live config) | Source | Stale after |
|---|---|---|---|
| price | `asset:ETH`, `asset:BTC` | Chainlink ETH / USD and BTC / USD on mainnet. Decimals and description are re-checked on every read. | 2h (2 × the 1h heartbeat) |
| utilization | enabled recorder venues with a `variableDebtToken` (today: `aave-v3-usde`) | the recorder's latest observed `venue_snapshots.params.utilization_pct`, the venue page's stat | 2h (2 × the hourly tick) |
| apr | enabled recorder venues that the net-APY registry also reads (today: `aave-v3-usde`) | supply APR now, from the net-APY chain read at the finalized block | read older than 240s, or finalized block older than 38 min |

- **Stale or unavailable value:** the threshold is not evaluated. Nothing crosses and nothing clears, and the feed says "not checked".
  - The UI judges staleness with the same max ages (`lib/userAlerts/freshness.ts`). On a stale value it shows no prefill and no distance-from-now line, and says "Not checked until the value is fresh."
  - Caches hold raw values. Every cache hit is judged against the clock again, so a cached value turns stale on time.
- **Out-of-order readings:** a reading older than the one a threshold last moved on is never evaluated. Each threshold stores `last_as_of`, and every write requires `last_as_of <= the reading's as-of`. So a server instance with an older cached value cannot undo a newer crossing or clear.
- **Number entry:** a comma is read as a thousands separator only in groups of three (`1,234.5`). A single comma with no dot is the decimal mark (`4,5` is 4.5). Any other comma (`1,23,4`) is refused. The API accepts a string threshold only as a plain decimal. Setting and editing share one rule: `thresholdError` in the form, `apiThreshold` in the API.
- **Hysteresis (`lib/userAlerts/metrics.ts`):**
  - Price: 0.5% of the threshold, which equals the Chainlink deviation trigger.
  - Utilization and APR: 0.5 pp.
- **When values are evaluated:** on every feed read. There is no schedule. The operator's existing hourly alarm tick also evaluates the feeds linked to a Telegram chat, but only once Telegram is on.
- **Writes per read:** a read with no transition writes `last_value`, `last_evaluated_at` and `last_as_of` only when the value changed, and at most once a minute per threshold. Feed GETs are rate-limited per IP and per IP + token. A malformed token is a 404 before any limiter or database call.

## Storage model

Five tables, applied by `scripts/apply-alert-thresholds-ddl.mjs`. They are mirrored in `db/schema.ts`.

- **`user_alert_owners`:** one row per **feed**.
  - Holds `owner_kind` (`address`, or `telegram` reserved), `owner_key` (a lower-cased 0x address) and `feed_token`.
  - `feed_token` is 32 random bytes in hex and is UNIQUE.
  - The token is stored once per owner, so a single unique index holds it.
- **`user_alert_thresholds`:** one opt-in threshold.
  - Holds metric, subject, direction, threshold, `opted_in_at`, `stopped_at`, `last_value`, `last_evaluated_at`, `last_as_of` and `crossed_at`.
  - `crossed_at` is the start of the current crossing. `last_as_of` is the as-of of the reading the state last moved on (the out-of-order guard).
  - `opted_in_at` is when the user pressed Set alert, or Save for an edit.
  - The API caps a feed at 25 active thresholds.
  - **The cap is soft (known behaviour):** two adds racing at 24 can both land, giving 26. The per-IP rate limit bounds this.
  - **An edit replaces the row.** The old row is stopped and a new row holds the new line ([Editing an alert](#editing-an-alert)). So a feed's rows are its active alerts plus stopped and replaced ones, which keep their events.
- **`user_alert_events`:** one row per transition.
  - Holds the value, its source and the source's as-of.
  - UNIQUE `(threshold_id, kind, crossing_at)`. With compare-and-set updates, this records each transition once, however many reads race.
- **`user_alert_chat_links`:** a Telegram chat linked to a feed by `/start th_<token>`. It is a link, not a copy, so stopping a threshold on the web also stops its messages.
- **`user_alert_deliveries`:** the Telegram ledger. Each (event, chat) pair is sent at most once. A claim is taken before the send and released if the send fails. When a group becomes a supergroup, its links and its ledger rows move to the new chat id, so nothing is re-sent.
- **Names:** every constraint and index is named identically in the DDL and in `db/schema.ts`. There is no index on `owner_key`, because no query may look up thresholds by address.

## Privacy rule, as implemented

- **The feed token is the only way to read thresholds.** `GET /api/alerts/feed/<token>` returns that feed's thresholds and events only, with `Cache-Control: private, no-store`. An unknown token returns 404.
- **The token is per feed, not per address.** The address is not authenticated, because Radar pastes it with no signature.
  - A POST without a token creates a **new** feed.
  - A POST with a token adds to that feed only if the feed belongs to the same address.
  - A wrong token and someone else's token get the same 404.
  - So knowing an address never yields its feed.
- **No listing endpoints.** No endpoint lists thresholds by address, by subject or in aggregate. `POST /api/alerts` returns only the new id, its feed URL and, when Telegram is on, its deep link. `PATCH` returns only `{id, changed}`.
- **Opting out and editing.** `/alerts/<token>` is the token-gated "Your alerts" page. It lists that feed's own thresholds, each with Edit and Stop: the same data the feed returns, `private, no-store`, noindex, no referrer.
  - The RSS channel and every item link to it, so stopping or editing never depends on the panel an alert was set in.
  - It is a link, not stop-on-GET: feed readers and link previews follow links.
  - When a feed is full, the control offers "Your alerts page" and "Start a second alerts page".
  - The panel and the page both say "Anyone with this link can read these alerts."
- **Every method on `/api/alerts/feed/<token>` (GET, DELETE, PATCH) takes the same path:** a malformed token is a 404 before any limiter or database call; both rate limits count; an unknown token is a 404 before any threshold is read. Every answer carries `Cache-Control: private, no-store`, `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`.
  - A wrong token never reveals whether a threshold exists. An unknown token answers `404 unknown feed` for a real id and a made-up one alike, and reads no threshold. Another feed's valid token answers `404 unknown alert` for this feed's id and a made-up id alike, because DELETE and PATCH only ever look among that token's own active rows.
- **Logs** carry counts and error names only. A threshold never appears in a log next to an owner key. A failed feed request logs only `alerts feed: read failed` or `alerts feed: write failed`.
- **The browser keeps its own token.** It stores the feed token in `localStorage` per address, so the next alert joins the same feed. This is a convenience: if storage is cleared, the next alert starts a new feed.
- **Known limits:**
  - Anyone with database read access can join `owner_key` to thresholds.
  - Request logs on the host contain feed URLs, which include the token.
  - The per-IP rate limit runs in memory per instance, so it slows spam but does not stop it.

## Editing an alert

`PATCH /api/alerts/feed/<token>?id=<uuid>` with body `{direction, threshold}`, from the Edit form on `/alerts/<token>`. Only the number and the direction change; the metric and the subject never do. Code: `lib/userAlerts/store.ts` `editThreshold`; tests: `tests/unit/userAlertsApi.test.ts` ("PATCH — edit one alert in place").

**Validation is the same as creating.**

- The form parses with the same rule as Set alert: decimal comma, groups of three, refused commas, then bounds.
- The API checks the body's shape first, before any threshold is read:
  - `direction` must be `above` or `below`;
  - a string threshold must be a plain decimal.
- It then applies the bounds of the row's own metric (`apiThreshold`, the same function POST uses).
- A bad body writes nothing.
- The form prefills the stored number exactly, not rounded to display precision. So editing only the direction cannot move the line.

**An edit is a replacement, in one SQL statement.**

- The old row is stopped at the edit time, exactly as Stop does. It keeps its events, so the history still names the line each event fired at.
- A new row holds the new line, with `opted_in_at` = the edit time.

**The semantics, each covered by a test:**

| Rule | How |
|---|---|
| **Resets the crossing state** | The new row starts with `crossed_at` NULL. The next reading that is at or past the new line records a new crossed event, as on a new alert. There is no cleared event for the old line's open crossing, the same as Stop. |
| **Never back-fills** | The edit statement writes no event, and no past reading is replayed against the new line. Only a later read evaluates it (the page re-reads after a save), against the live value at that read: the same first check a new alert gets. |
| **Idempotent** | Saving the values the row already has is a no-op: `200 {id: same id, changed: false}`, with no write. Repeating a change on the old id finds it stopped and gets `404 unknown alert`, so a change lands once. The same values sent to the new id are a no-op. Two edits racing on one row: the row lock lets one replace it, and the other finds it stopped. |
| **Out-of-order guard** | The new row carries over `last_value`, `last_evaluated_at` and `last_as_of`. A reading older than one the old row already moved on is still never evaluated, and the once-a-minute write throttle holds. An evaluation that read the old row before the edit writes nothing on it, because every transition and reading write requires `stopped_at IS NULL`. |
| **UNIQUE event key** | The new row has a new id, so its events can never collide with the old row's on `(threshold_id, kind, crossing_at)`. |
| **Stopped alerts** | **Refused.** An edit of a stopped (or already replaced) alert answers the same `404 unknown alert` as an unknown id or Stop on a stopped alert. An edit never revives an alert. |
| **The 25 cap** | An edit stops one row and adds one, so the active count never changes. It works on a full feed and can never take one past 25. |

**Known behaviour:**

- **New id.** The edited alert gets a new id. An old RSS item's `#t-<old id>` anchor then finds no active row.
- **Telegram.** The bot sends only events of active rows. So an old-line event recorded but not yet sent when the edit lands is not sent, the same as after Stop.
- **The alerts page** puts the new row in the old one's place at once, then re-reads the feed. The re-read checks the new line against the current reading.

## Future aggregate "intent map": a requirement, not built

**PROPOSED, owner to rule.** Any aggregate view of thresholds must meet all of these:

- **Only proven owners count.** An owner counts toward any aggregate only if a wallet signature proves it controls its address.
  - **Unsigned address keys must never be counted.** Today every `owner_key` is unsigned: anyone can POST any address, as many times as they like.
  - Without proof, one person could fake 20 "owners" into a bucket and unmask the one real threshold in it.
  - The alternative to signatures is calibrated noise (differential privacy) large enough to drown any such fakes. That is the owner's call.
- **Coarse buckets:** no finer than 5% of price, and no finer than 5 pp of utilization or APR.
- **Delay:** at least 7 days.
- **Minimum owners:** at least 20 distinct **proven** owners per bucket. Count distinct `owner_key`, not feeds, because one address can hold several feeds. Buckets below that are suppressed.
- **No per-address breakdown,** ever.

Until the owner rules, nothing reads these tables in aggregate.

## Applying the DDL

The owner runs `pnpm alerts:ddl` from the membrane-app root. It reads `DATABASE_URL_UNPOOLED` or `DATABASE_URL` from `.env.local`, uses IF NOT EXISTS throughout, and is safe to re-run.

If the first version of the script already ran, re-running it reconciles that database:

- adds `last_as_of`;
- drops the by-address index;
- adds the plain `(owner_id)` index;
- renames the auto-named `owner_kind` CHECK to `user_alert_owners_kind_check`.

Until it has run, `GET /api/alerts/status` answers `storage: false` and the control stays hidden.

## Telegram

Telegram stays dark until `TELEGRAM_ALERTS_WEBHOOK_SECRET` is set, together with `TELEGRAM_ALERTS_BOT_TOKEN` and `TELEGRAM_ALERTS_BOT_USERNAME`. While it is dark:

- the status reports `telegram: false`;
- the API returns no Telegram link and the UI shows none;
- `/start th_…` gets the help reply;
- `sendThresholdAlerts` returns before any query or fetch.

**Set the secret in BOTH places,** with the bot token and username:

1. **The Vercel env.** This turns on the UI's Telegram link and the webhook that links a chat (`/start th_…`).
2. **The operator machine's `.env.local`.** This is the hourly tick (`scripts/check-venue-alarms.mjs`) that evaluates linked feeds and sends the messages.

If only Vercel has it, the UI hands out links that link a chat but never send. If only the operator has it, nothing can be linked.

**Known behaviour:**

- **No backfill:** a chat gets only events recorded after it linked. A crossing that happened before `/start th_…` is in the RSS feed and on the manage page, not in the chat.
- **`/stop` ends every alert in the chat:** linked feeds and Radar address subscriptions alike. The reply says so. The feeds keep working over RSS, and a single alert is stopped or edited on the alerts page.

The deep link carries the feed token as base64url (`th_` + 43 characters), because Telegram limits a start payload to 64 characters.

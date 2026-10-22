# CODEX CONTINUATION — two-source seen-BTC transport feasibility

Question: can the currently documented historical-hourly interfaces return one
already-seen BTC candle in the fixed2020-01-01/02 UTC window? This does not qualify
any unseen asset, reserve entity, complete history, or forecasting model.

Freeze one request per source, no retries, pagination, substitution or listing:
CoinEx GET https://api.coinex.com/v2/spot/kline?market=BTCUSDT&period=1hour&start_time=1577836800000&end_time=1577923200000&limit=1
BitMart GET https://api-cloud.bitmart.com/spot/quotation/v3/klines?symbol=BTC_USDT&step=60&before=1577923200&limit=1

Both refer only to BTC history already used in development across venues.
No unseen/allocated asset catalogue, return, forecast or score is requested.
Documented source availability is distinct from live reachability and retention.

One process, two requests maximum,30seconds total wall,10seconds per transport,
The30-second timer covers requests and parsing. A bounded32KiB metadata
finalization follows with the alarm disabled to preserve partial outcomes. Total
elapsed time is recorded; any total above30seconds is not treated as an in-budget
probe. No hard syscall-duration guarantee is asserted.
64KiB maximum response per source,32KiB total saved metadata,256MiB RSS and2GiB
free Data-volume reserve. Retain HTTP/status/schema stage, bytes, elapsed and
safe timestamp summaries only. Discard OHLC/volume values rather than persisting
or emitting them. Output contains no raw body. On failure retain exact category,
leave unattempted source explicit, and stop after the declared two calls.

CoinEx documented data is list-of-objects, created_at milliseconds and market.
BitMart row serialization remains unqualified. Its one request is admitted only
for safe HTTP/vendor/container metadata. It cannot produce a timestamp or history
success claim. CoinEx validates its declared shape and at-most-one row. A timestamp inside
the fixed closed interval [1577836800,1577923200] in epoch seconds is evidence
of this seen-symbol time query only. Boundary inclusivity is not qualified for
future acquisition. Empty, rejected,
wrong-time or unknown-shape replies are not successful history evidence.

First exercise synthetic populated/empty/malformed bodies through the exact
parser and serializer, including rejection of nonfinite numbers, oversize input
and wrong units. No network call occurs in fixtures. Preserve command, source
hashes, start/end UTC and per-source outcomes. No automatic bulk collection,
new reserve allocation or revised-model development follows.

Sources: https://docs.coinex.com/api/v2/spot/market/http/list-market-kline
https://developer.bitmart.com/spot/spot-market/history-kline

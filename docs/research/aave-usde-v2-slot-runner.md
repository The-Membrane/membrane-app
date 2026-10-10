# Aave USDe v2 single-slot runner

`scripts/research/aave-usde-v2-slot-runner.mjs` is a dormant adapter for one
predeclared, current UTC hour. It does not schedule itself, publish a manifest,
grant database privileges, replace the legacy recorder or imply a complete feed.

```text
confirmed manifest + exact global slot ID
  → start_aave_usde_v2_recorder (standalone committed SQL statement)
  → pinned finalized Aave USDe read and block-hash recheck
  → latest atomic predecessor UUID through a narrow database function
  → ingest_aave_usde_v2_recorder_success (snapshot + terminal in one SQL statement)
  ↳ read failure / atomic rejection → non-success terminal; error propagates
```

The default invocation prints dry-mode help and performs no SQL or RPC. Live
invocation requires `--live --manifest SHA --slot aave-v3-usde:...` and **both**
`AAVE_USDE_V2_RECORDER_DATABASE_URL` and `AAVE_USDE_V2_RECORDER_RPC_URL` in the
process environment. It never loads `.env.local` or generic `DATABASE_URL`.
The database migration, separate confirmation, runtime grants and removal of
the legacy recorder must be independently reviewed before live use. The
start function rejects duplicate, unconfirmed, early and closed slots. Its
one-statement call must resolve before any RPC call. A failed terminal write is
reported with the original read/insert error; it is never represented as
success. In particular the legacy recorder's recent row can cause the atomic
function to reject an attempted v2 insert until a deliberate cutover.

The reader requires mainnet chain ID, a finalized block no older than two
hours, matching aToken underlying/decimals, an actual underlying balance and
variable debt read, and a second hash/time check for the pinned block. It
records the existing `$1/USDe` assumption from the venue reader. These checks
attest one captured reserve state, not executable withdrawal capacity or
future forecast accuracy. Static injected tests prove call ordering and error
paths only; there has been no PostgreSQL integration or live run.

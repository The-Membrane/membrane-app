# sUSDe pending-episode mined payout attestation

## Positive mined delivery with unresolved episode

`scripts/research/susde-public-mined-delivery.mjs` is a separate, smaller
positive proof lane for a candidate transaction. It verifies a pending public
issue, then requires two independent Ethereum origins to match a finalized,
successful direct `unstake(holder)` transaction, its full bounded receipt, a
unique USDe `Transfer` from the Silo to that holder for the frozen pending
amount, payout-time EOA status, and unchanged vault/USDe/Silo code and route
identity. It stores `minedDeliveryProven: true` with the fixed fields
`episodeAttribution: unresolved`, `durationEstimated: false`, and
`forecastValidated: false`. A matching amount does not establish that the
paid queue is the queue seen at the issue anchor.

```sh
NODE_OPTIONS='--max-old-space-size=384' node scripts/research/susde-public-mined-delivery.mjs --verify
# A public candidate hash can later be checked read-only:
NODE_OPTIONS='--max-old-space-size=384' node scripts/research/susde-public-mined-delivery.mjs --attest <issue-sequence> <transaction-hash>
```

Capture preflights at most eight origins, retries at most six independent
pairs after transport failures, and stops on any chain, header, receipt, or
economic disagreement. All attempts share a 180-second/100-call bound;
receipts are capped at 128 logs/80 KiB, sealed records at 120 KiB, and the
append-only writer preserves at least 1 GiB free disk. No native schedule is
activated. The issue-3 candidate
`0x7539a78329b506b472dfe3cb67be2c94360229696cfc84c435b177d38a314801`
was sealed as mined delivery sequence 1 on 2026-10-02. Offline verification
replays one record. The ledger permits one delivery per issue and requires
the two selected origins to have different hostnames, even if several URLs
were configured. Finality is attested by RPC finalized-head responses and
canonical pinned reads; the stored headers alone do not prove ancestry.

## Same-episode attribution

### Issue 3 continuity archive

`scripts/research/susde-public-pending-continuity-archive.mjs` incrementally
collects the exact owner/Silo `Withdraw` log filter from issue 3's anchor
block + 1 through its sealed delivery block. It verifies the existing issue
and positive mined-delivery ledgers before accepting a window. Each row fixes
both ledger hashes, the holder, query parameters, ten-block cursor, two
distinct provider hosts, matching boundary headers and full filtered logs.
The first and last windows bind to the issue anchor and delivery block hashes;
adjacent windows bind through parent hash. The two RPC origins attest boundary
headers and filtered log completeness; intermediate headers are not archived,
so this is not cryptographic chain-ancestry or log-absence proof. Logs are
validated for topics, amount encoding, block hash at boundaries, and
transaction/log order.

```sh
NODE_OPTIONS='--max-old-space-size=384' node scripts/research/susde-public-pending-continuity-archive.mjs --verify
# A local operator can advance up to eight windows in one bounded run:
NODE_OPTIONS='--max-old-space-size=384' node scripts/research/susde-public-pending-continuity-archive.mjs --tick 3
```

One tick accepts at most eight complete ten-block windows, 60 RPC calls and
180 seconds. A transport failure may try another independent host pair under
the same budget; any evidence disagreement stops. The append-only writer
preserves 1 GiB free disk and never seals a partial window. The
measured-capable Alchemy+Ankr host pair is attempted first when configured;
the remaining fallback pairs share the same bound and cannot override a
disagreement. Offline `verifyContinuityArchive()` returns ordered rows and a compact coverage
summary: frozen issue/delivery hashes, start/end/cursor, unique provider-host
pairs, and counts of observed `Withdraw` logs before delivery. `complete`
means only that the whole range has two-origin RPC-attested log coverage. It
does **not** attribute the delivery to the original queue episode, prove
cryptographic absence, estimate duration, or validate a forecast. The
existing mined-delivery row remains `episodeAttribution: unresolved`.

The local Mac LaunchAgent `com.membrane.susde-public-pending-continuity` is
loaded at five-minute intervals with a 185-second outer timeout and a
384 MiB Node heap cap. It calls `susde-public-pending-campaign.mjs`: each run
advances the archive, then a later run attempts the separate same-episode
assay only if the archive is complete. Its first scheduled archive attempt hit
a transient RPC error; subsequent attempts succeeded. At 2026-10-02 01:43 UTC
the archive verified 24 of 714 windows through block 26,093,963, with no
owner `Withdraw` logs in that covered prefix. The scheduler does not promote
a partial archive or emit a forecast.

### Issue 3 same-episode sidecar (V2)

`scripts/research/susde-public-pending-payout-v2.mjs` is a separate append-only
attribution record. Before any RPC read, it replays the verified issue,
delivery, and continuity archive; the archive must be complete, contain zero
owner/Silo `Withdraw` logs before the delivery transaction, and end at the
exact sealed payout block. The sidecar binds the issue and delivery SHA-256
values plus the final archive row SHA-256. An incomplete archive returns
`susde_episode_archive_incomplete` without contacting an RPC.

Two distinct RPC hostnames must then agree on canonical issue-anchor and
payout-block headers, Ethereum chain ID, the direct holder transaction and
its nonce, holder nonce at the anchor and payout block, and zero cooldown
state at the pinned payout block. The anchor nonce must equal the transaction
nonce; the payout-block nonce must be exactly one greater. Both origins must
attest a finalized head at or beyond payout. The already verified delivery
record supplies the successful receipt, exact whole-amount USDe transfer, and
contract code and route identity. The duration is explicitly the observed
time **from pending issue anchor to mined payout**, not queue initiation to
payout. Its fixed labels are `sameEpisodeEvidenceLevel:
two_origin_rpc_log_attested`, `cryptographicAbsenceProven: false`, and
`forecastValidated: false`; no likely duration is emitted. This retains the
two-RPC log-completeness trust assumption and does not modify the original
delivery or V1 records.

```sh
NODE_OPTIONS='--max-old-space-size=384' node scripts/research/susde-public-pending-payout-v2.mjs --verify
# Explicit operator action only, after the archive becomes complete:
NODE_OPTIONS='--max-old-space-size=384' node scripts/research/susde-public-pending-payout-v2.mjs --attest
```

The sidecar has no scheduler. One attempt is capped at 60 RPC calls and 180
seconds, the Node command at 384 MiB, each sealed record at 32 KiB, and the
shared atomic ledger writer keeps at least 1 GiB of disk free. Offline tests
cover nonce mismatch, nonzero queue, archive gaps, final-row replay, host
aliases, origin disagreement, and duplicate sequence. No live V2 attestation
has been run by this implementation.

`scripts/research/susde-public-pending-payout.mjs` is a separate, opt-in proof
lane for a transaction hash associated with an already verified public pending
issue. It does not change issue or score semantics and has no native schedule.
The read-only verifier is:

```sh
NODE_OPTIONS='--max-old-space-size=384' node scripts/research/susde-public-pending-payout.mjs --verify
```

`--discover <issue-sequence>` scans USDe `Transfer` logs filtered to
Silo→the frozen holder from the issue anchor's next block through a common
finalized head. It returns candidate transaction hashes only after two origins
agree on every contiguous 512-block window. If the entire interval cannot be
scanned within 128 windows, 300 calls, 180 seconds, and 64 KiB/128 logs per
response, it returns a typed incomplete status **without a partial candidate
list**. Discovery does not identify a paid queue episode.
The CLI preflights at most eight configured origins and tries up to six
independent pairs when an origin has a transport outage. All retries share
the same 180-second/300-call budget. A chain or economic/log disagreement
stops discovery immediately; another pair cannot hide it.

An operator may later submit a _public_ candidate hash with
`--attest <issue-sequence> <transaction-hash>` after the issue's cooldown. No
transaction is broadcast. The command returns a typed unproven status when
finality, RPC, code, continuity, or exact payout checks cannot be established;
only a fully replayable proof is sealed. No live attestation or scheduler has
been activated as of this document.

The proof links to the verified issue hash, frozen owner, pending USDe amount,
cooldown end, vault, Silo, and USDe. Two independent origins must agree on a
finalized mined transaction, successful receipt, block, account nonces, vault
code and identity, cleared post-block cooldown state, and every owner-specific
cooldown `Withdraw` log across the interval. The transaction must be sent by
that EOA directly to the vault as `unstake(holder)` with the exact next nonce.
Its receipt must contain a unique USDe `Transfer` from the Silo to the holder
for the _entire frozen amount_. Any prior cooldown addition or reset log,
including an earlier transaction in the payout block, makes the original
episode ambiguous. An unchanged EOA nonce between issue anchor and payout
rules out an intervening holder-initiated unstake or cooldown reset. The
[exact-matched deployed StakedUSDeV2 source](https://sourcify.dev/server/v2/contract/1/0x9D39A5DE30e57443BfF2A8307A4256c8797A3497?fields=all)
uses one-argument `cooldownAssets`/`cooldownShares` methods and binds the
cooldown owner to `msg.sender`, so a third party cannot reset this holder's
queue. The owner-specific `Withdraw` scan still detects additions or resets
under the stated two-origin log-completeness assumption. The older
[code4arena StakedUSDeV2 source](https://github.com/ethena-labs/code4arena-contest/blob/main/protocols/USDe/contracts/StakedUSDeV2.sol)
has two-argument methods and different third-party initiation semantics; it
does not describe this deployed vault.

Two agreeing RPC log answers attest completeness; they are **not a
cryptographic absence proof**. The sealed record fixes
`sameEpisodeEvidenceLevel: two_origin_rpc_log_attested` and
`cryptographicAbsenceProven: false`. `minedDeliveryProven: true` rests on the
successful transaction receipt and exact USDe Transfer, while attribution to
the frozen queue episode retains that explicit RPC-log trust assumption.

Capture is bounded to 128 consecutive windows of 512 blocks (65,536 blocks),
300 RPC requests, 180 seconds, 128 logs per response, and a 220 KiB proof.
The inherited atomic ledger writer preserves at least 1 GiB free disk. A
longer cooldown or an origin that rejects a window returns
`susde_payout_continuity_range_unavailable` or another typed unproven status;
it never infers payment from a later empty queue. The study currently has no
verified payout records and does not yield a forecast or a likely duration.

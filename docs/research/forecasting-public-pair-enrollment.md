# Separate public-pair qualification

`scripts/research/forecasting-public-pair-policy.mjs` is a pending, separate policy.
It does not read recorder credentials, replace C1/C3, enroll an archive roster,
or participate in any live holder/API issuer. No network request is made by the
module or its offline test. The URLs are exact HTTPS URI and host bindings:
`https://ethereum-rpc.publicnode.com`, `https://eth.llamarpc.com`, and the optional
schema-only `https://api.morpho.org/graphql` request. Redirects are forbidden.

After the environment owner configures those exact egress hosts, deliberately
retain a separate enrollment JSON returned by `enrollPublicPairQualification`.
Provide the exported policy digest, scope `finite-read-only-head-qualification`,
an enrollment UTC time and an expiry no more than one hour later. This record
does not authorize changing the active C1/C3 policy. Enrollment is not evidence
that a provider has qualified.

The manual runner must use `publicPairQualificationPlan` in two stages under
the established Linux launcher, one runtime and one request at a time:

1. Send the four fixed requests: chain ID and finalized header on each host.
   Reject errors, non-mainnet responses and disagreement in number/hash/time.
2. Supply the agreed exact hexadecimal block number to the second-stage plan.
   Read that exact header on both hosts; optionally perform the one Morpho
   schema query. Pass both stages' responses to `verifyPublicPairHead`.

One enrollment permits one attempt of at most seven HTTP requests in total,
30 seconds total, four seconds per request, 256 KiB per response, no retry,
no redirect, and concurrency one. Retain request/response digests, original
response bytes, availability times, unsuccessful attempts and launcher proof
in the separate dataset repository. The module prepares requests and validates
head identities; it is not a transport and does not enforce these HTTP limits.
An executing transport must enforce all limits before sending. Do not execute
the plan using an unbounded generic fetch or assume ordinary egress approval
enrolls the policy.

Successful head agreement remains `head_agreement_only`. Archive availability,
historical EIP-1898 canonical reads, typed asset/decimals/share/preview/cash
agreement, owner/Q/horizon binding, additional venue mechanisms and Morpho
history coverage remain unqualified. Schema reachability alone proves no
Morpho data accuracy, pagination coverage or historical availability. A later
archive or native-holder qualification needs its own explicit finite scope
and source seals; it cannot inherit a successful head probe as permission.

The offline assertion suite is `tests/unit/forecastingPublicPairPolicy.node.test.mjs`.
Run it through a newly sealed Linux gate using Node old-space 192 MiB and the
unchanged aggregate RSS/deadline/disk/child-cleanup limits. No network gate has
been executed by this change.

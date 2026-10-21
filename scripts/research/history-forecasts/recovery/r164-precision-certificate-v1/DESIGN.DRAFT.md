# R16.4 precision certificate — prospective DRAFT, CODEX CONTINUATION

No actual matrix or original prediction payload is admitted by this draft. Existing immutable sources/results remain unchanged. This is a numerical box certificate, not a fit, forecast revision, power validation or market confidence interval.

## Fixed targets and draws

Four existing targets only: T24_G0 comparison0 ordinal0, T720_G0 comparison0 ordinal12, T720_G0 comparison5 ordinal12, T168_G3 comparison0 ordinal11. Expected S127, B29. Retain all four, without selection by results. Reuse the exact accepted O65 SeedSequence([20261641,ordinal]) schedule, 2000 cluster multinomials followed by 2000 block multinomials. Generate each group's base draws once. T720 targets share those arrays. Verify hardcoded original O65 float64 ws/wb hashes and the accepted empirical JSON. Three modes: combined, cluster_only, calendar_only. This is O65's per-group sensitivity schedule, not original global-RNG replay.

Read the matrix once through lazy np.load. Verify all96 member names, but materialize only six members from each of three selected groups (18 members). Each selected Md/MdLo/MdHi member contains12 comparison planes. Select only the fixed planes for statistics. Preserve exact integer Mn, zero-cell counts, sorted IDs and accepted group totals. No other group statistics or130 raw series payloads are read.

## Two distinct mathematical domains

1. Literal stored endpoint box: every binary64 MdLo/MdHi endpoint is its exact dyadic value. Enclose exact-real functionals for arbitrary cell sums in that box. This claim does not depend on original lost probabilities being inside it.
2. Conditional packing/aggregation box: widen each stored endpoint by exact rational E(n)=n(n−1)/(2^53−n+1), directed to binary64 using exact rational comparisons. Zero-count cells remain exact zero. This assumes ordinary nearest float32→float16 packing, closed adjacent-half preimages and the explicit correctly rounded binary64 addition-tree contract. Packing lineage is unproved. No original floating-pipeline replay is claimed.

The finite endpoint prerequisite exhausts15361 nonnegative half bitpatterns through1 plus signed zero against Fraction. Midpoint probabilities are on2^-25; loss endpoints/differences are on2^-50 with≤51 significant bits. The reconstruction's pinned source assigns each row once, partitions thresholds0through9 disjointly using the actual pinned request shallow0..3/mid4..6/deep7..9, merges cluster/threshold/band counts by addition, and has n leaves per final Mn cell. Removing exact initial-zero additions gives n−1 additions. For arbitrary parenthesization, gamma_(n−1)*sumabs≤E(n). The dyadic lattice prevents underflow and count bounds prevent overflow. This is conditional on native binary64 reduction semantics, not proved by finite bincount examples. Empty weighted bincount has integer-zero output in the pinned runtime, handled as exact zero. All main-field geometry must be half in the accepted reconstruction metadata. A non-half field, duplicated declared band partition, source drift or failed finite proof blocks the conditional claim rather than introducing epsilon.

The original132-file identity manifests are inherited through accepted request/reconstruction hashes, not republished in the aggregate. The actual original input packet has132 pinned files (130 series plus two JSON artifacts). Native reduction assumptions, unattainable joint endpoints and historical arithmetic holds remain explicit.

## Directed functionals and domain branches

Counts and nonnegative integer weight products use a Python-integer-derived global bound before int64 contraction. Require N*max(ws)*max(wb)<min(2^53,2^63). All denominator products/partial sums are then exact. Zero-denominator draws are censored once, without redraw/zero fill. Fewer than two valid draws produces insufficient-support SD/z.

Numerators, means and reductions use directed Interval arithmetic at every operation and sequential addition. Never use np.sum plus one ulp. Choose arbitrary finite interval midpoints, clamped to their boxes. Always compute BOTH centered-identity sample-SD and norm-perturbation bounds, retain both, and intersect. The first uses any fixed binary64 center c and [sum(m−c)^2−sum(m−c)^2/R]/(R−1). The second bounds SD around midpoint vectors by ||radius||2/sqrt(R−1). Known nonnegative radius/squared-norm/sample-variance quantities may be intersected with zero. A contradictory interval fails closed.

An exact structural proof of point D=alpha*Mn identifies constant replicate means even for unequal denominators, and preserves SD[0,0]. A nonpoint box is not assumed to share that dependency. No variance bound is inferred merely by evaluating Lo/Hi SDs.

CGM net variance is signed: U=(D−mu*Mn)/N and V=sum(rowU)^2+sum(colU)^2−sum(U^2). Always retain its direct interval and a fixed center-perturbation interval, then intersect. The perturbation sums absolute quadratic changes for row, column and intersection terms. Never clip negative CGM net variance. Its center net is computed independently with exact Fraction arithmetic over the chosen dyadic centers and counts. Its exact rational value and directed enclosure are recorded separately. This can prove a mathematical zero even when ordinary floating CGM arithmetic gives a tiny signed value.

Strictly positive SD permits finite signed z=mu/SD and favorable z=-z, represented by exact negation/swapped endpoints. SD[0,0] means undefined throughout. A denominator interval reaching zero gives explicit possible undefined behavior and an extended closure for its positive branch, not a finite surrogate. CGM upper≤0 certifies no positive net branch. A CGM interval crossing zero retains both signed endpoints and its unresolved positive branch. Broad interval branches do not establish attainability under original row dependencies.

Completed output scope is eight observed-mean boxes,24 bootstrap-SD/z records and eight CGM records. Existing O65 point summaries are ancillary context, not automatically enclosed historical floating statistics. Tiny machine/exact-real discrepancies do not authorize widening a proved enclosure.

## Admission and resource boundary

request.DRAFT.json refuses before any payload authentication. A separately frozen parent request must bind driver/tests, cleared core/tests, endpoint helper/tests/proof, this design, both design audit notes, accepted reconstruction implementation and O65 implementation/request/result. Reuse unchanged O65 authenticate for metadata graph. Additionally rehash all325 inherited O86 runtime/native pins plus its interpreter, bind that exact list to its pinned identity audit, and compare invoked interpreter as well as O65 resolved interpreter/prefix/full version/platform/NumPy. No Torch/SciPy or new package import. Final rehash covers old artifacts, runtime, new sources and request.

One future attempt:120seconds internal alarm plus parent external guard,1,000,000,000-byte RSS,2,147,483,648-byte free reserve,10,000,000-byte recursive owned output cap. Resource observations and failure stage/code are retained. Partial completed targets are not complete evidence. No precision/seed/domain/mode adjustment or automatic retry after observing a payload. Parent source read, own synthetic tests and fresh independent refutation precede admission.

A single fixed synthetic R2000 SD-plus-norm preflight measured0.417947125seconds and31,178,752-byte process peak. Naive24-record SD component is10.03seconds. Weighted mean kernels were not included in that measurement. It is resource preparation, not a scientific attempt or measured complete-job runtime. A subsequent single full-shape synthetic target with127×29 cells,2000 draws,both domains,all three modes and two CGM computations measures9.168929041seconds with50,642,944-byte peak RSS. Naive four-target scaling is36.68seconds. It uses fixed synthetic seed2026109999 and no historical matrix. This is prospective resource evidence, not a guarantee of actual-job runtime.

## Review history

Core drafts b7e5c10c and5126f758 were refuted for mixed Python sequence and nested ndarray coercion of nonrepresentable integers. Cleared93baeb9e source validates originals recursively before conversion. No real input was opened under those drafts. All prior source identities remain in parent review history. Endpoint tests also expose NumPy's empty-bincount integer-zero behavior explicitly. These are instrument corrections, not model results.

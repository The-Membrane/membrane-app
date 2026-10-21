# Original R16.4 precision: rigorous numerical design, no payload access

**Target:** certify enclosures of the real-valued mean, fixed-draw bootstrap sample SD/z, and signed CGM variance/z for exactly four already selected cells. This note admits no execution. It uses no arrays, fits, new outcomes or Board edits. It does **not** certify full PartA power/leave-top selection, PartB width randomness, historical floating-point bitwise replay, or market confidence coverage.

Four fixed cells: T24/all rec12−fH; T720/all rec12−fH; T720/all recb12−fH; T168/deep rec12−fH. Group/comparison identities are frozen, not picked for current results.

## 1. Separate three claims before calculating anything

1. **Stored-box certificate:** interpret each finite binary64 MdLo/MdHi endpoint as its exact dyadic value. Prove the numerical functional lies in the computed enclosure for every matrix in that literal box. This is rigorous even if the box has no relationship to missing original float32 predictions.
2. **Conditional packing-and-aggregation certificate:** additionally prove a widened box encloses the *exact mathematical loss sums* of every float32 preimage under the expressly assumed ordinary nearest float32→float16 packing map. That packing map is not authenticated original producer lineage. The box is a conservative superset; simultaneous endpoints can be unattainable.
3. **Historical machine-output replay:** not supplied by either certificate. Real-function enclosures over exact input values do not automatically reproduce every old NumPy rounding operation, original RNG order, lost float32 inputs or published bit pattern. Retain existing original summary compatibility separately. An old FP point can lie just outside an exact-real point certificate (for example, np.std of a constant0.1 array can return a tiny positive value while the mathematical SD is0). Record that as a semantic/roundoff distinction, not a failed exact-real proof or license to pad its bounds. Literal old-pipeline certification needs a separate operation-by-operation roundoff ledger. Do not relabel the new certificate as recovered historical values.

The first two point-mean envelopes already contain zero. Their sign ambiguity is completed knowledge, not a new result promised here.

## 2. Existing Lo/Hi arrays are NOT already outward certificates

`reconstruct_r164_loss_matrices.py:49–58` computes midpoint preimages and endpoint losses in ordinary NumPy arithmetic. Lines80–90 accumulate paired endpoint differences with np.bincount and binary64 additions. Lines92–98 and129–137 merge levels/bands; lines140–149 write their floating sums as MdLo/MdHi. The64epsilon compatibility slack at64–72 and148 is an acceptance tolerance, not an outward-rounding proof. The downstream validator likewise uses a tolerance (`audit_r164_bootstrap_sensitivities.py:59–62`). A new implementation must not silently call those bounds certified.

### A feasible conditional upstream proof

First authenticate every original probability-field geometry as binary16, all labels as0/1, exact common-row/count/partition identities and the pinned producer/runtime. Do not extend this proof to binary32 fields. Existing reconstruction supports both types (`:50–52,121–125`), so the actual authenticated main dtype must be checked explicitly before applying the following argument.

For every finite half probability0≤p≤1, clipped adjacent-half midpoint endpoints are multiples of2^−25. They lie in[0,1]. Their squared loss endpoints have denominator2^50 and magnitude≤1; their numerator fits within51 significant bits. Each one-minus, square and paired endpoint subtraction therefore has a binary64-exact mathematical result. **Verify actual pinned NumPy operations exhaustively against Fraction** for every nonnegative binary16 bit pattern through1, plus signed zero: midpoint/clipping, both binary-label loss endpoints, denominator lattice and range. This is15,361 positive-or-zero patterns plus signed zero, not a data run. Algebraically establish any difference of two endpoint losses remains a representable2^−50-grid number in[−1,1]; an O(K²) pair enumeration is unnecessary. If a check fails or any input geometry is not half, stop the packing-and-aggregation claim; do not insert nominal epsilon.

For each exact-count matrix cell n=Mn[s,b], each row contributes exactly one endpoint difference to its threshold/horizon. Thresholds0…9 are disjoint; BANDS partitions them (`:20,129–137`). Per-file bincount, same-cluster additions, band merge and all-band merge are just a parenthesized sum of the **same n leaves once each**. Remove additions of exact constant zero (they do not round). The resulting reduction tree has n−1 binary additions, regardless of grouping/order. Nontrivial cancellation to zero does not delete its data leaves from the bound. This establishes the required count; it is not an unsupported “n operations” guess. It depends on binary64 correctly rounded addition semantics of the pinned NumPy implementation, no input duplication/multiplication, and no overflow/underflow. The2^−50 lattice, |partial sum|≤n and authenticated finite n rule out underflow/overflow in this particular reduction. If any extra non-additive operation or duplicated leaf is found, this n−1 argument fails and its count must be rederived before using it.

Let u=2^−53 and k=max(n−1,0). Compute exactly with integer/Fraction arithmetic

```
gamma_k = k*u/(1-k*u), requiring k*u < 1
E_n = gamma_k * n
L_cert[s,b] = exact(stored_MdLo[s,b]) - E_n
U_cert[s,b] = exact(stored_MdHi[s,b]) + E_n
```

The standard sum error bound is gamma_k Σ|leaf|≤gamma_k n, valid for signed leaves and any such tree. Convert these exact rationals **outward**, never nearest. n=0 requires exact stored zeros and E=0. These expanded bounds certify exact mathematical sums under the preceding assumptions; they do not establish the original packing transform or a historical machine-output trace.

**Fallback if that proof cannot be closed:** retain the stored-box certificate only. Alternatively request a separately pinned exact recomputation from the already admitted130 row files, not new acquisition: express half endpoint numerators on the integer2^−25 grid, endpoint losses on2^−50, paired differences as integers, and sum with arbitrary integers. A bounded int64 chunk is allowed only after proving chunk_length×2^50<2^63; flush chunk sums to Python int. This would consume original row payloads and is **not** included automatically in a matrix-only attempt. It requires its own explicit access/budget admission. No tolerance-based repair of stored arrays is equivalent.

## 3. Actual machine enclosure primitives

Use the author's finite binary64 Interval(lo,hi) layer, with a documented IEEE round-to-nearest/no-FTZ runtime assumption and exact Fraction fixtures. Every elementary add/subtract/multiply/divide result is widened immediately with np.nextafter toward−∞/+∞. Signed multiplication/division considers all relevant endpoint combinations. A denominator interval containing zero is a domain branch, never divided through. Reductions are **sequential directed additions**, optionally vectorized across independent replicates; np.sum/BLAS/einsum followed by one nextafter is not a proof. Nonfinite endpoints, unexpected dtype, overflow or an unprovable domain cause a preserved stop, not saturation.

For exact integers/rationals, conversion is proved using float.as_integer_ratio cross-multiplication and nextafter adjustment until the lower≤rational≤upper inequalities hold. Do not assume int→float conversion is outward. The same exact check handles the gamma rational and counts if not exactly representable.

For sqrt, begin with any finite library approximation but **prove the bound**: compare exact Fraction(s)^2 against the exact endpoint and move outward as needed. Lower satisfies s_lo²≤x_lo; upper satisfies s_hi²≥x_hi, with nonnegative roots. Cap the correction loop and fail if it cannot certify; do not trust a libm accuracy claim. Zero endpoints are exact. An alternative is integer isqrt of a fixed rational grid; either method needs a proof, not a nominal ulp margin.

A small directed primitive can be tested exhaustively over handpicked exact operands, but its all-input guarantee comes from the IEEE operation semantics plus the exact endpoint inequalities, not the number of tests.

## 4. Mean and frozen bootstrap means

Flatten cell sums D_j∈[L_j,U_j], exact integer counts n_j≥0 and N=Σn_j>0. Point mean μ=ΣD_j/N uses directed interval sum/division.

For replicate r, a_rj=wS[r,s(j)]×wB[r,b(j)] is an exact nonnegative integer. The mode substitutions use all-one vectors for calendar-only or cluster-only. Let

```
q_r = Σ_j a_rj*n_j          exact integer denominator
m_r(D) = (Σ_j a_rj*D_j)/q_r, for q_r>0
```

Generate **the already frozen O65 schedule**: Nrep2000, SeedSequence([20261641,group_ordinal]), first series multinomials then block multinomials (`audit_r164_bootstrap_sensitivities.py:13,65–69`). Freeze ordinal/group order and verify existing weight hashes. This is not the original scorer's global RNG replay: its own LIMITS at15 says so, and `r164_score.py:123–124,151–163` advances one shared generator through comparisons/bands. Name the certified schedule honestly.

Compute q_r in Python integers, or int64 only after proving a global bound `N*max(wS)*max(wB) < min(2^53,2^63)`. Because terms are nonnegative, this bounds every product/partial sum and also proves the original double integer denominator contractions exact. Do not use an already overflowed np.sum to establish N; sum Python ints first. Weight values must be finite exact integers, not silently truncated floats.

For numerator bounds, apply nonnegative integer weights to endpoint intervals, outward at each multiply/add; batch across r. No loss-row expansion or real-data resampling is required. Replicates with q_r=0 are censored exactly as O65, without redraw or zero fill; report requested/valid/censored counts. The valid set depends only on counts/weights, so it is common to every matrix in the box. If fewer than2 valid replicates remain, sample SD/z are insufficient-support branches, not zero.

## 5. Bootstrap sample SD: two valid enclosures

Let R be valid-replicate count. The target is

```
s² = [Σ(m_r-c)² - (Σ(m_r-c))²/R]/(R-1)
```

for **any fixed finite c**. Choose c once as an ordinary finite mean of replicate-interval midpoints; it need not equal any true mean and is not fitted to labels. Treat that binary64 c as an exact constant in the interval evaluation. Apply outward operations to each difference, sum of squares, sum, square, division and subtraction. Intersect the resulting variance interval with[0,∞), since this functional is mathematically nonnegative. Reject an upper bound below zero as a numerical/proof contradiction. This nonnegative intersection is justified for sample variance only; it must never be applied to signed CGM variance.

Independently obtain a norm-perturbation enclosure. For each replicate interval choose fixed center c_r and radius ρ_r=max(c_r−lower_r,upper_r−c_r), both outward. With P=I−11ᵀ/R,

```
s = ||P m||₂/sqrt(R-1)
| ||P m||₂ - ||P c||₂ | ≤ ||P(m-c)||₂ ≤ ||ρ||₂.
```

Compute certified bounds on ||Pc||₂ and ||ρ||₂, so

```
s_lo = max(0, (normPc_lo - normRho_hi)/sqrt(R-1)_hi)
s_hi = (normPc_hi + normRho_hi)/sqrt(R-1)_lo.
```

Use directed arithmetic for those divisions. Intersect this SD interval with the certified sqrt of the centered-variance interval. Both enclosures are valid despite shared dependence between replicate means; treating replicate intervals independently only enlarges the feasible set. No empirical choice of center/precision/algorithm after scores. Exact point-constant replicate inputs can be recognized structurally and return SD=[0,0]; otherwise a lower bound0 means strict positivity was **not certified**, not proof that zero is attainable.

z=μ/s is finite-interval certified only when s_lo>0. If s_hi=0, source z is undefined throughout the certified domain. If0=s_lo<s_hi, report a possible undefined branch and an extended-real enclosure of the defined branch; do not replace the denominator by epsilon. If μ_lo>0, a safe defined-branch range is[μ_lo/s_hi,+∞); if μ_hi<0 it is(−∞,μ_hi/s_hi]; if mean spans signs it can be the whole extended line. If μ is exactly0, the defined branch is z=0 while a zero-SD branch may remain unexcluded. Intersecting with source branch semantics is mandatory; “branch not excluded by enclosure” is not an attainability claim or probability mass.

## 6. Signed CGM variance and z

Use exactly `r164_score.py:87–93` and the accepted audit at74–76:

```
U_sb = (D_sb - μ*n_sb)/N
V = Σ_s(Σ_b U_sb)² + Σ_b(Σ_s U_sb)² - Σ_sb U_sb².
```

This is a **signed** quadratic expression; it can be negative. Build the direct outward interval through U, row/column sums, squares and signed subtraction. Never floor its lower bound or map a zero crossing to a positive SE.

A second centered perturbation bound can reduce dependency inflation. Choose a fixed exact/directed midpoint matrix C, μ_C=ΣC/N, U_C=(C−μ_C n)/N, and cell radii r_j. A valid radius is

```
r_μ = Σr_j/N
e_j = (r_j + n_j*r_μ)/N
E_s = Σ_b e_sb; F_b = Σ_s e_sb
Δ = [2Σ_s |row(U_C)_s|E_s + Σ_s E_s²]
  + [2Σ_b |col(U_C)_b|F_b + Σ_b F_b²]
  + [2Σ_j |U_Cj|e_j + Σ_j e_j²].
```

Then V(D)∈[V(C)−Δ,V(C)+Δ]. Compute center V(C) with directed intervals or exact dyadic/common-denominator integers; all radii/Δ arithmetic is outward. Intersect with the direct interval. This follows by applying `|(x+e)²−x²|≤2|x|ρ+ρ²` to each term; the negative intersection term contributes its absolute perturbation bound, not a claimed positive variance component.

Branches: V_hi≤0 certifies no positive-net CGM SD/z; V_lo>0 permits sqrt and finite z enclosure. If V_lo≤0<V_hi, nonpositive/null behavior is not excluded, and z on the positive branch has the same extended-real denominator-zero handling as above. A broad box crossing zero does not prove some admissible original row array realizes each sign. Preserve signed endpoints and report the exact-center value separately. No interpretation as additive causal variance components follows.

## 7. Cheap exact fixtures required BEFORE any matrix payload

1. **Input lattice:** exhaustive half endpoints/loss endpoints versus Fraction, including p0,p1,signed zero,min subnormal, power-of-two boundaries and clipping. Verify actual NumPy expressions, not a substitute formula only.
2. **Upstream summation:** Fraction sums with exact cancellation, alternating signs, unequal per-file/level partitions, and huge-to-small magnitude sequences; verify both tree-count accounting and widened old sums. Include an intentionally non-half field and a duplicated row partition that must reject the conditional upstream claim.
3. **Zero SD:** exact constant observations and exact proportional cell sums D_j=αn_j under unequal counts/weights. Preserve SD0/undefined-z; an interval that merely contains zero must not be labeled all-positive.
4. **Near cancellation:** replicate means[1,1+2^−40,1−2^−40] have sample variance2^−80 and SD2^−40 exactly. Center1 avoids uncentered loss of this signal; both enclosures must contain the Fraction answer.
5. **Unequal denominators:** n=(1,3), D=(−1,3), weight pairs(1,0),(0,1),(1,1),(0,0) give means−1,+1,1/2 and one censored replicate. Valid R3 mean is1/6, sample variance13/12; no zero fill/redraw.
6. **CGM signs:**2×2 counts all1. D=[[1,−1],[−1,1]] has μ0,V=−1/4; D=[[1,1],[−1,−1]] has μ0,V=+1/4. A box containing both cannot certify positive CGM variance. D=[[1,0],[−1,0]] has V0 despite nonconstant entries. For row-effect r and interaction t, D=[[r+t,r−t],[−r−t,−r+t]] gives V=(r²−t²)/4; test r=1/2,t=1/2±2^−30 to expose signed near-zero cancellation.
7. **Ratio branches:** exact zero mean with positive/zero SD; positive/negative means with a denominator interval touching zero; n=0 cells, all-zero denominators, one valid replicate, overflow/unprovable conversion. Require explicit branch records, never finite fabricated z.

## 8. One bounded prospective attempt and reporting

After independent primitive/source tests, parent review and a frozen request only: read the existing accepted matrix/reconstruction/admission metadata; no raw row packet unless separately admitted. Verify all half geometry and provenance prerequisites for claim2, widen upstream boxes by the proved rational error, and run the four fixed cells under three existing O65 modes. Preserve raw stored-box and conditionally widened results separately. Fixed precision, schedule and branch policy; no reruns to obtain narrower intervals.

Cap one invocation at120seconds,1GB sampled RSS,2GiB free reserve, bounded aggregate output, with a parent external guard including startup/cleanup. Stream modes/replicates; retain completed cells and terminal failure metadata. A time/resource stop is incomplete evidence, not permission for a changed method. No unbounded exact Fraction accumulation of2000 mutually different denominators is required; exact integers handle counts/conversions, directed intervals handle the statistical functionals.

Report: all input/source/runtime hashes; lattice and reduction-proof checks; packing assumption; each cell/mode's exact count/censor support; stored-box versus widened-box μ/SD/z; signed CGM endpoints/status; width of each enclosure; exact-zero/positive/not-certified branch distinctions; whether original point summaries lie inside as an ancillary check; and explicit original-RNG/nonattainability/semantic-target limitations. No full power, leave-top, percentile interval, PartB, actual-market CI or promotion certificate is implied. If the upstream proof fails, say **stored-box only**; if arithmetic/budget fails, preserve **incomplete**; if intervals cross a relevant branch, say **not certified**, not “fixed.”

## Source roots

`reconstruct_r164_loss_matrices.py` and `audit_r164_bootstrap_sensitivities.py` are in `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/`. `r164_score.py` is in `/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts/`. Only those source bytes were read for this design. No matrix or original prediction arrays were opened.

## 9. Driver SPEC to freeze before payload (final target contract)

This section makes BOTH SD enclosures mandatory, not an optional data-dependent choice. It supersedes the optional language about selecting whether to use norm perturbation above. Core `b7e5c10c…` is **not admitted**: a separate refuter found mixed-sequence integer coercion before exactness checking. Fixed source and nested mixed-integer regression tests must receive new hashes and review before any payload. My prior10,760 float-endpoint checks do not cover that constructor failure and are not general clearance of that version.

### Target and draw manifest

| Fixed target | O65 group ordinal | comparison index | S,B |
|---|---:|---:|---:|
| 1d rec12−fH all | T24_G0,0 | 0 |127,29|
| 30d rec12−fH all | T720_G0,12 |0|127,29|
| 30d recb12−fH all | T720_G0,12 |5|127,29|
| 7d rec12−fH deep | T168_G3,11 |0|127,29|

These dimensions/order were read from existing JSON metadata only. Verify actual matrix geometry against them after admission; no guessed B≈17. Exactly2000 draws per mode; generate a group’s base ws/wb once and reuse it for its comparisons/domains. The three modes are combined,(ws,wb); cluster_only,(ws,ones); calendar_only,(ones,wb). Compare **float64 serialization** hashes with the accepted O65 result, while checking integer weights exactly:

- T24_G0 ws `3b9ba92b844630c6ddf934f59a45056a0718bc19d90eb53e54fa53f2ae825c1a`, wb `b1654df8cff4943cf4e2b7985b3f9616e259faf27aaf8a3e106a6e76be514ad3`.
- T168_G3 ws `0d5fbc928096e5dffa324025b316028d70432671c3d05a2eacedb9528283d676`, wb `1cb46401b652ca7aa86ec3f5a27bc5966c8531f8558b3d2ab9cb6bcc96b8ac7b`.
- T720_G0 ws `a14ff7c722888a4a527dd65cdbfe2528b045ffc26f1530f6a0bb7409547a3120`, wb `4abdaf75b1e714ba015ecbfdb1f6dc499403e7e67b0d1fca9d8ee2eb1a94499f`.

### Two domains, no implicit claim merging

Always emit `literal_stored_endpoint_box` and `conditional_packing_aggregation_box`. In the second, use exact `reduction_error(n)=n*(n−1)/(2^53−n+1)` and certified rational conversion to subtract/add it outward from stored Lo/Hi. n0 is exactly zero. Do not mutate the stored arrays, make a nominal-epsilon substitute, or pretend the second proves packing lineage. Do not silently emit the second domain if half geometry, lattice proof, reduction graph or runtime premises fail; emit its explicit unavailable reason. First-domain results remain mathematical stored-box claims only. Both domains have four mean records,12 bootstrap SD/z records and four signed CGM variance/z records: eight means,24 SD/z and eight CGM in a completed report.

No literal original np.std/einsum pipeline is certified. Original point values are ancillary records only; tiny outside-enclosure discrepancies cannot be used to pad a mathematically proved point interval. They must be labeled historical machine-roundoff versus exact-real scope differences until a separate operation ledger exists.

### Mandatory SD implementation order

For each cell/domain/mode: get exact integer denominator mask, then all outward replicate-mean intervals. Choose each midpoint with a finite safe expression and clamp it to its own bounds if necessary; this is an arbitrary fixed center, not a learned parameter. Choose the scalar fixed-center c from those finite midpoints. Always calculate:

1. centered-identity SD interval using the tested primitive;
2. norm-perturbation SD interval, including directed `rho_hi=max((I(mid)−I(lo)).hi,(I(hi)−I(mid)).hi)` and a certified centered midpoint norm;
3. their intersection, using max of lower endpoints/min of upper endpoints. Empty intersection is a proof/program failure, never a choice of whichever interval looks favorable.

Retain both component intervals and their intersection in output. Norm lower and upper arithmetic itself uses interval operations; do not subtract/divide its float endpoints in ordinary arithmetic and call the result directed. If a structural exact-constant proof applies, preserve SD[0,0] rather than a spurious positive bound. No precision/center/bound choice based on payload outcomes.

For each final SD interval report **signed z=+μ/SD** and **favorable z=−μ/SD**. Favorable is exact interval negation/swapped endpoints of signed, not a second independently rounded point estimate. CGM is calculated once per target/domain, not once per bootstrap mode; preserve the signed variance interval, both raw/direct and perturbation bounds if used, and their intersection under a fixed predeclared policy. Do not clip CGM to nonnegative.

Suggested domain statuses: `strictly_positive_denominator_certified`, `zero_denominator_certified`, `nonpositive_CGM_certified`, `undefined_branch_not_excluded`, `insufficient_valid_replicates`, `arithmetic_or_proof_failure`. An interval touching zero does not prove an attainable zero under the original shared row constraints. For extended defined-branch z use explicit lower/upper-unbounded flags; null values alone must not conflate an undefined entire domain with an infinite closure. Preserve zero/censored counts and no-redraw policy.

### Source/runtime/native addition contract

The new request must pin by exact path,size,SHA256: fixed interval core and tests; `endpoint_arithmetic_check.py` and tests; driver and tests; this approved design projection; outer monitor and independent verifier if any; original reconstruction source/metadata/admission/matrix/request/monitor; accepted O65 source/request/result and original score source; runtime proof and its native pin list. Newly written files are **source additions**, not edits to any immutable old artifact. Endpoint helper as received is8084bytes/SHA256 `14f7e638844237bdf2fce556a9cfa567e8f14dc882192073c464dec55ae3b3f3`, tests2045bytes/SHA256 `ae54a055e92a043f6880534b73bc5b7f5f93d2a7c0ea4940e1c84a96de3ab1e2`; parent must independently review those actual bytes before freezing them. No stale b7e5 core hash may remain in a READY request.

No package install, native-library addition/removal, NumPy upgrade, Torch/SciPy import or new raw-data path is required. Reauthenticate the accepted runtime/native closure; record any mismatch as an admission failure, not a permitted dependency refresh. Freeze canonical/resolved interpreter path, invocation path, sys.prefix, complete Python version, NumPy version and platform. Existing O65 metadata uses resolved executable `/Users/EBmic/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12` with prefix `/Users/EBmic/research-workspaces/history-forecasts-recovery-runtime`, Python3.12.14/NumPy2.5.4. Do not confuse a venv invocation symlink string with the historical resolved path; record and compare both deliberately. One-thread environment and no-bytecode policy remain fixed.

### Admission and terminal checks

Before loading the matrix: refuse DRAFT, authenticate request/source/runtime/native identities, original metadata graph and all half-field geometry; run the exact synthetic primitive/endpoint/proof self-checks. Require no unresolved input-coercion bug. Matrix read is only the accepted5.25MB payload, with exact96-key closure/count geometry and selected group/comparison mapping; no raw130-row packet is automatically authorized. Rehash all frozen inputs and new sources at terminal state. Resource-only cap120s/1GB/2GiB applies to full process via parent outer guard; errors preserve partial aggregates and resource/source receipts. No automatic fallback to a new precision/seed/mode or a second run. Parent independently reviews all completed records before any statistical/inference claim changes.

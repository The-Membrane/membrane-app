# R16.4 precision/provenance input audit — read-only

**Finding:** existing MdLo/MdHi are ordinary float64 endpoint-loss sums, not demonstrated outward-rounded enclosures. A rigorous certificate over the literal stored cell boxes is a different claim from a certificate covering the lost float32 predictions. The latter still needs an aggregation-roundoff argument and the explicitly unproved nearest float32→float16 packing premise. No NPZ arrays were opened in this audit.

Local shorthand: E=`/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence`; S=`/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts`. All references below are actual source lines or selected JSON metadata, not new data-array inspection.

## Four fixed targets and matrix schema

| Requested cell | Matrix group | Comparison plane | Empirical group ordinal | Common seed | Rows / S / B |
|---|---|---:|---:|---|---|
|1d rec12 versus fH, all|T24_G0|0|0|SeedSequence([20261641,0])|585420 /127 /29|
|30d rec12 versus fH, all|T720_G0|0|12|SeedSequence([20261641,12])|578190 /127 /29|
|30d recb12 versus fH, all|T720_G0|5|12|SeedSequence([20261641,12])|578190 /127 /29|
|7d rec12 versus fH, deep|T168_G3|0|11|SeedSequence([20261641,11])|175719 /127 /29|

These dimensions/counts come from accepted reconstruction JSON, not freshly opened matrix members. Groups are all16 horizon×band combinations, with horizons24/72/168/720 and band order all/shallow/mid/deep. “All” contains10 threshold indices. Deep is k=7,8,9. Each group has six members: `<group>_Md`, `_MdLo`, `_MdHi` float64 `(12,S,B)`; `_Mn` int64 `(S,B)`; `_SIDs` int64 `(S,)`; `_BIDs` int64 `(B,)`. Total96keys. Comparison order fixes rec12/fH at0 and recb12/fH at5. Source: E/reconstruct_r164_loss_matrices.py:18–24, :126–149, :220–224; E/audit_r164_bootstrap_sensitivities.py:52–63.

Input packet is130 series NPZs plus two JSON artifacts,132 pinned restored files. The parent admission binds retrieval request/receipt/monitor and immutable private dataset commit `a8d2594e68faa44ad4376de24d21c6c8c20c4e5f`. Each series has scalar string name and aligned day/T_h/k_i/y/p_model arrays. One recorded header example has day<i8,T_h<i2,k_i|i1,y<f8 and main predictions<f2. Binary labels are validated, and common support requires finite predictions from all7models. Actual expected main dtype is frozen<f2, not a generic float32 path. Source: E/reconstruct_r164_loss_matrices.py:110–134, :187–206. No full132-file manifest or row names are reproduced here.

Major ETH/BTC venue rows collapse to shared major clusters. Otherwise each series is its own cluster, giving127 clusters. Calendar IDs are `(day−17532)//182`, shared across assets,29 blocks in the selected groups. This is not a per-asset block resample. Source: S/r164_score.py:23–28, :31–67; E/reconstruct_r164_loss_matrices.py:21, :116, :126.

## Exact draws and statistic being bounded

The accepted empirical sensitivity uses2000 draws per group. Generate one PCG64 default_rng from `SeedSequence([20261641,ordinal])`; draw multinomial127 cluster-count vectors first, then multinomial29 calendar-count vectors, both cast float64. The same draws serve all12 comparisons and all three modes. Combined uses both weight arrays; calendar-only sets cluster weights to ones. The two30d targets must share exactly the same arrays, not regenerate with a comparison-specific seed. Verify regenerated ws/wb byte hashes against retained empirical JSON before claiming that draw design. Source: E/audit_r164_bootstrap_sensitivities.py:65–84.

For cell-sum vector D and exact count matrix N, each retained replicate is `m_r=sum(ws_r D wb_r)/sum(ws_r N wb_r)`. SD is sampleSD(ddof=1) over positive-denominator draws, and favorable z is `−mean_d/SD`, where `mean_d=sum(D)/sum(N)` is the observed mean, not the bootstrap mean. All2000 denominators are positive for these four recorded targets; no redraw occurred. Zero-denominator behavior must still remain explicit in a certificate. Source: E/audit_r164_bootstrap_sensitivities.py:68–84.

Selected ordinary-float empirical metadata, not precision certificates:

|Target|Stored-point mean_d|Combined SD|Favorable z|
|---|---:|---:|---:|
|1d rec12/fH all|−0.00005184154161|0.0001867837793|0.2775484|
|30d rec12/fH all|0.0001946615236|0.0010943819414|−0.1778735|
|30d recb12/fH all|0.0008005487663|0.0011568911367|−0.6919828|
|7d rec12/fH deep|0.0003975702456|0.0002553584976|−1.5569102|

This common per-group draw design is **not** the original scorer's global RNG replay. Original `score` initializes one RNG and consumes it sequentially across horizons, comparisons, optional28-day calls, and band calls (bands use1000 draws, whole horizon2000). Source: S/r164_score.py:123–164. Preserve the declared empirical design instead of describing these new sensitivity draws as the historical exact sequence.

`r164_power.part_a` negates stored z, projects it by sqrt(new-block-ratio), and applies normal-CDF formulas. A precision certificate for these four statistics does not validate that extrapolation/power model or revise a gate. Source: S/r164_power.py:32–46. CGM z is a different formula from bootstrap-SD z and requires a separate certificate if requested; do not silently substitute it (S/r164_score.py:86–93).

## Why stored endpoints are not already rigorous

1. Probability envelopes are closed adjacent-float16 midpoint intervals, clamped0..1. Their preimage interpretation is conditional on ordinary nearest packing of the lost original float32 predictions. The request explicitly says that packing transform was not independently proved. Summary compatibility is not recovery of original floats. Source: E/reconstruct_r164_loss_matrices.py:49–55; E/r164-original-loss-matrix-request-v2.json `precision`; E/parent-r164-original-matrix-admission-v1.json `limitations`.
2. Loss endpoints use ordinary NumPy `(1−p)**2`/`p**2`. Endpoint differences are fed to float64 `np.bincount`, then accumulated with ordinary `+=`; bands/all are ordinary floating merges. No rounding direction, interval arithmetic or error ledger is retained. Source: E/reconstruct_r164_loss_matrices.py:57–58, :80–98, :135–149.
3. `guard=64*eps*max(1,abs(value))` is a tolerance in compatibility/conservation checks, not a proof that a stored lower endpoint is below the mathematical lower sum. The parent admission records maximum absolute cell-sum roundoff2.362554596402333e−13 and agreement at1e−12. That verifies close ordinary arithmetic, not one-sided enclosure. Source: E/reconstruct_r164_loss_matrices.py:64–74, :145–148; admission JSON.
4. Taking SD of MdLo and SD of MdHi cannot bound all interior SDs: sample variance is nonmonotone in the cell sums. Neither the mean envelope nor a small observed arithmetic residual supplies an SD/z bound. The existing empirical metadata explicitly sets `quantization_envelope_is_SD_bound=false` (E/audit_r164_bootstrap_sensitivities.py:80–84).

## Can final Mn support a proved aggregation-error widening?

**At the Python algorithm level, yes, conditionally on the native arithmetic contract.** Each common row contributes once to one horizon/threshold leaf. Each band merges disjoint threshold sets; all merges disjoint bands. Same major-cluster aggregation across different series also combines disjoint rows. Thus one final comparison/cell has n=Mn exact row leaves, a summation tree with at most n−1 nonzero binary additions and depth at most n−1. Additions of initial zero are exact. Source: E/reconstruct_r164_loss_matrices.py:80–98, :126–138, :141–144. No row is duplicated by these merges.

For this actual<f2 path, all clamped midpoint probabilities lie on the2^−25 grid. Complements lie on that grid. Squared endpoint losses and differences are integers times2^−50 of magnitude at most1, with at most51 significant bits; mathematically they are exactly representable float64. Midpoint addition/halving is also exactly representable. The singleton<f4 test path does not inherit this argument and must not be mixed into the actual-packet proof.

Remaining native proof obligations: establish that `**2` returns those exact representable squared results and `np.bincount(weights=float64)` is a finite binary64-addition reduction without unaccounted operations, in the pinned runtime/binary. A bounded exhaustive synthetic check of all15361 nonnegative float16 patterns≤1 and both labels can verify the finite endpoint arithmetic against integer/rational values without opening market inputs. Native source/build semantics must justify the reduction-tree assumption. These checks have **not** been executed by this audit.

With exact row leaves and ordinary round-to-nearest binary64 addition proved, use unit roundoff `u=2^−53`, not finfo.eps. A conservative bound is

`E(n)=n*gamma_(n−1)=n*(n−1)/(2^53−(n−1))`, provided n−1<2^53.

Then mathematical aggregate endpoint sums lie above `storedMdLo−E(n)` and below `storedMdHi+E(n)`. Compute E as an exact rational and convert widened endpoints outward. This is a derived worst-case summation-tree error bound, not a nominal epsilon pad. It avoids reopening raw rows **if** the dtype/leaf/native-tree premises and exact Mn linkage are established. It can be conservative because it ignores actual cancellation and row magnitudes.

If any premise cannot be proved, the clean minimal repair is a separately admitted bounded reconstruction of just these four cells from the already-restored rows: accumulate dyadic endpoint-loss differences as exact Python integers in2^−50 units, then convert rational sums outward. Do not alter existing matrices or historical evidence. Plain “one nextafter” on the already-rounded aggregates without an error argument is insufficient.

## What the small matrix can and cannot certify

- **Literal declared-box claim:** take the stored [MdLo,MdHi] float64 endpoints as the *definition* of arbitrary cell-sum boxes. With exact counts, fixed authenticated draws and rigorous downstream arithmetic, the matrix is sufficient to certify SD/z over that explicitly artificial domain. It does not prove the true unpersisted float32 row aggregates belong to it.
- **Underlying-prediction claim:** first prove/widen aggregation bounds as above, and explicitly retain the nearest-packing assumption. The resulting cell box is an outer relaxation: dependencies among rows, comparisons, thresholds and common model parameters may make corners jointly unattainable. Certifying an outer relaxation is conservative; it does not identify which lost float32 array occurred.
- **Original-packing claim:** remains unproved. None of the5.25MB matrix, metadata checks or matching published summaries establishes the original packing transformation or recovers original floats. A rigorous calculation must be labeled conditional on that premise. No original model rerun is authorized here.

## Mathematical Brier versus the original floating score function

`r164_score.load_rows` normally retains stored prediction dtype when concatenating complete columns (`S/r164_score.py:45–63`). The score function then explicitly casts both labels (`:131`) and every selected model probability (`:136`) to NumPy `float`, i.e. binary64 in this pinned runtime, before forming `(P−y)**2` at `:137` and loss differences at `:154`. This is not a float32-loss calculation merely because the lost prediction inputs were float32. The matrix reconstruction also casts common labels/probabilities tofloat64 (`E/reconstruct_r164_loss_matrices.py:123–125`).

Nevertheless, **exact-real Brier values of possible original float32 predictions are not automatically equal to the original score function's floating outputs**. Binary64 complement/subtraction, power2, comparison subtraction, cell reduction, weighted numerator/denominator division, std and z division each need a justified rounding treatment if the certificate claims to enclose the historical machine statistic. The endpoint2^-50 exactness argument establishes finite endpoint terms, not every interior lost-float computation or the final score's execution arithmetic.

Keep three distinct labels: (1) literal stored-cell-box mathematical sensitivity, (2) exact-real Brier statistic over possible float32 prediction preimages, conditional on packing and valid aggregate envelopes, and (3) original floating score arithmetic, conditional on the same premises plus a validated operation/rounding ledger and the intended draw schedule. A proof of(2) alone must not be promoted to(3), especially near cancellation. Retain the original replay hold. A conservative per-row floating-loss error bound could be added before aggregation, or the monotone correctly-rounded loss computation could be bounded directly; neither is already proved by the existing matrix. The new per-group draw design still is not the original global RNG schedule.

## Minimal downstream certificate after upstream domain is valid

Freeze the four targets, combined and calendar-only modes, existing2000 draws, seeds and hashes. Counts/weights give exact positive integer denominators. Propagate valid cell intervals through nonnegative weighted sums and rational division with directed arithmetic to get per-replicate intervals and an observed-mean interval. Include floating evaluation error, rather than trusting einsum/std on endpoints.

For a simple safe SD bound, let c_r be interval centers and e_r their radii. Projection onto centered replicate vectors is a contraction, so

`abs(SD(m)−SD(c)) <= ||e||_2/sqrt(R−1)`.

Enclose SD(c) and that norm rigorously, clamp the lower SD at0, and combine with the observed-mean interval. If SDlower>0, bound favorable z=−mean/SD by the appropriate interval-ratio extrema. If SDlower=0, report unresolved/unbounded instead of inserting epsilon or declaring a result. This may be loose; it is a certificate over the chosen valid relaxation, not a new inferential confidence interval. Do not optimize, tighten or change the domain after observing a favorable result without a new prespecified method.

## Resource/provenance closure and status

Matrix artifact metadata:5248072bytes, SHA256 `21a0e7e3c4bb9feb36719c81820e3ce9aa6bb74bea1bfebc6a189da67d022523`. Reconstruction request74633bytes SHA `7d10b3ab73fd0581d2c922425c6037d3b94cb221eee8ed02cce5ca576d32d13d`; reconstruction423717bytes SHA `1b7dbd64ac66a55221dde5620f820f85f3fc8cf444a3e45b487e8625347e1092`; parent admission2136bytes SHA `ba97731bae8518143c25a267f8186aa8608080e0ae2c0fdf19647dd341e96df8`. Metadata identifies the matrix; this audit did not open or rehash its bytes.

Actual reconstruction source18636bytes SHA `374c612fed1a4a053129472041ffd8874fb9f87d6769836dbbfc111879386cf5`; original scorer source SHA `151b6eb0c3f8543fe6b4e11c560407eacac3ce4780ce7068f9609c5e86055142`. Accepted empirical result956171bytes SHA `ff84cb0631c5b813fda397045ab1bb89ef793911a00fb1bdf7b6c41319c473e4`. Only source/JSON artifacts were byte-hashed in this audit.

Both reconstruction and accepted empirical requests freeze1GB RSS,300seconds and2000000000-byte free reserve. Reconstruction output cap10MB; empirical output cap5MB. These are historical decimal-byte policies, not an inferred2GiB rule. Reconstruction reports4.23296seconds/152911872-byte peak; parent admission's separate check reports3.19074seconds/216973312-byte peak; empirical run reports0.51036seconds/86360064-byte peak. Future rigorous work needs its own parent-reviewed resource/request/source/runtime pins. Existing source/test/runtime/restore/monitor closure is available through those metadata artifacts without publishing the132-file manifest.

No arrays opened, bootstrap rerun, interval certificate computed, model fit, Board edit or evidence mutation occurred. Only `/private/tmp/q26-precision-input-audit.md` was written.

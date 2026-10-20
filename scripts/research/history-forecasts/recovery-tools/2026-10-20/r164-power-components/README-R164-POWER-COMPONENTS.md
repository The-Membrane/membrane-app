# R16.4 known-law component audit — CODEX CONTINUATION

This is a mathematical validation of unchanged r164_power.py summary components.
It is not an empirical R16.4 variance decomposition, forecast revision, reserve
experiment, market-power estimate, model/gate change or new test of forecasting skill.
No market inputs, outcomes or prediction payloads are admitted.

Part B retains all 99 cases: eleven coverage-mean/known-SE combinations crossed
with three width medians and three correlations. C_hat is an unbounded Gaussian
summary proxy, not literal finite Bernoulli coverage. Width_hat is lognormal.
Coverage means .84/.85/.95/.96 are null; only .90 is interior alternative. Boundary
classification uses declared parameter positions, not floating absolute-difference
comparisons. The .90/.04 SE control is alternative with an empty TOST acceptance set.
Width at population median10 passes the original deterministic gate, but a random
width summary at that median passes with probability.5. No stochastic width-test
or CGM/width-bootstrap behavior is invented from the original source header.
Original zero-SE c=.95 accepts because binary subtraction is slightly below.05;
this source behavior is preserved and tested. Main grid SEs are strictly positive.

Each case uses200000 independent worlds with SeedSequence([20261020,case_id]).
Exact Gaussian coverage and width marginals plus two independent one-dimensional
quadratures authenticate the joint reference. rho0 additionally checks the product.
World-level Clopper-Pearson95% intervals and MCSE are pointwise, not simultaneous
or cross-case-independent inference. The predeclared discrepancy diagnostic is
6*sqrt(p_ref*(1-p_ref)/N)+1/N. It is not a model-performance gate or outcome selection.
All null acceptance rates and alternative acceptance/power rates remain separate.
Classification pertains to coverage equivalence; width is a noisy gate, not an
independently registered hypothesis test in this synthetic experiment.

Part A enumerates all6912 independent bootstrap draw tuples in a balanced4×3
additive example, comparing combined, time-only and series-only population SDs.
Actual original Part A is called on each known-z fixture. This counterexample
shows why a combined plug-in is not a time-only ceiling; it does not measure the
original historical components. Original paired-loss availability is a separate
recovery question and is neither invented nor answered by these synthetic laws.

The request pins current implementation/tests/README, unchanged source, existing
fresh-runtime proof identity and current Python/NumPy/SciPy versions. Runtime proof
is a provenance input, not a claim that old missing receipts have been restored.
The helper permits runtime resources, exact pinned source/metadata and a fresh
run working directory. Network/subprocess events and other file reads are denied.
Fixtures and aggregate result remain within that fresh directory. It imports no
Torch and emits no per-world arrays. External parent monitoring remains required.

Policy:1GB RSS,2GB free disk,180seconds,2MB aggregate fixtures/output. Parent must
read code/tests/request, run independent meaningful tests and fresh refutation,
then authorize the monitored CLI. Only small-N synthetic tests run before review.
No historical full benchmark has been run at preparation.

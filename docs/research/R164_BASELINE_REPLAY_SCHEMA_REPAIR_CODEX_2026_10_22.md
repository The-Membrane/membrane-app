# R16.4 baseline replay schema repair — CODEX CONTINUATION

The first declared replay attempt failed after11.822588 seconds, charged12 seconds. The failure was a producer KeyError before any NPZ load, pool reconstruction or simulation. No saved-output checker ran. This was an instrumentation failure, not a model result.

The accepted O144 historical envelopes contain derived_provenance and result. Each result contains only quarter_fits and rows. Every retained row carries its mandatory series identity. The replay producer incorrectly required a result-level series header. The original synthetic fixtures supplied that invented header, concealing the mismatch. The checker also accepted absent row identity through a fallback. Both assumptions are repaired.

Identity now binds the authenticated historical filename to the selected key, the accepted saved state and every historical row. Result-level and envelope-level series headers are optional. Any supplied header must agree. Missing or contradictory row identities fail. Producer authentication validates this historical metadata before numerical execution. The independent checker uses the same explicit identity contract without importing producer helpers or filling absent row identity.

Synthetic fixtures now use the genuine headerless envelope/result structure with entirely synthetic values. They cover matching optional headers, contradictory headers, missing row series and wrong row series. The complete42-series/806-quarter/2619-origin/104310-row fixture passes through the actual producer output/marker/manifest serialization and independent checker. Only numerical replay and input loading are synthetic seams. Separate fixtures retain the exact kernel argument and one-ULP rejection checks.

Historical input bytes, retained probabilities, original numerical sources, model parameters, seeds, paths, full horizons and exact native-float equality remain unchanged. No fitting, actual private-array reads, numerical jobs, new plan freeze or automatic retry is included in this repair.

The original numerical phase is CLOSED12/1380. Its1368 unused seconds are not reused. A repaired-source attempt requires separate source qualification, independent review, a new frozen plan and an exclusive new output directory. A proposed fresh1200-second producer plus180-second checker allocation totals1380 seconds. This proposal is not permission to launch a job. Original blind A/B remain NOT RUN.

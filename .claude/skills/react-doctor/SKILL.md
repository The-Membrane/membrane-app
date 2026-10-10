---
name: react-doctor
description: Use when finishing a feature, fixing a bug, before committing React code, or when the user types `/doctor`, asks to scan, triage, or clean up React diagnostics. Covers lint, accessibility, bundle size, architecture. Includes a regression check, a full local-triage workflow that fetches the canonical playbook, and a list of anti-patterns to avoid reintroducing.
version: "1.5.0"
---

# React Doctor

Scans React codebases for security, performance, correctness, and architecture issues. Outputs a 0–100 health score.

## Do NOT reintroduce these — the anti-patterns this codebase keeps hitting

Fixing findings after the fact is reactive; the real win is not writing them. When you add or edit React code in this repo, avoid the following. Each maps to an **error-severity** rule that has already bitten this codebase, and each has an in-repo fix pattern — reuse it instead of rolling your own.

**Rules of Hooks (`rules-of-hooks`) — the #1 offender (was 41 findings).** Every render must hit the same hook calls in the same order.
- No early `return` (a spinner / `null` guard / `if (!x) return …`) **above** hook calls. Call ALL hooks first, then put the guard after them. (`if (!router.isReady) return <Spinner/>` before the data hooks is the classic bug.)
- No hooks inside `.map` / `.forEach` / loops. Extract a child component so each item owns its hook (see `components/Racing/MintCarConfirmButton.tsx` + the `renderOptionAction` render-prop pattern).
- No hooks inside a react-query `queryFn`, a `useMemo`, an event handler, or any async/callback. Call the hook at top level and pass the value in.
- A function that calls hooks **is a hook** — name it `useX`, not `getX`/`fetchX`, and only call it at component/hook top level. "Service" helpers that fetch via hooks belong in `hooks/`, named `use*` (e.g. `useMarketName`, `useCLPositionsForVault`).

**No `eval` / `new Function` (`no-eval`, Security).** For the Ditto `when`/`condition` DSL use `evaluateExpression` from `components/DittoSpeechBox/utils/expressionEvaluator.ts` (a safe recursive-descent evaluator — do not reach back for `new Function`). To build a string, use a template literal, never `eval('\`' + … + '\`')`.

**No secrets behind `NEXT_PUBLIC_` (`artifact-env-leak`, Security).** `NEXT_PUBLIC_*` is bundled into every browser download. Keep secrets in an unprefixed, server-only env var read only in an API route / server component (pattern: `pages/api/feedback.ts` + `helpers/submitFeedbackToGithub.ts`). Never name a public var `*TOKEN*`/`*SECRET*`/`*KEY*`.

**Heavy libs load on demand (`prefer-dynamic-import`).** Import `recharts` via the `lazyChart` helper (`components/ui/lazyChart.tsx`) — never a static top-level `import … from 'recharts'` (not even type-only; use the helper's exported `RechartsModule` type). Build the whole chart subtree inside the factory (recharts resolves axes/tooltips by component identity).

**Components ≤300 lines (`no-giant-component`).** Extract logical sections into focused subcomponents and lift data/effects into `use*` hooks in a `hooks/` subfolder. Behavior-preserving extraction only — no restyle/redesign while splitting.

**Effects clean up (`effect-needs-cleanup`).** Any `useEffect` that starts a timer / interval / event listener / subscription / animation loop MUST `return` a cleanup that tears it down.

**Guard browser globals (`no-unguarded-browser-global-in-render-or-hook-init`).** `window` / `document` / `new Image()` touched during render or hook initialization crash SSR/hydration. Access them inside `useEffect`, or guard with `typeof window !== 'undefined'`.

**Effect/callback dependencies (`exhaustive-deps`) — memoize FIRST, and never ship a possible infinite loop.** This is the largest bucket and the only one a build/tsc cannot catch — a wrong "fix" here is a runtime infinite loop, not a compile error. Rules, in order:
- **Classify every missing dep before adding it.** *Stable* (a primitive value, a `useState`/zustand setter, react-query `data`) → add it raw, it's loop-safe. *Unstable* (a function or object/array rebuilt every render) → you MUST wrap it at its source in `useCallback`/`useMemo` **before** adding it; adding an unstable dep raw re-runs the effect every render → infinite loop.
- **Err toward LEFT (omit) for animation / rAF / `ticker` / `setTimeout` / self-referential (effect writes state it also depends on) effects.** Forcing deps there causes visible loops. When you deliberately omit, leave a one-line comment explaining why — **never** an `eslint-disable`. (In-repo examples: `RaceCampaignSync.ts`, `PipesCanvas.tsx`, `useRaceAnimation.ts`.)
- **A dep-array add can surface a *type* error in this EVM-migration repo.** If the value you add reads a field that the type never declared (e.g. `metrics?.dailyRevenue`, `portState.lastVisitTime`), tsc flags TS2339 — the field was feature code written against a stale type. Fix the **type at its source** (declare `lastVisitTime: number | null` on `PortState`, `dailyRevenue?: number` on `PortMetrics`), don't drop the dep or blind-cast to `any`. Adding the dep is correct; the type was the bug.

**Interactive elements are real buttons; don't mutate refs in render.** Two fixes that spawn NEW findings if done naively:
- An element with `onClick` should be a real button — `<Box as="button" type="button">` or `<Button>` — NOT a `<div>`/`<Box>` with `role="button"` + `tabIndex` + a manual `onKeyDown`. A real button gets Enter/Space for free and clears `no-static-element-interactions`, `click-events-have-key-events`, AND `prefer-tag-over-role` in one shot. (The `role="button"` workaround clears the first two but trips `prefer-tag-over-role`.)
- A "latest-value ref" must be updated in a `useEffect`, never `ref.current = value` in the render body (`no-ref-current-in-render`) — mutating a ref during render breaks StrictMode/concurrent rendering. Pattern: `const r = useRef(v); useEffect(() => { r.current = v }, [v])`; consumer callbacks run post-commit, so they still read fresh values.

**Framer-motion: use `m` under LazyMotion, never `motion` (`use-lazy-motion`).** `pages/_app.tsx` already wraps the app in `<LazyMotion features={…domMax} strict={false}>`. Import `m` from `framer-motion` and write `<m.div>` / `m(Box)` — never `import { motion }` / `<motion.div>` (that pulls the full animation engine into the initial bundle). `AnimatePresence`, `MotionConfig`, and the motion hooks (`useMotionValue`, `useSpring`, `useTransform`, …) stay imported and used as-is.

## After making React code changes:

Run `npx react-doctor@latest --verbose --scope changed` and check the score did not regress.

If the score dropped, fix the regressions before committing.

## For general cleanup or code improvement:

Run `npx react-doctor@latest --verbose` (the default `--scope full`) to scan the full codebase. Fix issues by severity — errors first, then warnings.

## /doctor — full local triage workflow

When the user types `/doctor`, says "run react doctor", or asks for a full triage / cleanup pass (not just a regression check), fetch the canonical local-triage playbook and follow every step in it:

```bash
curl --fail --silent --show-error \
  --header 'Cache-Control: no-cache' \
  https://www.react.doctor/prompts/react-doctor-agent.md
```

The playbook is the single source of truth — a scan → filter → triage → fix → validate loop that edits the working tree directly (never commits, never opens PRs). Updating the prompt at its source updates every agent on its next fetch — no skill reinstall needed.

Pair it with the matching per-rule prompts at `https://www.react.doctor/prompts/rules/<plugin>/<rule>.md` (fetched on demand inside the playbook) so each fix uses the canonical, reviewer-tested recipe.

## Configuring or explaining rules

When the user wants to understand a rule, disagrees with one, or wants to disable / tune which rules run (not fix code), read [references/explain.md](references/explain.md) and follow it. Start with `npx react-doctor@latest rules explain <rule>`, then apply the narrowest control via `npx react-doctor@latest rules disable|set|category|ignore-tag …`, which edits your `doctor.config.*` (or `package.json#reactDoctor`).

## Command

```bash
npx react-doctor@latest --verbose --scope changed
```

| Flag              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `.`               | Scan current directory                                           |
| `--verbose`       | Show affected files and line numbers per rule                    |
| `--scope changed` | Only report issues introduced vs the base branch (default: full) |
| `--scope lines`   | Only report issues on the changed lines                          |
| `--score`         | Output only the numeric score                                    |

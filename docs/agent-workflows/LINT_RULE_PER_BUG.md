# A lint rule after each bug

Prose rules get skimmed; lint rules run on every change. Rules live in `eslint-rules/` (one
file per rule, CommonJS, no deps beyond eslint), config in `.eslintrc.factory.json`, and
the ratchet is `pnpm lint:factory` (`scripts/ci/factory-lint.sh`) against
`.ci/factory-lint-baseline.json`.

## The loop

1. **Fix the bug** as usual.
2. **Ask: could software have caught it?** If the bug has a syntactic shape (a copied type, a
   banned literal, a call in the wrong place), it gets a rule. If it needs runtime or type
   facts, write a test instead. A rule with precision below 0.8 is worse than none.
3. **Write the RuleTester case first.** In `eslint-rules/__tests__/<rule>.test.js` add the
   buggy code *as found* (cite the file:line or commit) as an `invalid` case and the fix as
   a `valid` case. Run `node eslint-rules/__tests__/run.js`; it must fail before the rule exists.
4. **Write the rule** `eslint-rules/<rule>.js`; cite the source (CLAUDE.md line or fix commit)
   in its header. Shared helpers go in `eslint-rules/lib/` (`--rulesdir` loads every top-level
   `.js` as a rule). Enable it in `.eslintrc.factory.json`.
5. **Run the ratchet** `pnpm lint:factory`. A new rule is missing from the baseline, so it
   starts at 0 and the run FAILS with today's count. Sample ~10 hits; if precision < 0.8,
   tighten the rule. Then record the count in `.ci/factory-lint-baseline.json`.
6. **Lower the baseline** whenever the script says `lower baseline to N`, in the same PR.
   Numbers only move down. Never raise one to make CI green; fix the new violation, or use
   `// eslint-disable-next-line <rule> -- <reason>` for a reviewed exception.

Without repo `node_modules`, point the script at any eslint 8 install:
`ESLINT_BIN=/path/node_modules/.bin/eslint bash scripts/ci/factory-lint.sh`
(it needs `eslint@8.57` + `@typescript-eslint/parser@8` side by side).

## Wiring into CI

There is no `.github/workflows/ci.yml` at the time of writing (only `docker-image.yml`).
Add this job (or just its last two steps to an existing job that has run `pnpm install`):

```yaml
  factory-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Factory lint rule tests
        run: node eslint-rules/__tests__/run.js
      - name: Factory lint ratchet
        run: pnpm lint:factory
```

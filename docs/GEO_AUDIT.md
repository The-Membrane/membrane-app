# GEO Audit - Public EVM Pages (evm-migration)

Date: 2026-09-05. Method: the `geo` skill (~/.claude/skills/geo), built from the top-20
GEO YouTube corpus + the is-agentic.com/Ora rubric. Two passes: static repo analysis and
runtime curl checks against the dev server (no JS execution, like ChatGPT's crawler).
Findings carry the consensus weight of the tactic they violate (N/19 videos).

## Verdict

The app's strongest GEO asset is already live: provenance-stamped first-party numbers on
the root and landing pages ("2,350 accounts... Aave closed a median 71% vs Membrane's
17.8%", "1,245 real carry positions measured on-chain"). Proprietary data is the
top-weighted citability signal (8/19 videos, Princeton GEO paper: up to +40% visibility).
The problem: that asset sits on pages with zero H1, the flagship borrow page is
deliberately noindexed, and every invalid URL returns a silent 200 - so crawlers either
cannot find the good content or cannot trust the site's structure.

## Scorecard (is-agentic/Ora rubric)

| Tier | Check | Result | Detail |
|---|---|---|---|
| Essential | Content without JS | PARTIAL | `/ethereum` 3,372 chars PASS; `/ethereum/borrow` 2,133 PASS; `/ethereum/stake` 437 FAIL (<500); invalid chain segments render empty 200 shells |
| Essential | Not blocked by bot detection | PASS | no middleware, no WAF rules in repo |
| Essential | Redirect hygiene | PASS | single 307 hop `/` -> `/ethereum` |
| Essential | Markdown negotiation | FAIL | `Accept: text/markdown` ignored (expected; low priority) |
| Essential | Agent crawler reachability | PASS | robots.txt `Allow: /`, no AI-bot blocks (GPTBot, ClaudeBot, PerplexityBot etc. all allowed) |
| Essential | Agent-friendly 404s | FAIL | unknown top-level paths 307-redirect to the homepage (200 soft-404); invalid `[chain]` segments return 200 empty body, client-JS redirects away ([ChainLayout.tsx:26-34](../components/ChainLayout.tsx)) |
| Recommended | Sitemap | PARTIAL | exists ([sitemap.xml.tsx](../pages/sitemap.xml.tsx)) but omits `/ethereum/borrow` and `/ethereum/home`, and still lists stake/transmuter which are out of nav |
| Recommended | JSON-LD | FAIL | none on any app page; only blog posts emit FAQPage ([blog/[slug].tsx:38-57](../pages/blog/[slug].tsx)) |
| Recommended | Agent instruction / llms.txt | FAIL | no llms.txt route; the catch-all chain redirect swallows `/llms.txt` into the homepage |
| Recommended | Metadata completeness | PARTIAL | title + description + og:type + lang OK everywhere tested; canonical and og:image missing at runtime - [Seo.tsx:14,31-33](../components/Seo.tsx) silently drops both when `NEXT_PUBLIC_SITE_URL` is unset; verify the production env var |
| Recommended | Organization schema | FAIL | absent |
| Recommended | Trust anchor pages | FAIL | no /privacy, no /contact; /ethereum/about is placeholder lore ("neural technology... consciousness"), zero real company/audit facts |
| Recommended | Token budget | PASS | ~80-110KB HTML per page, well within an agent context |

## Findings by GEO consensus weight

### Weight 8/19 - answer-first structure and classic SEO foundation

1. **Zero H1 on the pages that matter most.** `/ethereum` (root, indexable), `/ethereum/landing`
   ("the one indexable page" per its own comment), `/ethereum/borrow`, `/ethereum/mint`,
   `/ethereum/carry`, `/radar`, `/position`: 0 H1 each. The best first-party data in the app has
   no crawlable headline. Highest-leverage single fix.
2. **`/ethereum/borrow` is `seoClass="app"` = noindex,nofollow** ([borrow.tsx:10-12](../pages/[chain]/borrow.tsx))
   and missing from the sitemap - while [docs/SEO_RULESET.md](SEO_RULESET.md) itself lists borrow
   as the indexable example. The highest-intent product page is invisible by (accidental) design.
   Bottom-funnel pages are exactly what AI engines cite at the decision moment (4/19).
3. **Soft-404 everywhere.** Two mechanisms: (a) unknown top-level paths 307 to the homepage with
   200; (b) any invalid `:chain` segment server-renders an empty 200 body and repairs itself only
   via client JS. AI engines send ~2.87x more 404-bound traffic than Google (hallucinated URLs);
   both paths must return real 404s server-side.
4. **Rule-0 drift: most surviving pages ship unclassified.** stake, mint, transmuter, disco,
   about, home, terms, boost, portfolio, liquidate, dashboards - bare `<Seo>` or nothing, so no
   robots directive at all. Classify each per SEO_RULESET.md.
5. **Redirect bookkeeping broke on this branch.** Six routes deleted with no `redirects()` map
   (R3); [pages/manic.tsx](../pages/manic.tsx) still redirects into the deleted
   `[chain]/manic` (real 404); sitemap and nav disagree about stake/transmuter.

### Weight 8/19 - specifics and verifiable facts

6. **Strength to build on:** the counterfactual stats on `/ethereum` and the measured-positions
   framing on `/ethereum/landing` are exactly the "numbers nobody else has" asset. Give them
   heading structure (fix 1) and they become citable blocks.
7. **`/ethereum/stake` serves 437 chars of text and its lone H1 says "Governance".** Below the
   500-char essential bar; a JS-less crawler sees nothing about MBRN staking.
8. **Trust anchors are missing or fake.** No /privacy, no /contact, and the /about page is
   leftover lore copy. Engines check these before recommending; misinformation fills official
   gaps (Gemini/Perplexity repeated planted fakes 37-39% of the time in the Ahrefs test).

### Weight 6/19 - FAQ and measurement

9. **FAQ content exists only in the blog pipeline.** Indexable app pages carry none. Add 6-10
   buyer-phrased Q&A blocks high on `/ethereum/landing` and `/ethereum/borrow` (once indexable).
10. **Measurement is not set up.** No LLM-referrer segmentation, no "how did you hear about us"
    hook, no Bing Webmaster (Bing feeds ChatGPT retrieval). Analytics will show ~0% AI-driven
    leads even when the true number is material (0% vs 23% in the Peec case).

### Contested tier - do cheaply

11. **JSON-LD:** add Organization + WebSite on root/landing (contactPoint + a real address make
    the Ora org-completeness check pass). Expect indirect benefit only.
12. **llms.txt:** add one with a concrete "when to use Membrane" section; 10 minutes, low
    expected impact, but the current behavior (redirects to homepage) is the worst version.

### Off-site (weight 11/19 - the cap on everything above)

On-site fixes make the site retrievable; the engine's opinion of Membrane forms off-site.
The corpus-consensus program, mapped to existing strategy: pick the one entity pairing
(Membrane = measured carry-trade infrastructure, per the mycelium narrative), get into the
"best CDP stablecoin / DeFi borrowing" listicles engines already cite (ask ChatGPT and
Perplexity the buyer questions, note the exact cited URLs, target those), keep the blog's
FAQPage pipeline shipping (already R13-compliant), publish the counterfactual data where
others will quote it, and treat YouTube as a channel (0.737 correlation with ChatGPT
visibility; transcripts are crawlable articles).

## Priority order

- P0: DONE 2026-09-05, curl-verified against the dev server. H1s on root/landing/borrow/mint;
  borrow -> `indexable` + sitemap; `middleware.ts` now 404s unknown paths and 308s legacy
  chain URLs into `/ethereum/*`; dead `/manic` stub removed; `NEXT_PUBLIC_SITE_URL`
  defaulted in `.env.example` - STILL OWED: set it in the production deploy env, canonical
  and og:image stay absent until then.
- P1: DONE 2026-09-05, same commit. 22 pages classified (5 indexable, 6 app, 11 internal);
  Organization/WebSite JSON-LD on the chain root; redirects() + docs/REDIRECT_MAP.md for
  the six deleted routes; manic stub deleted; borrow + home added to the sitemap; llms.txt
  shipped early from P2. STILL OWED from this tier: stake and transmuter are in the sitemap
  as `indexable` per the ruleset but stay commented out of the nav (R4: within 2 clicks of /)
  - restore the nav links or downgrade their class, an owner call.
- P2: stake page real text; FAQ blocks on indexable pages; real about/privacy/contact;
  llms.txt; LLM-referrer analytics + attribution question.
- P3: the off-site mention/entity program (largest long-term weight, out of repo scope).

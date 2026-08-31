# SEO Ruleset — Develop With SEO In Mind

**Scope:** Development-time rules for every page and route in membrane-app. Written during the
Ethereum migration (Aug 2026) deliberately **page-agnostic**: routes will change, these rules
apply to whatever pages exist. Current-state gaps are listed in the appendix as known debt, not
as the subject of the rules.

**The one idea everything hangs on:** every page declares an **SEO class** at creation, and the
class mechanically determines its meta tags, rendering mode, sitemap membership, and perf budget.
No page ships unclassified.

---

## 🏷️ Rule 0 — Every page declares an SEO class

| Class | What it is | Examples (today's equivalents) | Indexed? |
|---|---|---|---|
| `indexable` | Marketing/entry pages a stranger should find via search or a shared link | landing, borrow, stake, transmuter | ✅ yes |
| `app` | Wallet-gated tools; useful only to existing users | portfolio, dashboards, management | ❌ `noindex,follow` |
| `internal` | Experiments, sims, event pages | acquisition-sim, tournament, manic | ❌ `noindex,nofollow` + robots Disallow |

```tsx
// Every page's first JSX child. No page without it.
<PageSeo
  seoClass="indexable"                     // 'indexable' | 'app' | 'internal'
  title="Borrow against ETH"               // ≤60 chars, unique per page
  description="Mint CDT against ETH …"     // 140–160 chars, states the user benefit
  path="/borrow"                           // used for canonical + og:url
  ogImage="/og/borrow.png"                 // optional; falls back to default card
/>
```

Build `PageSeo` once (wraps `next-seo` or plain `<Head>`): it emits title, description,
`rel="canonical"`, OG/Twitter tags for every class, and the correct `robots` meta for
`app`/`internal`. New pages get SEO by filling in four props, not by remembering ten tags.

- ❌ NEVER ship a page without `PageSeo`
- ❌ NEVER set titles in a client `useEffect` (the crawler sees the pre-hydration HTML)
- ✅ Add a CI/lint check: every file in `pages/` (or `app/`) renders `PageSeo`

---

## 🕷️ Crawlability

### R1 — Indexable pages render their real content in server HTML

Headline, H1, and descriptive copy must be in the HTML the server sends. Only the
wallet-connected interactive widgets may be `dynamic(…, { ssr: false })`.

```
Verify: curl -s https://$SITE/<path> | grep -i "<the headline>"
→ no match = rule violated, regardless of what the browser shows.
```

### R2 — The root `/` serves content, never a bare redirect

The domain root is the strongest URL. If chain-prefixed routing survives the migration, `/`
still renders the landing content (or 308s exactly once to a canonical URL that obeys R1).
Never chain redirects.

### R3 — URLs are stable, and renames ship with redirects

- Lowercase, hyphenated, human-readable paths; no query-string-only pages for indexable content.
- **Migration rule:** any route that moves gets a permanent (308) redirect from the old path,
  declared in `next.config` `redirects()`, in the same PR that moves it. Keep a running
  `docs/REDIRECT_MAP.md` so post-migration cleanup doesn't drop them.

### R4 — Navigation is crawlable

Header/footer links are real `<a href>` (`next/link`), not JS `onClick` handlers. Every
`indexable` page is reachable within 2 clicks of `/`.

---

## 🏗️ Infrastructure (build once, forget)

### R5 — One canonical site URL, from one env var

`NEXT_PUBLIC_SITE_URL` is the single source for canonical tags, `og:url`, sitemap, and
robots.txt. No hardcoded domains anywhere else.

### R6 — Sitemap and robots.txt are generated, driven by SEO class

- `next-sitemap` (or equivalent) runs at build; **only `indexable` pages** are listed.
- `robots.txt`: allow all, `Sitemap:` line, `Disallow:` for `internal` paths.
- ❌ NEVER rely on robots.txt alone to keep a page out of the index — `app`/`internal` pages
  carry `noindex` meta (a disallowed-but-linked page can still be indexed).

### R7 — Social cards on everything

Every page (all classes — app pages get shared in Discord too) emits `og:title`,
`og:description`, `og:image` (1200×630 branded default; per-page override for `indexable`),
`og:url`, `twitter:card=summary_large_image`. `PageSeo` makes this automatic.
For a DeFi app, X/Telegram/Discord link previews are the dominant referral surface — treat this
as more important than Google ranking, not less.

### R8 — Structured data, conservatively

`Organization` + `WebSite` JSON-LD on the landing page; `FAQPage` only if a real FAQ exists.
Nothing else — DeFi is a YMYL category and mismatched schema hurts more than it helps.

---

## ✍️ Content (for `indexable` pages)

### R9 — One H1, keyword-honest

- Exactly one `<h1>` per page, aligned with the `<title>`'s intent.
- Use the words strangers search, not protocol vocabulary: "borrow against ETH",
  "CDP stablecoin", "interest-free crypto loan" — nobody searches "transmuter" or "CDT".
  Pages named after internal concepts include the plain-English equivalent in H1 + description.

### R10 — Real prose, not just widgets

Each `indexable` page carries 100–300 words of static explanatory copy: what it does, how
fees/liquidation work, what the risks are. This is simultaneously UX, E-E-A-T signal (YMYL
pages are held to a higher bar), and the only thing a crawler can rank. Link docs and audit
reports from the sitewide footer.

---

## 🤖 AEO & content ops (added Aug 2026, from the Browserbase "blogEO" build-log — @harsehaj)

Answer engines (ChatGPT/Claude/Gemini/AI Overviews) are a separate distribution channel
from Google ranking: the posts that win search and the posts AI engines cite are often
different sets. Rules for the blog and any indexable content page:

### R13 — Structure for LLM parsing
Every blog post / content page carries: a labeled **TL;DR** block at the top,
**questions-as-headers** where natural, and an **FAQ section** for pages targeting
question-shaped queries. This is AEO = "SEO done very well, plus structure for llm parsing."

### R14 — Provenance-traced claims (we already live this)
Every number, code snippet, or data claim in published content traces to a source URL or a
measurement stamp — the same `measured · date` discipline the app uses. Browserbase gates
generated content on "code provenance"; ours is "data provenance." No invented specifics, ever.

### R15 — Audit by recoverable clicks, not by age
Once GSC has data: expected CTR at the page's average position × impressions − actual clicks
= recoverable clicks. Fix the biggest gaps first (their canonical example: 329k impressions
at position 9.4, 0.26% CTR — one page, huge headroom). Near-miss queries (real impressions,
position 5–20, no dedicated page) are the cheapest new-content wins.

### R16 — No cannibalization
Before publishing, check the new page's target queries against existing pages. Two of our
pages competing for one query splits authority — merge or differentiate.

### R17 — Track AI citation separately from search clicks
Instrument three funnels: crawled → cited → clicked, per answer engine. AI referral traffic
is not search traffic; measure it on its own so wins/losses are attributable.

### R18 — Content changes re-measure against a control
Edits are judged at fixed intervals (28/56 days) against a same-period blog-wide snapshot,
so a general ranking lift is never misread as the edit working. (Same measured-vs-narrative
discipline as everything else here.)

### Blog placement (CONFIRMED — owner, Aug 24 2026)
Canonical blog lives IN-REPO at `/blog` (MDX/markdown → server-rendered through the Seo
component; every post passes R1/R5/R13 by construction). The Substack remains the email
distribution channel: substantial excerpt + link, same-day — never the canonical copy
(Substack cannot set rel=canonical, so full cross-posts risk outranking us).

---

## ⚡ Performance (Core Web Vitals are a ranking input)

### R11 — Static imagery goes through `next/image`

With explicit `width`/`height` (prevents CLS). Chakra `Image` is acceptable only for small
dynamic asset icons.

### R12 — Heavy deps stay out of indexable first load

pixi.js, chart libraries, and the full wallet stack load behind `dynamic()` on `indexable`
pages. Budget: **landing-page first-load JS < 200 KB gzipped** — check the per-route table in
`next build` output on every PR that touches an indexable page.

---

## ✅ Definition of done — new or changed page

Copy into the PR description:

- [ ] `PageSeo` present with an explicit `seoClass`
- [ ] Unique title (≤60 chars) + description (140–160 chars) — server-rendered
- [ ] `indexable` only: H1 + copy present in `curl` output (R1 check)
- [ ] `indexable` only: 100–300 words of static prose, plain-English keywords (R9/R10)
- [ ] `app`/`internal`: `noindex` meta emitted
- [ ] Route moved/renamed? 308 redirect added to `next.config` + `REDIRECT_MAP.md`
- [ ] New static imagery uses `next/image` with dimensions
- [ ] `next build` route size within budget (indexable pages)
- [ ] Lighthouse SEO ≥ 90 on the changed page (`npx unlighthouse` or DevTools)

---

## 📎 Appendix — pre-migration known debt (Aug 2026 survey)

Recorded so it isn't rediscovered; fix opportunistically or as part of the migration, guided by
the rules above. Citations are to pre-migration code and will go stale.

| Debt | Where (pre-migration) | Violates |
|---|---|---|
| Page bodies load `{ ssr: false }` → empty HTML for crawlers | `pages/[chain]/index.tsx:9` | R1 |
| `/` is a server redirect to `/${DEFAULT_CHAIN}`, no content | `pages/index.tsx:6` | R2 |
| Titles set client-side; server HTML always `<title>Membrane</title>` | `hooks/usePageTitle.ts`, `pages/_document.tsx:7` | Rule 0 |
| One global meta description, no OG/Twitter/canonical/JSON-LD anywhere | `pages/_document.tsx:8` | Rule 0, R7, R8 |
| No robots.txt, no sitemap, no `NEXT_PUBLIC_SITE_URL` | `public/`, `package.json` | R5, R6 |
| Zero `next/image` usage; ~94 files use Chakra `Image` | repo-wide | R11 |
| TS/ESLint build errors ignored (`ignoreBuildErrors`) | `next.config.mjs:13,17` | quality gate, not SEO |

**Suggested build order for the shared pieces:** (1) `PageSeo` component + `NEXT_PUBLIC_SITE_URL`,
(2) robots.txt + sitemap generation, (3) apply `PageSeo` to pages as they're rebuilt for the
Ethereum migration — every migrated page arrives compliant instead of being retrofitted.

---

**Last Updated:** August 17, 2026
**Companion docs:** `docs/EVM_MIGRATION.md` (route changes → R3 redirects), `CLAUDE.md` (PR checklist)

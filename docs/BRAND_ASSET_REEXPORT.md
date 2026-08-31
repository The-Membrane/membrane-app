# Brand asset re-export — the Living Typeface migration's raster blockers

**Status:** open design task. Nothing here can be fixed in code.
**Last audited:** 31 Aug 2026.

The Living Typeface migration replaced the legacy purple/cyan palette everywhere it lives
in CSS or vector data. What remains is **raster art**, which no code change can recolor.
This file lists exactly which files, what they currently contain, and the target token —
so the re-export is a mechanical job rather than a design conversation.

Target palette (`config/semanticColors.ts`, never hardcode):

| Token | Hex | Use |
|---|---|---|
| Bone | `#ece6d8` | ink, wordmark strokes |
| Phosphor | `#9bdc4f` | living/positive emphasis |
| Cyber teal | `#46d39a` | machine-side emphasis |
| Gold | `#d8b24a` | gates, locks, caution |
| Near-black | `#09090a` | background |

Legacy colors being removed: `#6943FF` `#A692FF` `#9333EA` `#A855F7` `#8C79FF` (purple),
`#22d3ee` `#20d6ff` `#3BE5E5` `#00F1EF` (cyan), `#00A3F9` (blue).

---

## 1. Ditto character art — 6 live PNGs

**Already done in code:** the glow halo (`glowColor` / `accentColor` in
`config/dittoThemes.ts`) is migrated to the tokens above.

**The mismatch this creates:** the halo is now teal/phosphor/gold while the art underneath
is, by theme intent, still cyan and purple — a cyan lightning hat, a purple DJ hat. Until
these are re-exported the glow and the character disagree. That is a deliberate, known
intermediate state, not an oversight.

| File | Theme / route | Glow now | Art needs |
|---|---|---|---|
| `public/images/ditto-manic.png` | manic · `/manic` | teal `#46d39a` | lightning hat: cyan → teal |
| `public/images/ditto-disco.png` | disco · `/disco` | phosphor `#9bdc4f` | DJ hat: purple → phosphor |
| `public/images/ditto-transmuter.png` | transmuter · `/transmuter` | teal `#46d39a` | alchemy hat: cyan → teal |
| `public/images/ditto-portfolio.png` | portfolio · `/portfolio` | teal `#46d39a` | analyst hat → teal |
| `public/images/ditto-lockhead.png` | lockdrop · `/acquisition` | gold `#d8b24a` | lock hat: purple → gold |
| `public/images/ditto-printer.png` | mint · `/mint` | phosphor `#9bdc4f` | printer → phosphor |

Fixed in passing: `dittoThemes.ts` pointed the lockdrop theme at `ditto-lockdrop.png`,
which does not exist on disk. Corrected to `ditto-lockhead.png`.

## 2. Raster-in-SVG — look like vectors, are not

Each of these is a single `<rect fill="url(#pattern)">` wrapping a base64 PNG. There are
no paths or fills to edit; a find/replace on hex values does nothing.

| File | Referenced from | Note |
|---|---|---|
| `public/images/ditto.svg` | `dittoThemes.ts` default theme | the fallback Ditto |
| `public/images/holo-no-ditto.svg` | `DittoHologram.tsx` | the hologram plinth, always rendered |
| `public/images/holo-w-ditto.svg` | *(unreferenced)* | orphaned; same palette risk if revived |

## 3. Logo / wordmark

| File | Shipped? | Composition | Blocker |
|---|---|---|---|
| `Logo_with_both_images.svg` | **yes** | vector gradients `#00A3F9` `#00F1EF` `#8C79FF` `#4FCABB` **+ 1 embedded raster** | recoloring only the vector leaves the embedded image legacy-blue — worse than leaving it consistent. Re-export whole. |
| `logo.svg` | no | pure vector, `#00A3F9` `#00F1EF` | fully code-fixable, but nothing imports it |
| `logo_with_name.svg` | no | mixed vector + raster | orphaned |
| `MBRN-logo-template.svg` | no | mixed vector + raster | orphaned |

**Scope is smaller than it looks:** `components/HorizontalNav.tsx:129` has `{/* <Logo /> */}`
commented out, so **the desktop header renders no logo at all**. The legacy-blue wordmark is
visible only on mobile (`HorizontalNav.tsx:348` drawer, `:486` centered mobile logo) and in
`components/ShareableCard/ShareableCard.tsx:115`.

## 4. Unused assets — delete or re-export, but don't leave half-migrated

`public/images/ditto-mask.png`, `public/images/ditto.png`, `logo.svg`,
`logo_with_name.svg`, `MBRN-logo-template.svg` have no code references. Confirm against
manifest/favicon config before deleting.

---

## The open question this does NOT settle

`.claude/skills/branding-guidelines/references/ditto-character.md` records Ditto's visual
treatment as an explicit open question — *"do not invent a new Living-Typeface Ditto design
without design sign-off."* This document assumes a **like-for-like recolour** of the existing
character. If the answer is instead that Ditto should be redrawn (mono-line? moss-grown?
retired as a deliberate cyber-side exception?), this table is the wrong plan and the
character decision comes first.

Ditto's *behavioural* contract is unaffected either way and stays as written.

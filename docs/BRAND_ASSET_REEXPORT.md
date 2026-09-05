# Brand asset re-export — the Living Typeface migration's raster blockers

**Status:** Ditto sprites DONE (1 Sep 2026, hue remap via scripts/recolor-sprites.py).
Logo/wordmark rasters remain an open design task.
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

## 1. Ditto — REDRAWN 4 Sep 2026, supersedes the recolour plan

Ditto is no longer the flat-cell character. He is now mossy stone with phosphor light
running through the seams, standing on a matching hologram plinth. This is a redesign,
not the like-for-like recolour this document originally planned, so the hue-remap
approach recorded here is superseded. `scripts/recolor-sprites.py` is kept because the
method is reusable, not because Ditto still needs it.

    public/images/ditto.png        1312x1199, aspect 1.094, real alpha
    public/images/holo-plinth.png  1536x1024, aspect 1.500, real alpha

Sized in `components/DittoHologram.tsx`: plinth 132x88, Ditto 119x109. Ditto is 90% of
the plinth's width (owner pick) and sits at bottom:25px, sunk 27% of his height into the
plate so his base is lost in the glow rather than resting on a surface. Both are set with
explicit width AND height because neither asset is square and a `boxSize` would distort
them.

The six hat variants (manic, disco, transmuter, portfolio, lockhead, printer) are
RETIRED. `config/dittoThemes.ts` is one theme; `routeThemeMap` and per-route theming are
gone. `glowColor` survives only because DittoHologram interpolates it into the
drop-shadow when actions are pending.

WATCH FOR: every delivered version before the final pair shipped with a BAKED BLACK
background (0% transparent, corner pixels 0,0,0 at alpha 1). Those render as a black
rectangle on parchment `#e7dfcc`. The two files now installed have genuine alpha, 32.5%
and 37.5% transparent. Check `corner alpha` on anything new before installing it.

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

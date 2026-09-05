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

## 1. Ditto character art — RESOLVED 1 Sep 2026

Recoloured in place with `scripts/recolor-sprites.py`, a per-pixel hue remap rather
than a re-draw. The artwork's own hues sat in a narrow 188-248 degree band (cyan
through violet); that band was remapped onto 157 -> 86 (teal -> phosphor), which keeps
the internal shading gradient instead of flattening the character to one colour.

Deliberately preserved: near-black linework (below 0.18 saturation is left alone,
because hue-rotating a desaturated pixel produces mud) and every out-of-band prop.
Manic's yellow lightning, disco's pink headphones and portfolio's brown cap all keep
their original hues.

Files recoloured: ditto.svg, holo-no-ditto.svg, ditto-manic.png, ditto-disco.png,
ditto-transmuter.png, ditto-portfolio.png, ditto-lockhead.png, ditto-printer.png.

STILL OFF-BRAND: the transmuter wizard hat is violet (hue ~275), outside the remapped
band, so it survived untouched. It is a costume rather than the character, and moving
that hue would also catch unrelated pixels. Left for a design call.

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

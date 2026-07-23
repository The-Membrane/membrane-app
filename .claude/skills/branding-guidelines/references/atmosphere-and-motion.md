# Atmosphere & Motion Reference

Living Typeface motion is quiet by default. This reference covers the two registers — interactive
micro-transitions and opt-in atmosphere decoration — plus the concrete CSS/technique patterns for
each. It replaces the old neon/glow visual-effects reference (see **Legacy** at the bottom).

## Interactive Motion (UI components)

Applies to buttons, cards, inputs, links, icon buttons — anything the user clicks or reads for data.

### Hairline brighten (default hover)

```css
/* Resting */
border: 1px solid rgba(236, 230, 216, 0.10);
transition: border-color 0.15s, color 0.15s;

/* Hover */
border-color: rgba(236, 230, 216, 0.22);
```

### Color shift (links, icon buttons)

```css
color: #8d877b; /* dim */
transition: color 0.15s;

/* Hover */
color: #9bdc4f; /* phosphor */
```

### Background raise (solid buttons)

```css
background: #0e0d10; /* card */
transition: background-color 0.15s;

/* Hover */
background: #100f12; /* raise */
```

### Press (active state)

```css
/* No translate, no scale — just a slight opacity dip */
opacity: 0.85;
```

### Focus ring

```css
outline: 1px solid #9bdc4f;
outline-offset: 2px;
/* No box-shadow blur, no purple ring */
```

**Hard rule:** nothing on this list uses `transform: translateY(...)`, `transform: scale(...)`, or a
`box-shadow` glow bloom. If a component needs more visual weight, brighten the hairline or deepen the
background step — don't add motion.

---

## Atmosphere Motion (opt-in, decorative only)

Applies only to heroes, landing pages, and section openers. **Never** wire these into a card, table,
button, or form.

### Ambient breathe (opacity pulse)

```css
@keyframes ambientBreathe {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
/* 6-10s cycle — slow, almost imperceptible */
```

### Ambient sway (position drift)

```css
@keyframes ambientSway {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(6px); }
}
/* 8-12s cycle */
```

### Scanlines

```css
background-image: repeating-linear-gradient(
  0deg,
  rgba(236, 230, 216, 0.03) 0px,
  rgba(236, 230, 216, 0.03) 1px,
  transparent 1px,
  transparent 3px
);
```

### Canopy glow

```css
background: radial-gradient(circle at 30% 20%, rgba(155, 220, 79, 0.15), transparent 60%),
            radial-gradient(circle at 70% 60%, rgba(216, 178, 74, 0.10), transparent 60%);
mix-blend-mode: screen;
```

### Light shafts

```css
background: linear-gradient(115deg, transparent 40%, rgba(236, 230, 216, 0.04) 50%, transparent 60%);
/* Optionally paired with a very slow translateX drift (ambientSway) */
```

### Gold motes

Small (2-4px) particles, low opacity gold (`#d8b24a`), animated with a slow float/drift path
(combination of `ambientSway` + a slight vertical rise). Randomize timing offsets per particle so they
don't move in lockstep.

### Moss patches / grass tufts

Grown procedurally in-browser, not baked images:
1. Value-noise field generates a growth mask.
2. The mask is applied through the Redaction glyph shapes (glyph-masked pixel grid).
3. Filled counters (the closed shapes inside letterforms) are flood-filled with moss texture.

This technique lives in the canonical design file (with the embedded font data). If you need the
moss-growth implementation, source it from there — don't approximate it with a static image or CSS
noise filter, since the whole point is that it reads as grown, not decorated.

---

## Where Each Effect Is Allowed

| Effect | Allowed | Not allowed |
|--------|---------|--------------|
| Hairline brighten / color shift / bg raise | All interactive components | — |
| Ambient breathe / sway | Hero backgrounds, section-opener decoration | Cards, buttons, tables, forms |
| Scanlines | Hero backgrounds | Data tables, modals |
| Canopy glow | Behind hero copy, section openers | Anywhere text needs to stay legible/high-contrast |
| Light shafts | Hero backgrounds | App chrome |
| Gold motes | Heroes, footers | Transactional components |
| Moss patches | Footer, wordmark edges, section openers | Card titles, table headers, buttons |

---

## Legacy (do not reintroduce)

The previous cyberpunk/neon system used purple/cyan glow as its signature interactive effect:
box-shadow blooms (`0 0 20px rgba(166,146,255,0.6)`), lift-on-hover (`translateY(-2px)`), scale-on-hover
(`1.02x`), and a dedicated neon-sign text effect on the old landing page. These patterns are being
migrated out. If you find them in an untouched component, that's legacy code pending migration — not a
pattern to copy into new work.

# Gas Fee Alert Banner -- Color Recommendations and Component

## 1. Recommended Colors (with hex values)

The Membrane app already defines a semantic color system in `/Users/EBmic/membrane-app/config/semanticColors.ts`. An alert banner for gas fees maps directly to two existing semantic tokens:

| State | Semantic Token | Hex Value | Usage |
|-------|---------------|-----------|-------|
| **Warning** (fees elevated) | `SEMANTIC_COLORS.warning` | `#fbbf24` | Icon, badge text, accent |
| **Danger** (fees very high) | `SEMANTIC_COLORS.danger` | `#ef4444` | Icon, badge text, accent |

Since those tokens are full-saturation colors meant for small accents (icons, badges, borders), the banner itself needs tinted variants for backgrounds and borders that sit comfortably on the app's dark background (`#091326`). Here is the full palette for each state:

### Warning State (yellow)

| Element | Color | Hex / RGBA |
|---------|-------|------------|
| Background | Very faint yellow tint | `rgba(251, 191, 36, 0.08)` |
| Border | Visible yellow border | `rgba(251, 191, 36, 0.30)` |
| Icon | Full warning yellow | `#fbbf24` |
| Heading text | Lighter yellow for readability on dark | `#fde68a` |
| Badge background | Subtle yellow fill | `rgba(251, 191, 36, 0.15)` |
| Badge text | Full warning yellow | `#fbbf24` |
| Ambient glow (box-shadow) | Faint yellow halo | `0 0 16px rgba(251, 191, 36, 0.12)` |
| Body text | Standard secondary text | `rgba(255, 255, 255, 0.6)` (i.e. `SEMANTIC_COLORS.textSecondary`) |

### Danger State (red)

| Element | Color | Hex / RGBA |
|---------|-------|------------|
| Background | Very faint red tint | `rgba(239, 68, 68, 0.10)` |
| Border | Visible red border | `rgba(239, 68, 68, 0.40)` |
| Icon | Full danger red | `#ef4444` |
| Heading text | Lighter red for readability on dark | `#fca5a5` |
| Badge background | Subtle red fill | `rgba(239, 68, 68, 0.18)` |
| Badge text | Full danger red | `#ef4444` |
| Ambient glow (box-shadow) | Faint red halo | `0 0 16px rgba(239, 68, 68, 0.15)` |
| Body text | Standard secondary text | `rgba(255, 255, 255, 0.6)` (i.e. `SEMANTIC_COLORS.textSecondary`) |

### Why these colors

- **Backgrounds at 8-10% opacity** keep the banner from overpowering surrounding content while still providing a clear tinted region that signals state.
- **Borders at 30-40% opacity** give visible delineation without harsh lines -- matching the existing border approach in the codebase (e.g. `TimedMessageInline` uses `#6943FF40`).
- **Heading colors** (`#fde68a` for warning, `#fca5a5` for danger) are lighter tints of the base semantic colors. They maintain enough contrast against the dark background for WCAG AA readability while feeling harmonious with the icon.
- **Body text** reuses `SEMANTIC_COLORS.textSecondary` so descriptive copy does not compete with the colored heading for attention.
- **Ambient glow** is very subtle (12-15% opacity) and adds perceived depth consistent with patterns elsewhere in the app (see `HOVER_EFFECTS.glow` in `config/transitions.ts`).

---

## 2. Complete React Component

The component file is saved separately at:

```
.claude/skills/branding-guidelines-workspace/iteration-1/alert-banner-colors/without_skill/outputs/GasFeeAlert.tsx
```

### Key design decisions

**Design system compliance:**
- All spacing uses `SPACING` / `SPACING_PATTERNS` constants (no arbitrary pixel values).
- All transitions use `TRANSITIONS` from `config/transitions.ts`.
- Typography uses `TYPOGRAPHY` constants.
- State colors derive from `SEMANTIC_COLORS`.

**Animations and transitions:**
- The banner enters and exits with a combined `opacity + height` animation via Framer Motion (`AnimatePresence`), matching the pattern used by `TimedMessageInline` in the existing codebase.
- The container box uses `transition={TRANSITIONS.all}` so that if the severity changes while visible (e.g. from warning to danger), all style properties animate smoothly.
- Duration is `0.3s` with `easeOut` easing, consistent with `DURATION.standard` and `EASING.easeOut` from the transitions config.

**Accessibility:**
- `role="alert"` and `aria-live="polite"` ensure screen readers announce the banner.
- The dismiss button has an explicit `aria-label`.
- Color contrast ratios: `#fde68a` on `rgba(251, 191, 36, 0.08)` over `#091326` yields a contrast ratio above 8:1. `#fca5a5` on the danger background is similarly high-contrast.

**Performance:**
- The component is wrapped in `React.memo` to prevent unnecessary re-renders.
- The dismiss handler is memoized with `useCallback`.

### Usage example

```tsx
import { useState } from 'react'
import { GasFeeAlert } from '@/components/GasFeeAlert'

const MyPage = () => {
  const [showAlert, setShowAlert] = useState(true)

  // Determine severity based on your gas fee logic
  const gasSeverity = gasMultiplier > 3 ? 'danger' : 'warning'

  return (
    <VStack spacing={SPACING_PATTERNS.sectionGap}>
      <GasFeeAlert
        severity={gasSeverity}
        isVisible={showAlert}
        onDismiss={() => setShowAlert(false)}
        gasMultiplier="2.4x"
      />

      {/* Rest of page content */}
    </VStack>
  )
}
```

---

## 3. Visual Description

### Warning State (fees elevated)

```
+----------------------------------------------------------------------+
| [!] Elevated Gas Fees   [ 2.4x avg ]                            [x] |
|     Gas fees are elevated. Consider waiting for lower network        |
|     congestion.                                                      |
+----------------------------------------------------------------------+

Background: very faint yellow tint
Border:     soft yellow (#fbbf24 at 30%)
Icon:       yellow triangle (AlertTriangle from lucide-react)
Heading:    light yellow (#fde68a)
Badge:      "2.4x avg" in yellow on subtle yellow pill
Body:       white at 60% opacity
Glow:       faint yellow ambient shadow
```

### Danger State (fees very high)

```
+----------------------------------------------------------------------+
| [flame] High Gas Fees   [ 5.1x avg ]                            [x] |
|     Gas fees are very high right now. Transactions may be            |
|     expensive.                                                       |
+----------------------------------------------------------------------+

Background: very faint red tint
Border:     soft red (#ef4444 at 40%)
Icon:       red flame (Flame from lucide-react)
Heading:    light red (#fca5a5)
Badge:      "5.1x avg" in red on subtle red pill
Body:       white at 60% opacity
Glow:       faint red ambient shadow
```

The icon intentionally changes between states: `AlertTriangle` for warning (a familiar caution symbol) and `Flame` for danger (conveying urgency and heat). Both are from `lucide-react`, which is already used throughout the codebase (see `TxConfirmationSection.tsx`).

---

## 4. Component API Reference

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `severity` | `'warning' \| 'danger'` | Yes | Controls color scheme and default messaging |
| `isVisible` | `boolean` | Yes | Toggles banner visibility with animation |
| `onDismiss` | `() => void` | Yes | Called when user clicks the close button |
| `gasMultiplier` | `string` | No | Displayed in the badge (e.g. `"2.4x"`) |
| `message` | `string` | No | Overrides the default body text for the severity |

---

## 5. Files Referenced

- `/Users/EBmic/membrane-app/config/semanticColors.ts` -- source of `SEMANTIC_COLORS.warning` (`#fbbf24`) and `SEMANTIC_COLORS.danger` (`#ef4444`)
- `/Users/EBmic/membrane-app/config/transitions.ts` -- source of `TRANSITIONS.all`, `MOTION_VARIANTS`, animation duration/easing standards
- `/Users/EBmic/membrane-app/config/spacing.ts` -- source of `SPACING` and `SPACING_PATTERNS` constants
- `/Users/EBmic/membrane-app/helpers/typography.ts` -- source of `TYPOGRAPHY` font size and weight constants
- `/Users/EBmic/membrane-app/components/ui/Card.tsx` -- reference for how the codebase structures reusable UI components
- `/Users/EBmic/membrane-app/components/DittoSpeechBox/TimedMessageBanner.tsx` -- reference for existing banner animation patterns (AnimatePresence + MotionBox)
- `/Users/EBmic/membrane-app/components/DittoSpeechBox/sections/TxConfirmationSection.tsx` -- reference for error/warning state styling and lucide-react icon usage
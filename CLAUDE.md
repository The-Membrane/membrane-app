# Membrane App - Design System Standards

**CRITICAL:** All code changes MUST follow these standardized patterns. No exceptions.

> **Brand direction:** Living Typeface (bone-on-black, phosphor green, sharp corners, hairlines). This
> supersedes the old cyberpunk navy/purple/glow system. See
> `.claude/skills/branding-guidelines/SKILL.md` for the full brand guide.

---

## 🌱 Living Typeface Principles

Four rules to internalize before touching any component:

1. **Cyber ⇄ Organic axis.** Membrane sits between a machine (precise, mono, hairline grids) and a
   living thing (serif, grown, slightly imperfect). Every surface leans one way or the other — never
   split the difference into something generic.
2. **The living face is display-only.** The moss-grown, pixelated Redaction wordmark treatment
   belongs to heroes, landing pages, and section openers — never inside app chrome, cards, tables, or
   anything a user reads while transacting.
3. **Numbers are always machine-readable.** Balances, LTVs, APRs, amounts — always JetBrains Mono
   (or plain Redaction, never the pixelated/moss variant). Never render a number in a decorative font.
4. **Warm bone, not pure white.** Text is `#ece6d8`, not `#fff` or `whiteAlpha.*`. Backgrounds are
   near-black (`#09090a`), not navy.

---

## 🎨 Design System Components

### Typography

**Use standardized typography helpers from `helpers/typography.ts`:**

```tsx
import { TYPOGRAPHY } from '@/helpers/typography'

// Page titles — Redaction serif display
<Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold}>
  Page Title
</Text>

// Section titles — Redaction serif
<Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.semibold}>
  Section
</Text>

// Card titles — Redaction serif or mono, per context
<Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h4} fontWeight={TYPOGRAPHY.medium}>
  Card Title
</Text>

// Body / data text — JetBrains Mono
<Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.body}>Content</Text>

// Eyebrows / labels — mono, uppercase, letterspaced
<Text
  fontFamily={TYPOGRAPHY.fontMono}
  fontSize={TYPOGRAPHY.label}
  textTransform="uppercase"
  letterSpacing="0.28em"
  color={SEMANTIC_COLORS.textSecondary}
>
  01 / Label
</Text>
```

**Scale (sizes unchanged, families changed):**
- h1: 32px (page titles) — Redaction serif
- h2: 24px (section titles) — Redaction serif
- h3: 18px (subsection titles) — Redaction serif or mono
- h4: 16px (card titles) — Redaction serif or mono
- body: 16px (primary text) — JetBrains Mono
- small: 14px (secondary text) — JetBrains Mono
- xs: 12px (tertiary text) — JetBrains Mono
- label: 11px (labels, table headers, eyebrows — always uppercase, mono, letterspacing 0.28em)

**Weights:**
- bold: 700
- semibold: 600
- medium: 500
- normal: 400

**Font families:**
- `TYPOGRAPHY.fontDisplay` → `'Redaction', Georgia, serif` — headings, editorial copy, italic sub-copy
- `TYPOGRAPHY.fontMono` → `'JetBrains Mono', ui-monospace, monospace` — everything functional: body, data, labels, buttons, inputs

**Rules:**
- ❌ NEVER use the pixelated/moss Redaction variant outside wordmark/hero contexts
- ❌ NEVER render a number, balance, or metric in the display serif
- ✅ Prose reads in serif, data reads in mono — don't blend them mid-sentence

---

## 🎨 Colors

### Semantic Colors (`config/semanticColors.ts`)

**ALWAYS use semantic colors for states:**

```tsx
import { SEMANTIC_COLORS } from '@/config/semanticColors'

// State colors
bg={SEMANTIC_COLORS.success}  // #9bdc4f (phosphor) - positive outcomes, healthy, up
bg={SEMANTIC_COLORS.warning}  // #d8b24a (gold) - gates, caution, approaching limits
bg={SEMANTIC_COLORS.danger}   // #cf4034 (blood) - errors, liquidation risk, down
bg={SEMANTIC_COLORS.info}     // #46d39a (cyber teal) - informational, machine-side emphasis

// Emphasis colors
bg={SEMANTIC_COLORS.primary}    // #9bdc4f (phosphor) - main CTAs, living/organic emphasis
bg={SEMANTIC_COLORS.secondary}  // #46d39a (cyber teal) - secondary actions, machine emphasis

// Text colors (warm bone, not pure white)
color={SEMANTIC_COLORS.textPrimary}    // #ece6d8 (bone)
color={SEMANTIC_COLORS.textSecondary}  // #8d877b (dim)
color={SEMANTIC_COLORS.textTertiary}   // #56524a (faint)

// Backgrounds
bg={SEMANTIC_COLORS.bgPage}   // #09090a (near-black)
bg={SEMANTIC_COLORS.bgRaise}  // #100f12
bg={SEMANTIC_COLORS.bgCard}   // #0e0d10

// Hairline borders (never solid glass borders)
borderColor={SEMANTIC_COLORS.hairline}        // rgba(236,230,216,0.10)
borderColor={SEMANTIC_COLORS.hairlineStrong}  // rgba(236,230,216,0.22)
```

**Color Usage Rules:**
- ❌ NEVER use random colors
- ❌ NEVER use purple (`#A692FF`, `#6943FF`) — it is the legacy brand color, being migrated out
- ❌ NEVER use cyan for success — cyan/`#22d3ee` was the old success color
- ❌ NEVER use pure white (`#fff`, `whiteAlpha.*`) for text — always warm bone
- ✅ ALWAYS use semantic color names
- ✅ Success = phosphor green, Warning = gold, Danger = blood red, Info = cyber teal

---

## 📏 Spacing

### Spacing Scale (`config/spacing.ts`)

**ALWAYS use standardized spacing values:**

```tsx
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'

// Spacing scale (Chakra numeric values)
p={SPACING.none}    // 0
p={SPACING.xs}      // 1 = 4px
p={SPACING.sm}      // 2 = 8px
p={SPACING.md}      // 3 = 12px
p={SPACING.base}    // 4 = 16px
p={SPACING.lg}      // 6 = 24px
p={SPACING.xl}      // 8 = 32px
p={SPACING['2xl']}  // 12 = 48px
p={SPACING['3xl']}  // 16 = 64px

// Common patterns
p={SPACING_PATTERNS.cardPadding}      // 4 = 16px
gap={SPACING_PATTERNS.sectionGap}     // 6 = 24px
spacing={SPACING_PATTERNS.stackSpacing}  // 3 = 12px
gap={SPACING_PATTERNS.formFieldGap}   // 4 = 16px
```

**Spacing Rules:**
- ❌ NEVER use arbitrary values like `p={5}`, `gap="20px"`, `gap="9%"`
- ❌ NEVER use inline pixel values: `padding: "20px"`
- ❌ NEVER mix units: `gap="1.5rem"`
- ✅ ALWAYS use SPACING constants
- ✅ ALWAYS use numeric Chakra values (not strings)

### Modal Padding Standard

**ALL modals MUST use standardized padding. Modals are sharp-cornered with a hairline border, not
rounded glass:**

```tsx
<Modal isOpen={isOpen} onClose={onClose}>
  <ModalOverlay />
  <ModalContent
    bg={SEMANTIC_COLORS.bgCard}
    borderRadius={0}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.hairline}
  >
    <ModalHeader fontFamily={TYPOGRAPHY.fontDisplay}>Title</ModalHeader>
    <ModalCloseButton _focus={FOCUS_STYLES.ring} />

    {/* REQUIRED: pb={6} or pb={SPACING_PATTERNS.modalPadding} */}
    <ModalBody pb={SPACING_PATTERNS.modalPadding}>
      <VStack spacing={SPACING_PATTERNS.stackSpacing}>
        {content}
      </VStack>
    </ModalBody>

    <ModalFooter
      pt={SPACING_PATTERNS.modalPadding}
      gap={SPACING_PATTERNS.buttonGroupGap}
    >
      <Button>Close</Button>
    </ModalFooter>
  </ModalContent>
</Modal>
```

**Standard:** `pb={6}` (24px) for ModalBody. `borderRadius={0}`, hairline border, no backdrop glow.

---

## 🎬 Animations & Transitions

### Micro-Interactions (`config/transitions.ts`)

Living Typeface motion is **subtle** — color and border transitions only. No lift, no scale, no glow.
Ambient breathing/sway motion exists only in opt-in atmosphere layers (heroes, landing, section
openers) and never on interactive UI.

```tsx
import {
  TRANSITIONS,
  HOVER_EFFECTS,
  ACTIVE_EFFECTS,
  FOCUS_STYLES,
  MOTION_VARIANTS
} from '@/config/transitions'

// Buttons (REQUIRED on all buttons)
<Button
  transition={TRANSITIONS.colorAndBorder}
  _hover={HOVER_EFFECTS.borderHighlight}
  _active={ACTIVE_EFFECTS.dim}
  _focus={FOCUS_STYLES.ring}
>
  Click me
</Button>

// Interactive Cards
<Card
  interactive  // Enables hairline-brighten hover automatically
  onClick={handleClick}
>
  Content
</Card>

// Or custom card with Box
<Box
  onClick={handleClick}
  cursor="pointer"
  transition={TRANSITIONS.colorAndBorder}
  _hover={HOVER_EFFECTS.borderHighlight}
  _active={ACTIVE_EFFECTS.dim}
>
  Content
</Box>

// Atmosphere-only entrances (heroes/landing, NOT app chrome)
import { motion } from 'framer-motion'

<motion.div
  variants={MOTION_VARIANTS.ambientSway}
  initial="hidden"
  animate="visible"
>
  Content
</motion.div>
```

**Animation Rules:**
- ❌ NEVER use inline transitions: `transition="all 0.2s"`
- ❌ NEVER use arbitrary timings
- ❌ NEVER add lift (`translateY`), scale, or glow/box-shadow-bloom hovers to interactive components
- ✅ ALWAYS import from `config/transitions.ts`
- ✅ Color/border transitions run at `.15s` — fast and quiet
- ✅ ALWAYS add focus indicators for accessibility

**Available Effects:**
- `HOVER_EFFECTS.borderHighlight` - hairline brightens (`0.10` → `0.22` alpha) — default for cards, ghost buttons, inputs
- `HOVER_EFFECTS.colorShift` - text/icon shifts to phosphor - links, icon buttons
- `HOVER_EFFECTS.bgRaise` - background steps from `bgCard` → `bgRaise` - solid buttons
- `ACTIVE_EFFECTS.dim` - opacity dips slightly on press (no translate)

**Removed (do not reintroduce):** `lift`, `liftSubtle`, `scale`, `glow`, `brighten`-filter — these were
signature cyberpunk-era effects. If you see them in older components, that's legacy code pending
migration, not something to copy.

---

## 🧩 Component Patterns

### Buttons

**Standard button patterns:**

```tsx
// Primary CTA (solid, phosphor)
<Button colorScheme="phosphor" borderRadius={0}>
  Primary Action
</Button>

// Secondary action (ghost, hairline border)
<Button variant="ghost">
  Secondary Action
</Button>

// Outline variant (hairline)
<Button variant="outline">
  Outline Action
</Button>

// Link variant (mono, uppercase)
<Button variant="link">
  Link Action
</Button>
```

**Button Rules:**
- ❌ NEVER add custom hover states (theme handles it)
- ❌ NEVER use `colorScheme="purple"` — legacy
- ❌ NEVER round the corners
- ✅ Button theme applies border-highlight/bg-raise automatically, not lift
- ✅ Ghost/outline buttons get hairline brightening on hover
- ✅ All buttons have focus rings (1px phosphor outline)

### Cards

**Standard card patterns:**

```tsx
import { Card } from '@/components/ui/Card'

// Static info card
<Card variant="default">
  <Text>Info content</Text>
</Card>

// Elevated card (more prominence)
<Card variant="elevated">
  <Text>Important content</Text>
</Card>

// Interactive/clickable card
<Card
  variant="default"
  interactive  // Enables hairline-brighten hover
  onClick={handleClick}
>
  <Text>Clickable content</Text>
</Card>
```

**Card Rules:**
- ❌ NEVER use Box with inline card styling
- ❌ NEVER round corners (`borderRadius={0}` always) or add scale/glow hover
- ✅ ALWAYS use Card component
- ✅ Cards are `bgCard` + `1px solid hairline` — sharp corners, no glass blur
- ✅ Use `interactive` prop for clickable cards (hairline brightens on hover)
- ✅ Variants: default, elevated, subtle

### Forms & Inputs

**Standard input patterns:**

```tsx
import { FOCUS_STYLES } from '@/config/transitions'

<Input
  placeholder="Enter amount"
  borderRadius={0}
  border="1px solid"
  borderColor={SEMANTIC_COLORS.hairline}
  transition={TRANSITIONS.colorAndBorder}
  _focus={FOCUS_STYLES.ring}  // 1px phosphor outline
  _invalid={{
    borderColor: SEMANTIC_COLORS.danger,
  }}
/>

// With error state
<FormControl isInvalid={hasError}>
  <FormLabel fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} textTransform="uppercase" letterSpacing="0.28em">
    Amount
  </FormLabel>
  <Input {...inputProps} />
  <FormErrorMessage color={SEMANTIC_COLORS.danger}>
    {errorMessage}
  </FormErrorMessage>
</FormControl>
```

**Form Rules:**
- ✅ ALWAYS use focus rings for accessibility (1px phosphor outline, no blurred box-shadow)
- ✅ ALWAYS use semantic colors for validation (danger = blood, never plain red)
- ✅ Labels are mono, uppercase, letterspaced 0.28em (11px)
- ✅ Error messages use danger color
- ❌ NEVER round input corners

---

## 📱 Responsive Design

### Breakpoints

```tsx
// Chakra breakpoints (use these)
{
  base: "0px",    // Mobile-first (default)
  xxs: "320px",   // Extra-small phones
  xs: "375px",    // Small phones
  sm: "480px",    // Large phones
  md: "768px",    // Tablets
  lg: "992px",    // Small laptops
  xl: "1280px",   // Desktops
  "2xl": "1536px" // Large screens
}

// Usage
<Box
  p={{ base: 4, md: 6, lg: 8 }}  // Responsive padding
  fontSize={{ base: "sm", md: "md", lg: "lg" }}
>
  Content
</Box>
```

**Responsive Rules:**
- ✅ Mobile-first approach (base is mobile)
- ✅ Test on: 375px (mobile), 768px (tablet), 1920px (desktop)
- ✅ Touch targets minimum 44px on mobile
- ✅ No horizontal scroll on mobile

---

## ⚡ Performance

### Re-render Prevention

```tsx
// Memoize expensive components
import { memo } from 'react'

export const ExpensiveComponent = memo(({ data }) => {
  // Component logic
})

// Memoize expensive calculations
import { useMemo } from 'react'

const sortedData = useMemo(() => {
  return data.sort((a, b) => a.value - b.value)
}, [data])

// Memoize callbacks
import { useCallback } from 'react'

const handleClick = useCallback(() => {
  doSomething(id)
}, [id])
```

**Performance Rules:**
- ✅ Memo components that render frequently
- ✅ UseMemo for expensive calculations
- ✅ UseCallback for event handlers passed to children
- ❌ Don't memo everything (overhead)

---

## ♿ Accessibility

### Focus Management

Focus rings are a **1px solid phosphor (`#9bdc4f`) outline, offset 2px** — not a purple blurred
box-shadow ring. Sharp, precise, visible on the near-black background.

```tsx
import { FOCUS_STYLES } from '@/config/transitions'

// All interactive elements need focus indicators
<Button _focus={FOCUS_STYLES.ring}>
  Click me
</Button>

<Box
  as="button"
  _focus={FOCUS_STYLES.ring}
  _focusVisible={FOCUS_STYLES.ring}
>
  Custom button
</Box>
```

### ARIA Attributes

```tsx
// Buttons
<Button aria-label="Close modal">
  <CloseIcon />
</Button>

// Modals
<Modal isOpen={isOpen} onClose={onClose}>
  <ModalContent aria-labelledby="modal-title">
    <ModalHeader id="modal-title">Title</ModalHeader>
  </ModalContent>
</Modal>

// Form inputs
<Input
  aria-label="Amount to deposit"
  aria-invalid={hasError}
  aria-describedby={hasError ? "error-message" : undefined}
/>
{hasError && (
  <FormErrorMessage id="error-message">
    {errorMessage}
  </FormErrorMessage>
)}
```

**Accessibility Rules:**
- ✅ All buttons need aria-label if no text
- ✅ Focus indicators required (WCAG 2.1 AA) — 1px phosphor outline, not a glow
- ✅ Form inputs need labels
- ✅ Modals need aria-labelledby
- ✅ Error states need aria-invalid + aria-describedby

---

## 🧪 Testing

### Playwright E2E Tests

**When adding new features, update tests:**

```tsx
// Location: tests/e2e/

// Add to smoke tests if critical user flow
test('new feature works', async ({ page }) => {
  await page.goto('/neutron')
  // Test logic
})

// Run tests before committing
// pnpm test:e2e tests/e2e/smoke.spec.ts
```

**Testing Rules:**
- ✅ Run smoke tests before major changes
- ✅ Test on multiple devices (chrome, mobile)
- ✅ Verify no console errors
- ✅ Check layout shifts (CLS < 0.1)

---

## 📋 Code Quality Standards

### Import Order

```tsx
// 1. React imports
import React, { useState, useEffect } from 'react'

// 2. Third-party imports
import { Box, VStack, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'

// 3. Config imports
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

// 4. Component imports
import { Card } from '@/components/ui/Card'

// 5. Hook imports
import { useDiscoDeposit } from './hooks/useDiscoDeposit'

// 6. Util imports
import { formatLargeNumber } from '@/helpers/format'
```

### File Organization

```
components/
  FeatureName/
    FeatureName.tsx           # Main component
    FeatureCard.tsx           # Sub-components
    hooks/
      useFeatureData.ts       # Custom hooks
      index.ts                # Hook exports
    utils.ts                  # Feature-specific utils
    types.ts                  # TypeScript types
```

---

## 🚫 Common Mistakes to Avoid

### ❌ DON'T DO THIS:

```tsx
// Random spacing values
<Box p={5} gap="20px" mt="1.5rem" mb="9%">

// Inline transitions
<Button transition="all 0.2s">

// Legacy purple / cyan
<Text color="#A692FF">Emphasis</Text>
<Text color="cyan.500">Success!</Text>

// No focus indicators
<Box as="button" onClick={handleClick}>

// Arbitrary font sizes
<Text fontSize="17px" fontWeight={550}>

// Rounded corners / glass card styling
<Box bg="rgba(10,10,10,0.8)" borderRadius="24px" p={6}>

// Lift/scale hover, glow shadow
<Button _hover={{ transform: "translateY(-3px)" }}>
<Box _hover={{ boxShadow: "0 0 20px rgba(155,220,79,0.6)" }}>

// Sans-serif heading, pure-white text
<Text fontFamily="Inter" color="white">Section Title</Text>
```

### ✅ DO THIS INSTEAD:

```tsx
// Standardized spacing
<Box p={SPACING.base} gap={SPACING_PATTERNS.sectionGap}>

// Standardized transitions
<Button
  transition={TRANSITIONS.colorAndBorder}
  _hover={HOVER_EFFECTS.borderHighlight}
  _focus={FOCUS_STYLES.ring}
>

// Semantic colors
<Text color={SEMANTIC_COLORS.success}>Success!</Text>

// Typography scale (mono for data, serif for display)
<Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.medium}>
  1,204.55 CDT
</Text>
<Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2}>Section Title</Text>

// Card component — sharp corners, hairline border
<Card variant="default">

// Mono uppercase eyebrow label
<Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} textTransform="uppercase" letterSpacing="0.28em">
  01 / Overview
</Text>
```

---

## 📚 Quick Reference

### Most Common Imports

```tsx
// Every component should likely import:
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
```

### Most Common Patterns

```tsx
// Button
<Button
  transition={TRANSITIONS.colorAndBorder}
  _hover={HOVER_EFFECTS.borderHighlight}
  _active={ACTIVE_EFFECTS.dim}
  _focus={FOCUS_STYLES.ring}
>
  Action
</Button>

// Card
<Card interactive onClick={handleClick}>
  Content
</Card>

// Stack with standard spacing
<VStack spacing={SPACING_PATTERNS.stackSpacing}>
  {items}
</VStack>

// Section gap
<VStack spacing={SPACING_PATTERNS.sectionGap}>
  <Section1 />
  <Section2 />
</VStack>

// Form field
<FormControl>
  <FormLabel fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} textTransform="uppercase" letterSpacing="0.28em">
    Label
  </FormLabel>
  <Input _focus={FOCUS_STYLES.ring} />
</FormControl>
```

---

## 🎯 Design System Compliance Checklist

Before submitting any PR, verify:

- [ ] Using SPACING constants (no arbitrary values)
- [ ] Using SEMANTIC_COLORS for states (success = phosphor, not cyan; no purple)
- [ ] Using TYPOGRAPHY for text sizing (serif for display, mono for data/body)
- [ ] Using TRANSITIONS for animations (color/border only, no lift/scale/glow)
- [ ] No `borderRadius` on cards/buttons/inputs/modals — sharp corners throughout
- [ ] Hairline borders used consistently (not solid white or glass borders)
- [ ] Buttons have border-highlight/color-shift + focus states
- [ ] Interactive elements have focus indicators (1px phosphor outline)
- [ ] Cards use Card component (not Box)
- [ ] Modals use standard padding (pb={6}) and sharp corners
- [ ] Labels/eyebrows are mono, uppercase, letterspaced
- [ ] No inline styles that bypass design system
- [ ] Tested on mobile, tablet, desktop
- [ ] No console errors
- [ ] Smoke tests passing

---

## 📖 Documentation

**Complete Documentation:**
- `docs/DESIGN_AUDIT.md` - Overall design system audit
- `docs/SPACING_AUDIT.md` - Spacing standards
- `docs/MODAL_PADDING_AUDIT.md` - Modal standards
- `docs/MICRO_INTERACTIONS_GUIDE.md` - Animation guide
- `docs/PLAYWRIGHT_SETUP.md` - Testing guide
- `docs/BUTTON_PATTERNS.md` - Button usage
- `docs/COMPONENT_GUIDE.md` - Component reference
- `.claude/skills/branding-guidelines/SKILL.md` - Full Living Typeface brand guide

**Config Files:**
- `config/spacing.ts` - Spacing scale & patterns
- `config/semanticColors.ts` - Color system
- `config/transitions.ts` - Animation library
- `helpers/typography.ts` - Typography scale

---

## 🚀 Summary

**Golden Rules:**
1. **NEVER** use arbitrary spacing values
2. **ALWAYS** use semantic colors for states (phosphor/teal/gold/blood — never purple/cyan)
3. **ALWAYS** use standardized transitions (color/border only — no lift, scale, or glow)
4. **ALWAYS** add focus indicators (1px phosphor outline)
5. **ALWAYS** use Card component for cards — sharp corners, hairline border
6. **ALWAYS** import from config files
7. **ALWAYS** use serif (Redaction) for display headings, mono (JetBrains Mono) for everything functional

**When in doubt:**
- Check `.claude/skills/branding-guidelines/SKILL.md` for the full token set and rationale
- Check existing components for patterns — but note the app's component long tail still contains
  legacy purple/cyan/glow code pending migration; don't copy those
- Read the documentation in `docs/`
- Use the Quick Reference above

---

**Design System Status:** Living Typeface migration in progress — this doc and the brand guide are
updated; component-level migration off legacy purple/cyan/glow is ongoing.
**Last Updated:** July 23, 2026
**Maintainer:** Design system standards enforced automatically

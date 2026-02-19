# Membrane App - Design System Standards

**CRITICAL:** All code changes MUST follow these standardized patterns. No exceptions.

---

## 🎨 Design System Components

### Typography

**Use standardized typography helpers from `helpers/typography.ts`:**

```tsx
import { TYPOGRAPHY } from '@/helpers/typography'

// Page titles
<Text fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold}>Page Title</Text>

// Section titles
<Text fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.semibold}>Section</Text>

// Card titles
<Text fontSize={TYPOGRAPHY.h4} fontWeight={TYPOGRAPHY.medium}>Card Title</Text>

// Body text
<Text fontSize={TYPOGRAPHY.body}>Content</Text>

// Labels (uppercase)
<Text fontSize={TYPOGRAPHY.label} textTransform="uppercase" color="whiteAlpha.600">
  Label
</Text>
```

**Scale:**
- h1: 32px (page titles)
- h2: 24px (section titles)
- h3: 18px (subsection titles)
- h4: 16px (card titles)
- body: 16px (primary text)
- small: 14px (secondary text)
- xs: 12px (tertiary text)
- label: 11px (labels, table headers - uppercase)

**Weights:**
- bold: 700
- semibold: 600
- medium: 500
- normal: 400

---

## 🎨 Colors

### Semantic Colors (`config/semanticColors.ts`)

**ALWAYS use semantic colors for states:**

```tsx
import { SEMANTIC_COLORS } from '@/config/semanticColors'

// State colors
bg={SEMANTIC_COLORS.success}  // #22d3ee (cyan) - positive outcomes
bg={SEMANTIC_COLORS.warning}  // #fbbf24 (yellow) - caution
bg={SEMANTIC_COLORS.danger}   // #ef4444 (red) - errors, critical
bg={SEMANTIC_COLORS.info}     // #60a5fa (blue) - informational

// Emphasis colors
bg={SEMANTIC_COLORS.primary}    // #A692FF (purple) - main CTAs
bg={SEMANTIC_COLORS.secondary}  // #4fcabb (teal) - secondary actions

// Text colors
color={SEMANTIC_COLORS.textPrimary}    // rgb(229, 222, 223)
color={SEMANTIC_COLORS.textSecondary}  // rgba(255, 255, 255, 0.6)
color={SEMANTIC_COLORS.textTertiary}   // rgba(255, 255, 255, 0.4)
```

**Color Usage Rules:**
- ❌ NEVER use random colors
- ❌ NEVER use `color="cyan.500"` for states
- ✅ ALWAYS use semantic color names
- ✅ Success = cyan, Warning = yellow, Danger = red

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

**ALL modals MUST use standardized padding:**

```tsx
<Modal isOpen={isOpen} onClose={onClose}>
  <ModalOverlay />
  <ModalContent>
    <ModalHeader>Title</ModalHeader>
    <ModalCloseButton />

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

**Standard:** `pb={6}` (24px) for ModalBody

---

## 🎬 Animations & Transitions

### Micro-Interactions (`config/transitions.ts`)

**ALL interactive elements MUST use standardized transitions:**

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
  transition={TRANSITIONS.transformAndShadow}
  _hover={HOVER_EFFECTS.lift}
  _active={ACTIVE_EFFECTS.press}
  _focus={FOCUS_STYLES.ring}
>
  Click me
</Button>

// Interactive Cards
<Card
  interactive  // Enables hover effects automatically
  onClick={handleClick}
>
  Content
</Card>

// Or custom card with Box
<Box
  onClick={handleClick}
  cursor="pointer"
  transition={TRANSITIONS.transformAndShadow}
  _hover={HOVER_EFFECTS.scale}
  _active={ACTIVE_EFFECTS.pressDown}
>
  Content
</Box>

// Animated Entrances (Framer Motion)
import { motion } from 'framer-motion'

<motion.div
  variants={MOTION_VARIANTS.fadeInUp}
  initial="hidden"
  animate="visible"
>
  Content
</motion.div>
```

**Animation Rules:**
- ❌ NEVER use inline transitions: `transition="all 0.2s"`
- ❌ NEVER use arbitrary timings: `transition="transform 0.35s"`
- ✅ ALWAYS import from `config/transitions.ts`
- ✅ ALWAYS use standardized hover effects
- ✅ ALWAYS add focus indicators for accessibility

**Available Effects:**
- `HOVER_EFFECTS.lift` - Lift up 2px + shadow (primary buttons)
- `HOVER_EFFECTS.liftSubtle` - Lift up 1px + shadow (secondary)
- `HOVER_EFFECTS.scale` - Scale to 1.02 (cards)
- `HOVER_EFFECTS.glow` - Purple glow (special emphasis)
- `HOVER_EFFECTS.brighten` - Brightness filter (icon buttons)
- `HOVER_EFFECTS.borderHighlight` - Border color change (ghost buttons)

---

## 🧩 Component Patterns

### Buttons

**Standard button patterns:**

```tsx
// Primary CTA (solid variant - default)
<Button
  colorScheme="purple"
  // Hover/active/focus states applied automatically via theme
>
  Primary Action
</Button>

// Secondary action (ghost variant)
<Button variant="ghost">
  Secondary Action
</Button>

// Outline variant
<Button variant="outline">
  Outline Action
</Button>

// Link variant
<Button variant="link">
  Link Action
</Button>
```

**Button Rules:**
- ❌ NEVER add custom hover states (theme handles it)
- ❌ NEVER use solid purple for repeated actions (use ghost)
- ✅ Button theme automatically applies lift effect
- ✅ Ghost buttons automatically get border highlight
- ✅ All buttons have focus rings

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
  interactive  // Enables hover effects
  onClick={handleClick}
>
  <Text>Clickable content</Text>
</Card>
```

**Card Rules:**
- ❌ NEVER use Box with inline card styling
- ❌ NEVER add custom hover effects
- ✅ ALWAYS use Card component
- ✅ Use `interactive` prop for clickable cards
- ✅ Variants: default, elevated, subtle

### Forms & Inputs

**Standard input patterns:**

```tsx
import { FOCUS_STYLES } from '@/config/transitions'

<Input
  placeholder="Enter amount"
  transition={TRANSITIONS.all}
  _focus={FOCUS_STYLES.ring}  // Purple focus ring
  _invalid={{
    borderColor: SEMANTIC_COLORS.danger,
    boxShadow: '0 0 0 3px rgba(239, 68, 68, 0.2)',
  }}
/>

// With error state
<FormControl isInvalid={hasError}>
  <FormLabel fontSize={TYPOGRAPHY.label} textTransform="uppercase">
    Amount
  </FormLabel>
  <Input {...inputProps} />
  <FormErrorMessage color={SEMANTIC_COLORS.danger}>
    {errorMessage}
  </FormErrorMessage>
</FormControl>
```

**Form Rules:**
- ✅ ALWAYS use focus rings for accessibility
- ✅ ALWAYS use semantic colors for validation
- ✅ Labels should be uppercase (11px)
- ✅ Error messages use danger color

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
- ✅ Focus indicators required (WCAG 2.1 AA)
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

// Random colors
<Text color="cyan.500">Success!</Text>

// No focus indicators
<Box as="button" onClick={handleClick}>

// Arbitrary font sizes
<Text fontSize="17px" fontWeight={550}>

// Inline card styling
<Box bg="rgba(10,10,10,0.8)" borderRadius="24px" p={6}>

// Custom hover without standards
<Button _hover={{ transform: "translateY(-3px)" }}>

// No semantic meaning
<Text color="#22d3ee">Completed</Text>
```

### ✅ DO THIS INSTEAD:

```tsx
// Standardized spacing
<Box p={SPACING.base} gap={SPACING_PATTERNS.sectionGap}>

// Standardized transitions
<Button
  transition={TRANSITIONS.transformAndShadow}
  _hover={HOVER_EFFECTS.lift}
  _focus={FOCUS_STYLES.ring}
>

// Semantic colors
<Text color={SEMANTIC_COLORS.success}>Success!</Text>

// Typography scale
<Text fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.medium}>

// Card component
<Card variant="default">

// Semantic color with meaning
<Text color={SEMANTIC_COLORS.success}>Completed</Text>
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
  transition={TRANSITIONS.transformAndShadow}
  _hover={HOVER_EFFECTS.lift}
  _active={ACTIVE_EFFECTS.press}
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
  <FormLabel fontSize={TYPOGRAPHY.label} textTransform="uppercase">
    Label
  </FormLabel>
  <Input _focus={FOCUS_STYLES.ring} />
</FormControl>
```

---

## 🎯 Design System Compliance Checklist

Before submitting any PR, verify:

- [ ] Using SPACING constants (no arbitrary values)
- [ ] Using SEMANTIC_COLORS for states
- [ ] Using TYPOGRAPHY for text sizing
- [ ] Using TRANSITIONS for animations
- [ ] Buttons have hover/active/focus states
- [ ] Interactive elements have focus indicators
- [ ] Cards use Card component (not Box)
- [ ] Modals use standard padding (pb={6})
- [ ] No inline styles that bypass design system
- [ ] Tested on mobile, tablet, desktop
- [ ] No console errors
- [ ] Smoke tests passing

---

## 📖 Documentation

**Complete Documentation:**
- `docs/DESIGN_AUDIT.md` - Overall design system audit (95% complete!)
- `docs/SPACING_AUDIT.md` - Spacing standards
- `docs/MODAL_PADDING_AUDIT.md` - Modal standards
- `docs/MICRO_INTERACTIONS_GUIDE.md` - Animation guide
- `docs/PLAYWRIGHT_SETUP.md` - Testing guide
- `docs/BUTTON_PATTERNS.md` - Button usage
- `docs/COMPONENT_GUIDE.md` - Component reference

**Config Files:**
- `config/spacing.ts` - Spacing scale & patterns
- `config/semanticColors.ts` - Color system
- `config/transitions.ts` - Animation library
- `helpers/typography.ts` - Typography scale

---

## 🚀 Summary

**Golden Rules:**
1. **NEVER** use arbitrary spacing values
2. **ALWAYS** use semantic colors for states
3. **ALWAYS** use standardized transitions
4. **ALWAYS** add focus indicators
5. **ALWAYS** use Card component for cards
6. **ALWAYS** import from config files

**When in doubt:**
- Check existing components for patterns
- Read the documentation in `docs/`
- Use the Quick Reference above

---

**Design System Status:** 95% Complete (21/22 items)
**Last Updated:** February 6, 2026
**Maintainer:** Design system standards enforced automatically

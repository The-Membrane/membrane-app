# Claude Code - Membrane App Configuration

## 📋 Before Making ANY Code Changes

**CHECK THIS FIRST:** [`../CLAUDE.md`](../CLAUDE.md)

This file contains ALL design system standards that must be followed.

## Quick Links

### Primary Reference
- **Main Standards:** [`../CLAUDE.md`](../CLAUDE.md) ⭐ **READ THIS FIRST**

### Documentation
- Master Audit: [`../docs/DESIGN_AUDIT.md`](../docs/DESIGN_AUDIT.md)
- Spacing Standards: [`../docs/SPACING_AUDIT.md`](../docs/SPACING_AUDIT.md)
- Animations: [`../docs/MICRO_INTERACTIONS_GUIDE.md`](../docs/MICRO_INTERACTIONS_GUIDE.md)
- Testing: [`../docs/PLAYWRIGHT_SETUP.md`](../docs/PLAYWRIGHT_SETUP.md)
- Performance: [`../docs/PERFORMANCE_AUDIT.md`](../docs/PERFORMANCE_AUDIT.md)

### Config Files
- [`../config/spacing.ts`](../config/spacing.ts) - Spacing scale
- [`../config/semanticColors.ts`](../config/semanticColors.ts) - Colors
- [`../config/transitions.ts`](../config/transitions.ts) - Animations

## 🚫 Never Do This

```tsx
// ❌ Arbitrary spacing
<Box p={5} gap="20px">

// ❌ Random colors
<Text color="cyan.500">

// ❌ Inline transitions
<Button transition="all 0.2s">

// ❌ No focus indicators
<Box as="button">
```

## ✅ Always Do This

```tsx
// ✅ Standardized spacing
import { SPACING_PATTERNS } from '@/config/spacing'
<Box p={SPACING_PATTERNS.cardPadding}>

// ✅ Semantic colors
import { SEMANTIC_COLORS } from '@/config/semanticColors'
<Text color={SEMANTIC_COLORS.success}>

// ✅ Pre-built transitions
import { TRANSITIONS, HOVER_EFFECTS } from '@/config/transitions'
<Button
  transition={TRANSITIONS.transformAndShadow}
  _hover={HOVER_EFFECTS.lift}
>

// ✅ Focus indicators
import { FOCUS_STYLES } from '@/config/transitions'
<Box as="button" _focus={FOCUS_STYLES.ring}>
```

## Project Status

✅ **Design System: 100% Complete**
- All 22 items finished
- All documentation complete
- Enforcement rules in CLAUDE.md
- 260+ automated tests

## Auto-Loading

This project is configured to automatically load:
1. ✅ `CLAUDE.md` (root) - Design system standards
2. ✅ `memory/MEMORY.md` - Project context
3. ✅ This README for reference

All future Claude Code sessions will have these standards loaded automatically.

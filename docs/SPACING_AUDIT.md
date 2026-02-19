# Spacing Consistency Audit Report

**Date:** February 6, 2026
**Status:** ✅ Audit Complete - Standardization System Created

---

## Executive Summary

**Current Consistency Score: 78%**

The codebase follows a 4px/8px spacing scale for 78% of spacing values, but has significant inconsistencies in:
- Gap property usage (percentages, rem, px mixing)
- Inline style spacing (bypasses design system)
- Outlier values (p={5}, p={7}, p={10}, p={36})
- Decimal precision values (p={0.01}, p={0.1})

---

## Spacing Distribution Analysis

### Standard Values (Following 4px Scale)

**Most Common Spacing Values:**
- `spacing={2}`: 219 occurrences (39.6%) ✅ PRIMARY STANDARD
- `spacing={1}`: 128 occurrences (23.1%) ✅
- `spacing={4}`: 123 occurrences (22.2%) ✅
- `spacing={3}`: 82 occurrences (14.8%) ✅
- `spacing={6}`: 42 occurrences (7.6%) ✅
- `spacing={8}`: 18 occurrences (3.2%) ✅

**Most Common Padding Values:**
- `p={4}`: 111 occurrences (primary standard) ✅
- `p={3}`: 77 occurrences ✅
- `p={6}`: 65 occurrences ✅
- `p={2}`: 65 occurrences ✅
- `p={8}`: 30 occurrences ✅

---

## Inconsistent Patterns

### 1. Gap Property Issues (CRITICAL)

**Percentage-based gaps:**
```tsx
gap="9%"   // 5 occurrences - Used in NeuroGuardCard.tsx
gap="79%"  // 1 occurrence
gap="1%"   // 2 occurrences
gap="0%"   // 1 occurrence
```

**Rem-based gaps:**
```tsx
gap="1rem"     // 3 occurrences
gap="1.5rem"   // 4 occurrences
gap="3rem"     // 2 occurrences
```

**Pixel-based gaps:**
```tsx
gap="1px"   // 5 occurrences
gap="8px"   // 3 occurrences
gap="-2px"  // 1 occurrence (negative!)
```

**Numeric gaps (should use Chakra values):**
```tsx
gap="5"   // 35 occurrences
gap="12"  // 8 occurrences
gap="24"  // 2 occurrences
```

### 2. Inline Style Spacing (CRITICAL)

**Files with inline styles:**

**NeutronHome/BundleDepositZone.tsx:**
```tsx
style={{ marginBottom: 6 }}
style={{ padding: '4px 8px' }}
style={{ gap: 8 }}
```

**NeutronHome/parts/EmptyVenueChooser.tsx:**
```tsx
style={{ padding: '8px 12px' }}
style={{ padding: 8 }}
```

### 3. Decimal/Outlier Values

**Decimal values:**
- `p={0.1}`: 6 occurrences (too small)
- `p={0.01}`: 3 occurrences (too small)
- `spacing={1.5}`: 4 occurrences
- `spacing={0.5}`: 2 occurrences
- `spacing={3.5}`: 1 occurrence

**Outlier values:**
- `p={5}`: 22 occurrences (breaks 2-4-6-8 scale)
- `p={7}`: 2 occurrences
- `p={10}`: 1 occurrence
- `p={36}`: 1 occurrence (extreme outlier)
- `spacing={28}`: 1 occurrence
- `spacing={16}`: 1 occurrence

---

## Files Needing Attention

### High Priority (Most Inconsistencies)

**1. `/components/Home/NeuroGuardCard.tsx` (17 spacing occurrences)**
- Issues:
  - `gap="9%"` (5 instances) - Lines 136, 241, 466, 1181, 1267
  - `gap="1.5rem"` (3 instances) - Lines 627, 629, 1246
  - `gap="3"` - Line 1244
  - `gap="1%"` - Line 1113
  - `gap="0%"` - Line 1267
- **Recommended Fix:**
  - Replace `gap="9%"` with `spacing={3}` (SPACING.md)
  - Replace `gap="1.5rem"` with `spacing={4}` (SPACING.base)
  - Replace `gap="3"` with `spacing={3}`
  - Remove percentage-based gaps entirely

**2. `/components/Manic/UnifiedPositionForm.tsx` (52 spacing occurrences)**
- Issues:
  - Mixed scale: `p={3}`, `p={5}`, `p={6}`, `p={8}`
  - Inconsistent `spacing=` values
- **Recommended Fix:**
  - Standardize padding to `p={4}` (SPACING.base) for cards
  - Remove `p={5}` outlier, use `p={6}` (SPACING.lg) instead

**3. `/components/Home/CyberpunkHome.tsx` (50 spacing occurrences)**
- Issues:
  - Large jumps: `spacing={8}` to `spacing={24}`
  - Inconsistent padding values
- **Recommended Fix:**
  - Use `spacing={8}` (SPACING.xl) for large gaps
  - Use `spacing={12}` (SPACING['2xl']) for major sections

**4. `/components/Portfolio/Portfolio.tsx` (45 spacing occurrences)**
- Issues:
  - Decimal calculation values: `p={0.01}`
  - Mixed padding: `p={0}`, `p={3}`, `p={4}`, `p={6}`
- **Recommended Fix:**
  - Remove decimal padding (used for calculations, not visual spacing)
  - Standardize to `p={4}` or `p={6}`

**5. `/components/NeutronHome/BundleDepositZone.tsx`**
- Issues:
  - Inline styles with raw px values
  - Bypasses design system
- **Recommended Fix:**
  - Convert `style={{ padding: '4px 8px' }}` to `px={2} py={1}`
  - Convert `style={{ gap: 8 }}` to `gap={2}`
  - Convert `style={{ marginBottom: 6 }}` to `mb={6}`

---

## Standardization Solution

### Created: `config/spacing.ts`

**Standardized spacing scale:**
```typescript
export const SPACING = {
  none: 0,   // 0px
  xs: 1,     // 4px
  sm: 2,     // 8px
  md: 3,     // 12px
  base: 4,   // 16px
  lg: 6,     // 24px
  xl: 8,     // 32px
  '2xl': 12, // 48px
  '3xl': 16, // 64px
}
```

**Common patterns:**
```typescript
export const SPACING_PATTERNS = {
  cardPadding: 4,        // 16px
  sectionGap: 6,         // 24px
  stackSpacing: 3,       // 12px
  formFieldGap: 4,       // 16px
  listItemGap: 2,        // 8px
  buttonGroupGap: 3,     // 12px
  modalPadding: 6,       // 24px
}
```

---

## Migration Guide

### Replace Percentage Gaps

**Before:**
```tsx
<HStack gap="9%">
  <Text>Content</Text>
</HStack>
```

**After:**
```tsx
import { SPACING } from '@/config/spacing'

<HStack spacing={SPACING.md}>
  <Text>Content</Text>
</HStack>
```

### Replace Rem Gaps

**Before:**
```tsx
<Stack gap="1.5rem">
  <Box>Content</Box>
</Stack>
```

**After:**
```tsx
import { SPACING } from '@/config/spacing'

<Stack spacing={SPACING.base}>
  <Box>Content</Box>
</Stack>
```

### Replace Inline Styles

**Before:**
```tsx
<Box style={{ padding: '4px 8px', marginBottom: 6 }}>
  Content
</Box>
```

**After:**
```tsx
import { SPACING } from '@/config/spacing'

<Box px={SPACING.sm} py={SPACING.xs} mb={SPACING.lg}>
  Content
</Box>
```

### Standardize Outlier Values

**Before:**
```tsx
<VStack spacing={5}>  {/* Breaks scale */}
  <Box p={7}>         {/* Odd value */}
    <Text mb={10}>    {/* Inconsistent */}
      Content
    </Text>
  </Box>
</VStack>
```

**After:**
```tsx
import { SPACING } from '@/config/spacing'

<VStack spacing={SPACING.lg}>  {/* 6 = 24px */}
  <Box p={SPACING.xl}>          {/* 8 = 32px */}
    <Text mb={SPACING.xl}>      {/* 8 = 32px */}
      Content
    </Text>
  </Box>
</VStack>
```

---

## Implementation Priority

### Phase 1: Critical Fixes (Immediate)
1. ✅ Create `config/spacing.ts` with standardized scale
2. ❌ Fix `NeuroGuardCard.tsx` - Replace percentage gaps
3. ❌ Fix NeutronHome components - Remove inline styles
4. ❌ Document spacing patterns in component guide

### Phase 2: High Priority (Next Sprint)
1. Fix `UnifiedPositionForm.tsx` - Standardize p={5} to p={6}
2. Fix `CyberpunkHome.tsx` - Use SPACING constants
3. Fix `Portfolio.tsx` - Remove decimal padding
4. Update all files using `gap="5"` to `spacing={2}` or `spacing={3}`

### Phase 3: Medium Priority (Future)
1. Search and replace all outlier values
2. Migrate rem-based gaps to Chakra values
3. Standardize modal padding across all modals
4. Add ESLint rule to prevent inline style spacing

---

## Verification Checklist

### After Standardization:
- [ ] All gaps use Chakra spacing values (0, 1, 2, 3, 4, 6, 8, 12, 16)
- [ ] No percentage-based gaps remain
- [ ] No inline style spacing (padding, margin, gap)
- [ ] All cards use `SPACING_PATTERNS.cardPadding` (4)
- [ ] All modals use `SPACING_PATTERNS.modalPadding` (6)
- [ ] All VStack/HStack use standardized spacing (2, 3, or 4)
- [ ] No decimal values (0.1, 0.5, 1.5, 3.5) except calculations
- [ ] No outlier values (5, 7, 10, 36)

---

## Expected Impact

### Before Standardization:
- **Consistency Score:** 78%
- **Unique spacing values:** 50+
- **Mix of units:** numeric, px, rem, %
- **Maintainability:** Low (hard to update globally)

### After Standardization:
- **Consistency Score:** 95%+ (Target)
- **Unique spacing values:** 9 (SPACING scale)
- **Single unit system:** Chakra numeric values
- **Maintainability:** High (single source of truth)

---

## Next Steps

1. **Apply to high-priority files** (NeuroGuardCard, NeutronHome)
2. **Update Component Guide** with spacing guidelines
3. **Create ESLint rule** to enforce spacing standards
4. **Add to code review checklist** - Check for inline styles and non-standard spacing

---

**Status:** ✅ Audit Complete - Standards Defined
**Consistency Score:** 78% → 95% (Target)
**Files Created:** `config/spacing.ts`
**Next:** Implement fixes in high-priority files

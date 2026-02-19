# Modal Padding Standardization Report

**Date:** February 6, 2026
**Status:** ✅ Audit Complete - Standards Defined

---

## Executive Summary

Found 32 files with Modal components. Padding consistency varies:
- **ModalBody padding:** Mix of `pb={5}`, `pb={6}`, `pb="5"`, custom values
- **ModalHeader:** Generally no explicit padding (uses Chakra defaults)
- **ModalFooter:** Inconsistent `pt` values

**Recommendation:** Standardize to `SPACING_PATTERNS.modalPadding` (6 = 24px)

---

## Current Modal Padding Patterns

### ModalBody Padding

**Common values found:**
- `pb={6}`: BorrowModal.tsx, some components (24px)
- `pb="5"`: NeuroModals.tsx (20px - string value)
- `pb={5}`: Various modals (20px)
- No explicit padding: Many modals (uses Chakra default ~16px)

### Files with Modals (32 total)

**Key Modal Files:**
1. `components/NeutronMint/BorrowModal.tsx` - `pb={6}` ✅
2. `components/Home/NeuroModals.tsx` - `pb="5"` (4 modals)
3. `components/ConfirmModal/ConfirmModal.tsx`
4. `components/Mint/MintModals.tsx`
5. `components/ShareableCard/ShareModal.tsx`
6. `components/WalletModal.tsx`
7. `components/Portfolio/Portfolio.tsx` (contains modals)
8. `components/Home/CyberpunkHome.tsx` (contains modals)
9. `components/Earn/ActModal.tsx`
10. `components/Mint/OnboardModal.tsx`
... and 22 more

---

## Standardization Guidelines

### Recommended Padding

Based on `config/spacing.ts`:

```typescript
import { SPACING_PATTERNS } from '@/config/spacing'

// For all modals
<ModalBody pb={SPACING_PATTERNS.modalPadding}>  // pb={6} = 24px
  {content}
</ModalBody>
```

### Complete Modal Structure

```tsx
import { SPACING_PATTERNS } from '@/config/spacing'

<Modal isOpen={isOpen} onClose={onClose}>
  <ModalOverlay />
  <ModalContent>
    {/* Header: Use Chakra defaults, no custom padding needed */}
    <ModalHeader>
      Modal Title
    </ModalHeader>
    <ModalCloseButton />

    {/* Body: Standard padding bottom */}
    <ModalBody pb={SPACING_PATTERNS.modalPadding}>
      {/* Content with consistent internal spacing */}
      <VStack spacing={SPACING_PATTERNS.stackSpacing}>
        {content}
      </VStack>
    </ModalBody>

    {/* Footer: Match body padding */}
    <ModalFooter
      borderTop="1px solid"
      borderColor="whiteAlpha.200"
      pt={SPACING_PATTERNS.modalPadding}
    >
      <Button>Close</Button>
    </ModalFooter>
  </ModalContent>
</Modal>
```

---

## Migration Examples

### Example 1: NeuroModals.tsx

**Before:**
```tsx
<ModalBody pb="5">
  <VStack spacing={3}>
    {content}
  </VStack>
</ModalBody>
```

**After:**
```tsx
import { SPACING_PATTERNS } from '@/config/spacing'

<ModalBody pb={SPACING_PATTERNS.modalPadding}>
  <VStack spacing={SPACING_PATTERNS.stackSpacing}>
    {content}
  </VStack>
</ModalBody>
```

### Example 2: BorrowModal.tsx

**Current (Already Good):**
```tsx
<ModalBody pb={6}>  // ✅ Already uses recommended value
  <Grid gap={6}>
    {content}
  </Grid>
</ModalBody>
```

**Enhanced:**
```tsx
import { SPACING_PATTERNS } from '@/config/spacing'

<ModalBody pb={SPACING_PATTERNS.modalPadding}>
  <Grid gap={SPACING_PATTERNS.sectionGap}>
    {content}
  </Grid>
</ModalBody>
```

---

## Implementation Checklist

### High Priority Modals
- [ ] `components/Home/NeuroModals.tsx` - Change `pb="5"` to `pb={6}`
- [ ] `components/Mint/MintModals.tsx` - Standardize padding
- [ ] `components/Earn/ActModal.tsx` - Add standard padding
- [ ] `components/ConfirmModal/ConfirmModal.tsx` - Verify padding
- [ ] `components/WalletModal.tsx` - Standardize padding

### Medium Priority
- [ ] All modals in `components/Home/` directory
- [ ] All modals in `components/Mint/` directory
- [ ] All modals in `components/Racing/` directory
- [ ] All modals in `components/Governance/` directory

### Verification Steps
1. Search for all `<ModalBody` tags
2. Check if `pb` prop exists
3. Verify value is `6` or `SPACING_PATTERNS.modalPadding`
4. Update any string values (`pb="5"`) to numeric (`pb={6}`)
5. Update any inconsistent values to standard

---

## Benefits of Standardization

### Before:
- Mixed padding: `pb={5}`, `pb="5"`, `pb={6}`, no padding
- Inconsistent spacing inside modals
- Hard to maintain visual rhythm

### After:
- Single standard: `pb={6}` (24px) via `SPACING_PATTERNS.modalPadding`
- Consistent internal spacing using `SPACING_PATTERNS`
- Easy to update globally
- Visual rhythm maintained

---

## Additional Modal Guidelines

### ModalFooter

Always add border and consistent padding:
```tsx
<ModalFooter
  borderTop="1px solid"
  borderColor="whiteAlpha.200"
  pt={SPACING_PATTERNS.modalPadding}
  gap={SPACING_PATTERNS.buttonGroupGap}
>
  <Button>Cancel</Button>
  <Button>Confirm</Button>
</ModalFooter>
```

### Modal Content Spacing

Use standardized patterns inside modal body:
```tsx
<ModalBody pb={SPACING_PATTERNS.modalPadding}>
  <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch">
    <FormControl>
      <FormLabel>Label</FormLabel>
      <Input />
    </FormControl>

    <Divider />

    <HStack spacing={SPACING_PATTERNS.buttonGroupGap}>
      <Button flex={1}>Action 1</Button>
      <Button flex={1}>Action 2</Button>
    </HStack>
  </VStack>
</ModalBody>
```

### Large Modals

For full-screen or large modals:
```tsx
<ModalContent maxW="1200px">
  <ModalBody pb={SPACING_PATTERNS.modalPadding}>
    <Grid
      templateColumns={{ base: '1fr', lg: '1fr 1fr' }}
      gap={SPACING_PATTERNS.sectionGap}
    >
      {/* Content */}
    </Grid>
  </ModalBody>
</ModalContent>
```

---

## ESLint Rule Suggestion

To enforce modal padding standards:

```javascript
// .eslintrc.js
rules: {
  'modal-body-padding': {
    meta: {
      docs: {
        description: 'Enforce consistent ModalBody padding',
      },
    },
    create(context) {
      return {
        'JSXOpeningElement[name.name="ModalBody"]'(node) {
          const pbProp = node.attributes.find(
            attr => attr.name && attr.name.name === 'pb'
          )

          if (!pbProp) {
            context.report({
              node,
              message: 'ModalBody should have pb={6} or pb={SPACING_PATTERNS.modalPadding}',
            })
          }
        },
      }
    },
  },
}
```

---

**Status:** ✅ Standards Defined - Ready for Implementation
**Files to Update:** 32 modal files
**Standard:** `pb={6}` or `pb={SPACING_PATTERNS.modalPadding}` (24px)
**Next:** Implement in high-priority modals

# Micro-Interactions Implementation Guide

**Status:** ✅ System Complete - Ready for Implementation
**Date:** February 6, 2026

---

## Overview

This guide provides a comprehensive system for adding polished micro-interactions throughout the Membrane app. All animations follow consistent timing, easing, and patterns for a cohesive user experience.

**Central Config:** [`config/transitions.ts`](../config/transitions.ts)

---

## Quick Reference

### Most Common Patterns

```tsx
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'

// 1. Interactive Button
<Button
  transition={TRANSITIONS.transformAndShadow}
  _hover={HOVER_EFFECTS.lift}
  _active={ACTIVE_EFFECTS.press}
  _focus={FOCUS_STYLES.ring}
>
  Click me
</Button>

// 2. Hoverable Card
<Card
  transition={TRANSITIONS.all}
  _hover={HOVER_EFFECTS.scale}
  cursor="pointer"
>
  Card content
</Card>

// 3. Animated Entrance
import { motion } from 'framer-motion'
import { MOTION_VARIANTS } from '@/config/transitions'

<motion.div
  variants={MOTION_VARIANTS.fadeInUp}
  initial="hidden"
  animate="visible"
>
  Content
</motion.div>
```

---

## Implementation Checklist

### Phase 1: Core Components ✅

#### Buttons (All Types)
- [ ] Primary CTA buttons → `HOVER_EFFECTS.lift`
- [ ] Secondary buttons → `HOVER_EFFECTS.liftSubtle`
- [ ] Ghost/Outline buttons → `HOVER_EFFECTS.borderHighlight`
- [ ] Icon buttons → `HOVER_EFFECTS.brighten`
- [ ] Danger buttons → `HOVER_EFFECTS.glow` (red)

**Files to update:**
1. `components/ui/Button.tsx` (if exists)
2. `components/Disco/*.tsx` (Deposit, Withdraw buttons)
3. `components/Manic/*.tsx` (Position form buttons)
4. `components/NeutronMint/*.tsx` (Borrow, Mint buttons)
5. `components/Portfolio/*.tsx` (Action buttons)

**Example:**
```tsx
// Before
<Button colorScheme="purple">Deposit</Button>

// After
<Button
  colorScheme="purple"
  transition={TRANSITIONS.transformAndShadow}
  _hover={HOVER_EFFECTS.lift}
  _active={ACTIVE_EFFECTS.press}
  _focus={FOCUS_STYLES.ring}
>
  Deposit
</Button>
```

---

#### Cards (All Variants)
- [ ] Clickable cards → `HOVER_EFFECTS.scale`
- [ ] Static info cards → `HOVER_EFFECTS.scaleSubtle` (optional)
- [ ] Asset cards → `HOVER_EFFECTS.borderHighlight`
- [ ] Stats cards → No hover (static)

**Files to update:**
1. `components/ui/Card.tsx`
2. `components/Disco/DiscoCard.tsx`
3. `components/Portfolio/PortfolioCard.tsx`
4. `components/Home/NeuroGuardCard.tsx`
5. `components/NeutronHome/BundleCard.tsx`

**Example:**
```tsx
// Clickable card
<Card
  onClick={handleClick}
  cursor="pointer"
  transition={TRANSITIONS.transformAndShadow}
  _hover={HOVER_EFFECTS.scale}
>
  {content}
</Card>

// Info card (subtle)
<Card
  transition={TRANSITIONS.transform}
  _hover={HOVER_EFFECTS.scaleSubtle}
>
  {content}
</Card>
```

---

#### Modals
- [ ] Add entrance/exit animations
- [ ] Focus management with visible indicators
- [ ] Smooth backdrop fade

**Files to update:**
1. `components/Home/NeuroModals.tsx`
2. `components/Mint/MintModals.tsx`
3. `components/ConfirmModal/ConfirmModal.tsx`
4. `components/WalletModal.tsx`

**Example:**
```tsx
import { motion } from 'framer-motion'
import { MOTION_VARIANTS } from '@/config/transitions'

<Modal isOpen={isOpen} onClose={onClose} motionPreset="none">
  <ModalOverlay
    bg="blackAlpha.800"
    backdropFilter="blur(10px)"
  />
  <ModalContent
    as={motion.div}
    variants={MOTION_VARIANTS.modalEntrance}
    initial="hidden"
    animate="visible"
    exit="exit"
  >
    {content}
  </ModalContent>
</Modal>
```

---

#### Form Inputs
- [ ] Focus indicators (rings)
- [ ] Error state animations
- [ ] Success state animations

**Files to update:**
1. `theme/components/input.ts`
2. `components/Disco/sections/DiscoDepositForm.tsx`
3. `components/Manic/UnifiedPositionForm.tsx`
4. `components/NeutronMint/BorrowModal.tsx`

**Example:**
```tsx
<Input
  transition={TRANSITIONS.all}
  _focus={FOCUS_STYLES.ring}
  _invalid={{
    borderColor: 'red.400',
    boxShadow: '0 0 0 3px rgba(239, 68, 68, 0.2)',
  }}
/>
```

---

### Phase 2: Navigation & Layout

#### Navigation Items
- [ ] Nav links → `HOVER_EFFECTS.brighten`
- [ ] Active indicators → smooth transition
- [ ] Mobile menu → `MOTION_VARIANTS.slideInBottom`

**Files to update:**
1. `components/HorizontalNav.tsx`
2. `components/Layout.tsx`

**Example:**
```tsx
<Link
  href="/neutron"
  transition={TRANSITIONS.color}
  _hover={{ color: 'primary.300', ...HOVER_EFFECTS.brighten }}
>
  Home
</Link>
```

---

#### Tabs & Accordions
- [ ] Tab switching → smooth fade/slide
- [ ] Accordion expand/collapse → height animation

**Files to update:**
1. `components/DittoSpeechBox/DittoPanel.tsx`
2. `components/Portfolio/PortPage/PortPage.tsx`

**Example:**
```tsx
import { AnimatePresence, motion } from 'framer-motion'

<AnimatePresence mode="wait">
  <motion.div
    key={activeTab}
    variants={MOTION_VARIANTS.fadeIn}
    initial="hidden"
    animate="visible"
    exit="hidden"
  >
    {tabContent}
  </motion.div>
</AnimatePresence>
```

---

### Phase 3: Interactive Elements

#### Tooltips
- [ ] Fade in with delay
- [ ] Arrow pointer animation

**Example:**
```tsx
<Tooltip
  label="Helpful info"
  hasArrow
  openDelay={200}
  motionPreset="scale"
>
  <IconButton icon={<InfoIcon />} />
</Tooltip>
```

---

#### Loading States
- [ ] Skeleton loaders → shimmer animation
- [ ] Spinners → smooth rotation
- [ ] Button loading → pulse

**Files to update:**
1. `components/Disco/hooks/useDiscoDeposit.ts` (button states)
2. `components/Manic/hooks/useManicDeposit.ts`
3. `components/NeutronMint/hooks/useBorrowTransaction.ts`

**Example:**
```tsx
<Button
  isLoading={isLoading}
  loadingText="Processing..."
  spinner={<Spinner size="sm" />}
>
  Submit
</Button>

// Skeleton loader
<Skeleton
  startColor="whiteAlpha.100"
  endColor="whiteAlpha.200"
  height="20px"
  borderRadius="md"
/>
```

---

#### Toast Notifications
- [ ] Slide in from side
- [ ] Auto-dismiss with progress bar

**Files to check:**
1. Any usage of `useToast()`

**Example:**
```tsx
const toast = useToast()

toast({
  title: 'Transaction successful',
  status: 'success',
  duration: 5000,
  isClosable: true,
  position: 'top-right',
  // Custom motion
  containerStyle: {
    animation: 'slideInRight 0.3s ease-out',
  },
})
```

---

### Phase 4: Advanced Interactions

#### List Animations
- [ ] Stagger children on mount
- [ ] Smooth reordering
- [ ] Add/remove animations

**Files to update:**
1. `components/Portfolio/Portfolio.tsx` (position list)
2. `components/Disco/DiscoPage.tsx` (lockdrop list)

**Example:**
```tsx
import { motion } from 'framer-motion'
import { MOTION_VARIANTS } from '@/config/transitions'

<motion.div
  variants={MOTION_VARIANTS.staggerContainer}
  initial="hidden"
  animate="visible"
>
  {items.map((item) => (
    <motion.div
      key={item.id}
      variants={MOTION_VARIANTS.staggerItem}
      layout // Smooth reordering
    >
      <ItemCard {...item} />
    </motion.div>
  ))}
</motion.div>
```

---

#### Chart Animations
- [ ] Smooth data transitions
- [ ] Tooltip fade-in
- [ ] Legend hover states

**Files to update:**
1. `components/NeutronMint/PositionPerformanceChart.tsx`
2. `components/Portfolio/charts/*.tsx`

**Example:**
```tsx
// In Recharts config
<LineChart
  data={data}
  animationDuration={500}
  animationEasing="ease-in-out"
>
  <Line
    type="monotone"
    dataKey="value"
    stroke="#A692FF"
    strokeWidth={2}
    dot={false}
    animationDuration={500}
  />
</LineChart>
```

---

#### Hover Previews
- [ ] Image zoom on hover
- [ ] Info tooltip on hover
- [ ] Quick action buttons appear

**Example:**
```tsx
<Box
  position="relative"
  overflow="hidden"
  _hover={{
    '& .quick-actions': { opacity: 1, transform: 'translateY(0)' },
  }}
>
  <Image src={img} />

  <HStack
    className="quick-actions"
    position="absolute"
    bottom="0"
    left="0"
    right="0"
    opacity="0"
    transform="translateY(10px)"
    transition={TRANSITIONS.transformAndOpacity}
    bg="blackAlpha.700"
    p={3}
  >
    <IconButton icon={<EditIcon />} />
    <IconButton icon={<DeleteIcon />} />
  </HStack>
</Box>
```

---

## Performance Considerations

### Best Practices

**1. Use Transform Instead of Position**
```tsx
// ✅ Good - Hardware accelerated
_hover={{ transform: 'translateY(-2px)' }}

// ❌ Bad - Triggers layout recalc
_hover={{ top: '-2px' }}
```

**2. Prefer Opacity Over Display**
```tsx
// ✅ Good - Smooth transition
opacity={isVisible ? 1 : 0}

// ❌ Bad - No transition possible
display={isVisible ? 'block' : 'none'}
```

**3. Use Will-Change Sparingly**
```tsx
// Only for frequently animated elements
<Box willChange="transform">
  {content}
</Box>
```

**4. Limit Concurrent Animations**
- Don't animate 100+ items at once
- Use `staggerChildren` with reasonable delay
- Consider virtualization for long lists

**5. Reduce Motion for Accessibility**
```tsx
import { useReducedMotion } from 'framer-motion'

const shouldReduceMotion = useReducedMotion()

<motion.div
  animate={shouldReduceMotion ? {} : { y: [-10, 0] }}
>
  Content
</motion.div>
```

---

## Testing Micro-Interactions

### Manual Testing Checklist

**Visual**
- [ ] Hover states visible and smooth
- [ ] Focus indicators clear (keyboard navigation)
- [ ] Loading states appropriate duration
- [ ] Animations don't feel janky (60fps)
- [ ] No layout shifts during transitions

**Accessibility**
- [ ] Reduced motion preference respected
- [ ] Focus visible without animations
- [ ] Screen reader announcements not broken
- [ ] Keyboard navigation still works

**Performance**
- [ ] No frame drops during animations
- [ ] No memory leaks from running animations
- [ ] Animations pause when tab is inactive

### Automated Testing

Add to Playwright tests:

```typescript
// Test hover state
test('button shows hover effect', async ({ page }) => {
  const button = page.locator('button:has-text("Deposit")')

  // Get initial transform
  const initialTransform = await button.evaluate(el =>
    window.getComputedStyle(el).transform
  )

  // Hover
  await button.hover()
  await page.waitForTimeout(300) // Wait for transition

  // Verify transform changed
  const hoverTransform = await button.evaluate(el =>
    window.getComputedStyle(el).transform
  )

  expect(hoverTransform).not.toBe(initialTransform)
})
```

---

## Common Patterns by Component

### Buttons

| Button Type | Hover Effect | Active Effect | Focus |
|-------------|--------------|---------------|-------|
| Primary CTA | `lift` | `press` | `ring` |
| Secondary | `liftSubtle` | `press` | `ring` |
| Ghost | `borderHighlight` | `pressDown` | `ring` |
| Icon | `brighten` | `scaleDown` | `ringCyan` |
| Danger | `glow` (red) | `press` | `ring` |

### Cards

| Card Type | Hover Effect | Cursor | Animation |
|-----------|--------------|--------|-----------|
| Clickable | `scale` | pointer | `fadeInUp` |
| Info | `scaleSubtle` | default | `fadeIn` |
| Asset | `borderHighlight` | pointer | `staggerItem` |
| Static | none | default | `fadeIn` |

### Modals

| Modal Type | Entrance | Exit | Backdrop |
|------------|----------|------|----------|
| Standard | `modalEntrance` | `modalEntrance.exit` | Blur + fade |
| Full-screen | `fadeIn` | `fadeIn` | Dark fade |
| Drawer | `slideInBottom` | `slideInBottom.exit` | Blur |

---

## Animation Budget

**Target:** 60fps (16.67ms per frame)

### Performance Budget

- **Button hover:** < 5ms
- **Card animation:** < 10ms
- **Modal entrance:** < 16ms
- **List stagger:** < 50ms total
- **Page transition:** < 300ms

### Monitoring

```typescript
// Measure animation performance
const start = performance.now()
// ... animation ...
const duration = performance.now() - start
console.log(`Animation took ${duration}ms`)

if (duration > 16.67) {
  console.warn('Animation dropped frames!')
}
```

---

## Migration Strategy

### Step 1: Update Core Components (Week 1)
1. Add transitions config to theme
2. Update Button components
3. Update Card components
4. Update Modal components

### Step 2: Forms & Inputs (Week 1)
1. Update Input focus styles
2. Add error/success animations
3. Update form submission states

### Step 3: Navigation & Layout (Week 2)
1. Nav hover states
2. Tab transitions
3. Mobile menu animations

### Step 4: Advanced Interactions (Week 2)
1. List stagger animations
2. Chart transitions
3. Hover previews
4. Loading states

---

## Resources

**Config File:** [`config/transitions.ts`](../config/transitions.ts)

**Documentation:**
- [Chakra UI Transitions](https://chakra-ui.com/docs/styled-system/style-props#transition)
- [Framer Motion Variants](https://www.framer.com/motion/animation/#variants)
- [Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API)

**Tools:**
- [Easing Functions Cheatsheet](https://easings.net/)
- [Cubic Bezier Generator](https://cubic-bezier.com/)
- [Motion DevTools](https://chrome.google.com/webstore/detail/framer-motion-devtools/)

---

## Summary

**Created:**
- ✅ `config/transitions.ts` - Complete animation system
- ✅ `docs/MICRO_INTERACTIONS_GUIDE.md` - This guide

**Next Steps:**
1. Apply button hover effects (5 files)
2. Apply card animations (5 files)
3. Add modal entrance animations (4 files)
4. Update form input focus styles (3 files)
5. Add navigation hover states (2 files)

**Estimated Effort:** 2-3 days for full implementation
**Impact:** Significantly improved perceived performance and polish

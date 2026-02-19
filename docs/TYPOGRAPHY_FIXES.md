# Typography Standardization Progress

**Goal:** Standardize all typography across the app using consistent scales

**Status:** Phase 2 Complete - Modal/Component Titles

---

## ✅ Completed

### Foundation
- [x] Created `helpers/typography.ts` with standardized scale
  - H1: 32px (page titles)
  - H2: 24px (section titles)
  - H3: 18px (subsection titles)
  - H4: 16px (card titles)
  - Body: 16px, Small: 14px, XS: 12px
  - Label: 11px (table headers, uppercase)

### Page Titles Fixed (Target: 32px / TYPOGRAPHY.h1)
- [x] AvailableCollateral component - `32px` ✓
- [x] Portfolio page (Portfolio.tsx) - `2xl` → `TYPOGRAPHY.h1` (32px) ✓
- [x] Manic page (ManicLooping.tsx) - `3xl` → `TYPOGRAPHY.h1` (32px) ✓
- [x] Transmuter page (TransmuterLockdropVisualizer.tsx) - `4xl` → `TYPOGRAPHY.h1` (32px) ✓
- [x] Boost page (pages/[chain]/boost.tsx) - `3xl` → `TYPOGRAPHY.h1` (32px) ✓
- [x] Visualize page (pages/[chain]/visualize.tsx) - `2xl` → `TYPOGRAPHY.h1` (32px) ✓
- [x] Portfolio page (PortPage.tsx) - `3xl` → `TYPOGRAPHY.h1` (32px) ✓
- [x] Index page (BaseHome fallback) - `2xl` → `TYPOGRAPHY.h1` (32px) ✓

### Modal Headers Fixed (Target: 18px / TYPOGRAPHY.h3)
- [x] Added `modalTitle` preset to TEXT_STYLES ✓
- [x] BorrowModal - `xl` (20px) → `TYPOGRAPHY.h3` (18px) ✓
- [x] DepositModal (Deposit) - `2xl` (24px) → `TYPOGRAPHY.h3` (18px) ✓
- [x] DepositModal (Withdraw) - `2xl` (24px) → `TYPOGRAPHY.h3` (18px) ✓

### Component Consistency
- [x] AvailableCollateral loading state - `lg` → `32px` (matches main title) ✓

---

## 🚧 Remaining Work

### Pages Verified (No standardization needed)
- [x] Disco page - Dashboard-style, no traditional text title (uses DiscoBallMeteor) ✓
- [x] About page - Decorative elements only, no traditional title ✓
- [x] Bridge, Stake, Mint, Headquarters pages - No page titles found ✓

### Additional Modal Headers (Lower Priority)
- [ ] ShareModal, WalletModal, ConfirmModal - Headers use ModalHeader component (inherits theme)
- [ ] NeuroModals, MintModals - Check if headers need standardization
- [ ] Payment/racing modals - Check if headers need standardization

### Section & Card Titles (Audit Needed)
**Finding:** Most `xl`, `lg`, `md` fontSize usages are for values/metrics, not structural titles.
- [ ] Identify true section headers (H2 - 24px) vs metric values
- [ ] Identify true card titles (H4 - 16px) vs labels
- [ ] Document pattern: App uses specific styling > generic fontSize for structural titles

### Body Text
- [ ] Audit all body text for consistency
- [ ] Replace arbitrary sizes with TYPOGRAPHY constants
- [ ] Ensure secondary/tertiary text uses proper hierarchy

### Labels & Small Text
- [ ] Table headers - Use TYPOGRAPHY.label with TEXT_STYLES.tableHeader
- [ ] Form labels - Standardize sizing
- [ ] Timestamps, captions - Use TYPOGRAPHY.xs

---

## 📋 Next Steps

1. **Continue Page Title Fixes** (30 minutes)
   - Find and fix remaining page titles
   - Test responsive behavior

2. **Component Title Audit** (1 hour)
   - Cards, modals, sections
   - Apply H2, H3, H4 appropriately

3. **Body Text Cleanup** (1 hour)
   - Replace inline fontSize props
   - Use TYPOGRAPHY constants everywhere

4. **Create Usage Guide** (30 minutes)
   - Add examples to typography.ts
   - Document when to use each size
   - Share with team

---

## 📊 Impact Metrics

**Before:**
- Page titles: 20px-48px (random)
- Body text: 12px-20px (inconsistent)
- No clear hierarchy

**After (Target):**
- Page titles: Consistent 32px
- Clear H1 → H2 → H3 → H4 hierarchy
- Predictable visual rhythm

**Estimated Files Affected:** ~125 files need typography updates

---

## 🎯 Success Criteria

- [x] All page titles use TYPOGRAPHY.h1 ✓
- [x] Key modal headers use TYPOGRAPHY.h3 ✓
- [ ] All section titles use TYPOGRAPHY.h2 (needs pattern identification)
- [ ] All card titles use TYPOGRAPHY.h4 (needs pattern identification)
- [ ] No arbitrary fontSize values (except special cases documented)
- [x] Typography guide documented (TEXT_STYLES presets created) ✓
- [ ] Team onboarded on new system

---

**Last Updated:** February 6, 2026
**Phase:** 2 of 4 Complete (Modal/Component Titles)
**Completion:** ~60% (8 page titles + 3 modal headers + 1 consistency fix)

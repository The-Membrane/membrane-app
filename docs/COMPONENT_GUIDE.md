# Component Guide

**Purpose:** Centralized reference for standardized UI components

**Last Updated:** February 6, 2026

---

## Quick Reference

| Component | Location | Purpose |
|-----------|----------|---------|
| **Card** | `components/ui/Card.tsx` | Container with consistent styling |
| **ProgressBar** | `components/ui/ProgressBar.tsx` | Adaptive progress visualization |
| **Button Patterns** | `docs/BUTTON_PATTERNS.md` | Button styling guidelines |
| **Chart Theme** | `config/chartTheme.ts` | Recharts styling constants |
| **Typography** | `helpers/typography.ts` | Font size and style constants |
| **Input Fields** | `theme/components/input.ts` | Form input styling |

---

## Card Component

### Variants

```tsx
import { Card } from '@/components/ui/Card'

// Default card - standard UI elements
<Card variant="default">
  <Text>Standard content</Text>
</Card>

// Elevated card - modals, important content
<Card variant="elevated">
  <Text>Emphasized content with shadow</Text>
</Card>

// Subtle card - secondary content
<Card variant="subtle">
  <Text>Background content</Text>
</Card>
```

### Props

Extends `BoxProps` from Chakra UI, plus:
- `variant?: 'default' | 'elevated' | 'subtle'`

### Usage Guidelines

- **Use Card for:** Grouped content, sections, data displays
- **Don't use for:** Single text elements, inline content
- **Override props:** Can override any Box prop (p, bg, etc.)

---

## ProgressBar Component

### Basic Usage

```tsx
import { ProgressBar } from '@/components/ui/ProgressBar'

// Basic progress bar
<ProgressBar value={75} maxValue={100} />

// With custom formatting
<ProgressBar
  value={750000}
  maxValue={1000000}
  formatValue={(v) => `$${(v / 1000000).toFixed(2)}M`}
/>

// Different sizes
<ProgressBar value={50} maxValue={100} size="sm" />
<ProgressBar value={50} maxValue={100} size="md" /> // default
<ProgressBar value={50} maxValue={100} size="lg" />

// Without label
<ProgressBar value={50} maxValue={100} showLabel={false} />
```

### Color Logic

Automatically adapts color based on usage:
- **0-49%:** Light cyan (`cyan.400`)
- **50-69%:** Standard cyan (`cyan.500`)
- **70-84%:** Medium cyan (`cyan.600`)
- **85-99%:** Dark cyan (`cyan.700`)
- **100%+:** Red warning (`red.400`)

### Props

- `value: number` - Current value
- `maxValue: number` - Maximum value
- `showLabel?: boolean` - Show value/max label (default: true)
- `size?: 'sm' | 'md' | 'lg'` - Bar height (default: 'md')
- `formatValue?: (value: number) => string` - Custom formatter
- `colorScheme?: string` - Override adaptive coloring
- `...ProgressProps` - All Chakra Progress props

---

## Chart Theme

### Quick Setup

```tsx
import { CHART_THEME, ASSET_COLORS, createCustomLegend } from '@/config/chartTheme'

<ResponsiveContainer width="100%" height={300}>
  <LineChart data={data}>
    <CartesianGrid {...CHART_THEME.grid} />
    <XAxis {...CHART_THEME.xAxis} />
    <YAxis {...CHART_THEME.yAxis} />
    <Tooltip {...CHART_THEME.tooltip} />
    <Legend content={createCustomLegend()} />
    <Line {...CHART_THEME.line} stroke={ASSET_COLORS[0]} />
  </LineChart>
</ResponsiveContainer>
```

### Available Configs

- **CHART_THEME.grid** - CartesianGrid styling
- **CHART_THEME.xAxis** - X-axis styling
- **CHART_THEME.yAxis** - Y-axis styling
- **CHART_THEME.tooltip** - Tooltip styling
- **CHART_THEME.legend** - Legend styling
- **CHART_THEME.line** - Line chart defaults
- **CHART_THEME.area** - Area chart defaults
- **CHART_THEME.bar** - Bar chart defaults

### Asset Colors

8 colors for multi-line charts:
```tsx
ASSET_COLORS = [
  '#22d3ee', // cyan
  '#a78bfa', // purple
  '#34d399', // green
  '#fb923c', // orange
  '#f472b6', // pink
  '#60a5fa', // blue
  '#fbbf24', // yellow
  '#f87171', // red
]
```

### Custom Legend

```tsx
// With label transformation
<Legend content={createCustomLegend((value) => {
  if (value === 'actual') return 'Bundled Value'
  return value.replace('hypo_', '100% ')
})} />
```

---

## Input Fields

### Variants

```tsx
import { Input } from '@chakra-ui/react'

// Outline (default)
<Input variant="outline" placeholder="Enter value" />

// Filled
<Input variant="filled" placeholder="Inline editing" />

// Unstyled (for custom styling)
<Input variant="unstyled" />
```

### States

All variants support:
- **Focus:** Cyan border with glow
- **Hover:** Brighter border
- **Invalid:** Red border
- **Disabled:** Grayed out, not-allowed cursor

### Usage Guidelines

- Use `outline` for forms and modals (default)
- Use `filled` for inline editing or compact layouts
- Use `unstyled` only when building custom input patterns

---

## Button Patterns

See full documentation: [`docs/BUTTON_PATTERNS.md`](./BUTTON_PATTERNS.md)

### Quick Reference

```tsx
// Ghost button (repeated actions)
<Button variant="outline" colorScheme="purple" />

// Solid button (primary actions)
<Button colorScheme="purple" bg="purple.500" />

// Disabled with error
<Button isDisabled borderColor="red.300" color="red.300" />
```

---

## Typography

See full documentation: [`helpers/typography.ts`](../helpers/typography.ts)

### Quick Reference

```tsx
import { TYPOGRAPHY, TEXT_STYLES } from '@/helpers/typography'

// Using constants
<Text fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold}>
  Page Title
</Text>

// Using presets
<Text {...TEXT_STYLES.pageTitle}>
  Page Title
</Text>

<Text {...TEXT_STYLES.sectionTitle}>
  Section Header
</Text>

<Text {...TEXT_STYLES.modalTitle}>
  Modal Header
</Text>

<Text {...TEXT_STYLES.cardTitle}>
  Card Header
</Text>
```

---

## Best Practices

### When to Create New Components

✅ **Create a new component when:**
- Pattern is used 3+ times
- Styling needs to be consistent
- Logic needs to be shared
- Testing needs to be centralized

❌ **Don't create a component when:**
- Used only once
- Highly context-specific
- Simple wrapper with no logic
- Over-abstraction risk

### Component Organization

```
components/
├── ui/              # Reusable UI primitives
│   ├── Card.tsx
│   ├── ProgressBar.tsx
│   └── ...
├── [Feature]/       # Feature-specific components
│   ├── Component.tsx
│   └── hooks/
└── ...
```

### Props Guidelines

- Extend Chakra props when possible
- Use TypeScript for all props
- Document complex props with JSDoc
- Provide sensible defaults
- Use `...props` spreading for flexibility

---

## Testing Checklist

When adding/updating components:
- [ ] TypeScript types are correct
- [ ] JSDoc documentation is complete
- [ ] Usage examples are provided
- [ ] All variants work correctly
- [ ] Responsive behavior is tested
- [ ] Accessibility is considered
- [ ] Props are properly spread
- [ ] Defaults make sense

---

## Future Additions

Potential components to standardize:
- [ ] Badge/Tag component
- [ ] Modal wrapper with consistent styling
- [ ] Table wrapper with responsive behavior
- [ ] Form field wrapper (label + input + error)
- [ ] Empty state component
- [ ] Loading skeleton component

---

**Status:** Phase 2 Complete
**Next:** Phase 3 (Layout) or continue with additional components

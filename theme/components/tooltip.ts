import { type ComponentStyleConfig } from '@chakra-ui/react'

// Living Typeface tooltip: raised surface, 1px bone hairline, SHARP corners,
// bone ink, mono type. No glow.
export const Tooltip: ComponentStyleConfig = {
  baseStyle: {
    borderRadius: '0', // sharp
    bg: 'var(--m-bg-tertiary)', // raised
    color: 'var(--m-text-primary)', // bone ink
    border: '1px solid',
    borderColor: 'var(--m-border-strong)',
    boxShadow: 'none',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '12px',
    px: 3,
    py: 2,
    // Chakra reads `--popper-arrow-bg` for the tooltip arrow fill.
    '--popper-arrow-bg': 'var(--m-bg-tertiary)',
  },
}

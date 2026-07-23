import { type ComponentStyleConfig } from '@chakra-ui/react'

// Living Typeface tooltip: raised surface, 1px bone hairline, SHARP corners,
// bone ink, mono type. No glow.
export const Tooltip: ComponentStyleConfig = {
  baseStyle: {
    borderRadius: '0', // sharp
    bg: '#100f12', // raised
    color: '#ece6d8', // bone ink
    border: '1px solid',
    borderColor: 'rgba(236, 230, 216, 0.22)',
    boxShadow: 'none',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '12px',
    px: 3,
    py: 2,
    // Chakra reads `--popper-arrow-bg` for the tooltip arrow fill.
    '--popper-arrow-bg': '#100f12',
  },
}

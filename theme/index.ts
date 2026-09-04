import { extendTheme, withDefaultColorScheme } from '@chakra-ui/react'
import { fonts, fontSizes, fontWeights } from './fonts'
import { colors } from './colors'
import { colors as configColors } from '@/config/defaults'
import { components } from './components'
import { KEYFRAMES } from '@/config/transitions'

const global = {
  // Keyframes for animations
  '@keyframes shimmer': {
    '0%': { backgroundPosition: '-200% 0' },
    '100%': { backgroundPosition: '200% 0' },
  },
  '@keyframes spin': {
    from: { transform: 'rotate(0deg)' },
    to: { transform: 'rotate(360deg)' },
  },
  '@keyframes pulse': {
    '0%, 100%': { opacity: 1 },
    '50%': { opacity: 0.5 },
  },
  '@keyframes slideInRight': {
    from: { transform: 'translateX(100%)', opacity: 0 },
    to: { transform: 'translateX(0)', opacity: 1 },
  },
  '@keyframes fadeIn': {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
  '@keyframes scaleIn': {
    from: { transform: 'scale(0.9)', opacity: 0 },
    to: { transform: 'scale(1)', opacity: 1 },
  },

  // Ensure border-box and prevent horizontal overflow
  '*': {
    boxSizing: 'border-box',
  },
  'html, body': {
    bg: configColors.globalBG, // Living Typeface page bg var(--m-bg-primary)
    color: configColors.global, // bone ink var(--m-text-primary)
    // NOT width:100vw — the viewport unit includes the scrollbar gutter, so it
    // overflows horizontally by the scrollbar width, which is what the old
    // overflow-x:hidden was papering over.
    width: '100%',
    // NOT height:100vh — a fixed-height body plus a hidden axis makes <body> the
    // scroll container instead of the document, which silently breaks
    // window.scrollTo, Next's scroll restoration, window scroll listeners
    // (components/NeutronHome/pipes/PipesCanvas.tsx) and mobile URL-bar collapse.
    minHeight: '100vh',
    // dvh tracks the dynamic viewport so the collapsing mobile URL bar does not
    // leave a gap; the vh above remains the fallback.
    '@supports (min-height: 100dvh)': {
      minHeight: '100dvh',
    },
  },
  // Make media responsive assets scale correctly
  'img, video': {
    maxWidth: '100%',
    height: 'auto',
  },
  // Touch-friendly interactive elements
  'button, input, select, textarea': {
    minHeight: '44px',
  },
  // Custom scrollbar behavior
  'html': {
    scrollbarWidth: 'thin',
    scrollbarColor: 'var(--m-border-strong) transparent',
  },
  'body': {
    scrollbarWidth: 'thin',
    scrollbarColor: 'var(--m-border-strong) transparent',
  },
  // Webkit scrollbar styles
  '::-webkit-scrollbar': {
    width: '8px',
    height: '8px',
  },
  '::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '::-webkit-scrollbar-thumb': {
    background: 'var(--m-border-strong)',
    borderRadius: '0px', // sharp
  },
  '::-webkit-scrollbar-thumb:hover': {
    background: 'color-mix(in srgb, var(--m-text-primary) 35%, transparent)',
  },
  '::-webkit-scrollbar-corner': {
    background: 'transparent',
  },
}

const config = {
  initialColorMode: 'dark',
  useSystemColorMode: false,
}

// Living Typeface: SHARP CORNERS everywhere. Override the entire Chakra radii
// scale to 0 so any consumer using theme radius tokens (borderRadius="md", etc.)
// renders square. Per-component overrides in theme/components also set radius 0.
const radii = {
  none: '0',
  sm: '0',
  base: '0',
  md: '0',
  lg: '0',
  xl: '0',
  '2xl': '0',
  '3xl': '0',
  // `full` intentionally stays circular: avatars, status dots, spinners and other
  // genuinely round elements rely on it. Sharp corners apply to rectangular
  // surfaces (cards/buttons/inputs/modals), not to circles.
  full: '9999px',
}

const theme = extendTheme(
  {
    config,
    styles: { global },
    colors,
    fonts,
    fontSizes,
    fontWeights,
    radii,
    components,
    breakpoints: {
      base: "0px", // Chakra implicitly treats 0 as the starting point
      xxs: "320px", // Extra-small phones (iPhone SE, etc.)
      xs: "375px",  // Small phones (iPhone 8, Galaxy S8)
      sm: "480px",  // Large phones / small tablets
      md: "768px",  // Tablets
      lg: "992px",  // Small laptops
      xl: "1280px", // Desktops
      "2xl": "1536px", // Large screens
    },
  },
  withDefaultColorScheme({ colorScheme: 'primary' }),
)

export default theme

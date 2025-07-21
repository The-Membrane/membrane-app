import { extendTheme, withDefaultColorScheme } from '@chakra-ui/react'
import { fonts, fontSizes, fontWeights } from './fonts'
import { colors } from './colors'
import { colors as configColors } from '@/config/defaults'
import { components } from './components'

const global = {
  // Ensure border-box and prevent horizontal overflow
  '*': {
    boxSizing: 'border-box',
  },
  'html, body': {
    bg: configColors.globalBG,
    // background: "radial-gradient(66.3% 66.3% at 72.54% 59.91%, rgba(17, 16, 21, 0.00) 0%, rgba(17, 16, 21, 0.00) 42%, #111015 100%)",
    color: configColors.global,
    width: '100vw',
    height: '100vh',
    overflowX: 'hidden',
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
    scrollbarColor: 'rgba(255, 255, 255, 0.3) transparent',
  },
  'body': {
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(255, 255, 255, 0.3) transparent',
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
    background: 'rgba(255, 255, 255, 0.3)',
    borderRadius: '4px',
  },
  '::-webkit-scrollbar-thumb:hover': {
    background: 'rgba(255, 255, 255, 0.5)',
  },
  '::-webkit-scrollbar-corner': {
    background: 'transparent',
  },
}

const config = {
  initialColorMode: 'dark',
  useSystemColorMode: false,
}

const theme = extendTheme(
  {
    config,
    styles: { global },
    colors,
    fonts,
    fontSizes,
    fontWeights,
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

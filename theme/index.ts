import { extendTheme, withDefaultColorScheme } from '@chakra-ui/react'
import { fonts, fontSizes, fontWeights } from './fonts'
import { colors } from './colors'
import { colors as configColors } from '@/config/defaults'
import { components } from './components'

const global = {
  'html, body': {
    bg: configColors.globalBG,
    // background: "radial-gradient(66.3% 66.3% at 72.54% 59.91%, rgba(17, 16, 21, 0.00) 0%, rgba(17, 16, 21, 0.00) 42%, #111015 100%)",
    color: configColors.global,
    width: '100vw',
    height: '100vh',
  },
  /* Make the scrollbar track transparent */
  '::-webkit-scrollbar': {
    width: '6px' /* Adjust the width as needed */,
    backgroundColor: 'transparent' /* Transparent background */,
  },
  /* Style the scrollbar thumb (slider) */
  '::-webkit-scrollbar-thumb': {
    backgroundColor: 'whiteAlpha.300' /* color for the thumb */,
    borderRadius: '3px' /* Rounded corners for the thumb */,
  },
  /* Style the scrollbar track on hover (optional) */
  '::-webkit-scrollbar-track:hover': {
    backgroundColor: 'rgba(0, 0, 0, 0.1)' /* Semi-transparent background on hover */,
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
      xxs: "320px", // Custom extra small breakpoint
      xs: "375px", // Custom extra small breakpoint
      sm: "425px",
      base: "0px",
      md: "768px",
      lg: "992px",
      xl: "1280px",
      "2xl": "1536px",
    },
  },
  withDefaultColorScheme({ colorScheme: 'primary' }),
)

export default theme

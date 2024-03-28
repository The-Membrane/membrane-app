// import type { ComponentStyleConfig } from '@chakra-ui/react'

// export const Tabs: ComponentStyleConfig = {
//   baseStyle: {
//     tab: {
//       bg: 'transparent',
//       color: 'white',
//       fontWeight: 'normal',
//       border: '1px solid #fff',
//       _selected: { fontWeight: 'normal', color: 'white', bg: 'primary.200', border: 'none' },
//     },
//     tabpanel: {
//       px: 0,
//       py: 3,
//     },
//   },
// }

import { tabsAnatomy } from '@chakra-ui/anatomy'
import { createMultiStyleConfigHelpers } from '@chakra-ui/react'

const { definePartsStyle, defineMultiStyleConfig } = createMultiStyleConfigHelpers(tabsAnatomy.keys)

const baseStyle = definePartsStyle({
  tab: {
    bg: 'transparent',
    color: 'white',
    fontWeight: 'normal',
    border: '1px solid #fff',
    _selected: {
      fontWeight: 'normal',
      border: 'none',
      bg: 'primary.200',
      color: 'white',
    },
  },
  tabpanel: {
    px: 0,
    py: 3,
  },
})

export const Tabs = defineMultiStyleConfig({ baseStyle })

import { colors } from '@/config/defaults'
import { cardAnatomy } from '@chakra-ui/anatomy'
import { createMultiStyleConfigHelpers } from '@chakra-ui/react'

const { definePartsStyle, defineMultiStyleConfig } = createMultiStyleConfigHelpers(cardAnatomy.keys)

// Living Typeface card = card bg + 1px bone hairline, SHARP corners, no glow/shadow.
const baseStyle = definePartsStyle({
  container: {
    borderRadius: '0', // sharp
    bg: colors.cardBG, // #0e0d10
    border: '1px solid',
    borderColor: 'var(--m-border-subtle)',
    boxShadow: 'none',
    padding: '6',
  },
  header: {},
  body: {},
  footer: {},
})

export const Card = defineMultiStyleConfig({ baseStyle })

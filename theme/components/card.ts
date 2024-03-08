import { cardAnatomy } from '@chakra-ui/anatomy'
import { createMultiStyleConfigHelpers } from '@chakra-ui/react'

const { definePartsStyle, defineMultiStyleConfig } = createMultiStyleConfigHelpers(cardAnatomy.keys)

const baseStyle = definePartsStyle({
  container: {
    borderRadius: '24px',
    // border: '2px solid rgba(250, 129, 253, 0.37)',
    // background: 'rgba(5, 7, 27, 0.85)',
    // boxShadow: '0px 0px 24px 0px rgba(250, 129, 253, 0.32)',
    // backdropFilter: 'blur(6px)',
    bg: 'whiteAlpha.100',
    padding: '6',
  },
  header: {},
  body: {},
  footer: {},
})

export const Card = defineMultiStyleConfig({ baseStyle })

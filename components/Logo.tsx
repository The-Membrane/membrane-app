import { Box, Image } from '@chakra-ui/react'
import React from 'react'

/**
 * The Membrane wordmark lockup: the dissolving cell mark + "Membrane" set in
 * Redaction. Bone on near-black, per Living Typeface.
 *
 * The asset is 1536x434 (a ~3.54:1 lockup), so it is sized by HEIGHT with width
 * left to `auto`. The previous version hardcoded `boxSize="180px"` alongside
 * `height="90px"`, which fought each other and distorted the mark.
 *
 * `variant="ink"` swaps to membrane-wordmark-ink.svg — the same embedded
 * raster behind an SVG color-transfer filter (bone → ink #1d1a13) — for use on
 * light "Parchment" surfaces where the bone mark would vanish.
 */
const WORDMARK_SRC = {
  bone: '/images/membrane-wordmark.svg',
  ink: '/images/membrane-wordmark-ink.svg',
} as const

const Logo = ({
  height = '32px',
  variant = 'bone',
}: {
  height?: string
  variant?: keyof typeof WORDMARK_SRC
}) => {
  return (
    <Box alignItems="center" display="flex" justifyContent="center">
      <Image
        data-testid="logo"
        src={WORDMARK_SRC[variant]}
        alt="Membrane"
        height={height}
        width="auto"
      />
    </Box>
  )
}

export default Logo

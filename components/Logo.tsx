import { Box, Image } from '@chakra-ui/react'
import React from 'react'

import { useThemeMode } from '@/hooks/useThemeMode'

/**
 * The Membrane wordmark lockup: the dissolving cell mark + "Membrane" set in
 * Redaction. Bone on near-black, per Living Typeface.
 *
 * The asset is 1536x434 (a ~3.54:1 lockup), so it is sized by HEIGHT with width
 * left to `auto`. The previous version hardcoded `boxSize="180px"` alongside
 * `height="90px"`, which fought each other and distorted the mark.
 *
 * `variant="ink"` swaps to membrane-wordmark-ink.svg — the same raster with
 * bone pixels baked to espresso #43331f and the phosphor/teal strand kept —
 * for light "Parchment" surfaces where the bone mark would vanish. With no
 * explicit variant, the lockup follows the active theme automatically.
 */
const WORDMARK_SRC = {
  bone: '/images/membrane-wordmark.svg',
  ink: '/images/membrane-wordmark-ink.svg',
} as const

const Logo = ({
  height = '32px',
  variant,
}: {
  height?: string
  variant?: keyof typeof WORDMARK_SRC
}) => {
  const { mode } = useThemeMode()
  const resolved = variant ?? (mode === 'light' ? 'ink' : 'bone')
  return (
    <Box alignItems="center" display="flex" justifyContent="center">
      <Image
        data-testid="logo"
        src={WORDMARK_SRC[resolved]}
        alt="Membrane"
        height={height}
        width="auto"
      />
    </Box>
  )
}

export default Logo

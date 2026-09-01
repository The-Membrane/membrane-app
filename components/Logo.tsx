import { Box, Image } from '@chakra-ui/react'
import React from 'react'

/**
 * The Membrane wordmark lockup: the dissolving cell mark + "Membrane" set in
 * Redaction. Bone on near-black, per Living Typeface.
 *
 * The asset is 1536x434 (a ~3.54:1 lockup), so it is sized by HEIGHT with width
 * left to `auto`. The previous version hardcoded `boxSize="180px"` alongside
 * `height="90px"`, which fought each other and distorted the mark.
 */
const Logo = ({ height = '32px' }: { height?: string }) => {
  return (
    <Box alignItems="center" display="flex" justifyContent="center">
      <Image
        data-testid="logo"
        src="/images/membrane-wordmark.svg"
        alt="Membrane"
        height={height}
        width="auto"
      />
    </Box>
  )
}

export default Logo

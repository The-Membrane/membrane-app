import { Box, Image } from '@chakra-ui/react'
import React from 'react'

type Props = {}

const Logo = (props: Props) => {
  return (
    <Box alignItems="center">
      <Image src="/images/logo_with_name.svg" alt="Logo" />
    </Box>
  )
}

export default Logo

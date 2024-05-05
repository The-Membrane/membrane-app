import { Box, Image } from '@chakra-ui/react'
import React from 'react'

const Logo = () => {
  return (
    <Box alignItems="center" display={"flex"} justifyContent={"center"}>
      <Image src="/images/logo_with_name.svg" alt="Logo" />
    </Box>
  )
}

export default Logo

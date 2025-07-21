import { Box, Image } from '@chakra-ui/react'
import React from 'react'

const Logo = () => {
  return (
    <Box alignItems="center" display={"flex"} justifyContent={"center"}>
      <Image src="/images/Logo_with_both_images.svg" alt="Logo" boxSize="180px" height="90px" />
    </Box>
  )
}

export default Logo

import { Box, Image, Stack } from '@chakra-ui/react'
import React, { Fragment } from 'react'

type Props = {}

const Filtration = (props: Props) => {
  return (
    <Box position="fixed" right="32" zIndex={100} top="3">
      <Image src="/images/flitration.svg" alt="beaker" />
    </Box>
  )
}

export default Filtration

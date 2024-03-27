import { Box, Image, Stack } from '@chakra-ui/react'
import React, { Fragment } from 'react'
import { BeakerLiquid } from './BeakerScale'

type Props = {}

const Beaker = (props: Props) => {
  return (
    <Box position="relative">
      <Box position="fixed" right="32" zIndex={1} top="3">
        <Image src="/images/beaker.svg" alt="beaker" />
        <BeakerLiquid />
      </Box>
    </Box>
  )
}

export default Beaker

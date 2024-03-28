import { Box, Image, Stack } from '@chakra-ui/react'
import React, { Fragment } from 'react'
import { BeakerLiquid } from './BeakerScale'

type Props = {}

const Beaker = (props: Props) => {
  return (
    <Box w="full">
      <Box w="full" position="relative">
        <Image
          src="/images/beaker.svg"
          alt="beaker"
          objectFit="contain"
          objectPosition="-70px -80px"
          w="600px"
          minW="600px"
        />
        <BeakerLiquid />
      </Box>
    </Box>
  )
}

export default Beaker

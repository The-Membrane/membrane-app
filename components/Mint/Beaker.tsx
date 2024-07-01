import { Box, Image, Stack } from '@chakra-ui/react'
import React, { Fragment } from 'react'
import { BeakerLiquid } from './BeakerScale'
import Health from './Health'

type Props = {}

const Beaker = (props: Props) => {
  return (
    <Box w="full" display={{base: "none", md: "flex"}}>
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
        <Health />
      </Box>
    </Box>
  )
}

export default Beaker

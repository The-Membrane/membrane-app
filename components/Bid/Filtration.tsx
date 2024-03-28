import { Box, Image, Stack } from '@chakra-ui/react'
import React, { Fragment } from 'react'

type Props = {}

const Filtration = (props: Props) => {
  return (
    <Box zIndex={100}>
      <Image
        src="/images/flitration.svg"
        alt="beaker"
        width="644px"
        objectFit="contain"
        objectPosition="-200px"
      />
    </Box>
  )
}

export default Filtration

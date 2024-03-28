import { Box, Image, Stack } from '@chakra-ui/react'
import React, { Fragment } from 'react'

type Props = {}

const Filtration = (props: Props) => {
  return (
    <Box zIndex={100}>
      <Image
        src="/images/flitration.svg"
        alt="beaker"
        w="660px"
        minW="660px"
        objectFit="contain"
        objectPosition="-150px 50px"
        transform="scale(1.15)"
      />
    </Box>
  )
}

export default Filtration

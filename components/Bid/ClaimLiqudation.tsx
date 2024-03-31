import { Button } from '@chakra-ui/react'
import React from 'react'

type Props = {}

const ClaimLiqudation = (props: Props) => {
  return (
    <Button
      borderRadius="24px"
      justifySelf="end"
      w="220px"
      px="3"
      size="sm"
      fontWeight="normal"
      mr="1"
    >
      Claim Liqudation
    </Button>
  )
}

export default ClaimLiqudation

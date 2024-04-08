import React from 'react'
import { Divider as ChakraDivider, DividerProps } from '@chakra-ui/react'

type Props = {}

const Divider = (props: DividerProps) => {
  return (
    <ChakraDivider
      bg="rgba(226, 216, 218, 0.24)"
      boxShadow="0px 0px 8px 0px rgba(226, 216, 218, 0.64)"
      w="calc(100% - 16px)"
      h="1px"
      my="5"
      mx="3"
      {...props}
    />
  )
}

export default Divider

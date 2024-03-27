import useWallet from '@/hooks/useWallet'
import { Box, Spinner, Image } from '@chakra-ui/react'
import React from 'react'

type Props = {}

const LoaderWithIcon = (props: Props) => {
  const { wallet } = useWallet()

  return (
    <Box position="relative">
      <Spinner
        thickness="4px"
        speed="0.65s"
        emptyColor="rgba(250, 129, 253, 0.57)"
        color="primary.500"
        size="xl"
        width="100px"
        height="100px"
        zIndex={1}
      />
      <Image
        zIndex={2}
        position="absolute"
        height="80px"
        width="80px"
        left="50%"
        top="48%"
        transform="translate(-50%, -50%)"
        borderRadius="full"
        src={wallet?.logo}
      />
    </Box>
  )
}

export default LoaderWithIcon

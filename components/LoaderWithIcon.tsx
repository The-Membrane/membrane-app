import { colors } from '@/config/defaults'
import useWallet from '@/hooks/useWallet'
import { Box, Spinner, Image } from '@chakra-ui/react'
import React from 'react'

const LoaderWithIcon = () => {
  // TODO(evm-migration): cosmos-kit exposed the connected `wallet` (with a `.logo`); wagmi
  // exposes the active `connector` whose `.icon` is the closest equivalent.
  const { connector } = useWallet()

  return (
    <Box position="relative">
      <Spinner
        thickness="4px"
        speed="0.65s"
        emptyColor={colors.emptyLoader}
        color={colors.loader}
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
        src={connector?.icon}
      />
    </Box>
  )
}

export default LoaderWithIcon

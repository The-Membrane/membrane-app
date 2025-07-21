import { Box, Image } from '@chakra-ui/react'

const Filtration = () => {
  return (
    <Box zIndex={100}>
      <Image
        src="/images/flitration.svg"
        alt="beaker"
        maxW={{ base: '100%', md: '660px' }}
        w={{ base: '100%', md: '660px' }}
        objectFit="contain"
        objectPosition="center"
        transform={{ base: 'scale(1)', md: 'scale(1.15)' }}
      />
    </Box>
  )
}

export default Filtration

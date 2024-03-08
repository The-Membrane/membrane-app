import { HStack, Heading } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import React from 'react'

type Props = {}

const Header = (props: Props) => {
  const router = useRouter()

  const pageName = router.pathname.split('/')?.[1]

  return (
    <HStack
      px="10"
      py="5"
      position="fixed"
      w="full"
      backdropFilter="blur(10px)"
      zIndex="100"
      // maxW="1280px"
    >
      <Heading size="md" textTransform="capitalize">
        {pageName}
      </Heading>
    </HStack>
  )
}

export default Header

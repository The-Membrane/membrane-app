import { Center, Text } from '@chakra-ui/react'
import { PropsWithChildren } from 'react'
import Logo from './Logo'
import { isMobile } from 'react-device-detect'

type Props = PropsWithChildren & {}

const Mobile = () => (
  <Center h="90vh" p={10} flexDir="column" display={['flex', 'none']} gap={10}>
    <Logo />
    <Text fontSize="xl" textAlign="center" variant="label">
      Mobile support <br /> coming soon
    </Text>
  </Center>
)

const Layout = ({ children }: Props) => {
  if (isMobile) return <Mobile />
  return children
}

export default Layout

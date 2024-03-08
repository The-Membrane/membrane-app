import { Center, Grid, GridItem, HStack, Stack, Text } from '@chakra-ui/react'
import { Fragment, PropsWithChildren } from 'react'
import Logo from './Logo'
import { isMobile } from 'react-device-detect'
import SideNav from './SideNav'
import RPCStatus from './RPCStatus'
import Header from './Header'

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
  return (
    <Fragment>
      <Mobile />

      <HStack w="100vw" display={['none', 'flex']}>
        <Stack flexGrow={1} flexBasis="240px" h="100vh" alignItems="flex-end" overflow="auto">
          <SideNav />
        </Stack>
        <Stack flexGrow={1} flexBasis="1200px" h="100vh" overflow="auto">
          <Header />
          <Stack as="main" p="10" maxW="1200px" w="full" mt="70px" pb="10">
            <RPCStatus />
            {children}
          </Stack>
        </Stack>
      </HStack>
    </Fragment>
  )
}

export default Layout

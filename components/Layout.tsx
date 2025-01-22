import { Box, Center, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { Fragment, PropsWithChildren } from 'react'
import Header from './Header'
import Logo from './Logo'
import RPCStatus from './RPCStatus'
import SideNav from './SideNav'
import MembersRules from './MembersRules'
import useMembersRulesState from './MembersRules/useRules'

type Props = PropsWithChildren & {}

// const Mobile = () => (
//   <Center h="90vh" p={10} flexDir="column" display={['flex', 'none']} gap={10}>
//     <Logo />
//     <Text fontSize="xl" textAlign="center" variant="label">
//       Mobile support <br /> coming soon
//     </Text>
//   </Center>
// )

const HexagonBackground = () => (
  <Box position="absolute" top="0" right="0" zIndex={0} display={['block']}>
    <Image src="/images/backgrounds/right.svg" alt="Hexagon" />
  </Box>
)

const Layout = ({ children }: Props) => {
  const { show } = useMembersRulesState()

  if (show) return <MembersRules />

  return (
    //<Fragment>
    //<Mobile />

    <Stack w="100vw" h="100vh" display={['flex']} position="relative" direction={{ base: "column", md: "row" }}>
      {/* <HexagonBackground /> */}
      <Stack marginRight={"2.5%"} flexBasis="240px" overflow="auto">
        <SideNav />
      </Stack>
      <Stack
        h="full"
        flexGrow={1}
        flexBasis="1200px"
        overflow="auto"
        alignItems="self-start"
        zIndex={1}
      >
        {/* <Header /> */}
        <Stack as="main" p={{ base: "2" }} w="full" flex={1} mt={{ base: "0px", md: "15px" }}>
          <RPCStatus />
          {children}
        </Stack>
      </Stack>
    </Stack>
    //</Fragment>
  )
}

export default Layout

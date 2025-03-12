import { Box, Center, HStack, Image, Stack, Text, Modal, ModalBody, ModalCloseButton, ModalContent, ModalHeader, ModalOverlay } from '@chakra-ui/react'
import { Fragment, PropsWithChildren } from 'react'
import Header from './Header'
import Logo from './Logo'
import RPCStatus from './RPCStatus'
import SideNav from './SideNav'
import MembersRules from './MembersRules'
import useMembersRulesState from './MembersRules/useRules'
import Select from './Select'
import useAppState from '@/persisted-state/useAppState'
import React from 'react'
import { RulesModal } from './MembersRules/RulesModal'

type Props = PropsWithChildren & {}

// const Mobile = () => (
//   <Center h="90vh" p={10} flexDir="column" display={['flex', 'none']} gap={10}>
//     <Logo />
//     <Text fontSize="xl" textAlign="center" variant="label">
//       Mobile support <br /> coming soon
//     </Text>
//   </Center>
// )

// const HexagonBackground = () => (
//   <Box position="absolute" top="0" right="0" zIndex={0} display={['block']}>
//     <Image src="/images/backgrounds/right.svg" alt="Hexagon" />
//   </Box>
// )

// export const RulesModal = React.memo(({
//   isOpen, children
// }: PropsWithChildren<{ isOpen: boolean, onClose: () => void }>) => {

//   return (<>

//     <Modal isOpen={isOpen} onClose={() => { }} closeOnOverlayClick={false}>
//       <ModalOverlay />
//       <ModalContent maxW="800px">
//         <ModalHeader>
//           {/* <Text variant="title">NeuroGuard FAQ</Text> */}
//         </ModalHeader>
//         <ModalCloseButton />
//         <ModalBody pb="5">
//           <MembersRules />
//         </ModalBody>
//         {/* {(
//           <ModalFooter
//             as={HStack}
//             justifyContent="end"
//             borderTop="1px solid"
//             borderColor="whiteAlpha.200"
//             pt="5"
//             gap="5"
//           >
//             <ActionButtons
//               proposal={proposal}
//               isExecuteAllowed={isExecuteAllowed}
//               isRemoveAllowed={isRemoveAllowed}
//               isVoteAllowed={isVoteAllowed}
//               isPending={isPending}
//               vote={vote}
//             />
//           </ModalFooter>
//         )} */}
//       </ModalContent>
//     </Modal>
//   </>)
// })

const Layout = ({ children }: Props) => {

  console.log("show")
  const { show } = useMembersRulesState()
  console.log("show", show)

  const { appState, setAppState } = useAppState()

  console.log("show", show)

  //create a list of rpc options
  const rpcs = ['https://osmosis-rpc.polkachu.com/', 'https://g.w.lavanet.xyz:443/gateway/osmosis/rpc-http/c6667993e9a0fac0a9c98d29502aa0a7', 'https://rpc.cosmos.directory/osmosis', 'https://rpc.osmosis.zone/'];


  const onChange = (value: string) => {
    setAppState({ rpcUrl: value });
  }

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
      <Stack
        position="absolute"
        top="16px"
        right="16px"
        zIndex="10">
        {/* <Select options={rpcs} onChange={onChange} value={appState.rpcUrl} /> */}
      </Stack>
      <RulesModal />
    </Stack>
    //</Fragment>
  )
}

export default Layout

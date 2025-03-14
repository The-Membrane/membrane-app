import {
  Box,
  Button,
  IconButton,
  ListItem,
  Modal,
  ModalBody,
  ModalContent,
  Stack,
  Text,
  UnorderedList,
  useBreakpointValue,
  useDisclosure,
} from '@chakra-ui/react'
import useMembersRulesState from './useRules'
import { rules } from './MembersRules'

export const RulesModal = () => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const { setRulesState } = useMembersRulesState()
  const isMobile = useBreakpointValue({ base: true, md: false })

  console.log("rules modal")

  const handleAgree = () => {
    setRulesState({ show: false })
    onClose()
  }

  return (
    <>

      <Modal isOpen={isOpen || (isMobile ?? false)} onClose={() => { console.log("closing rules"); onClose; }} size="xl" isCentered>
        <ModalContent
          p="0"
          border="none"
          m="0"
          bg="transparent"
          boxShadow="none"
          h={"493px"}
          w="534px"
          backdropFilter="none"
          style={isMobile ? { zoom: "69%" } : { zoom: "90%" }}
        >
          <ModalBody p="58px 23px" position="relative" zIndex={1}>
            <Stack h="full">
              <Text variant="title" fontSize={isMobile ? "20px" : "45px"} textAlign="center" py={4}>
                MEMBRANE RULES
              </Text>

              <UnorderedList spacing={1} pl="7">
                {rules.map((rule, index) => (
                  <ListItem key={index} fontSize={isMobile ? "sm" : "lg"} fontWeight="bold">
                    {rule}
                  </ListItem>
                ))}
              </UnorderedList>
              <Button onClick={handleAgree} w="fit-content" alignSelf="center" mt={4}>
                I agree
              </Button>
            </Stack>
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  )
}

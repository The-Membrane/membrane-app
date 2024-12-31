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
  const { setShow } = useMembersRulesState()
  const isMobile = useBreakpointValue({ base: true, md: false })

  const handleAgree = () => {
    setShow(false)
    onClose()
  }

  return (
    <>
      <IconButton
        isRound={true}
        variant="solid"
        aria-label="Done"
        fontSize="20px"
        onClick={onOpen}
        position="absolute"
        top="518px"
        right="335px"
        border="none"
        w="36px"
        h="36px"
        bg="#C3BFAF"
        shadow="0 0 10px 5px #C3BFAF, 0 0 1px 0 #C3BFAF, 0 0 1px 0 #C3BFAF"
        transform="scale(0.8)"
        _hover={{
          bg: '#C3BFAF',
          boxShadow: '0 0 10px 15px #C3BFAF, 0 0 1px 0 #C3BFAF, 0 0 1px 0 #C3BFAF',
          transform: 'scale(0.7)',
          transition: 'all 0.3s',
        }}
      />

      <Modal isOpen={isOpen || (isMobile ?? false)} onClose={onClose} size="xl" isCentered>
        <ModalContent
          p="0"
          border="none"
          m="0"
          bg="transparent"
          boxShadow="none"
          h={isMobile ? "90vh" : "493px"}
          w="534px"
          backdropFilter="none"
          style={isMobile ? { zoom: "69%" } : { zoom: "90%" }}
        ><Box
            position="absolute"
            top="0"
            left="0"
            right="0"
            bottom="0"
            bgImage="url('/images/rules_frame.svg')"
            bgRepeat="no-repeat"
            bgPosition="center"
            bgSize="100% 100%"
            zIndex={0}
          />
          <ModalBody p="58px 23px" position="relative" zIndex={1}>
            <Stack h="full">
              <Text variant="title" fontSize="45px" textAlign="center" py={4}>
                MEMBRANE RULES
              </Text>

              <UnorderedList spacing={1} pl="10">
                {rules.map((rule, index) => (
                  <ListItem key={index} fontSize="lg" fontWeight="bold">
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

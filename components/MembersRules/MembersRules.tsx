import {
  Button,
  Center,
  Icon,
  IconButton,
  ListItem,
  Modal,
  ModalBody,
  ModalContent,
  Stack,
  Text,
  UnorderedList,
  useDisclosure,
} from '@chakra-ui/react'
import { FaCircle } from 'react-icons/fa'
import useMembersRulesState from './useRules'
import { useState } from 'react'

const rules = [
  'Sovereign individuals only',
  'Your actions are your own responsibility/liability',
  'If your jurisdiction is banned, do not enter',
  "Once you're in, you're within",
]

const RulesModal = () => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const { show, setShow } = useMembersRulesState()
  const [hovered, setHovered] = useState(false)

  const handleAgree = () => {
    setShow(false)
    onClose()
  }

  return (
    <>
      {/* <Button onClick={onOpen} w="5" h="5" borderRadius="full" /> */}

      <IconButton
        // w="fit-content"
        // h="fit-content"
        // minW="0"
        isRound={true}
        variant="solid"
        aria-label="Done"
        fontSize="20px"
        onClick={onOpen}
        position="absolute"
        top="518px"
        right="335px"
        border="none"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        w="36px"
        h="36px"
        bg="transparent"
        shadow={hovered ? '0 0 5px 0 #cdff44, 0 0 1px 0 #cdf744, 0 0 1px 0 #cdf044' : 'none'}
        _hover={{
          bg: 'transparent',
          shadow: '0 0 10px 0 #cdff44, 0 0 1px 0 #cdf744, 0 0 1px 0 #cdf044',
        }}
      />

      <Modal isOpen={isOpen} onClose={onClose} size="xl" isCentered>
        <ModalContent
          p="0"
          border="none"
          m="0"
          bg="transparent"
          boxShadow="none"
          h="493px"
          w="534px"
          backdropFilter="none"
        >
          <ModalBody
            bgImage="url('/images/rules_frame.svg')"
            p="58px 23px"
            // backdropFilter="blur(6px)"
          >
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

const MembersRules = () => {
  const { show, setShow } = useMembersRulesState()
  if (!show) return null
  return (
    <Center
      w="1440px"
      h="1080px"
      margin="auto"
      bg="#111015"
      position="relative"
      zIndex={1}
      bgImg={`url("/images/backgrounds/rules_bg.svg")`}
      bgSize="contain"
      bgRepeat="no-repeat"
      bgPosition="center"
    >
      <RulesModal />
    </Center>
  )
}

export default MembersRules

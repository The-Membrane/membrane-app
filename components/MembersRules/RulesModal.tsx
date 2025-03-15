import {
  Box,
  Button,
  IconButton,
  ListItem,
  Modal,
  ModalBody,
  ModalContent,
  ModalOverlay,
  Stack,
  Text,
  UnorderedList,
  useBreakpointValue,
  useDisclosure,
} from '@chakra-ui/react'
import useMembersRulesState from './useRules'
import { useCallback } from 'react'
import { colors } from '@/config/defaults'

export const rules = [
  'Sovereign individuals only',
  "Your experience is your own responsibility/liability",
  "If your jurisdiction is banned, don't enter",
  "Once you're in, you're within",
]

export const RulesModal = ({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) => {
  const { setRulesState } = useMembersRulesState()
  const isMobile = useBreakpointValue({ base: true, md: false })

  console.log("rules modal", isOpen)

  const handleAgree = useCallback(() => {
    console.log("ran agree")
    setRulesState({ show: false })
    onClose()
  }, [setRulesState, onClose])

  return (
    <>

      <Modal isOpen={isOpen} onClose={onClose} size="xl" isCentered >
        <ModalOverlay />

        <ModalContent
          h={"493px"}
          w="534px"
          borderWidth={"2px"}
          borderColor={colors.tabBG}
        >
          <ModalBody p="24x 23px" position="relative" zIndex={1}>
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
              <Text
                fontStyle="italics"
                alignSelf="center"
                paddingTop="1rem"
              >
                The evolution of money is now.</Text>
              <Button onClick={handleAgree} w="fit-content" alignSelf="center" mt={4}>
                Join the evolution
              </Button>
            </Stack>
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  )
}

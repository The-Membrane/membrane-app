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
import { useCallback } from 'react'
import { colors } from '@/config/defaults'
import useMembersRulesState from '../MembersRules/useRules'

export const notes = [
    "You can add any number of collateral to your bundle",
    "Individual collateral parameters influence the overall loan params",
    "Interest rates automatically increase when CDT depegs",
    "Liquidations are partial, ~25% ",
    "Deposits and withdrawals are limited by supply caps"
]

export const OnboardModal = ({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) => {
    const { setRulesState } = useMembersRulesState()
    const isMobile = useBreakpointValue({ base: true, md: false })

    // console.log("rules modal", isOpen)

    const handleAgree = useCallback(() => {
        console.log("ran agree")
        setRulesState({ show: false })
        onClose()
    }, [setRulesState, onClose])

    return (
        <>

            <Modal isOpen={isOpen} onClose={onClose} size="xl" isCentered closeOnOverlayClick={false}>
                <ModalOverlay />

                <ModalContent
                    h={"fit-content"}
                    w="534px"
                    borderWidth={"2px"}
                    borderColor={colors.tabBG}
                >
                    <ModalBody p="24x 23px" position="relative" zIndex={1}>
                        <Stack h="full">
                            <Text variant="title" fontSize={isMobile ? "20px" : "35px"} textAlign="center" py={4}>
                                Loan Information
                            </Text>

                            <UnorderedList spacing={1} pl="7">
                                {notes.map((rule, index) => (
                                    <ListItem key={index} fontSize={isMobile ? "sm" : "lg"} fontWeight="bold">
                                        {rule}
                                    </ListItem>
                                ))}
                            </UnorderedList>
                            {/* <Text
                                fontStyle="italic"
                                alignSelf="center"
                                paddingTop="1rem"
                            >
                                The evolution of money is now.</Text> */}
                            <Button onClick={handleAgree} w="fit-content" alignSelf="center" mt={4}>
                                Sync your Brane
                            </Button>
                        </Stack>
                    </ModalBody>
                </ModalContent>
            </Modal>
        </>
    )
}

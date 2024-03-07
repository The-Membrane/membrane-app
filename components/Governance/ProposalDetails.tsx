import { ProposalResponse } from '@/contracts/codegen/governance/Governance.types'
import { truncate } from '@/helpers/truncate'
import {
  Box,
  Button,
  HStack,
  Link,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Stack,
  Text,
  useDisclosure,
} from '@chakra-ui/react'
import { Badge } from './Badge'

type Props = {
  proposal: ProposalResponse
}

const CreatedBy = ({ submitter }: { submitter: string }) => {
  const url = `https://www.mintscan.io/osmosis/address/${submitter}`
  return (
    <HStack>
      <Text fontSize="sm">Created by:</Text>
      <Link isExternal href={url} color="primary.200">
        {truncate(submitter, 'osmo')}
      </Link>
    </HStack>
  )
}

const ProposalStatus = ({ status }: { status: string }) => {
  return (
    <HStack>
      <Text fontSize="sm">Status:</Text>
      <Badge status={status} />
    </HStack>
  )
}

const ProposalLink = ({ link }: { link?: string | null }) => {
  return (
    <HStack>
      <Text fontSize="sm">Link:</Text>
      <Link isExternal href={link} color="primary.200">
        proposal discussion
      </Link>
    </HStack>
  )
}

const Power = ({ label, power }: { label: string; power: string }) => {
  return (
    <HStack borderRadius="md" bg="whiteAlpha.200" py="1" px="3">
      <Text fontSize="sm">{label}:</Text>
      <Text color="primary.200">{power}</Text>
    </HStack>
  )
}

const ProposalDescription = ({ description }: { description: string }) => {
  return (
    <Box fontSize="sm" ml="-3" p="3" bg="whiteAlpha.200" borderRadius="md">
      {description}
    </Box>
  )
}

const ProposalDetails = ({ proposal }: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()

  return (
    <>
      <Button
        onClick={onOpen}
        variant="link"
        minW="fit-content"
        w="fit-content"
        size="sm"
        fontSize="sm"
      >
        view
      </Button>

      <Modal isOpen={isOpen} onClose={onClose} size="2xl">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>
            <Text variant="title">Proposal Details</Text>
            <Text fontSize="small" color="whiteAlpha.600">
              {proposal.title}
            </Text>
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Stack gap="5">
              <ProposalDescription description={proposal.description} />

              <Stack gap="0">
                <ProposalLink link={proposal.link} />
                <HStack justifyContent="space-between">
                  <CreatedBy submitter={proposal.submitter} />
                  <ProposalStatus status={proposal.status} />
                </HStack>
              </Stack>

              <HStack justifyContent="space-between">
                <Power label="Against" power={proposal.against_power} />
                <Power label="Aligned" power={proposal.aligned_power} />
                <Power label="Amendment" power={proposal.amendment_power} />
                <Power label="Removal" power={proposal.removal_power} />
              </HStack>
            </Stack>
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  )
}

export default ProposalDetails

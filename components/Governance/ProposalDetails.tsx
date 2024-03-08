import { truncate } from '@/helpers/truncate'
import {
  Box,
  Button,
  Circle,
  HStack,
  Icon,
  Link,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  SimpleGrid,
  Stack,
  Text,
  useDisclosure,
} from '@chakra-ui/react'
import { Badge } from './Badge'
import { ProposalResponse } from '@/services/governance'
import { CheckIcon, DeleteIcon } from '@chakra-ui/icons'
import { Fragment, useState } from 'react'
import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import VoteButton from './VoteButton'
import ExecuteButton from './ExecuteButton'
import RemoveButton from './RemoveButton'
import useWallet from '@/hooks/useWallet'
import ActionButtons from './ActionButtons'

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

const ProposalBadge = ({ badge }: { badge: string }) => {
  return (
    <HStack>
      <Text fontSize="sm">Status:</Text>
      <Badge badge={badge} />
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

type PowerProps = {
  label: string
  power: number
  isSelected?: boolean
  onSelect?: () => void
}

const PowerAction = ({ label, power, isSelected, onSelect }: PowerProps) => {
  return (
    <Button
      as={HStack}
      borderRadius="md"
      bg="whiteAlpha.200"
      py="2"
      px="3"
      onClick={onSelect}
      boxShadow="md"
      w="full"
      color="whiteAlpha.700"
      _hover={{ bg: 'whiteAlpha.300' }}
      _active={{ bg: 'whiteAlpha.300' }}
    >
      <Text fontSize="sm" textTransform="capitalize">
        {label}:
      </Text>
      <Text flexGrow={1} color="primary.200">
        {power}%
      </Text>
      {isSelected && (
        <Circle bg="primary.200" p="1.5">
          <Icon as={CheckIcon} boxSize="3" />
        </Circle>
      )}
    </Button>
  )
}

const Power = ({ label, power }: PowerProps) => {
  return (
    <HStack
      borderRadius="md"
      bg="whiteAlpha.200"
      py="2"
      px="3"
      boxShadow="md"
      w="full"
      color="whiteAlpha.700"
    >
      <Text fontSize="sm" textTransform="capitalize">
        {label}:
      </Text>
      <Text flexGrow={1} color="primary.200">
        {power}%
      </Text>
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

const votes = ['for', 'against', 'amend', 'remove', 'align']

const ProposalDetails = ({ proposal }: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [vote, setVote] = useState<ProposalVoteOption | null>()
  const { address } = useWallet()
  const buttonLabel = proposal?.status === 'active' ? 'Vote' : 'View'

  const isExecuteAllowed = proposal?.badge === 'passed'
  const isRemoveAllowed = proposal?.submitter === address
  const isVoteAllowed = proposal?.status === 'active' || proposal?.status === 'pending'
  const isPending = proposal?.status === 'pending'

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
        {buttonLabel}
      </Button>

      <Modal isOpen={isOpen} onClose={onClose} size="2xl" closeOnOverlayClick={false}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>
            <Text variant="title">Proposal Details</Text>
            <HStack>
              <Badge badge={proposal.badge} py="0" />
              <Text fontSize="small" color="whiteAlpha.600">
                {proposal.title}
              </Text>
              <Text fontSize="small" color="whiteAlpha.600">
                {isPending ? 'this proposal is pending' : null}
              </Text>
            </HStack>
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody pb="5">
            <Stack gap="5">
              <ProposalDescription description={proposal.description} />

              <Stack gap="0">
                <ProposalLink link={proposal.link} />
                <HStack justifyContent="space-between">
                  <CreatedBy submitter={proposal.submitter} />
                  {/* <ProposalBadge badge={proposal.badge} /> */}
                </HStack>
              </Stack>

              {!isVoteAllowed && (
                <HStack justifyContent="space-between">
                  <Power label="For" power={proposal.ratio.forRatio} />
                  <Power label="Against" power={proposal.ratio.againstRatio} />
                  <Power label="Align" power={proposal.ratio.againstRatio} />
                  <Power label="Amend" power={proposal.ratio.alignRatio} />
                  <Power label="Remove" power={proposal.ratio.removeRatio} />
                </HStack>
              )}

              {isVoteAllowed && (
                <Stack>
                  <Text fontSize="sm">Select to vote</Text>
                  <SimpleGrid columns={3} spacing={4}>
                    {isPending ? (
                      <PowerAction
                        label="Align"
                        power={proposal.ratio?.alignRatio}
                        isSelected={vote === 'align'}
                        onSelect={() => setVote('align' as ProposalVoteOption)}
                      />
                    ) : (
                      <Fragment>
                        {votes.map((v) => (
                          <PowerAction
                            label={v}
                            power={proposal.ratio?.[v + 'Ratio']}
                            isSelected={vote === v}
                            onSelect={() => setVote(v as ProposalVoteOption)}
                          />
                        ))}
                      </Fragment>
                    )}
                  </SimpleGrid>
                </Stack>
              )}
            </Stack>
          </ModalBody>
          {(isVoteAllowed || isRemoveAllowed || isExecuteAllowed) && (
            <ModalFooter
              as={HStack}
              justifyContent="end"
              borderTop="1px solid"
              borderColor="whiteAlpha.200"
              pt="5"
              gap="5"
            >
              <ActionButtons
                proposal={proposal}
                isExecuteAllowed={isExecuteAllowed}
                isRemoveAllowed={isRemoveAllowed}
                isVoteAllowed={isVoteAllowed}
                isPending={isPending}
                vote={vote}
              />
            </ModalFooter>
          )}
        </ModalContent>
      </Modal>
    </>
  )
}

export default ProposalDetails

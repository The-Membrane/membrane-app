import { truncate } from '@/helpers/truncate'
import {
  Avatar,
  Button,
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
  Skeleton,
  Stack,
  Text,
  useDisclosure,
} from '@chakra-ui/react'
import { FaXTwitter, FaDiscord } from 'react-icons/fa6'
import useDelegator from './hooks/useDelegator'
import { num } from '@/helpers/num'
import { colors } from '@/config/defaults'

type Delegator = {
  name: string
  socials: string[]
  address: string
}

const Delegator = ({ name, socials, address }: Delegator) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const { data: delegatorInfo, isLoading } = useDelegator(address, isOpen)
  const [twtter, discord] = socials || []
  const { commission = 0, totalDelegation = 0 } = delegatorInfo || {}

  return (
    <>
      <Button variant="link" onClick={onOpen} w="fit-content" size="sm" fontSize="sm">
        {name}
      </Button>

      <Modal isOpen={isOpen} onClose={onClose} closeOnOverlayClick={false}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>
            <Text variant="title">Delegator info</Text>
            <Text color="whiteAlpha.600" fontSize="md">
              {name}
            </Text>
          </ModalHeader>
          <ModalCloseButton />

          <ModalBody>
            <Stack gap="3">
              <HStack
                justifyContent="space-between"
                borderBottom="1px solid"
                borderColor="whiteAlpha.300"
                pb="1"
              >
                <Text color="whiteAlpha.600">Address</Text>
                <Link isExternal href={`https://www.mintscan.io/osmosis/address/${address}`} color={colors.link}>
                  {truncate(address, 'osmo')}
                </Link>
              </HStack>

              <HStack
                justifyContent="space-between"
                borderBottom="1px solid"
                borderColor="whiteAlpha.300"
                pb="1"
              >
                <Text color="whiteAlpha.600">Total Delegated</Text>
                <Skeleton isLoaded={!isLoading} minW="100px" textAlign="right">
                  <Text>{totalDelegation}</Text>
                </Skeleton>
              </HStack>

              <HStack
                justifyContent="space-between"
                borderBottom="1px solid"
                borderColor="whiteAlpha.300"
                pb="1"
              >
                <Text color="whiteAlpha.600">Commision</Text>
                <Skeleton isLoaded={!isLoading} minW="50px" textAlign="right">
                  <Text>{num(commission).times(100).toNumber()}%</Text>
                </Skeleton>
              </HStack>
            </Stack>
          </ModalBody>
          <ModalFooter gap="5" justifyContent="space-between">
            <HStack>
              <Icon as={FaXTwitter} boxSize="3" />
              <Link isExternal href={`https://twitter.com/${twtter}`} fontSize="sm">
                {twtter}
              </Link>
            </HStack>
            <HStack>
              <Icon as={FaDiscord} boxSize="4" />
              <Text fontSize="sm">{discord}</Text>
            </HStack>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}

export default Delegator

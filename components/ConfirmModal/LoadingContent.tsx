import { ModalContent, ModalBody, Text, VStack, Spinner, Stack } from '@chakra-ui/react'
import React from 'react'
import LoaderWithIcon from '../LoaderWithIcon'
import { Action } from '@/types/tx'
import useWallet from '@/hooks/useWallet'

type Props = {
  action?: Action
}

export const LoadingContent = ({ action }: Props) => {
  // TODO(evm-migration): cosmos-kit exposed the connected `wallet` (with `.prettyName`);
  // wagmi exposes the active `connector` whose `.name` is the closest equivalent.
  const { connector, isWalletConnected } = useWallet()
  const wallentName = connector?.name || 'wallet'

  if (!action?.tx?.isPending) return null

  const messages = {
    approve: `Approve transaction on ${wallentName}`,
    broadcast: 'Broadcasting transaction',
  }

  return (
    <ModalContent>
      <Stack h="140px" my="16" alignItems="center" w="full">
        <LoaderWithIcon />
        <Text color="white" fontSize="xs" fontWeight="normal">
          {action?.tx?.isApproved ? messages.broadcast : messages.approve}
        </Text>
      </Stack>
    </ModalContent>
  )
}

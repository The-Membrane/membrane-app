import { ModalContent, ModalBody, Text, VStack, Spinner, Stack } from '@chakra-ui/react'
import React from 'react'
import LoaderWithIcon from '../LoaderWithIcon'
import { Action } from '@/types/tx'
import useWallet from '@/hooks/useWallet'

type Props = {
  action?: Action
}

export const LoadingContent = ({ action }: Props) => {
  const { wallet, isWalletConnected } = useWallet()
  const wallentName = wallet?.prettyName || 'wallet'

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

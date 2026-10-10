import { Link, Text, useToast, UseToastOptions, VStack } from '@chakra-ui/react'
import useWallet from './useWallet'
import { useChainRoute } from './useChainRoute'
import { getTxExplorerUrl } from '@/helpers/explorer'

export enum ToastTypes {
  Success = 'success',
  Error = 'error',
  Pending = 'pending',
  Warning = 'warning',
  Info = 'info',
}

export interface ToastPayload {
  actions?: JSX.Element
  message?: string | JSX.Element
  title: string
  type: ToastTypes
  dismissable?: boolean
}

type ToastProps = {
  message: JSX.Element | string
  title?: string
  chainName?: string
  txHash?: string
  duration?: number | null,
  shrinkMessage?: boolean
}
export interface IToaster {
  dismiss: any
  message: (data: ToastProps) => void
  success: (data: ToastProps) => void
  pending: (data: ToastProps) => void
  error: (data: ToastProps) => void
}

const defaultSettings: UseToastOptions = {
  duration: 9000,
  variant: 'left-accent',
  colorScheme: 'primary',
  isClosable: true,
  containerStyle: {
    margin: 5,
    bg: '#05071B',
    borderRadius: 'md',
    // boxShadow: '0px 0px 24px 0px rgba(250, 129, 253, 0.32)',
    backdropFilter: 'blur(6px)',
  },
}

type ToastContentProps = {
  message: JSX.Element | string
  txHash?: string
  txLink?: string
}

const ToastContent = ({ message, txHash, txLink }: ToastContentProps) => {
  const first4 = txHash?.slice(0, 4)
  const last4 = txHash?.slice(-4)
  const txLabel = `TxHash: ${[first4, last4].join('...')}`

  return (
    <VStack alignItems="flex-start" gap={0} paddingTop={"3%"}>
      {typeof message === "string" ? <span>{message}</span> : message}
      {!!txHash && (txLink ? (
        <Link isExternal href={txLink} style={{ margin: 'unset' }}>
          {txLabel}
        </Link>
      ) : (
        // No block explorer on this chain (e.g. local anvil): show the hash, don't link it
        <Text as="span">{txLabel}</Text>
      ))}
    </VStack>
  )
}

const useToaster = (): IToaster => {
  const toast = useToast()
  const { chainName } = useChainRoute()
  const { chain } = useWallet(chainName)

  const error = ({ message, txHash }: ToastProps) => {
    toast({
      ...defaultSettings,
      title: 'Error',
      description: (
        <ToastContent message={message} txHash={txHash} txLink={getTxExplorerUrl(chain, txHash)} />
      ),
      status: ToastTypes.Error,
      position: 'top-right',
    })
  }
  const success = ({ message, txHash, shrinkMessage }: ToastProps) => {
    console.log("success", message, txHash)
    toast({
      ...defaultSettings,
      title: 'Success',
      description: (
        !shrinkMessage && <ToastContent message={message} txHash={txHash} txLink={getTxExplorerUrl(chain, txHash)} />
      ),
      status: ToastTypes.Success,
      position: 'top-right',
    })
  }
  const pending = ({ message, txHash }: ToastProps) => {
    toast({
      ...defaultSettings,
      title: 'Pending',
      description: <ToastContent message={message} txHash={txHash} txLink={getTxExplorerUrl(chain, txHash)} />,
      status: ToastTypes.Info,
      position: 'top-right',
    })
  }
  const message = ({ title, message, duration = 7000 }: ToastProps) => {
    toast({
      ...defaultSettings,
      title: title,
      description: <ToastContent message={message} />,
      status: ToastTypes.Info,
      position: 'top-right',
      duration,
    })
  }

  //dismiss logic is missing for now
  return {
    dismiss: () => { toast.closeAll() },
    message,
    success,
    error,
    pending,
  }
}

export default useToaster

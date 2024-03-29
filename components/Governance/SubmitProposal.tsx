import {
  Button,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Stack,
  Text,
  useDisclosure,
} from '@chakra-ui/react'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useFilePicker } from 'use-file-picker'
import { DescriptionField, LinkField, TitleField } from './Fields'
import FilePicker from './FilePicker'
import useSubmitProposal from './hooks/useSubmitProposal'
import { TxButton } from '../TxButton'
import TxError from '@/components/TxError'

type Props = {}

const SubmitProposal = (props: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()

  const { openFilePicker, filesContent, clear } = useFilePicker({
    accept: '.json',
  })

  const {
    handleSubmit,
    register,
    formState: { errors, isSubmitting, isValid },
    reset,
    setValue,
    setError,
    getValues,
  } = useForm({
    defaultValues: {
      title: '',
      description: '',
      link: '',
      msgs: {},
    },
  })

  const values = getValues()

  const submitProposal = useSubmitProposal({
    values,
    enabled: isValid,
  })

  // register msgs field
  useEffect(() => {
    register('msgs', {
      required: 'Msgs is required',
      pattern: {
        value: /^.*$/,
        message: 'Invalid json file',
      },
    })
  }, [])

  // validate json file content
  useEffect(() => {
    if (filesContent.length > 0) {
      try {
        const json = JSON.parse(filesContent[0]?.content)
        setValue('msgs', json, {
          shouldValidate: true,
        })
      } catch (e) {
        setError('msgs', {
          type: 'manual',
          message: 'Invalid json file',
        })
      }
    }
  }, [filesContent?.[0]?.content])

  const onSubmit = () => {
    submitProposal?.tx.mutate()
  }

  const onModalClose = () => {
    reset()
    clear()
    onClose()
  }

  return (
    <>
      <Button onClick={onOpen} w="fit-content" size="sm" fontSize="sm" px="5">
        Submit Proposal
      </Button>

      <Modal isOpen={isOpen} onClose={onModalClose} size="xl" closeOnOverlayClick={false}>
        <ModalOverlay />
        <ModalContent>
          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <ModalHeader>
              <Text variant="title">Submit Proposal</Text>
            </ModalHeader>

            <ModalCloseButton />

            <ModalBody>
              <Stack gap="5">
                <TitleField register={register} errors={errors} />
                <DescriptionField register={register} errors={errors} />
                <LinkField register={register} errors={errors} />
                <FilePicker
                  filesContent={filesContent}
                  openFilePicker={openFilePicker}
                  errors={errors}
                />
              </Stack>
            </ModalBody>

            <ModalFooter as={Stack}>
              <TxButton
                maxW="200px"
                type="submit"
                isLoading={submitProposal?.simulate.isLoading || submitProposal?.tx.isPending}
                isDisabled={submitProposal?.simulate.isError || !submitProposal?.simulate.data}
                // onClick={() => submitProposal?.tx.mutate()}
              >
                Submit Proposal
              </TxButton>
              <TxError action={submitProposal} />
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </>
  )
}

export default SubmitProposal

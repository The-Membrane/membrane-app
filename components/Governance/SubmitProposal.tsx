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
  } = useForm({
    defaultValues: {
      title: '',
      description: '',
      link: '',
      msgs: {},
    },
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

  function onSubmit(values) {
    return new Promise((resolve) => {
      setTimeout(() => {
        alert(JSON.stringify(values, null, 2))
        resolve(true)
      }, 3000)
    })
  }

  const onModalClose = () => {
    reset()
    clear()
    onClose()
  }

  return (
    <>
      <Button onClick={onOpen} w="fit-content" size="sm" fontSize="xs">
        Submit Proposal
      </Button>

      <Modal isOpen={isOpen} onClose={onModalClose} size="xl">
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

            <ModalFooter>
              <Button
                type="submit"
                w="fit-content"
                fontSize="sm"
                px="10"
                isDisabled={isSubmitting || !isValid}
                isLoading={isSubmitting}
              >
                Submit
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </>
  )
}

export default SubmitProposal

import { Select as ChakraSelect, ChakraStylesConfig, OptionProps } from 'chakra-react-select'
import { Asset } from '@/helpers/chain'

const chakraStyles: ChakraStylesConfig = {
  singleValue: (provided, state) => ({
    ...provided,
    border: 'none',
    fontSize: '16px',
    justifyContent: 'center',
    display: 'flex',
    px: 2,
    cursor: 'pointer',
  }),
  control: (provided, state) => ({
    ...provided,
    bg: 'transparent',
    border: 'none',
    boxShadow: 'none',
    borderRadius: 16,
    _focus: {
      boxShadow: 'none',
    },
  }),
  container: (provided, state) => ({
    ...provided,
    padding: 1,
    borderRadius: 16,
    bg: '#C445F0',
    color: '#fff',
  }),
  option: (provided) => ({
    ...provided,
    bg: 'transparent',
    color: '#fff',
    cursor: 'pointer',
    width: '100%',
    justifyContent: 'center',
    _selected: {
      bg: '#C445F0',
    },
    _hover: {
      bg: '#C445F0',
    },
  }),
  menuList: (provided, state) => ({
    ...provided,
    padding: 0,
    minW: 'full',
    borderRadius: 16,
    width: 'max-content',
    justifyContent: 'center',
    minWidth: '200px',
    ml: '-5px',
  }),
}

type Props = {
  options: OptionProps<any>[]
  onChange?: (value: any) => void
  value?: Asset | undefined
}

const QASelect = ({ options, onChange, value }: Props) => {
  if (!options) return null
  console.log("Value", value)
  return (
    <ChakraSelect
      isSearchable={false}
      variant="unstyled"
      chakraStyles={chakraStyles}
      defaultValue={options?.[0]}
      value={(value?.symbol??"None")}
      options={options}
      onChange={onChange}
    />
  )
}

export default QASelect

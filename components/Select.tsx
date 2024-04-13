import { Select as ChakraSelect, ChakraStylesConfig, OptionProps } from 'chakra-react-select'

const chakraStyles: ChakraStylesConfig = {
  singleValue: (provided, state) => ({
    ...provided,
    border: 'none',
    fontSize: '16px',
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
    width: 'full',
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
    minWidth: '200px',
    ml: '-50px',
  }),
}

type Props = {
  options: OptionProps<any>[]
  onChange?: (value: any) => void
  value?: any
}

const Select = ({ options, onChange, value }: Props) => {
  if (!options) return null
  return (
    <ChakraSelect
      isSearchable={false}
      variant="unstyled"
      chakraStyles={chakraStyles}
      defaultValue={options?.[0]}
      value={value}
      options={options}
      onChange={onChange}
    />
  )
}

export default Select

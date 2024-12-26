import { colors } from '@/config/defaults'
import { Select as ChakraSelect, ChakraStylesConfig, OptionProps } from 'chakra-react-select'

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
    width: '15%',
    padding: 1,
    borderRadius: 16,
    bg: colors.walletIcon,
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
      bg: colors.walletIcon,
    },
    _hover: {
      bg: colors.walletIcon,
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
  value: string
}

const QASelect = ({ options, onChange, value }: Props) => {
  if (!options) return null
  // if (options && options.length === 0) return "No collateral in wallet"
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

export default QASelect

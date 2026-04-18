import Select, { type SingleValue } from 'react-select'
import { useModelStore } from '../../stores'
import { darkSelectStyles } from '../../styles/selectTheme'

interface ModelOption {
  value: string
  label: string
  isNew?: boolean
}

const selectStyles = darkSelectStyles<ModelOption>()

export function ModelSelector() {
  const { currentModelKey, models, switchModel } = useModelStore()

  const options: ModelOption[] = Object.entries(models).map(([key, info]) => ({
    value: key,
    label: info.name,
  }))

  const selected = options.find((o) => o.value === currentModelKey) ?? null

  const handleChange = (opt: SingleValue<ModelOption>) => {
    if (opt) switchModel(opt.value)
  }

  return (
    <div className="w-56">
      <Select<ModelOption>
        value={selected}
        onChange={handleChange}
        options={options}
        styles={selectStyles}
        placeholder="Select model..."
        isSearchable
        menuPlacement="auto"
      />
    </div>
  )
}

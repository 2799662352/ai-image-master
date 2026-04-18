import Select, { type SingleValue } from 'react-select'
import { darkSelectStyles } from '../../styles/selectTheme'

interface ModelOption {
  value: string
  label: string
}

interface ModelPairSelectorProps {
  options: ModelOption[]
  leftValue: string | null
  rightValue: string | null
  onLeftChange: (key: string | null) => void
  onRightChange: (key: string | null) => void
}

export function ModelPairSelector({ options, leftValue, rightValue, onLeftChange, onRightChange }: ModelPairSelectorProps) {
  const leftOption = options.find((o) => o.value === leftValue) ?? null
  const rightOption = options.find((o) => o.value === rightValue) ?? null

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="text-sm text-gray-400 mb-1 block">左侧模型</label>
        <Select<ModelOption>
          value={leftOption}
          onChange={(v: SingleValue<ModelOption>) => onLeftChange(v?.value ?? null)}
          options={options}
          styles={darkSelectStyles<ModelOption>()}
          placeholder="选择模型..."
        />
      </div>
      <div>
        <label className="text-sm text-gray-400 mb-1 block">右侧模型</label>
        <Select<ModelOption>
          value={rightOption}
          onChange={(v: SingleValue<ModelOption>) => onRightChange(v?.value ?? null)}
          options={options}
          styles={darkSelectStyles<ModelOption>()}
          placeholder="选择模型..."
        />
      </div>
    </div>
  )
}

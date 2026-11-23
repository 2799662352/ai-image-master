import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomGatewayUrlField } from '../CustomGatewayUrlField'

afterEach(() => cleanup())

describe('CustomGatewayUrlField', () => {
  it('显示当前生效地址', () => {
    render(
      <CustomGatewayUrlField
        value="https://gw.example.com"
        activeUrl="https://gw.example.com"
        onChange={() => {}}
      />,
    )

    expect(screen.getByText(/当前:/).textContent).toContain('https://gw.example.com')
  })

  it('敲到一半不合法时说清原因,并写明仍在用哪个地址', () => {
    render(
      <CustomGatewayUrlField value="http://" activeUrl="https://still-in-use.example.com" onChange={() => {}} />,
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/地址格式不正确/)
    expect(alert.textContent).toContain('https://still-in-use.example.com')
    expect(screen.queryByText(/^当前:/)).toBeNull()
  })

  it('公网明文 http 给出安全提示', () => {
    render(
      <CustomGatewayUrlField
        value="http://api.example.com"
        activeUrl="http://api.example.com"
        onChange={() => {}}
      />,
    )

    expect(screen.getByRole('note').textContent).toMatch(/明文 http/)
  })

  it('本机 / https 不弹安全提示', () => {
    const { rerender } = render(
      <CustomGatewayUrlField value="http://127.0.0.1:3000" activeUrl="http://127.0.0.1:3000" onChange={() => {}} />,
    )
    expect(screen.queryByRole('note')).toBeNull()

    rerender(
      <CustomGatewayUrlField value="https://api.example.com" activeUrl="https://api.example.com" onChange={() => {}} />,
    )
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('离开输入框时把原文收成归一化地址', () => {
    const onChange = vi.fn()
    render(
      <CustomGatewayUrlField value="api.example.com/v1/" activeUrl="https://api.example.com" onChange={onChange} />,
    )

    fireEvent.blur(screen.getByLabelText('网关地址'))

    expect(onChange).toHaveBeenCalledWith('https://api.example.com')
  })

  it('原文已经是归一化结果时,离开不重复触发', () => {
    const onChange = vi.fn()
    render(
      <CustomGatewayUrlField value="https://api.example.com" activeUrl="https://api.example.com" onChange={onChange} />,
    )

    fireEvent.blur(screen.getByLabelText('网关地址'))

    expect(onChange).not.toHaveBeenCalled()
  })

  it('不合法时离开也不改输入框', () => {
    const onChange = vi.fn()
    render(<CustomGatewayUrlField value="http://" activeUrl="https://x.com" onChange={onChange} />)

    fireEvent.blur(screen.getByLabelText('网关地址'))

    expect(onChange).not.toHaveBeenCalled()
  })

  it('输入框改动把原文交给上层', () => {
    const onChange = vi.fn()
    render(<CustomGatewayUrlField value="" activeUrl="http://127.0.0.1:3000" onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('网关地址'), { target: { value: '192.168.1.5:3000' } })

    expect(onChange).toHaveBeenCalledWith('192.168.1.5:3000')
  })
})

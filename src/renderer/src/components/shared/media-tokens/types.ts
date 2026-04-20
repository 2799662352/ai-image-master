export interface MediaRef {
  index: number
  type: 'image'
  url: string
  label?: string
}

export type TokenTheme = 'punk' | 'default'

export const TOKEN_REGEX = /【@图片(\d+)】/g

export const makeToken = (n: number): string => `【@图片${n}】`

import { type ReactNode } from 'react'

/**
 * BatchShell - 批量生成页根容器,沿用 GeneratePage / HistoryPage 的 zinc + cyberpunk-yellow 风格。
 * 之前的 PunkShell 用了 P5 朋克拼贴(危险带、缺角、绝对定位红印),太花。
 * 现在只保留:暗背景 + 适度 padding + 容器宽度,装饰交给子组件自己加。
 */
export default function BatchShell({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`mx-auto w-full max-w-6xl xl:max-w-7xl 2xl:max-w-[1600px] px-4 md:px-6 xl:px-10 pt-2 md:pt-3 pb-8 space-y-5 ${className}`}
      style={{ marginTop: '-1rem' }}
    >
      {children}
    </div>
  )
}

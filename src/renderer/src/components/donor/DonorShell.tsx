import { type ReactNode } from 'react'

/**
 * Donor 外壳: 提供 .donor-theme 根作用域 + 默认紫黑背景
 * scanline/grain overlay 由 CSS ::before/::after 处理
 *
 * 关键:父级 <main class="container mx-auto"> 会把宽度钳到 breakpoint(sm=640/md=768/...)
 * 这里用 viewport breakout (100vw + 负 margin) 让 History 页脱离 container 约束、占满全宽
 */
export default function DonorShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`donor-theme px-4 md:px-6 pt-2 md:pt-3 pb-6 md:pb-8 ${className}`}
      style={{
        width: '100vw',
        maxWidth: '100vw',
        marginLeft: 'calc(50% - 50vw)',
        marginRight: 'calc(50% - 50vw)',
        marginTop: '-1rem',
      }}
    >
      {children}
    </div>
  )
}

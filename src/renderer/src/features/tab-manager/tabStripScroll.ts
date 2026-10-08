// src/renderer/src/features/tab-manager/tabStripScroll.ts
/**
 * 导航标签条横向滚动
 * 标签放不下时可左右滚动:原生滚动条隐藏,悬停时在底边下方浮出细滑块(可拖、点轨道跳转),
 * 鼠标滚轮的纵向滚动映射成横向。样式见 public/css/components.css 的 `.tab-strip`。
 */

const MIN_THUMB_PX = 32
const REVEAL_MARGIN_PX = 24

export interface TabStripScroll {
  /** 按当前尺寸与滚动位置重算滑块 */
  update(): void
  /** 把指定标签滚进可视区,已完整可见时不动 */
  revealTab(tabName: string): void
  destroy(): void
}

export function initTabStripScroll(strip: HTMLElement): TabStripScroll | null {
  const scroller = strip.querySelector<HTMLElement>('.tab-strip-scroller')
  if (!scroller) return null

  const rail = document.createElement('div')
  rail.className = 'tab-strip-rail'
  rail.setAttribute('aria-hidden', 'true')
  const thumb = document.createElement('div')
  thumb.className = 'tab-strip-thumb'
  rail.appendChild(thumb)
  strip.appendChild(rail)

  const measure = () => {
    const { scrollWidth, clientWidth } = scroller
    const thumbWidth = Math.min(clientWidth, Math.max(MIN_THUMB_PX, (clientWidth * clientWidth) / scrollWidth))
    return { maxScroll: scrollWidth - clientWidth, thumbWidth, maxThumbLeft: clientWidth - thumbWidth }
  }

  const update = (): void => {
    const { maxScroll, thumbWidth, maxThumbLeft } = measure()
    const overflowing = maxScroll > 1
    strip.classList.toggle('is-overflowing', overflowing)
    if (!overflowing) return
    thumb.style.width = `${thumbWidth}px`
    thumb.style.transform = `translateX(${(scroller.scrollLeft / maxScroll) * maxThumbLeft}px)`
  }

  const onWheel = (event: WheelEvent): void => {
    const maxScroll = scroller.scrollWidth - scroller.clientWidth
    if (maxScroll <= 1 || event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
    // 滚到头的那一侧不拦截,页面照常纵向滚动
    if (event.deltaY < 0 ? scroller.scrollLeft <= 0 : scroller.scrollLeft >= maxScroll - 1) return
    event.preventDefault()
    scroller.scrollLeft += event.deltaY
  }

  const onThumbPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const { maxScroll, maxThumbLeft } = measure()
    if (maxThumbLeft <= 0) return
    event.preventDefault()
    const startX = event.clientX
    const startScroll = scroller.scrollLeft
    const onMove = (move: PointerEvent): void => {
      scroller.scrollLeft = startScroll + ((move.clientX - startX) * maxScroll) / maxThumbLeft
    }
    thumb.setPointerCapture(event.pointerId)
    thumb.addEventListener('pointermove', onMove)
    thumb.addEventListener('lostpointercapture', () => {
      thumb.removeEventListener('pointermove', onMove)
      strip.classList.remove('is-dragging')
    }, { once: true })
    strip.classList.add('is-dragging')
  }

  const onRailPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.target !== rail) return
    const { maxScroll, thumbWidth, maxThumbLeft } = measure()
    if (maxThumbLeft <= 0) return
    const offset = event.clientX - rail.getBoundingClientRect().left - thumbWidth / 2
    scroller.scrollTo({
      left: (Math.min(Math.max(offset, 0), maxThumbLeft) / maxThumbLeft) * maxScroll,
      behavior: 'smooth'
    })
  }

  const revealTab = (tabName: string): void => {
    const button = Array.from(scroller.querySelectorAll<HTMLElement>('.tab-btn'))
      .find(btn => btn.dataset.tab === tabName)
    if (!button) return
    const view = scroller.getBoundingClientRect()
    const rect = button.getBoundingClientRect()
    if (rect.left < view.left) {
      scroller.scrollBy({ left: rect.left - view.left - REVEAL_MARGIN_PX, behavior: 'smooth' })
    } else if (rect.right > view.right) {
      scroller.scrollBy({ left: rect.right - view.right + REVEAL_MARGIN_PX, behavior: 'smooth' })
    }
  }

  // 切语言会改标签宽度而不改容器宽度,所以每个标签也要观察
  const resizeObserver = new ResizeObserver(() => update())
  resizeObserver.observe(scroller)
  scroller.querySelectorAll('.tab-btn').forEach(btn => resizeObserver.observe(btn))
  scroller.addEventListener('scroll', update, { passive: true })
  strip.addEventListener('wheel', onWheel, { passive: false })
  thumb.addEventListener('pointerdown', onThumbPointerDown)
  rail.addEventListener('pointerdown', onRailPointerDown)
  update()

  return {
    update,
    revealTab,
    destroy: () => {
      resizeObserver.disconnect()
      scroller.removeEventListener('scroll', update)
      strip.removeEventListener('wheel', onWheel)
      rail.remove()
      strip.classList.remove('is-overflowing', 'is-dragging')
    }
  }
}

// 卡片防抖落库的定时器表。独立成模块是为了让 projects slice 能在删卡前取消挂着的
// 落库,而不必从 store.ts 导入值 —— store.ts 又要导入 slice,值级别的环会让先加载
// projects.ts 的一方拿到 undefined 的 createProjectsSlice。

export const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 取消一张卡挂着的防抖落库(删卡前调,否则定时器会把已删的卡重新写回库)。 */
export function cancelPendingPersist(cardId: string): void {
  const prev = persistTimers.get(cardId)
  if (prev) {
    clearTimeout(prev)
    persistTimers.delete(cardId)
  }
}

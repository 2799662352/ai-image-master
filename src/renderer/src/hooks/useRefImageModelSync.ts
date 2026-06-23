import { useEffect, useRef } from 'react'

/**
 * useRefImageModelSync — 切换模型时按"参考图格式制式"双向清洗参考图。
 *
 * 背景:不同端点对参考图的格式要求不一样,且互不兼容:
 *  - base64 内联模型(gemini-native / nano / 大香蕉全系):参考图必须以 inline_data
 *    (data: base64)发送,远端 http(s) URL 支持不稳定 → 切进来时清掉 URL 参考图。
 *  - URL 模型(万相 wan2.7 等):参考图要走公网 URL,本地 data: base64 不被接受 →
 *    切进来时清掉本地 base64 参考图。
 *
 * 与其在发送时偷偷 fetch/转码(易卡顿、跨域失败),不如在切换那一刻清掉不兼容的,
 * 提示用户重新上传(重新上传会走正确的 skipCos 策略,见 BatchRefDrop / refImageUpload)。
 *
 * 设计要点(修复"批量页切两次才清理 + 卡顿"的根因):
 *  - 调用方必须把 `wantsInlineBase64` 用**同步**派生值传进来(直接读 model store 的
 *    apiType,而不是异步 setState 出来的 modelConfig),否则切换那一刻 flag 是旧值,
 *    清洗会错过一拍。GeneratePage 一直是同步的(工作正常),BatchPage 之前是异步的
 *    (modelConfig 慢一拍)→ 才出现切两次。
 *  - 只在 modelKey **真正切换**的那一刻触发,不在每次参考图变化时清。
 *  - 这是所有页面(生成/批量/朋克)共用的唯一入口,一改全改。
 */
export function useRefImageModelSync(params: {
  /** 当前模型 key —— 切换它才触发清洗 */
  currentModelKey: string
  /** 当前模型是否走 base64 内联(必须同步派生,见上方说明) */
  wantsInlineBase64: boolean
  /** store 侧的双向清洗:按新制式删掉不兼容的参考图,返回删除数量 */
  syncRefs: (wantsInlineBase64: boolean) => number
  /** 删除发生后的回调(通常弹 toast 提示用户重新上传) */
  onRemoved?: (removed: number, wantsInlineBase64: boolean) => void
}): void {
  const { currentModelKey, wantsInlineBase64, syncRefs, onRemoved } = params
  const prevKeyRef = useRef(currentModelKey)

  useEffect(() => {
    if (prevKeyRef.current === currentModelKey) return
    prevKeyRef.current = currentModelKey
    const removed = syncRefs(wantsInlineBase64)
    if (removed > 0) onRemoved?.(removed, wantsInlineBase64)
    // syncRefs / onRemoved 来自 store getState / 稳定回调,刻意不进依赖,
    // 只在 key(或同步派生的制式)变化时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentModelKey, wantsInlineBase64])
}

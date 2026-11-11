// Seedance 任务错误 → 人话。上游(火山方舟经 Miau 网关)的裸错误翻译表。
//
// 从原来的 `assets.ts` 里搬出来:那个文件是 vvdance 素材库客户端,随 vvdance 直连一起删了,
// 而这张翻译表对网关那条路仍然有用。约定不变:**认不出就原样返回**。

/**
 * 把上游创建任务的裸错误翻译成人话。未识别的错误原样返回。
 */
export function translateSeedanceTaskError(message: string): string {
  // 真人检测(火山 `input_real_face`):图片 / 视频各一个码,param 里带的是 content[] 下标。
  // 官方说法是「换成合规或虚拟的人像素材,暂无自动脱敏」—— 把这句话连同我们这边的两条
  // 出路(人像库登记 / 抽帧当参考图)一起说清楚,别让用户盯着一串英文 JSON 猜。
  const privacy = /Input(Image|Video)SensitiveContentDetected\.PrivacyInformation/.exec(message)
  if (privacy) {
    const media = privacy[1] === 'Video' ? '参考视频' : '参考图'
    const slot = /content\[(\d+)\]/.exec(message)?.[1]
    const where = slot !== undefined ? `(content[${slot}] 那一项)` : ''
    const requestId = /Request id:\s*([\w-]+)/i.exec(message)?.[1]
    return (
      `${media}${where}被上游判定含有真人,整次生成被拒(火山方舟 PrivacyInformation,官方暂不提供自动脱敏)。` +
      (privacy[1] === 'Video'
        ? '可以这样绕:① 用 ffmpeg 抽这段视频的关键帧当参考图(平台余额下图片会自动登记进人像库再引用);' +
          '② 换成人像库里的虚拟形象或 Seedance 自己生成的片段做二创;③ 把人脸裁掉 / 打码后再传。'
        : '可以这样绕:① 从人像库选择已登记的素材(asset:// 引用不走这道检测;人像库仅平台余额下可用);' +
          '② 换成虚拟形象;③ 把人脸裁掉 / 打码后再传。') +
      (requestId ? ` Request id: ${requestId}` : '')
    )
  }
  // 由样片生成成片被网关拒(new-api #113:按「本人 + Seedance 渠道 + 已成功」查样片)。
  // 只有成片请求会带 draft_task,所以这两个码在本 app 里只可能来自这条路。
  // 不带原 JSON:`task_not_exist` 会被下一层的万相翻译表误读成「任务已过期」。
  if (/task_origin_not_exist/.test(message)) {
    return (
      '找不到这条样片:网关只认同一个账号、同一个计费池里生成的样片。' +
      '请切回生成样片时用的计费池再点「生成 1080P 成片」,或重新生成样片。'
    )
  }
  if (/invalid_draft_task/.test(message)) {
    return /not succeeded/i.test(message)
      ? '这条样片还没有成功,等它出片后再生成 1080P 成片。'
      : '这条任务不是 Seedance 2.5 样片,不能用来生成成片。'
  }
  // 平台余额(网关)那条路的「素材不存在」:任务已经建了、跑到取素材才失败,原文是
  // `The specified asset asset-… is not found`。几乎总是 id 来自另一个计费池或已被彻底删除。
  // 不带原 JSON:它会被下一层当成 InvalidParameter 再包一遍「参数不合法」。
  const assetMissing = /specified asset (asset-[\w-]+|[\w-]+) is not found/i.exec(message)
  if (assetMissing) {
    const slot = /content\[(\d+)\]/.exec(message)?.[1]
    const requestId = /Request id:\s*([\w-]+)/i.exec(message)?.[1]
    return (
      `引用的素材 asset://${assetMissing[1]}${slot !== undefined ? `(content[${slot}])` : ''}` +
      '在这次提交用的素材库里找不到。素材库按账户和计费池隔离,只认当前计费池素材库里的素材 —— ' +
      '多半是这张素材登记在另一个计费池,也可能已被彻底删除。' +
      '请在卡片上删掉它,从「人像库」按钮重新选择或重新上传后再生成;原样重试还会失败。' +
      (requestId ? ` Request id: ${requestId}` : '')
    )
  }
  return message
}

/**
 * 卡片级摘要:AI 写、AI 维护的一行话,补上递归披露阶梯里缺的那一级。
 *
 * 为什么卡片这级需要人写的摘要,而不是继续截提示词开头 —— 我们的提示词是经
 * sd2-pe 按八大要素工程化过的,结构固定,所以每张卡的开头几十个字长得**都一样**
 * (景别、机位、光线那套开场)。截断在别处够用,在这里恰恰因为模板化而最没信息量。
 * 页摘要当初也是同一个理由落地的:页名常常只是「页面 3」。
 *
 * 摘要是**有损**的,而业界共识把有损摘要排在可逆卸载之后(Anthropic 的
 * effective-context-engineering:先 just-in-time 取回,summarization 是退路)。
 * 这里不违背那条顺序 —— 骨架 + cardIds 的可逆取回仍是主路,摘要只是**附加**的
 * 一层索引,没写就退回原来的截断行为,不退步。
 *
 * ## 为什么绑提示词指纹而不是 rev
 *
 * 卡片摘要真正的风险是**漂移**:提示词天天变(patch_prompt 存在的全部理由),
 * 一条过期摘要比截断更危险 —— 截断看得出残缺,过期摘要看起来是权威的。
 *
 * 直觉的做法是绑 `rev`,但 `rev` 在任何卡片变更时都涨,包括素材上传完成后把
 * 本地路径换成 COS URL 那一下(store 的 attachUploadedMaterial)—— 那是后台事件,
 * 内容一个字没变。绑 rev 会让图片传完摘要就集体过期。
 *
 * 绑提示词指纹则精确命中语义:摘要写的是这一镜的内容,只在内容变时失效。
 */

/**
 * 提示词指纹(FNV-1a 32 位,十六进制)。
 *
 * 不用加密哈希 —— 这里防的是「提示词变了摘要没跟上」,不是防篡改。碰撞的后果
 * 是一条过期摘要被当成新鲜的,而 FNV-1a 在这个量级下的碰撞率远低于「用户手动
 * 改回一模一样的提示词」这种真实情况,后者反而是我们**希望**判为新鲜的。
 */
export function promptFingerprint(prompt: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < prompt.length; i++) {
    hash ^= prompt.charCodeAt(i)
    // FNV 质数 16777619,用移位加法避免 32 位溢出丢精度。
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 摘要在这张卡上还算不算数。
 *
 * 三态而不是布尔:「没写过」和「写过但过期了」对调用方意味着不同的动作 ——
 * 前者是可选的增强,后者是明确的「该刷新了」信号。
 */
export function cardSummaryState(
  card: { prompt?: string; summary?: string; summaryFor?: string },
): 'absent' | 'fresh' | 'stale' {
  if (!card.summary) return 'absent'
  return card.summaryFor === promptFingerprint(card.prompt ?? '') ? 'fresh' : 'stale'
}

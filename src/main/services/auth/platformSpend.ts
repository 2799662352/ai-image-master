/**
 * 「平台余额刚被花掉了」的汇合点。
 *
 * ## 为什么需要它
 *
 * 余额此前只在两个时机刷新:设置页挂载(`useQuotaStore.load()`)与切计费池。出图 /
 * 出视频 / 聊天扣完钱之后没有任何东西触发刷新,于是数字停在旧值,用户要把设置页
 * 关掉重开才看得到 —— 表现成「扣费了但额度没动」,像是后端没记账。
 *
 * ## 报的是「完成」,不是「发起」
 *
 * 上游(new-api)是在**转发这次请求的事务里**落账的。在请求发出时刷新,读到的是
 * 扣费前的余额,刷了等于没刷,而且更糟:用户看到数字"刷新"了却没变,会以为这次
 * 生成是免费的。所以三条出网路径一律在拿到响应之后才报。
 *
 * ## 为什么要防抖
 *
 * 批量九张图会在一秒内完成九次,九次余额查询里有八次是浪费。尾部防抖把一串突发
 * 收敛成一次。`MAX_WAIT_MS` 是给「事件一直密于静默窗口」的情况兜底 —— 纯尾部防抖
 * 在那种输入下永远不会触发,而余额就再也不刷新了。
 *
 * ## 这个模块刻意不 import electron
 *
 * 广播由 `auth/ipc.ts` 订阅后发出。两个原因:一是 `seedanceGateway/client.ts` 刻意
 * 保持在 Electron 之外可加载(为了能对着真网关跑烟测),它 import 的东西不能把
 * electron 拽进来;二是这样这个模块能在单测里直接跑,不用搭 BrowserWindow。
 */

/** 突发收敛窗口。一次生成的收尾动作(响应完成 → 落盘 → 广播)都落在这个量级内。 */
const QUIET_MS = 1200

/**
 * 强制上限。
 *
 * 没有它的话,只要事件间隔一直小于 `QUIET_MS`,尾部防抖就会被无限推迟 —— 余额在
 * 最需要刷新的那段时间(用户正在连续出图)反而一次都不刷。
 */
const MAX_WAIT_MS = 5000

type Listener = () => void

const listeners = new Set<Listener>()
let quietTimer: ReturnType<typeof setTimeout> | null = null
let maxTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 定时器不该拖住进程退出。
 *
 * `unref` 在 Node 的 Timeout 上有,在 jsdom / 假定时器给的对象上不一定有 ——
 * 直接调用会在测试里抛,所以可选链。
 */
function unref(timer: ReturnType<typeof setTimeout>): void {
  ;(timer as { unref?: () => void }).unref?.()
}

function flush(): void {
  if (quietTimer) clearTimeout(quietTimer)
  if (maxTimer) clearTimeout(maxTimer)
  quietTimer = null
  maxTimer = null

  // 复制一份再遍历:监听者在回调里退订是合法的(登出就会),直接遍历原集合
  // 会在迭代中被改。
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (e) {
      // 一个监听者抛错不该让其余的收不到。这条链路是「刷新一下余额」,
      // 失败的代价是数字晚一点更新,不值得让它把调用方的流程带崩。
      console.warn('[platformSpend] listener failed:', e)
    }
  }
}

/**
 * 报告「一次平台余额消费已经完成」。
 *
 * 由三条出网路径在**拿到响应之后**调用,见文件头。多调无害 —— 防抖会收敛,
 * 而漏调的代价是余额不刷新,所以拿不准时宁可多报。
 */
export function notePlatformSpend(): void {
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = setTimeout(flush, QUIET_MS)
  unref(quietTimer)

  // 只在没有在途上限时起表:每次都重置就等于没有上限。
  if (!maxTimer) {
    maxTimer = setTimeout(flush, MAX_WAIT_MS)
    unref(maxTimer)
  }
}

/** 订阅收敛后的消费信号。返回退订函数。 */
export function onPlatformSpend(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Test-only：清掉模块级单例状态。
 *
 * 不清的话,上一条用例留下的在途定时器会在下一条用例里触发,把那边的监听者
 * 打出一次它没预期的调用 —— 表现成一个与本次改动无关的、时有时无的断言失败。
 */
export function __resetPlatformSpendForTesting(): void {
  if (quietTimer) clearTimeout(quietTimer)
  if (maxTimer) clearTimeout(maxTimer)
  quietTimer = null
  maxTimer = null
  listeners.clear()
}

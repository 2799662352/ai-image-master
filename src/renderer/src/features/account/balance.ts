// 余额的呈现规则。设置页的账号分区与头部账号胶囊共用这一份。
//
// 抽出来不是为了省那几行,是因为下面这条 `null ≠ 0` 的判别一旦在两处漂开,
// 用户会在一个地方看到「余额未知」、另一个地方看到「¥0.00」,而这两句话
// 指向完全相反的下一步动作。

/** 低于这个数就该提醒了(元)。 */
export const LOW_BALANCE_YUAN = 5

/** 余额充不充裕。UI 据此决定用哪种颜色、要不要把充值入口抬到显眼处。 */
export type BalanceLevel = 'unknown' | 'empty' | 'low' | 'ok'

/**
 * 余额文案。
 *
 * **`null` 与 `0` 必须区分。** 余额未知(还没选池 / 查询失败)显示 `¥0.00` 会让用户
 * 以为钱花光了、跑去充值,而真实原因完全不同 —— 前者要去选池或重试,后者才要充钱。
 */
export function balanceText(yuan: number | null): string {
  if (yuan === null) return '余额未知'
  return `¥${yuan.toFixed(2)}`
}

/**
 * 余额档位。
 *
 * 负数归到 `empty`:上游允许透支到负值(预扣与结算之间的差额),而对用户来说
 * 「欠着」和「花光了」要做的事一样 —— 都得充钱。分成两档只会多一种文案。
 */
export function balanceLevel(yuan: number | null): BalanceLevel {
  if (yuan === null) return 'unknown'
  if (yuan <= 0) return 'empty'
  if (yuan < LOW_BALANCE_YUAN) return 'low'
  return 'ok'
}

/**
 * 万相 3.0 的上游身份 —— 单独一个极小的模块，因为它有两个不相干的消费方。
 *
 * `seedance/region.ts` 的 `Record<VideoModelAlias, string>` 要它来填 wan3 那一行
 * （那张表的穷尽性是我们的护栏，见那边的注释）；本目录的 `request.ts` 要它来填
 * 请求体的 `model` 字段。
 *
 * 放这里而不是留在 `region.ts`：region 是 **vvdance 的站点概念**（海外 / 国内两个
 * Base URL、两套模型 ID 前缀），而万相既不走那两个站点、也不分区域。让它的 id 住在
 * region 表里，下一个读代码的人会以为万相也有区域之分。
 */
export const WAN3_UPSTREAM_MODEL_ID = 'wan3.0-video'

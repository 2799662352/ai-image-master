/**
 * PGlite 连接上限的两个数字，以及它们之间那条必须成立的不变量。
 *
 * ## 为什么会有这个文件
 *
 * `@electric-sql/pglite-socket` 的 socket server **默认只接 1 条 TCP 连接**
 * （`this.maxConnections = e.maxConnections ?? 1`，见 dist/chunk-*.js；注意它的
 * `.d.ts` 注释写的是 "default: 100"，与实现不符，别信注释）。超出时它不是排队，
 * 而是往 socket 写一句**非 Postgres 协议**的裸文本然后直接关闭：
 *
 * ```js
 * if (this.handlers.size >= this.maxConnections) {
 *   socket.write(Buffer.from('Too many connections\n')); socket.end(); return
 * }
 * ```
 *
 * 而 Prisma 走的是 node-postgres 连接池（`PrismaPg` 收 `pg.PoolConfig`），默认
 * `max: 10`。于是只要有两条查询在时间上重叠 —— 视频工作台一批卡同时回流会同时
 * 产生历史写、附件元数据写、线程更新 —— 池子就会开第二条连接，被上面那段掐掉，
 * 客户端看到的就是 `PrismaClientKnownRequestError ... Server has closed the
 * connection`（P1017）。重启能恢复，是因为池子重建、流量退回串行。
 *
 * ## 不变量
 *
 * `PRISMA_POOL_MAX < PGLITE_MAX_CONNECTIONS`
 *
 * 两侧都要设，缺一边都留洞：
 *
 * - 只放大服务端上限 → 就得依赖上游那个多路复用器，而 README 明写
 *   "not all use cases are guaranteed to work"；更具体的风险是它的查询队列对事务
 *   有特殊处理（事务开着时只出队**同一个 handler** 的查询），多连接池叠上事务
 *   会让别的连接干等。
 * - 只把池子收到 1 → 启动时 `ensureSchemaViaConnection` 自己还开一条客户端连接，
 *   与池子那条重叠就是 2 条，服务端上限若仍是 1 照样被拒。
 *
 * 所以：服务端给足余量（永不拒绝），池子收到 1（永不真的依赖多路复用并发）。
 * 吞吐没有损失 —— PGlite 本来就是单连接、查询在它那侧串行执行的。
 */

/**
 * socket server 允许同时存在的 TCP 连接数。给足余量：池子 + 建表引导客户端 +
 * 偶尔重连时新旧连接短暂并存，都不该撞上限。
 */
export const PGLITE_MAX_CONNECTIONS = 10

/**
 * Prisma / node-postgres 连接池的上限。刻意是 1：PGlite 在它那侧串行执行查询，
 * 多开连接换不来吞吐，只会把并发压到上游警告过的多路复用路径上。并发查询在
 * 池子里排队（客户端侧等待），而不是在服务端被掐断。
 */
export const PRISMA_POOL_MAX = 1

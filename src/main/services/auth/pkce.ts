// PKCE(RFC 7636)与 state(RFC 8252 §8.9)的生成。纯函数,无 IO。
//
// 校验侧在后端(`sora-ui-backend/src/utils/desktopPairing.ts`),两边共用 RFC 7636
// Appendix B 的官方向量做一致性锚点 —— 任何一边改了编码方式,那条测试会先红。

import crypto from 'node:crypto'

/** RFC 7636 §4.1:43–128 字符,取自 unreserved 集合。32 字节 base64url 恰好 43 字符。 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** RFC 7636 §4.2:challenge = BASE64URL(SHA256(ASCII(verifier)))。只支持 S256。 */
export function deriveCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** RFC 8252 §8.9:高熵随机数,回调侧比对,不匹配即拒。 */
export function generateState(): string {
  return crypto.randomBytes(32).toString('base64url')
}

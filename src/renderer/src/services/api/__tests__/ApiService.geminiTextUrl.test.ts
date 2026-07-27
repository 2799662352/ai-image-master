import { describe, expect, it } from 'vitest'
import { extractImagesFromApiResponse } from '../ApiService'

/**
 * Gemini 原生端点并不总是回 `inlineData`:网关侧把产物上传到对象存储后,
 * 会把**预签名 URL 当作纯文本**放进 `parts[].text`,整条响应里没有一处 base64。
 * 只认 inlineData 的提取器在这种响应上返回空数组,用户看到的是「未能从响应中
 * 提取图片」——图其实生成成功了。
 *
 * 预签名 URL 的查询串是签名本身,截掉就是 403,所以断言必须逐字比对完整 URL。
 */

const SIGNED_URL
  = 'https://mycdn-gg.oss-us-west-1.aliyuncs.com/response_images/17137/2026/07/27/'
  + '1785159694185136739_7079.png?X-Amz-Algorithm=AWS4-HMAC-SHA256'
  + '&X-Amz-Credential=LTAI5t72MBNM4Xih2NZwL8Ym%2F20260727%2Fus-west-1%2Fs3%2Faws4_request'
  + '&X-Amz-Date=20260727T134134Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host'
  + '&X-Amz-Signature=2634628be48046dd0a703293b45695c37594bbfb9d9e6e6501829e6719d5be58'

describe('Gemini 响应把图片放在文本里', () => {
  it('从 parts[].text 的裸 URL 里取图,签名查询串一字不落', () => {
    const data = {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ text: SIGNED_URL, thoughtSignature: 'Eoj29QIKg/b1AgERTTIPx0e' }],
        },
      }],
    }

    expect(extractImagesFromApiResponse(data)).toEqual([SIGNED_URL])
  })

  it('文本是 markdown 图片时也能取到,不会把右括号吃进 URL', () => {
    const data = {
      candidates: [{
        content: { parts: [{ text: `这是结果：![图](${SIGNED_URL})` }] },
      }],
    }

    expect(extractImagesFromApiResponse(data)).toEqual([SIGNED_URL])
  })

  it('同一响应里 inlineData 与文本 URL 并存时都收下,且不重复', () => {
    const data = {
      candidates: [{
        content: {
          parts: [
            { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
            { text: SIGNED_URL },
            { text: SIGNED_URL },
          ],
        },
      }],
    }

    expect(extractImagesFromApiResponse(data)).toEqual([
      'data:image/png;base64,AAAA',
      SIGNED_URL,
    ])
  })

  it('文本里的 data URL 同样收下', () => {
    const data = {
      candidates: [{
        content: { parts: [{ text: 'data:image/webp;base64,UklGRg==' }] },
      }],
    }

    expect(extractImagesFromApiResponse(data)).toEqual(['data:image/webp;base64,UklGRg=='])
  })

  it('纯说明文字不产生图片(空数组才能触发上层的错误提示)', () => {
    const data = {
      candidates: [{
        content: { parts: [{ text: '抱歉，我无法生成该图片。' }] },
      }],
    }

    expect(extractImagesFromApiResponse(data)).toEqual([])
  })

  it('Chat Completions 文本里的预签名 URL 也不再被截断在扩展名处', () => {
    // 同一条正则此前也服务着这条分支:截到 .png 为止,签名丢了必然 403。
    const data = { choices: [{ message: { content: `![img](${SIGNED_URL})` } }] }

    expect(extractImagesFromApiResponse(data)).toEqual([SIGNED_URL])
  })
})

/**
 * Minimal typings for the bundled WeChat plugin's media send helper.
 * The package ships compiled JS under dist/ without type definitions; this
 * mirrors the signature of src/messaging/send-media.ts (v2.4.10).
 */
declare module '@tencent-weixin/openclaw-weixin/dist/src/messaging/send-media.js' {
  export function sendWeixinMediaFile(params: {
    filePath: string
    to: string
    text: string
    opts: {
      baseUrl: string
      token?: string
      timeoutMs?: number
      contextToken?: string
    }
    cdnBaseUrl: string
  }): Promise<{ messageId: string }>
}

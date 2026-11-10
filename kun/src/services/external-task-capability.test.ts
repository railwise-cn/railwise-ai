import { describe, expect, it } from 'vitest'
import { defaultExternalTaskCapability, detectExternalTaskProvider, externalProviderAmbiguity, externalTaskIntent, preflightExternalTask } from './external-task-capability.js'

describe('external task capability preflight', () => {
  it('detects DingTalk and does not confuse it with the supported Lark integration', () => {
    expect(detectExternalTaskProvider('处理钉钉里的待办事项')).toBe('dingtalk')
    expect(preflightExternalTask('处理钉钉里的待办事项')).toMatchObject({
      provider: 'dingtalk', status: 'unsupported', action: { kind: 'connect' }
    })
  })

  it('asks for Lark authorization before any turn can execute', () => {
    expect(preflightExternalTask('帮我处理飞书审批待办')).toMatchObject({
      provider: 'lark', status: 'needs_authorization', action: { kind: 'connect' }
    })
  })

  it('detects an explicit connection or authorization request before work starts', () => {
    expect(detectExternalTaskProvider('请先授权连接飞书')).toBe('lark')
    expect(detectExternalTaskProvider('配置钉钉')).toBe('dingtalk')
    expect(externalTaskIntent('连接飞书')).toMatchObject({ kind: 'connect_provider', provider: 'lark' })
    expect(externalTaskIntent('授权飞书并处理待办')).toMatchObject({ kind: 'external_task', provider: 'lark' })
  })

  it('uses actual managed CLI state instead of assuming authentication',()=>{
    expect(preflightExternalTask('处理飞书待办',{lark:{enabled:true,authState:'not_installed'}})?.status).toBe('not_installed')
    expect(preflightExternalTask('处理飞书待办',{lark:{enabled:true,authState:'needs_login',executablePath:'/test/lark'}})?.status).toBe('needs_authorization')
    expect(preflightExternalTask('处理飞书待办',{lark:{enabled:true,authState:'installed',executablePath:'/test/lark'}})?.status).toBe('available')
  })

  it('leaves ordinary discussion alone', () => {
    expect(detectExternalTaskProvider('介绍一下飞书和钉钉的区别')).toBeNull()
    expect(preflightExternalTask('如何使用钉钉审批')).toBeNull()
    expect(defaultExternalTaskCapability('dingtalk').message).toContain('不会生成未经验证的 dws 命令')
  })

  it('requires a platform decision for dual-provider actions while preserving comparisons as chat', () => {
    expect(externalProviderAmbiguity('帮我处理钉钉和飞书待办')).toBe(true)
    expect(externalProviderAmbiguity('连接钉钉和飞书')).toBe(true)
    expect(externalProviderAmbiguity('比较钉钉和飞书审批功能')).toBe(false)
    expect(externalProviderAmbiguity('如何连接钉钉和飞书')).toBe(false)
    expect(externalProviderAmbiguity('帮我处理钉钉待办')).toBe(false)
  })

  it('recognizes direct sends, transfers, and detail reads as platform operations', () => {
    expect(externalTaskIntent('帮我发送飞书消息')).toMatchObject({ provider: 'lark', operation: 'send', mutation: true })
    expect(externalTaskIntent('转交钉钉审批')).toMatchObject({ provider: 'dingtalk', operation: 'transfer', mutation: true })
    expect(externalTaskIntent('查看飞书审批详情')).toMatchObject({ provider: 'lark', operation: 'detail', mutation: false })
    expect(externalTaskIntent('show dingtalk tasks')).toMatchObject({ provider: 'dingtalk', operation: 'list', mutation: false })
    expect(externalTaskIntent('帮我办理钉钉里的事项')).toMatchObject({ provider: 'dingtalk', mutation: true })
    expect(externalTaskIntent('帮我拒绝飞书里的那一个')).toMatchObject({ provider: 'lark', operation: 'reject', mutation: true })
  })
})

import { describe, expect, it } from 'vitest'
import { defaultExternalTaskCapability, detectExternalTaskProvider, preflightExternalTask } from './external-task-capability.js'

describe('external task capability preflight', () => {
  it('detects DingTalk and does not confuse it with the supported Lark integration', () => {
    expect(detectExternalTaskProvider('处理钉钉里的待办事项')).toBe('dingtalk')
    expect(preflightExternalTask('处理钉钉里的待办事项')).toMatchObject({
      provider: 'dingtalk', status: 'unsupported', action: { kind: 'install' }
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
  })

  it('leaves ordinary discussion alone', () => {
    expect(detectExternalTaskProvider('介绍一下飞书和钉钉的区别')).toBeNull()
    expect(defaultExternalTaskCapability('dingtalk').message).toContain('不会生成未经验证的 dws 命令')
  })
})

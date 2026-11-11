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
    expect(defaultExternalTaskCapability('dingtalk').message).toContain('不会通过未经验证的 Shell 命令代理平台操作')
  })

  it('requires a platform decision for dual-provider actions while preserving comparisons as chat', () => {
    expect(externalProviderAmbiguity('帮我处理钉钉和飞书待办')).toBe(true)
    expect(externalProviderAmbiguity('连接钉钉和飞书')).toBe(true)
    expect(externalProviderAmbiguity('比较钉钉和飞书审批功能')).toBe(false)
    expect(externalProviderAmbiguity('如何连接钉钉和飞书')).toBe(false)
    expect(externalProviderAmbiguity('帮我处理钉钉待办')).toBe(false)
  })

  it.each([
    '请查询我当前未完成的钉钉待办，最多列出 5 条的标题和当前状态。这次仅做只读验收。',
    '查询钉钉已完成的待办', '查看钉钉待完成的待办', '列出飞书未审批的申请',
    '查询飞书已批准和已拒绝的审批', '查看钉钉待办完成情况', '查询需要处理的飞书待办',
    '查询钉钉待办，不要完成或批准任何一条', 'list incomplete DingTalk tasks', 'show completed Lark tasks',
    'list rejected Lark approvals'
  ])('treats status filters as read-only queries (%s)', prompt => {
    expect(externalTaskIntent(prompt)).toMatchObject({ operation: 'list', mutation: false })
  })

  it.each([
    ['列出钉钉待办并完成第一条', 'complete'],
    ['查询后需要完成钉钉待办', 'complete'],
    ['查询飞书审批，不要拒绝而是批准', 'approve'],
    ['列出未完成的钉钉待办，然后完成第一条', 'complete'],
    ['查看已拒绝的飞书审批，然后批准我选定的审批', 'approve'],
    ['list incomplete DingTalk tasks then complete task 1', 'complete'],
    ['列出钉钉待办并处理它们', undefined]
  ])('preserves explicit mutations after a read (%s)', (prompt, operation) => {
    expect(externalTaskIntent(prompt!)).toMatchObject({ operation, mutation: true })
  })

  it('recognizes direct sends, transfers, and detail reads as platform operations', () => {
    expect(externalTaskIntent('完成报告并通过飞书发送邮件')).toMatchObject({ provider: 'lark', operation: 'send' })
    expect(externalTaskIntent('完成报告并上传到飞书云盘')).toMatchObject({ provider: 'lark', operation: 'upload' })
    expect(externalTaskIntent('帮我发送飞书消息')).toMatchObject({ provider: 'lark', operation: 'send', mutation: true })
    expect(externalTaskIntent('转交钉钉审批')).toMatchObject({ provider: 'dingtalk', operation: 'transfer', mutation: true })
    expect(externalTaskIntent('查看飞书审批详情')).toMatchObject({ provider: 'lark', operation: 'detail', mutation: false })
    expect(externalTaskIntent('show dingtalk tasks')).toMatchObject({ provider: 'dingtalk', operation: 'list', mutation: false })
    expect(externalTaskIntent('帮我办理钉钉里的事项')).toMatchObject({ provider: 'dingtalk', mutation: true })
    expect(externalTaskIntent('帮我拒绝飞书里的那一个')).toMatchObject({ provider: 'lark', operation: 'reject', mutation: true })
  })

  it.each([
    ['请通过飞书连接器，将已准备好的单个合成测试文件上传一次到我个人云盘根目录。上传后回读核验文件名和大小。用户已明确批准这一个测试文件的一次上传并回读。', 'upload'],
    ['请上传测试文件到飞书云盘。', 'upload'],
    ['请通过飞书发送一条合成测试消息。用户已经明确同意这条消息的一次发送并回读。', 'send'],
    ['我同意你通过飞书发送一封测试邮件。', 'send'],
    ['请批准在飞书上传这份审批附件。', 'upload'],
    ['请通过飞书发送消息，用户已明确批准此操作。', 'send'],
    ['I approve this upload to Lark Drive.', 'upload'],
    ['I approve sending this message through Lark.', 'send']
  ])('classifies the delivery action in permission language (%s)', (prompt, operation) => {
    expect(externalTaskIntent(prompt!)).toMatchObject({ provider: 'lark', operation, mutation: true })
    expect(preflightExternalTask(prompt!)?.approvalState).toBe('required')
  })

  it.each([
    '请批准飞书报销申请。',
    '请同意飞书里的那一个。',
    '请先批准飞书审批，再上传附件。',
    '请同意飞书里的那一个并发送通知。',
    '请批准飞书文件上传申请并发送通知。',
    '请同意飞书消息发送申请。',
    '请上传飞书文件，然后批准我选定的审批。',
    '用户已明确批准这次上传，请同意飞书审批 A。',
    'Approve this Lark request and send a confirmation.',
    'Approve this Lark upload request.'
  ])('preserves actual approval clauses alongside delivery or permission language (%s)', prompt => {
    expect(externalTaskIntent(prompt)).toMatchObject({ provider: 'lark', operation: 'approve', mutation: true })
  })

  it.each([
    ['请先批准飞书审批，再上传测试文件。', ['approve', 'upload']],
    ['请同意飞书里的那一个并发送通知。', ['approve', 'send']],
    ['请上传飞书文件，然后批准我选定的审批。', ['approve', 'upload']],
    ['完成飞书待办 A 并发送通知。', ['send', 'complete']],
    ['同意钉钉审批 A，并拒绝审批 B。', ['reject', 'approve']],
    ['Approve this Lark request and upload the file.', ['approve', 'upload']]
  ])('retains all explicit platform operations (%s)', (prompt, operations) => {
    expect(externalTaskIntent(String(prompt))?.operations).toEqual(operations)
  })

  it.each(['完成报告并通过飞书发送邮件', '请批准飞书文件上传申请。', '我同意你通过飞书发送一封邮件。',
    '请上传到飞书。用户已明确批准这次上传。', '如何批准飞书审批并上传文件？'])('avoids inventing secondary operations (%s)', prompt => {
    expect(externalTaskIntent(prompt)?.operations).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { clawDefaultAgentName } from './SidebarClawDialogHelpers'

describe('SidebarClawDialogHelpers', () => {
  it('uses product default agent names for phone providers', () => {
    expect(clawDefaultAgentName('feishu')).toBe('RailWise AI')
    expect(clawDefaultAgentName('lark')).toBe('RailWise AI')
    expect(clawDefaultAgentName('weixin')).toBe('RailWise AI')
  })
})

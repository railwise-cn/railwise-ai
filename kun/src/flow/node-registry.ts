import type { FlowNodeRegistryEntryV1, FlowPortTypeV1 } from '../contracts/flow.js'

type CapabilityState = Record<string, { available: boolean; reason?: string; configurationRoute?: string }>
const port = (id: string, label: string, type: FlowPortTypeV1, required = false) => ({ id, label, type, required, multiple: false })
const jsonIn = [port('input', 'Input', 'json')]
const jsonOut = [port('output', 'Output', 'json')]

const CATALOGUE: Array<Omit<FlowNodeRegistryEntryV1, 'available' | 'disabledReason' | 'configurationRoute'>> = [
  { type: 'manual_trigger', category: 'trigger', label: 'Manual', inputs: [], outputs: jsonOut, requiredCapabilities: [] },
  { type: 'schedule_trigger', category: 'trigger', label: 'Schedule', inputs: [], outputs: jsonOut, requiredCapabilities: ['schedule'] },
  { type: 'webhook_trigger', category: 'trigger', label: 'Webhook', inputs: [], outputs: jsonOut, requiredCapabilities: ['webhook'] },
  { type: 'feishu_trigger', category: 'integration', label: 'Feishu', inputs: [], outputs: [port('message', 'Message', 'agent_message')], requiredCapabilities: ['feishu'] },
  { type: 'wechat_trigger', category: 'integration', label: 'WeChat', inputs: [], outputs: [port('message', 'Message', 'agent_message')], requiredCapabilities: ['wechat'] },
  { type: 'agent', category: 'intelligence', label: 'Agent', inputs: jsonIn, outputs: [port('message', 'Message', 'agent_message')], requiredCapabilities: ['model'] },
  { type: 'subagent', category: 'intelligence', label: 'Subagent', inputs: jsonIn, outputs: [port('message', 'Message', 'agent_message')], requiredCapabilities: ['subagents'] },
  { type: 'knowledge_retrieval', category: 'intelligence', label: 'Knowledge retrieval', inputs: [port('query', 'Query', 'string', true), port('document', 'Document', 'document')], outputs: jsonOut, requiredCapabilities: ['attachments'] },
  { type: 'classification', category: 'intelligence', label: 'Classification', inputs: [port('text', 'Text', 'string', true)], outputs: [port('category', 'Category', 'string')], requiredCapabilities: ['model'] },
  { type: 'parameter_extraction', category: 'intelligence', label: 'Parameter extraction', inputs: [port('text', 'Text', 'string', true)], outputs: jsonOut, requiredCapabilities: ['model'] },
  { type: 'http', category: 'tool', label: 'HTTP', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['network'] },
  { type: 'restricted_code', category: 'tool', label: 'Restricted code', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['restricted_code'] },
  { type: 'condition', category: 'control', label: 'Condition', inputs: jsonIn, outputs: [port('true', 'True', 'json'), port('false', 'False', 'json')], requiredCapabilities: [] },
  { type: 'switch', category: 'control', label: 'Switch', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: [] },
  { type: 'merge', category: 'control', label: 'Merge', inputs: [{ ...port('inputs', 'Inputs', 'json'), multiple: true }], outputs: jsonOut, requiredCapabilities: [] },
  { type: 'loop', category: 'control', label: 'Loop', inputs: jsonIn, outputs: [port('body', 'Body', 'json'), port('done', 'Done', 'json')], requiredCapabilities: [] },
  { type: 'parallel', category: 'control', label: 'Parallel', inputs: jsonIn, outputs: [{ ...port('branches', 'Branches', 'json'), multiple: true }], requiredCapabilities: [] },
  { type: 'human_approval', category: 'human', label: 'Human approval', inputs: [...jsonIn, port('file', 'File', 'file')], outputs: [port('approved', 'Approved', 'json'), port('rejected', 'Rejected', 'json')], requiredCapabilities: ['approvals'] },
  { type: 'alert_confirmation', category: 'human', label: 'Alert confirmation', inputs: jsonIn, outputs: [port('confirmed', 'Confirmed', 'json'), port('rejected', 'Rejected', 'json')], requiredCapabilities: ['approvals'] },
  ...(['docx', 'xlsx', 'pdf', 'pptx'] as const).map((format) => ({
    type: `${format}_output`, category: 'output' as const, label: `${format.toUpperCase()} output`, inputs: jsonIn,
    outputs: [port('file', 'File', 'file')], requiredCapabilities: [`output_${format}`]
  })),
  { type: 'publish', category: 'output', label: 'Publish', inputs: [port('file', 'File', 'file')], outputs: jsonOut, requiredCapabilities: ['publish'] },
  { type: 'archive', category: 'output', label: 'Archive', inputs: [port('file', 'File', 'file')], outputs: jsonOut, requiredCapabilities: ['archive'] },
  { type: 'image_generation', category: 'integration', label: 'Image generation', inputs: [port('prompt', 'Prompt', 'string')], outputs: [port('image', 'Image', 'image')], requiredCapabilities: ['image_generation'] },
  { type: 'speech_generation', category: 'integration', label: 'Speech generation', inputs: [port('text', 'Text', 'string')], outputs: [port('file', 'Audio', 'file')], requiredCapabilities: ['speech_generation'] },
  { type: 'music_generation', category: 'integration', label: 'Music generation', inputs: [port('prompt', 'Prompt', 'string')], outputs: [port('file', 'Audio', 'file')], requiredCapabilities: ['music_generation'] },
  { type: 'video_generation', category: 'integration', label: 'Video generation', inputs: [port('prompt', 'Prompt', 'string')], outputs: [port('file', 'Video', 'file')], requiredCapabilities: ['video_generation'] },
  { type: 'office_cli', category: 'integration', label: 'OfficeCLI', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['office_cli'] },
  { type: 'lark_cli', category: 'integration', label: 'Lark CLI', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['lark_cli'] },
  { type: 'ego_browser', category: 'integration', label: 'ego-browser', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['ego_browser'] },
  { type: 'run_flow', category: 'intelligence', label: 'Run Flow', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['flow'] }
  ,{ type: 'railwise.monitoring_data_first_check', category: 'tool', label: 'RailWise quality check', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['railwise'] }
  ,{ type: 'railwise.deformation_rate', category: 'tool', label: 'RailWise trend analysis', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['railwise'] }
  ,{ type: 'railwise.chart_generator', category: 'output', label: 'RailWise chart', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['railwise'] }
  ,{ type: 'railwise.report_export', category: 'output', label: 'RailWise report', inputs: jsonIn, outputs: [port('file', 'File', 'file')], requiredCapabilities: ['railwise'] }
  ,{ type: 'railwise.archive', category: 'output', label: 'RailWise archive', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['railwise'] }
  ,{ type: 'railwise.survey_draft_check', category: 'tool', label: '检查成果与草稿', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['survey_drafts'] }
  ,{ type: 'railwise.survey_draft_export', category: 'output', label: '导出专业审查稿', inputs: jsonIn, outputs: jsonOut, requiredCapabilities: ['survey_drafts'] }
]

export const FLOW_PORT_CONVERSIONS_V1 = Object.freeze<Record<string, { from: FlowPortTypeV1; to: FlowPortTypeV1 }>>({
  'string-to-number': { from: 'string', to: 'number' },
  'string-to-boolean': { from: 'string', to: 'boolean' },
  'string-to-json': { from: 'string', to: 'json' },
  'table-to-json': { from: 'table', to: 'json' },
  'file-to-document': { from: 'file', to: 'document' },
  'image-to-file': { from: 'image', to: 'file' },
  'agent-message-to-string': { from: 'agent_message', to: 'string' }
})

export function buildFlowNodeRegistry(capabilities: CapabilityState = {}): FlowNodeRegistryEntryV1[] {
  return CATALOGUE.map((entry) => {
    const missing = entry.requiredCapabilities.find((id) => capabilities[id]?.available === false)
    const capability = missing ? capabilities[missing] : undefined
    return {
      ...entry,
      available: !missing,
      ...(missing ? { disabledReason: capability?.reason ?? `Missing capability: ${missing}` } : {}),
      ...(capability?.configurationRoute ? { configurationRoute: capability.configurationRoute } : {})
    }
  })
}

export function portsCompatible(from: FlowPortTypeV1, to: FlowPortTypeV1, conversionId?: string): boolean {
  if (from === to) return conversionId === undefined
  if (!conversionId) return false
  const conversion = FLOW_PORT_CONVERSIONS_V1[conversionId]
  return conversion?.from === from && conversion.to === to
}

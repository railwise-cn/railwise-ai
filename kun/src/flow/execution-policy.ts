/** A missing execution boundary is a terminal configuration block, never a retry. */
export class FlowExecutionPolicyError extends Error {
  readonly code: string
  readonly resolution: string

  constructor(reason: string, policy?: {code:string;resolution:string}) {
    const code = policy?.code ?? 'external_effect_requires_typed_provider'
    const resolution = policy?.resolution ?? 'Replace this generic Flow node with a connected typed Provider task. Review the exact operation and targets, then authorize it through the task approval card. Do not substitute Shell or another HTTP proxy.'
    super(`${code}: ${reason} ${resolution}`)
    this.name = 'FlowExecutionPolicyError'
    this.code = code
    this.resolution = resolution
  }
}

const UNAVAILABLE_FLOW_NODES: Record<string,{reason:string;resolution:string;configurationRoute:string}> = {
  publish: {
    reason:'通用发布节点尚未接入目标授权与操作回执，当前不可执行。',
    resolution:'保留原节点和资料，在任务工作台使用已连接的平台创建独立任务，确认具体发布目标与写入操作后执行。',
    configurationRoute:'tasks'
  },
  archive: {
    reason:'通用归档节点尚未接入可核验的文件归档服务，当前不可执行。',
    resolution:'保留原节点和文件，使用写作工作台保存成果或通过持续文档交付任务生成并检查交付文件。',
    configurationRoute:'write'
  },
  subagent: {
    reason:'Flow 子 Agent 尚未绑定可继承的父任务执行授权，当前不可执行。',
    resolution:'保留原节点，在任务工作台创建持续任务，由该任务的真实执行实例委派子任务；普通任务子 Agent 与文档交付仍可使用。',
    configurationRoute:'tasks'
  }
}

/** These nodes remain readable but cannot be enabled by a capability flag alone. */
export function unavailableFlowNode(type:string): typeof UNAVAILABLE_FLOW_NODES[string] | undefined {
  return Object.hasOwn(UNAVAILABLE_FLOW_NODES,type) ? UNAVAILABLE_FLOW_NODES[type] : undefined
}

export function assertFlowNodeExecutable(type:string):void {
  const policy = unavailableFlowNode(type)
  if (policy) throw new FlowExecutionPolicyError(policy.reason,{code:'flow_node_unavailable',resolution:policy.resolution})
}

export function flowPolicyEvidence(error: unknown): { code: string; resolution: string } | Record<string, never> {
  return error instanceof FlowExecutionPolicyError ? { code: error.code, resolution: error.resolution } : {}
}

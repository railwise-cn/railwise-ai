import type { FlowRuntimeService } from '../../flow/service.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

export function buildFlowToolProviders(service: FlowRuntimeService): CapabilityToolProvider[] {
  return [{
    id: 'flow', kind: 'flow', enabled: true, available: true,
    tools: [LocalToolHost.defineTool({
      name: 'run_flow',
      description: 'Run an authorized published RailWise AI Flow through the existing Runtime. Recursive calls and depth above three are rejected.',
      inputSchema: { type: 'object', properties: { flow_id: { type: 'string' }, input: {} }, required: ['flow_id'], additionalProperties: false },
      policy: 'on-request',
      execute: async (args, context) => {
        if (typeof args.flow_id !== 'string' || !args.flow_id.trim()) return { output: { error: 'flow_id is required' }, isError: true }
        try {
          return { output: { run: await service.run(args.flow_id, args.input ?? {}, context.flowInvocationStack ?? []) } }
        } catch (error) {
          return { output: { error: error instanceof Error ? error.message : String(error) }, isError: true }
        }
      }
    })]
  }]
}

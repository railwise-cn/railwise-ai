/** Runtime-owned effects: a model or API client cannot downgrade approval risk. */
export const engineeringPlanToolRisks = {
  survey_network_validate: 'write',
  survey_adjustment_read: 'read',
  survey_calculator: 'write',
  control_network: 'write',
  cpiii_adjustment: 'write',
  coord_transform: 'write',
  distance_calculator: 'write',
  angle_convert: 'write',
  monitoring_data_first_check: 'write',
  deformation_rate: 'write',
  chart_generator: 'export',
  report_export: 'export',
  excel_export: 'export',
  standard_query: 'read',
  tool_norm_cite: 'read'
} as const

export function engineeringPlanToolRisk(tool: string): 'read' | 'write' | 'export' | undefined {
  const name = tool.startsWith('railwise.') ? tool.slice('railwise.'.length) : tool
  if (tool.startsWith('railwise.') && ['standard_query', 'tool_norm_cite'].includes(name)) return undefined
  return Object.prototype.hasOwnProperty.call(engineeringPlanToolRisks, name)
    ? engineeringPlanToolRisks[name as keyof typeof engineeringPlanToolRisks]
    : undefined
}

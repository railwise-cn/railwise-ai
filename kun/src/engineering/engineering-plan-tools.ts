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

/** Shared by plan review and the executor; aliases retain the same capability. */
export const surveyAdjustmentToolNetworks: Readonly<Record<string, readonly string[]>> = {
  survey_calculator: ['leveling', 'height-control'],
  control_network: ['traverse', 'plane-control', 'triangulation', 'gnss'],
  cpiii_adjustment: ['cpiii-free-station', 'cpiii-resection'],
  coord_transform: ['coordinate-transform']
}

export function engineeringPlanToolRisk(tool: string): 'read' | 'write' | 'export' | undefined {
  const name = tool.startsWith('railwise.') ? tool.slice('railwise.'.length) : tool
  if (tool.startsWith('railwise.') && ['standard_query', 'tool_norm_cite'].includes(name)) return undefined
  return Object.prototype.hasOwnProperty.call(engineeringPlanToolRisks, name)
    ? engineeringPlanToolRisks[name as keyof typeof engineeringPlanToolRisks]
    : undefined
}

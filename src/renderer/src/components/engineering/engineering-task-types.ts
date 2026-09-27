export const engineeringTaskTypes = ['control-network', 'leveling-network', 'traverse-network', 'resection', 'deformation', 'gnss'] as const

export function engineeringTaskLabel(type: string | undefined, translate: (key: string) => string): string {
  return type && engineeringTaskTypes.includes(type as typeof engineeringTaskTypes[number])
    ? translate(`engineeringTaskTypes.${type}`)
    : type || '—'
}

export function surveyNetworkTypeLabel(type: string | undefined, translate: (key: string) => string): string {
  const keys: Record<string, string> = {
    leveling: 'surveyLeveling', traverse: 'surveyTraverse', 'plane-control': 'surveyPlaneControl',
    triangulation: 'surveyTriangulation', 'cpiii-free-station': 'surveyCpiiiStation',
    'cpiii-resection': 'surveyCpiiiResection', gnss: 'surveyGnssBaseline', 'coordinate-transform': 'surveyCoordinateTransform'
  }
  return type ? (keys[type] ? translate(keys[type]) : type) : '—'
}

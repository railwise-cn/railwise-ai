import type { SurveyNetworkImportRequest } from '../contracts/survey.js'

type LegacySurveyNetworkImport<TNetwork extends object = Record<string, unknown>> = Omit<SurveyNetworkImportRequest, 'network' | 'name' | 'dataBase64'> & {
  network: TNetwork
  name?: string
  dataBase64?: string
}

/**
 * Turns an in-process legacy `network` request into the frozen WorkWise JSON
 * source envelope so tests exercise raw-byte preservation and source checks.
 * Synthetic examples use an explicit local grid/benchmark unless their
 * fixture specifies a reference. Missing-reference tests must import their
 * own undeclared source rather than using these calculation fixtures.
 */
export function workwiseSurveyNetworkFileImport<TNetwork extends object>(
  request: LegacySurveyNetworkImport<TNetwork>
): Omit<LegacySurveyNetworkImport<TNetwork>, 'network' | 'name' | 'dataBase64'> & { name: string; dataBase64: string } {
  const { network, name: _legacyName, dataBase64: _legacyDataBase64, ...metadata } = request
  const legacyNetwork = network as TNetwork & { networkType?: unknown; transformType?: unknown; unit?: unknown; coordinateSystem?: string; verticalDatum?: string; heightDatum?: string }
  const sourceNetwork = {
    ...network,
    ...(legacyNetwork.networkType === undefined && request.networkType !== undefined ? { networkType: request.networkType } : {}),
    ...(legacyNetwork.transformType === undefined && request.transformType !== undefined ? { transformType: request.transformType } : {}),
    unit: legacyNetwork.unit ?? 'm',
    coordinateSystem: legacyNetwork.coordinateSystem ?? 'SYNTHETIC-LOCAL-GRID',
    verticalDatum: legacyNetwork.verticalDatum ?? legacyNetwork.heightDatum ?? 'SYNTHETIC-LOCAL-BENCHMARK'
  }
  return {
    ...metadata,
    name: 'workwise-survey-network.json',
    dataBase64: Buffer.from(JSON.stringify({
      format: 'workwise-survey-network',
      formatVersion: 1,
      network: sourceNetwork
    })).toString('base64')
  }
}

/** Convenience adapter for fixture services that exposes the file import path. */
export function importWorkwiseSurveyNetwork<TResult, TNetwork extends object>(
  service: { importNetwork(input: unknown): Promise<TResult> },
  request: LegacySurveyNetworkImport<TNetwork>
): Promise<TResult> {
  return service.importNetwork(workwiseSurveyNetworkFileImport(request))
}

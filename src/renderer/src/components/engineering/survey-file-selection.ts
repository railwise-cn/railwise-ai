// This only routes the picker. The Runtime still identifies formats by content.
export const SURVEY_FILE_EXTENSIONS = [
  '.csv', '.tsv', '.xlsx', '.json', '.zip', '.gz',
  '.gsi', '.in1', '.in2', '.net', '.ou1', '.ou2', '.xyo', '.clo', '.gco', '.hexml', '.jxl', '.jobxml', '.m5', '.dat', '.txt', '.raw', '.rw5', '.sdr', '.sdr20', '.sdr33', '.xml', '.landxml',
  '.suc', '.gts', '.gt7', '.fc5', '.nik', '.survey', '.spj',
  '.rnx', '.obs', '.nav', '.crx', '.snx', '.sinex', '.nmea', '.rtcm', '.rtcm2', '.rtcm3', '.sp3', '.ion', '.inx', '.atx',
  '.ubx', '.nov', '.sbf', '.bnx', '.binex', '.jps', '.tps', '.sth', '.zhd', '.hcn', '.cnb',
  '.t00', '.t01', '.t02', '.t04', '.job', '.dbx', '.mdb',
  ...Array.from({ length: 100 }, (_, year) => String(year).padStart(2, '0')).flatMap((year) => [`.${year}o`, `.${year}d`, `.${year}n`, `.${year}g`, `.${year}m`, `.${year}l`, `.${year}p`, `.${year}h`, `.${year}q`])
]
export const SURVEY_FILE_ACCEPT = SURVEY_FILE_EXTENSIONS.join(',')
const documentExtensions = new Set(['.csv', '.xlsx', '.txt'])
const instrumentExtensions = new Set(SURVEY_FILE_EXTENSIONS.filter((extension) => !documentExtensions.has(extension)))
export function isSurveyInstrumentFile(file: Pick<File, 'name'>): boolean {
  return instrumentExtensions.has(file.name.slice(file.name.lastIndexOf('.')).toLowerCase())
}

/** Computation files from the AI composer use the shared processing entry. */
export function isSurveyImportFile(file: Pick<File, 'name'>): boolean {
  return isSurveyInstrumentFile(file) || /\.(csv|xlsx)$/i.test(file.name)
}

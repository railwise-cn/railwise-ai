import type { TFunction } from 'i18next'

export function surveySourceFormatLabel(t: TFunction, value: string, locale = 'zh'): string {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-')
  return ({
    'workwise-json': t('surveyStructuredJson'), 'delimited-text': t('surveyDelimitedText'), csv: 'CSV', xls: 'Excel', xlsx: 'Excel', in1: 'COSA IN1', in2: 'COSA IN2',
    'cosa-in1': 'COSA IN1', 'cosa-in2': 'COSA IN2', 'cosa-net': 'COSA NET', 'cosa-ou1': 'COSA OU1', 'cosa-ou2': 'COSA OU2', 'south-dat': locale.startsWith('en') ? 'South DAT' : '南方 DAT',
    'leica-gsi8': 'Leica GSI-8', 'leica-gsi16': 'Leica GSI-16', 'leica-hexml': 'Leica HeXML',
    'trimble-jobxml': 'Trimble JobXML / JXL', 'trimble-m5': 'Trimble / Zeiss M5',
    'tds-raw': 'TDS RAW', 'carlson-rw5': 'Carlson RW5', 'sokkia-sdr': 'Sokkia SDR2x / SDR33',
    'topcon-gts7': 'Topcon GTS-7', 'topcon-fc5': 'Topcon FC-5', 'nikon-raw': 'Nikon RAW', 'spectra-survey-pro': 'Spectra Survey Pro', landxml: 'LandXML', 'survey-cloud-suc': t('surveySucArchive'),
    'rinex-observation': t('surveyRinexObservation'), 'rinex-navigation': t('surveyRinexNavigation'), 'rinex-meteorological': t('surveyRinexMeteorological'), 'rinex-clock': t('surveyRinexClock'), 'hatanaka-rinex': 'Hatanaka / CRINEX',
    sinex: 'SINEX', 'nmea-0183': 'NMEA 0183', rtcm2: 'RTCM 2', rtcm3: 'RTCM 3', sp3: t('surveySp3'), ionex: 'IONEX', antex: 'ANTEX',
    'ublox-ubx': 'u-blox UBX', 'novatel-oem': 'NovAtel OEM', 'septentrio-sbf': 'Septentrio SBF', binex: 'BINEX', 'javad-jps': 'Javad JPS', 'topcon-tps': 'Topcon TPS',
    'south-sth': t('surveySouth'), 'hitarget-zhd': t('surveyHitarget'), 'chcnav-hcn': t('surveyChcnav'), 'comnav-cnb': t('surveyComnav'),
    'trimble-t00': 'Trimble T00', 'trimble-t01': 'Trimble T01', 'trimble-t02': 'Trimble T02', 'trimble-t04': 'Trimble T04', 'trimble-job': 'Trimble JOB', 'leica-dbx': 'Leica DBX', 'leica-mdb': 'Leica MDB', unknown: t('surveyUnknownFormat')
  } as Record<string, string>)[normalized] ?? t('surveyUnknownFormat')
}

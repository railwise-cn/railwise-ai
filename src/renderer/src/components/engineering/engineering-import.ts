import { isSurveyInstrumentFile } from './survey-file-selection'

export type EngineeringImportKind = 'auto' | 'monitoring' | 'survey'

/** Routing only. Parsing, units, datum and admission remain runtime decisions. */
export async function engineeringImportKind(file: File, selected: EngineeringImportKind): Promise<'monitoring' | 'survey'> {
  if (selected !== 'auto') return selected
  if (isSurveyInstrumentFile(file)) return 'survey'
  if (/\.xlsx$/i.test(file.name)) return 'monitoring'
  if (/\.(csv|txt)$/i.test(file.name)) {
    const header = (await file.slice(0, 8192).text()).split(/\r?\n/, 1)[0] ?? ''
    const fields = header.replace(/^\uFEFF/, '').split(/[,\t;]/).map(field => field.trim().replace(/^"|"$/g, '').toLowerCase())
    if (fields.some(field => ['timestamp', 'time', '时间', '日期'].includes(field))
      && fields.some(field => ['point', '测点', '测点编号', '点号'].includes(field))
      && fields.some(field => ['value', '当前变化', '数值', '观测值'].includes(field))) return 'monitoring'
  }
  return 'survey'
}

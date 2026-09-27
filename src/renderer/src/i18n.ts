import enQualityAssessment from './locales/en/quality-assessment.json'
import zhQualityAssessment from './locales/zh/quality-assessment.json'
import enQualityScoring from './locales/en/quality-scoring.json'
import zhQualityScoring from './locales/zh/quality-scoring.json'
import enStandardBasis from './locales/en/standard-basis.json'
import zhStandardBasis from './locales/zh/standard-basis.json'
import brand from '@shared/product-brand.json'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import enCommon from './locales/en/common.json'
import zhCommon from './locales/zh/common.json'
import enSettings from './locales/en/settings.json'
import zhSettings from './locales/zh/settings.json'

for (const [locale, common] of [['zh', zhCommon], ['en', enCommon]] as const) {
  common.appName = brand.platform
  common.surveyProductName = brand.survey
  common.engineeringWorkbenchTitle = brand.survey
  common.engineeringWorkbenchSubtitle = brand.surveySubtitle[locale]
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon, settings: enSettings, qualityScoring: enQualityScoring, qualityAssessment: enQualityAssessment, standardBasis: enStandardBasis },
    zh: { common: zhCommon, settings: zhSettings, qualityScoring: zhQualityScoring, qualityAssessment: zhQualityAssessment, standardBasis: zhStandardBasis }
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false, defaultVariables: { productName: brand.platform, runtimeName: brand.runtime } },
  defaultNS: 'common',
  ns: ['common', 'settings', 'qualityScoring', 'qualityAssessment', 'standardBasis']
})

export default i18n

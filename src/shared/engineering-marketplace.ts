import type { MarketplacePackageV1 } from './marketplace'

export const OPTIONAL_ENGINEERING_SKILLS = [
  { id: 'project-source-index', name: '资料盘点与来源索引', summary: '整理项目资料、版本、定位和缺失项，形成可追溯来源索引。' },
  { id: 'monitoring-data-check', name: '监测质检与图表', summary: '检查监测表的单位、缺失、重复和时序，再生成统计与图表。' },
  { id: 'document-change-review', name: '工程文档差异审阅', summary: '对照基线与候选正文，记录修改来源、冲突和待确认事项。' },
  { id: 'meeting-action-items', name: '会议纪要与待办', summary: '从会议记录提取已确认决议、责任人、截止时间及待确认项。' }
] as const

export const ENGINEERING_FEATURED_PACKAGE_IDS = [
  'markitdown', 'docling-mcp', 'officecli', 'antv-chart-mcp', 'playwright-mcp'
] as const

export const AMAP_READ_TOOLS = [
  'maps_regeocode', 'maps_geo', 'maps_ip_location', 'maps_weather', 'maps_search_detail',
  'maps_bicycling', 'maps_direction_walking', 'maps_direction_driving',
  'maps_direction_transit_integrated', 'maps_distance', 'maps_text_search', 'maps_around_search'
] as const

export const ZOTERO_READ_TOOLS = [
  'zotero_search_items', 'zotero_get_item_metadata', 'zotero_get_item_fulltext',
  'zotero_get_collections', 'zotero_get_collection_items', 'zotero_get_item_children',
  'zotero_get_tags', 'zotero_get_recent', 'zotero_get_notes', 'zotero_get_annotations'
] as const

export const ZOTERO_PACKAGE = {
  id: 'zotero-mcp', packageName: 'zotero-mcp-server', version: '0.17.0',
  sha256: '80f1c67060176eeeb1473a790a3e973c828f9df2fb6cb9199e05e6d1d292c41f',
  license: 'MIT AND AGPL-3.0-or-later',
  wheelUrl: 'https://files.pythonhosted.org/packages/77/8c/84503b4469a2045587ccd2eb9b5b6579a679ac63c48abb18c23fa8b94c3e/zotero_mcp_server-0.17.0-py3-none-any.whl'
} as const

/** Explicit upstream installation decision for this exact reviewed artifact only. */
export function isApprovedUpstreamPackage(item: MarketplacePackageV1): boolean {
  const component = item.components[0]
  return item.id === ZOTERO_PACKAGE.id && item.version === ZOTERO_PACKAGE.version && item.license === ZOTERO_PACKAGE.license
    && item.installation.mode === 'upstream-only' && item.sources.length === 1
    && item.source.kind === 'pypi' && item.source.packageName === ZOTERO_PACKAGE.packageName
    && item.source.version === ZOTERO_PACKAGE.version && item.source.digest.algorithm === 'sha256' && item.source.digest.value === ZOTERO_PACKAGE.sha256
    && item.components.length === 1 && component.type === 'mcp' && component.runtime.kind === 'uv'
    && component.runtime.packageName === ZOTERO_PACKAGE.packageName && component.runtime.version === ZOTERO_PACKAGE.version
    && component.runtime.executable === 'zotero-mcp' && JSON.stringify(component.runtime.args) === JSON.stringify(['serve'])
    && component.runtime.install.digest.value === ZOTERO_PACKAGE.sha256
}

export function isCatalogInstallable(item: MarketplacePackageV1): boolean {
  return item.installation.mode === 'direct-mirror' || isApprovedUpstreamPackage(item)
}

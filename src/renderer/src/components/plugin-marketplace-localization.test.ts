import { describe, expect, it } from 'vitest'
import {
  friendlyMarketplaceError,
  managedToolStatusIsInstalled,
  marketplaceText,
  skillValidationWarning
} from './PluginMarketplaceView'

const missing = (key: string): string => key

describe('plugin marketplace localization fallbacks', () => {
  it('uses readable built-in fallbacks instead of unresolved translation keys', () => {
    expect(marketplaceText(missing, 'pluginCliLarkTitle')).toBe('Lark CLI')
    expect(marketplaceText(missing, 'pluginSkillAgentReachTitle')).toBe('Agent Reach')
    expect(marketplaceText(missing, 'pluginSkillDocumentIllustratorTitle')).toBe('Document Illustrator')
    expect(marketplaceText(missing, 'pluginCommercialLicenseRequired')).toBe('Commercial license required')
    expect(marketplaceText(missing, 'pluginNoRedistributionLicense')).toBe('No redistribution license')
    expect(marketplaceText(missing, 'pluginDetailExternalProject'))
      .toBe('External project · not installed by RailWise AI')
  })

  it('turns technical Skill and network failures into concise messages', () => {
    expect(
      friendlyMarketplaceError(
        'Unsafe Skill package: file exceeds 1 MiB: assets/reference.pptx.',
        missing
      )
    ).toContain('oversized file')
    expect(friendlyMarketplaceError('TypeError: fetch failed', missing)).toContain(
      'could not be reached'
    )
    expect(friendlyMarketplaceError(
      'OAuth client ID is missing and dynamic registration is unavailable.',
      missing
    )).toContain('OAuth client ID')
  })

  it('keeps installed CLIs visible when login or a health check needs attention', () => {
    expect(managedToolStatusIsInstalled({ id: 'lark-cli', state: 'needs_login' })).toBe(true)
    expect(managedToolStatusIsInstalled({
      id: 'officecli',
      state: 'error',
      executablePath: '/tools/bin/officecli',
      message: 'health check failed'
    })).toBe(true)
    expect(managedToolStatusIsInstalled({ id: 'ego-browser', state: 'needs_external_app' })).toBe(false)
    expect(managedToolStatusIsInstalled({ id: 'officecli', state: 'not_installed' })).toBe(false)
  })

  it('identifies the exact skipped Skill and oversized file during discovery', () => {
    expect(skillValidationWarning(
      '/plugins/cache/openai/templates/skills/artifact-template-team-alignment',
      'Unsafe Skill package: file exceeds 1 MiB: assets/reference.pptx.',
      missing
    )).toBe(
      'Skipped Skill “artifact-template-team-alignment”: assets/reference.pptx exceeds the 1 MiB discovery limit. Remove the large file or move it outside the Skill package. Other Skills are unaffected.'
    )
    expect(skillValidationWarning(
      '/Users/wangjiawei/.codex/skills/gstack',
      'Unsafe Skill package: links and junctions are not allowed: ETHOS.md.',
      missing
    )).toBe(
      'Skipped Skill “gstack”: ETHOS.md is a symbolic link or junction, which is not allowed. Replace it with a regular file. Other Skills are unaffected.'
    )
  })
})

import { expect, it } from 'vitest'
import type { BrowserExecutionScope } from '../contracts/browser-skill.js'
import type { EgoBrowserCapabilityConfig } from '../contracts/ego-browser.js'
import type { TaskRunRepository } from './task-run-repository.js'
import { EgoBrowserRuntime } from './ego-browser-runtime.js'

const installedConfig: EgoBrowserCapabilityConfig = {
  state: 'installed' as const,
  executablePath: '/managed/ego-browser',
  executableHash: 'a'.repeat(64),
  version: '2.2.1',
  revision: 3
}

function runtime(config: EgoBrowserCapabilityConfig = installedConfig): EgoBrowserRuntime {
  return new EgoBrowserRuntime({ config, repository: {} as TaskRunRepository })
}

it('prefers an installed Ego browser for public source tasks with a user-provided origin', () => {
  expect(runtime().selectsForPublicRead('Create a PPT using https://www.railwise.cn', undefined, true)).toBe(true)
})

it('keeps explicit Chrome or BrowserSkill requests on the selected browser', () => {
  expect(runtime().selectsForPublicRead('Use BrowserSkill to read https://www.railwise.cn', undefined, true)).toBe(false)
  expect(runtime().selectsForPublicRead('Use Chrome to read https://www.railwise.cn', undefined, true)).toBe(false)
})

it('does not auto-select Ego without a verified install, source, or unbound task scope', () => {
  expect(runtime({ ...installedConfig, executableHash: undefined }).selectsForPublicRead(
    'Create a PPT using https://www.railwise.cn', undefined, true)).toBe(false)
  expect(runtime().selectsForPublicRead('Create a PPT', undefined, false)).toBe(false)
  const browserScope: BrowserExecutionScope = {
    browserInstanceId: 'chrome-test', origins: ['https://www.railwise.cn'], interaction: 'observe', revision: 1
  }
  expect(runtime().selectsForPublicRead('Create a PPT using https://www.railwise.cn', browserScope, true)).toBe(false)
})

import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  marketplaceCommandEnvironment,
  resolveMarketplaceCommand,
  resolveMarketplaceNpmCommand
} from './marketplace-command'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveMarketplaceCommand', () => {
  it('uses a tool directory that is present in the inherited PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-marketplace-command-'))
    roots.push(root)
    const executable = join(root, 'npm')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)

    expect(resolveMarketplaceCommand('npm', { PATH: root }, root)).toBe(executable)
  })

  it('finds user-managed tools even when the GUI PATH is minimal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-marketplace-command-'))
    roots.push(root)
    const executable = join(root, '.local', 'bin', 'workwise-tool')
    await mkdir(join(root, '.local', 'bin'), { recursive: true })
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)

    expect(resolveMarketplaceCommand('workwise-tool', { PATH: '/usr/bin' }, root)).toBe(executable)
  })

  it('preserves explicit executable paths', () => {
    expect(resolveMarketplaceCommand('/custom/bin/npm', { PATH: '' }, '/tmp')).toBe('/custom/bin/npm')
    expect(resolveMarketplaceCommand('C:\\custom\\npm.cmd', { PATH: '' }, '/tmp')).toBe('C:\\custom\\npm.cmd')
    expect(resolveMarketplaceCommand('  ', { PATH: '' }, '/tmp')).toBe('')
  })

  it('augments child PATH so env-based tool launchers can find their runtime', () => {
    const env = marketplaceCommandEnvironment({ PATH: '/usr/bin' }, '/tmp/workwise-home')
    expect(env.PATH?.split(delimiter)).toEqual(expect.arrayContaining(['/usr/bin', '/opt/homebrew/bin']))
  })

  it('resolves Windows PATHEXT commands and mirrors a Path-only environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-marketplace-command-'))
    roots.push(root)
    const executable = join(root, 'workwise-tool.CMD')
    await writeFile(executable, '@echo off\r\n')

    expect(resolveMarketplaceCommand(
      'workwise-tool',
      { Path: root, PATHEXT: '.EXE;.CMD' },
      root,
      'win32'
    )).toBe(executable)
    const env = marketplaceCommandEnvironment({ Path: root }, root, 'win32')
    expect(env.PATH?.split(';')).toContain(root)
    expect(env.Path).toBe(env.PATH)
  })

  it('executes env-based launchers with a runtime from the augmented PATH', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'workwise-marketplace-command-'))
    roots.push(root)
    const toolDirectory = join(root, '.local', 'bin')
    const runtimeDirectory = join(root, '.local', 'node', 'bin')
    const executable = join(toolDirectory, 'workwise-tool')
    const runtime = join(runtimeDirectory, 'workwise-node')
    await mkdir(toolDirectory, { recursive: true })
    await mkdir(runtimeDirectory, { recursive: true })
    await writeFile(executable, '#!/usr/bin/env workwise-node\n')
    await writeFile(runtime, '#!/bin/sh\nprintf runtime-ok\n')
    await chmod(executable, 0o755)
    await chmod(runtime, 0o755)

    const result = await execFileAsync(
      resolveMarketplaceCommand('workwise-tool', { PATH: '/usr/bin' }, root),
      [],
      { env: marketplaceCommandEnvironment({ PATH: '/usr/bin' }, root) }
    )

    expect(result.stdout).toBe('runtime-ok')
  })

  it('falls back to the command name when no executable candidate exists', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'workwise-marketplace-command-'))
    roots.push(root)
    const unavailable = join(root, 'workwise-missing-tool')
    await writeFile(unavailable, '#!/bin/sh\n')
    await chmod(unavailable, 0o644)

    expect(resolveMarketplaceCommand('workwise-missing-tool', { PATH: root }, root))
      .toBe('workwise-missing-tool')
  })
})

describe('resolveMarketplaceNpmCommand', () => {
  it('resolves npm.cmd into a native Windows launch and a separate script argument', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise npm 中文 '))
    roots.push(root)
    const cliDirectory = join(root, 'node_modules', 'npm', 'bin')
    await mkdir(cliDirectory, { recursive: true })
    await writeFile(join(root, 'npm.CMD'), '@exit /b 81\r\n')
    await writeFile(join(root, 'node.exe'), '')
    const cli = join(cliDirectory, 'npm-cli.js')
    await writeFile(cli, '')

    expect(resolveMarketplaceNpmCommand({ Path: root, PATHEXT: '.EXE;.CMD' }, root, 'win32')).toEqual({
      executable: join(root, 'node.exe'),
      args: [cli]
    })
  })

  it('reports the missing Windows npm toolchain instead of executing a batch file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-npm-wrapper-'))
    roots.push(root)
    await writeFile(join(root, 'npm.CMD'), '@exit /b 81\r\n')

    expect(() => resolveMarketplaceNpmCommand({ Path: root, PATHEXT: '.EXE;.CMD' }, root, 'win32'))
      .toThrow('Windows Node.js with npm was not found.')
  })
})

import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import type { SurveyConverterManifestV1 } from '../contracts/survey.js'
import { MacOsSandboxedSurveyConverterExecutor, SurveyConverterRegistry, type SandboxedSurveyConverterExecutor } from './survey-converter.js'
import { SurveyFormatRegistry } from './survey-format-registry.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixtureManifest(): Promise<{ manifest: SurveyConverterManifestV1; output: Buffer }> {
  const directory = await mkdtemp(join(tmpdir(), 'workwise-converter-fixture-'))
  directories.push(directory)
  const executablePath = join(directory, 'audited-converter')
  const executable = Buffer.from('synthetic audited converter fixture')
  await writeFile(executablePath, executable)
  await chmod(executablePath, 0o755)
  return {
    manifest: {
      schemaVersion: 1,
      id: 'fixture-trimble-rinex',
      version: '1.0.0-test',
      origin: 'user-supplied',
      auditReference: 'synthetic:test-only',
      executablePath,
      executableHash: createHash('sha256').update(executable).digest('hex'),
      inputFormats: ['trimble-t02'],
      outputFormat: 'rinex-observation',
      outputExtension: '.obs',
      arguments: ['--input', '{input}', '--output', '{output}'],
      timeoutMs: 5_000,
      maxOutputBytes: 1024 * 1024,
      networkAccess: 'none'
    },
    output: Buffer.from('     3.04           O                   RINEX VERSION / TYPE\n                                                            END OF HEADER\n')
  }
}

async function adjustmentReadyOpenOutput(format: 'workwise-json' | 'delimited-text' | 'xlsx'): Promise<Buffer> {
  if (format === 'workwise-json') return Buffer.from(JSON.stringify({
    format: 'workwise-survey-network',
    formatVersion: 1,
    network: {
      networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
    }
  }))
  if (format === 'delimited-text') return Buffer.from('type,from,to,value,unit\nheight-difference,BM,P1,0.1,m\n')
  const workbook = new JSZip()
  workbook.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  workbook.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
  workbook.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
  return await workbook.generateAsync({ type: 'nodebuffer' })
}

describe('SurveyConverterRegistry', () => {
  it('uses a valid user-supplied converter output as the active source while retaining both source identities', async () => {
    const { manifest, output } = await fixtureManifest()
    const executor: SandboxedSurveyConverterExecutor = {
      networkIsolation: 'verified-none',
      async execute(request) {
        await writeFile(request.outputPath, output)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    }
    const converters = new SurveyConverterRegistry([manifest], executor)
    const registry = new SurveyFormatRegistry(converters)
    const original = Buffer.from([0, 1, 2, 3, 4, 5])
    const result = await registry.ingest({ name: 'receiver.t02', bytes: original, networkType: 'gnss' })

    expect(result.sourceFile).toMatchObject({
      detection: { format: 'rinex-observation' },
      sha256: createHash('sha256').update(output).digest('hex'),
      disposition: 'gnss-processing-required',
      converter: {
        id: 'fixture-trimble-rinex', origin: 'user-supplied', status: 'passed', networkAccess: 'none',
        inputHash: createHash('sha256').update(original).digest('hex'),
        outputHash: createHash('sha256').update(output).digest('hex')
      },
      conversionInput: {
        formatId: 'trimble-t02', sha256: createHash('sha256').update(original).digest('hex'), originalPreserved: true
      }
    })
    expect(result.sourceFile.originalPreserved).toBe(true)
    expect(result.originalSourceFile).toMatchObject({
      formatId: 'trimble-t02', sha256: createHash('sha256').update(original).digest('hex'), disposition: 'converter-required'
    })
    expect(result.originalBytes).toEqual(original)
    expect(result.effectiveBytes).toEqual(output)
    expect(result.sourceFile.rawRecordAnchors).toHaveLength(2)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'info',
      message: expect.stringContaining('无网络沙箱')
    }))
  })

  it.each([
    ['workwise-json', '.json'],
    ['delimited-text', '.csv'],
    ['xlsx', '.xlsx']
  ] as const)('applies normal parser and admission gates to converted %s output', async (outputFormat, outputExtension) => {
    const { manifest } = await fixtureManifest()
    const output = await adjustmentReadyOpenOutput(outputFormat)
    const executor: SandboxedSurveyConverterExecutor = {
      networkIsolation: 'verified-none',
      async execute(request) {
        await writeFile(request.outputPath, output)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    }
    const converters = new SurveyConverterRegistry([{
      ...manifest,
      id: `fixture-open-output-${outputFormat}`,
      outputFormat,
      outputExtension
    }], executor)
    const registry = new SurveyFormatRegistry(converters)
    const original = Buffer.from([0, 1, 2, 3, 4, 5])
    const result = await registry.ingest({ name: 'receiver.t02', bytes: original, networkType: 'gnss' })

    expect(result.sourceFile).toMatchObject({
      formatId: outputFormat,
      sha256: createHash('sha256').update(output).digest('hex'),
      converter: { id: `fixture-open-output-${outputFormat}`, origin: 'user-supplied', status: 'passed', outputHash: createHash('sha256').update(output).digest('hex') },
      conversionInput: { formatId: 'trimble-t02', sha256: createHash('sha256').update(original).digest('hex') }
    })
    expect(result.originalSourceFile).toMatchObject({ formatId: 'trimble-t02', sha256: createHash('sha256').update(original).digest('hex') })
    expect(result.effectiveBytes).toEqual(output)
    if (outputFormat === 'workwise-json') {
      expect(result.sourceFile.disposition).toBe('adjustment-ready')
      expect(result.sourceFile.diagnostics.some((item) => item.severity === 'blocking')).toBe(false)
    } else {
      expect(result.sourceFile).toMatchObject({ disposition: 'archive-only', requiresManualConfirmation: true })
      expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'mapping_required', severity: 'blocking' }))
    }
  })

  it('retains and blocks the opaque original when converter output does not match its declared format', async () => {
    const { manifest } = await fixtureManifest()
    const output = await adjustmentReadyOpenOutput('workwise-json')
    const executor: SandboxedSurveyConverterExecutor = {
      networkIsolation: 'verified-none',
      async execute(request) {
        await writeFile(request.outputPath, Buffer.from('     3.04           O                   RINEX VERSION / TYPE\n                                                            END OF HEADER\n'))
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    }
    const registry = new SurveyFormatRegistry(new SurveyConverterRegistry([{
      ...manifest, id: 'fixture-mismatched-output', outputFormat: 'workwise-json', outputExtension: '.json'
    }], executor))
    const original = Buffer.from([0, 1, 2, 3, 4, 5])
    const result = await registry.ingest({ name: 'receiver.t02', bytes: original, networkType: 'gnss' })

    expect(result.sourceFile).toMatchObject({
      formatId: 'trimble-t02', sha256: createHash('sha256').update(original).digest('hex'), disposition: 'converter-required',
      converter: { id: 'fixture-mismatched-output', status: 'blocked' }
    })
    expect(result.effectiveBytes).toEqual(original)
    expect(result.originalSourceFile).toBeUndefined()
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'converter_required', severity: 'blocking', message: expect.stringContaining('声明输出 workwise-json')
    }))
    void output
  })

  it('requires license and redistribution approval only for a WorkWise-bundled converter', async () => {
    const { manifest } = await fixtureManifest()
    const incompleteBundled = { ...manifest, origin: 'workwise-bundled' } as unknown as SurveyConverterManifestV1
    expect(() => new SurveyConverterRegistry([incompleteBundled])).toThrow(/license|redistributionApproved/i)
  })

  it('blocks a changed executable before invoking the converter', async () => {
    const { manifest } = await fixtureManifest()
    let called = false
    const executor: SandboxedSurveyConverterExecutor = {
      networkIsolation: 'verified-none',
      async execute() {
        called = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    }
    const converters = new SurveyConverterRegistry([{ ...manifest, executableHash: '0'.repeat(64) }], executor)
    const result = await converters.convert('trimble-t02', 'receiver.t02', Buffer.from('source'))
    expect(called).toBe(false)
    expect(result).toMatchObject({ ok: false, provenance: { status: 'blocked' }, diagnostic: { code: 'converter_required', severity: 'blocking' } })
  })

  it('returns no adapter for unapproved formats instead of executing a fallback', async () => {
    const converters = new SurveyConverterRegistry()
    await expect(converters.convert('leica-dbx', 'job.dbx', Buffer.from([0, 1]))).resolves.toBeNull()
  })

  it.each([
    ['trimble-t01', 'job.t01'],
    ['trimble-t02', 'job.t02'],
    ['trimble-t04', 'job.t04'],
    ['trimble-job', 'job.job'],
    ['leica-dbx', 'job.dbx'],
    ['leica-mdb', 'job.mdb'],
    ['spectra-survey-pro', 'job.survey']
  ] as const)('keeps %s intact and converter-required when no audited adapter is registered', async (format, name) => {
    const registry = new SurveyFormatRegistry()
    const source = Buffer.from([0, 1, 2, 3, 4])
    const result = await registry.ingest({ name, bytes: source, networkType: 'gnss' })

    expect(result.sourceFile).toMatchObject({
      formatId: format,
      disposition: 'converter-required',
      originalPreserved: true,
    })
    expect(result.effectiveBytes).toEqual(source)
    expect(result.observations).toEqual([])
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'converter_required', severity: 'blocking'
    }))
  })

  it('rejects oversized and symbolic outputs even from an executor that reports success', async () => {
    const { manifest } = await fixtureManifest()
    for (const output of ['oversized', 'symlink'] as const) {
      const converter = new SurveyConverterRegistry([{ ...manifest, maxOutputBytes: 4 }], {
        networkIsolation: 'verified-none',
        async execute(request) {
          if (output === 'oversized') await writeFile(request.outputPath, Buffer.alloc(5))
          else await symlink(request.arguments[1]!, request.outputPath)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
      })
      expect(await converter.convert('trimble-t02', 'receiver.t02', Buffer.from('input'))).toMatchObject({ ok: false, provenance: { status: 'blocked' } })
    }
  })
})

describe.skipIf(process.platform !== 'darwin' || process.env.WORKWISE_TEST_MACOS_SURVEY_SANDBOX !== '1')('real macOS converter process boundaries', () => {
  async function executableFixture(body: string): Promise<{ manifest: SurveyConverterManifestV1; marker: string }> {
    const { manifest } = await fixtureManifest()
    const executable = Buffer.from(`#!${process.execPath}\n${body}\n`)
    await writeFile(manifest.executablePath, executable)
    const marker = join(manifest.executablePath, '..', 'process.json')
    return {
      manifest: { ...manifest, executableHash: createHash('sha256').update(executable).digest('hex'), arguments: ['{input}', '{output}', marker], maxOutputBytes: 4096, timeoutMs: 1000 },
      marker
    }
  }

  async function waitForProcesses(marker: string): Promise<{ parent: number; child: number; workspace: string }> {
    let info: { parent: number; child: number; workspace: string } | undefined
    await vi.waitFor(async () => { info = JSON.parse(await readFile(marker, 'utf8')) }, { timeout: 3000, interval: 20 })
    return info!
  }

  async function expectReaped(info: { parent: number; child: number; workspace: string }): Promise<void> {
    await vi.waitFor(() => {
      for (const pid of [info.parent, info.child]) {
        expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)
      }
    }, { timeout: 3000, interval: 20 })
    await expect(stat(info.workspace)).rejects.toMatchObject({ code: 'ENOENT' })
  }

  const processTree = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync(process.argv[4], JSON.stringify({ parent: process.pid, child: descendant.pid, workspace: process.cwd() }));
setInterval(() => {}, 1000);
`

  it.each(['trimble-t00', 'trimble-t01', 'trimble-t02', 'trimble-t04', 'trimble-job', 'leica-dbx', 'leica-mdb', 'spectra-survey-pro', 'hatanaka-rinex'] as const)('executes a hash-pinned synthetic adapter for %s without changing the format allowlist', async (format) => {
    const executablePath = '/bin/cp'
    const executableHash = createHash('sha256').update(await readFile(executablePath)).digest('hex')
    const manifest: SurveyConverterManifestV1 = {
      schemaVersion: 1,
      id: 'macos-sandbox-copy-fixture',
      version: 'system-test',
      origin: 'workwise-bundled',
      license: 'system-test-only',
      redistributionApproved: true,
      auditReference: 'synthetic:test-only',
      executablePath,
      executableHash,
      inputFormats: [format],
      outputFormat: 'unknown',
      outputExtension: '.bin',
      arguments: ['{input}', '{output}'],
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      networkAccess: 'none'
    }
    const source = Buffer.from('sandboxed converter integration')
    const result = await new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor()).convert(format, 'receiver.bin', source)
    expect(result, result?.diagnostic.message).toMatchObject({ ok: true, provenance: { executableHash, networkAccess: 'none', status: 'passed' } })
    expect(result?.outputBytes).toEqual(source)
  })

  it.each(['timeout', 'cancel'] as const)('terminates the real parent and child and removes the workspace after %s', async (mode) => {
    const { manifest, marker } = await executableFixture(processTree)
    manifest.timeoutMs = 3000
    const controller = new AbortController()
    const registry = new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor())
    const conversion = registry.convert('trimble-t02', 'receiver.t02', Buffer.from('source'), controller.signal)
    const info = await waitForProcesses(marker)
    if (mode === 'cancel') controller.abort()
    const result = await conversion
    expect(result).toMatchObject({ ok: false, provenance: { status: 'blocked', executableHash: manifest.executableHash, inputHash: createHash('sha256').update('source').digest('hex') } })
    expect(result?.diagnostic.message).toMatch(mode === 'timeout' ? /timed out/ : /cancelled/)
    await expectReaped(info)
  }, 10_000)

  it('cleans up a background descendant even when the converter parent exits successfully', async () => {
    const { manifest, marker } = await executableFixture(processTree.replace('setInterval(() => {}, 1000);\n', "fs.writeFileSync(process.argv[3], 'output'); process.exit(0);\n"))
    const conversion = new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor()).convert('trimble-t02', 'receiver.t02', Buffer.from('source'))
    const info = await waitForProcesses(marker)
    expect(await conversion).toMatchObject({ ok: true, outputBytes: Buffer.from('output') })
    await expectReaped(info)
  })

  it.each(['stdout', 'stderr'] as const)('fails on oversized UTF-8 %s bytes instead of silently truncating characters', async (stream) => {
    const { manifest } = await executableFixture(`process.${stream}.write('测'.repeat(400000), () => require('node:fs').writeFileSync(process.argv[3], 'output'));`)
    const result = await new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor()).convert('trimble-t02', 'receiver.t02', Buffer.from('source'))
    expect(result).toMatchObject({ ok: false, provenance: { status: 'blocked' } })
    expect(result?.diagnostic.message).toContain(`${stream} exceeds 1048576 bytes`)
  })

  it('accepts exactly the stdout and output-file byte limits', async () => {
    const { manifest } = await executableFixture("process.stdout.write(Buffer.alloc(1048576, 'a'), () => require('node:fs').writeFileSync(process.argv[3], Buffer.alloc(4096, 'b')));")
    const result = await new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor()).convert('trimble-t02', 'receiver.t02', Buffer.from('source'))
    expect(result).toMatchObject({ ok: true, outputBytes: Buffer.alloc(4096, 'b'), provenance: { status: 'passed' } })
  })

  it.each(['exit', 'keep-running'] as const)('rejects a real oversized output on %s without accepting a prefix', async (mode) => {
    const { manifest } = await executableFixture(`require('node:fs').writeFileSync(process.argv[3], Buffer.alloc(4097)); ${mode === 'keep-running' ? 'setInterval(() => {}, 1000);' : ''}`)
    const result = await new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor()).convert('trimble-t02', 'receiver.t02', Buffer.from('source'))
    expect(result).toMatchObject({ ok: false, provenance: { status: 'blocked' } })
    expect(result?.diagnostic.message).toContain('output exceeds 4096 bytes')
    expect(result?.outputBytes).toBeUndefined()
  })

  it('rejects a real symlink output and a pre-cancelled invocation without starting the script', async () => {
    const { manifest, marker } = await executableFixture("const fs = require('node:fs'); fs.writeFileSync(process.argv[4], 'started'); fs.symlinkSync(process.argv[2], process.argv[3]);")
    const registry = new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor())
    const controller = new AbortController()
    controller.abort()
    expect(await registry.convert('trimble-t02', 'receiver.t02', Buffer.from('source'), controller.signal)).toMatchObject({ ok: false, provenance: { status: 'blocked' } })
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    const result = await registry.convert('trimble-t02', 'receiver.t02', Buffer.from('source'))
    expect(result).toMatchObject({ ok: false, provenance: { status: 'blocked' } })
    expect(result?.diagnostic.message).toContain('regular file')
  })

  it('propagates cancellation through format ingestion while retaining the opaque source', async () => {
    const { manifest, marker } = await executableFixture(processTree)
    manifest.timeoutMs = 3000
    const controller = new AbortController()
    const source = Buffer.from([0, 1, 2, 3])
    const registry = new SurveyFormatRegistry(new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor()))
    const ingestion = registry.ingest({ name: 'receiver.t02', bytes: source, signal: controller.signal })
    const info = await waitForProcesses(marker)
    controller.abort()
    const result = await ingestion
    expect(result.sourceFile).toMatchObject({ formatId: 'trimble-t02', originalPreserved: true, disposition: 'converter-required', converter: { status: 'blocked', inputHash: createHash('sha256').update(source).digest('hex') } })
    expect(result.effectiveBytes).toEqual(source)
    expect(result.observations).toEqual([])
    await expectReaped(info)
  })

  it('still denies network access for the real hash-pinned process', async () => {
    const { manifest } = await executableFixture("const socket = require('node:net').connect(9, '127.0.0.1'); socket.on('error', error => require('node:fs').writeFileSync(process.argv[3], error.code));")
    const result = await new SurveyConverterRegistry([manifest], new MacOsSandboxedSurveyConverterExecutor()).convert('trimble-t02', 'receiver.t02', Buffer.from('source'))
    expect(result).toMatchObject({ ok: true, outputBytes: Buffer.from('EPERM'), provenance: { networkAccess: 'none', status: 'passed' } })
  })
})

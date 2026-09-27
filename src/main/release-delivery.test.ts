import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import YAML from 'yaml'
// The R2 publisher is an executable ESM module that also exposes side-effect-free
// validation helpers for release-gate coverage.
// @ts-expect-error JavaScript release helper intentionally has no declaration file.
import { _internals } from '../../scripts/publish-r2.mjs'
// @ts-expect-error JavaScript release helper intentionally has no declaration file.
import { _internals as websiteDelivery } from '../../scripts/deploy-website-release.mjs'
// @ts-expect-error JavaScript release helper intentionally has no declaration file.
import { isTransientMacSigningFailure, runMacArtifactBuildWithRetry } from '../../scripts/run-mac-artifact-build-with-retry.mjs'

describe('R2 release delivery gates', () => {
  it('retries only transient Apple timestamp outages during signed macOS packaging', async () => {
    expect(isTransientMacSigningFailure('The timestamp service is not available.')).toBe(true)
    expect(isTransientMacSigningFailure('A timestamp was expected but was not found.')).toBe(true)
    expect(isTransientMacSigningFailure('bundle format is ambiguous')).toBe(false)

    const attempts: number[] = []
    const waits: number[] = []
    await runMacArtifactBuildWithRetry('x64', {
      attempts: 3,
      baseDelayMs: 5,
      execute: async (attempt: number) => {
        attempts.push(attempt)
        return attempt === 1
          ? { code: 1, signal: null, output: 'The timestamp service is not available.' }
          : { code: 0, signal: null, output: '' }
      },
      wait: async (ms: number) => { waits.push(ms) }
    })

    expect(attempts).toEqual([1, 2])
    expect(waits).toEqual([5])
    const timestampMissingAttempts: number[] = []
    await runMacArtifactBuildWithRetry('x64', {
      attempts: 2,
      baseDelayMs: 5,
      execute: async (attempt: number) => {
        timestampMissingAttempts.push(attempt)
        return attempt === 1
          ? { code: 1, signal: null, output: 'A timestamp was expected but was not found.' }
          : { code: 0, signal: null, output: '' }
      },
      wait: async () => undefined
    })
    expect(timestampMissingAttempts).toEqual([1, 2])
    await expect(runMacArtifactBuildWithRetry('arm64', {
      attempts: 3,
      execute: async () => ({ code: 1, signal: null, output: 'invalid signature' }),
      wait: async () => undefined
    })).rejects.toThrow(/artifact build failed/)
  })

  it('keeps releases in semantic newest-first order for three-version retention', () => {
    expect(['v0.3.9', 'v0.10.0', 'v0.3.10', 'v0.2.8'].sort(_internals.compareReleaseTagsDescending))
      .toEqual(['v0.10.0', 'v0.3.10', 'v0.3.9', 'v0.2.8'])
  })

  it('bounds R2 promotion concurrency and network requests', () => {
    expect(_internals.R2_COPY_CONCURRENCY).toBe(3)
    expect(String(_internals.createR2RequestHandler)).toContain('requestTimeout: 5 * 60_000')
    expect(String(websiteDelivery.createR2RequestHandler)).toContain('connectionTimeout: 15_000')
  })

  it('rejects non-three-part release tags and unknown channels', () => {
    expect(() => _internals.normalizeTag('v0.3.3.1')).toThrow(/vX.Y.Z/)
    expect(() => _internals.normalizeChannel('nightly')).toThrow(/frontier, stable/)
  })

  it('limits updater acceptance cleanup to the exact run-scoped R2 prefix', () => {
    expect(_internals.acceptancePrefixForRunId('workwise/acceptance/12345', '12345'))
      .toBe('workwise/acceptance/12345/')
    expect(() => _internals.acceptancePrefixForRunId('workwise', '12345')).toThrow(/Refusing/)
    expect(() => _internals.acceptancePrefixForRunId('workwise/acceptance/12346', '12345')).toThrow(/Refusing/)
    expect(() => _internals.acceptancePrefixForRunId('workwise/acceptance/all', 'all')).toThrow(/positive/)
  })

  it('limits website publication to stable or exact run-scoped acceptance prefixes', () => {
    expect(websiteDelivery.normalizeReleasePrefix('workwise')).toEqual({
      prefix: 'workwise',
      relative: '',
      acceptanceRunId: ''
    })
    expect(websiteDelivery.normalizeReleasePrefix('workwise/acceptance/12345')).toEqual({
      prefix: 'workwise/acceptance/12345',
      relative: 'acceptance/12345',
      acceptanceRunId: '12345'
    })
    expect(() => websiteDelivery.normalizeReleasePrefix('workwise/../other')).toThrow(/Release prefix/)
    expect(() => websiteDelivery.normalizeReleasePrefix('workwise/acceptance/all')).toThrow(/Release prefix/)
    expect(websiteDelivery.r2StagingPrefix('workwise/acceptance/12345', '12345-1'))
      .toBe('workwise/acceptance/12345/delivery-staging/12345-1/')
    expect(websiteDelivery.normalizeTransport('r2')).toBe('r2')
    expect(() => websiteDelivery.normalizeTransport('ftp')).toThrow(/transport/)
  })

  it('pins website deployment to the WorkWise download root and atomic verified promotion', () => {
    expect(websiteDelivery.normalizeWebsiteRoot('/srv/site/downloads/workwise'))
      .toBe('/srv/site/downloads/workwise')
    expect(() => websiteDelivery.normalizeWebsiteRoot('/srv/site/downloads')).toThrow(/Unsafe/)
    expect(() => websiteDelivery.normalizeWebsiteRoot('/srv/../downloads/workwise')).toThrow(/Unsafe/)
    expect(() => websiteDelivery.normalizeWebsiteRoot('/')).toThrow(/Unsafe/)
    expect(websiteDelivery.FINALIZE_STAGE_SCRIPT).toContain('sha256sum -c SHA256SUMS.txt')
    expect(websiteDelivery.REPLACEABLE_WITHDRAWN_RELEASES.get('v0.4.0'))
      .toBe('5527492ea36c1b0518d8bacf655ec559a250db26c9bfb30bcba47678ef6009f9')
    expect(websiteDelivery.FINALIZE_STAGE_SCRIPT).toContain('refusing to replace the release currently selected by Stable')
    expect(websiteDelivery.FINALIZE_STAGE_SCRIPT).toContain('channels/$channel/withdrawn')
    expect(websiteDelivery.FINALIZE_STAGE_SCRIPT).toContain('test "$channel" = stable')
    expect(websiteDelivery.FINALIZE_STAGE_SCRIPT).toContain('test "$tag" = v0.4.0')
    expect(websiteDelivery.FINALIZE_STAGE_SCRIPT).toContain('(cd "$release" && sha256sum -c SHA256SUMS.txt)')
    expect(websiteDelivery.R2_DOWNLOAD_WORKER).toContain('urllib.request.urlopen')
    expect(websiteDelivery.R2_DOWNLOAD_WORKER).toContain('ThreadPoolExecutor')
    expect(websiteDelivery.R2_DOWNLOAD_WORKER).toContain("'Range': f'bytes={start}-{end}'")
    expect(websiteDelivery.R2_DOWNLOAD_WORKER).toContain('max_workers=min(24, len(jobs))')
    expect(websiteDelivery.R2_DOWNLOAD_WORKER).toContain('for attempt in range(4)')
    expect(websiteDelivery.START_R2_STAGE_DOWNLOAD_SCRIPT).toContain('nohup setsid')
    expect(websiteDelivery.POLL_R2_STAGE_DOWNLOAD_SCRIPT).toContain("printf 'running\\n'")
    expect(String(websiteDelivery.waitForRemoteR2Download)).toContain('consecutivePollFailures >= 5')
    expect(websiteDelivery.CLEAN_STAGE_SCRIPT).toContain('kill -- "-$pid"')
    expect(websiteDelivery.PROMOTE_SCRIPT).toContain('renameat2')
    expect(websiteDelivery.PROMOTE_SCRIPT).toContain('sorted(versions, reverse=True)[3:]')
    expect(websiteDelivery.CLEANUP_ACCEPTANCE_SCRIPT).toContain('/acceptance/[1-9][0-9]*')
    expect(websiteDelivery.CLEANUP_ACCEPTANCE_SCRIPT).toContain('.r2-download.pid')
    expect(websiteDelivery.sshOptions({
      port: '22',
      keyPath: '/tmp/key',
      knownHostsPath: '/tmp/known-hosts'
    })).toContain('ServerAliveCountMax=3')
  })

  it('archives the exact withdrawn release before replacing its immutable directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'workwise-release-recovery-'))
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    try {
      const release = join(root, 'channels/stable/releases/v0.4.0')
      const latest = join(root, 'channels/stable/latest')
      const payload = join(root, '.deploy-recovery-1/payload')
      mkdirSync(release, { recursive: true })
      mkdirSync(latest, { recursive: true })
      mkdirSync(payload, { recursive: true })

      const oldBody = 'withdrawn release fixture\n'
      const oldChecksums = `${digest(oldBody)}  old.bin\n`
      writeFileSync(join(release, 'old.bin'), oldBody)
      writeFileSync(join(release, 'SHA256SUMS.txt'), oldChecksums)
      writeFileSync(join(latest, 'latest.json'), JSON.stringify({ version: '0.3.6', tag: 'v0.3.6' }))

      const newBody = 'replacement release fixture\n'
      const latestYml = 'version: 0.4.0\n'
      const latestMacYml = 'version: 0.4.0\n'
      const newChecksums = [
        `${digest(newBody)}  new.bin`,
        `${digest(latestYml)}  latest.yml`,
        `${digest(latestMacYml)}  latest-mac.yml`
      ].join('\n') + '\n'
      writeFileSync(join(payload, 'new.bin'), newBody)
      writeFileSync(join(payload, 'latest.yml'), latestYml)
      writeFileSync(join(payload, 'latest-mac.yml'), latestMacYml)
      writeFileSync(join(payload, 'SHA256SUMS.txt'), newChecksums)

      const withdrawnChecksum = digest(oldChecksums)
      execFileSync('bash', [
        '-s', '--', root, '', 'stable', 'v0.4.0', '0.4.0', 'recovery-1', withdrawnChecksum
      ], { input: websiteDelivery.FINALIZE_STAGE_SCRIPT })

      expect(readFileSync(join(release, 'new.bin'), 'utf8')).toBe(newBody)
      expect(existsSync(join(release, 'old.bin'))).toBe(false)
      expect(readFileSync(
        join(root, `channels/stable/withdrawn/v0.4.0-${withdrawnChecksum}/old.bin`),
        'utf8'
      )).toBe(oldBody)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects long, duplicate, or conflicting public metadata cache headers', () => {
    const valid = new Headers({
      'cache-control': 'public, max-age=60, must-revalidate',
      date: 'Mon, 10 Aug 2026 09:00:00 GMT',
      expires: 'Mon, 10 Aug 2026 09:01:00 GMT',
      etag: '"fixture"',
      'last-modified': 'Mon, 10 Aug 2026 08:59:00 GMT',
      'accept-ranges': 'bytes'
    })
    expect(websiteDelivery.assertMetadataCacheHeaders(valid, 'latest.json'))
      .toBe('public, max-age=60, must-revalidate')

    const duplicated = new Headers(valid)
    duplicated.set('cache-control', 'max-age=604800, public, max-age=604800')
    expect(() => websiteDelivery.assertMetadataCacheHeaders(duplicated, 'latest.yml'))
      .toThrow(/cache policy is invalid/)

    const staleExpires = new Headers(valid)
    staleExpires.set('cache-control', 'no-cache, no-store, must-revalidate')
    staleExpires.set('expires', 'Mon, 17 Aug 2026 09:00:00 GMT')
    expect(() => websiteDelivery.assertMetadataCacheHeaders(staleExpires, 'latest-mac.yml'))
      .toThrow(/Expires is too long/)
  })

  it('verifies metadata byte ranges with an actual one-byte GET', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([123]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-0/2168' }
    }))
    globalThis.fetch = fetchMock as typeof fetch
    try {
      await websiteDelivery.verifyMetadataRange(new URL('https://example.com/latest.json'), 'latest.json')
      expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
        headers: { Range: 'bytes=0-0', 'Cache-Control': 'no-cache' }
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects metadata Range responses that do not prove one-byte support', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('full body', { status: 200 })) as typeof fetch
    try {
      await expect(websiteDelivery.verifyMetadataRange(
        new URL('https://example.com/latest.yml'),
        'latest.yml'
      )).rejects.toThrow('Range verification failed 200')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('parses updater metadata with SHA-512 and blockmap fields', () => {
    expect(_internals.parseUpdateYml([
      'version: 0.3.3',
      'files:',
      '  - url: WorkWise-0.3.3-win-x64.exe',
      '    sha512: ZmFrZS1zaGE=',
      '    size: 123',
      '    blockMapSize: 45',
      'path: WorkWise-0.3.3-win-x64.exe',
      'sha512: ZmFrZS1zaGE='
    ].join('\n'))).toMatchObject({
      version: '0.3.3',
      files: [{ url: 'WorkWise-0.3.3-win-x64.exe', sha512: 'ZmFrZS1zaGE=', size: 123, blockMapSize: 45 }]
    })
  })

  it('keeps native updater acceptance signed, three-platform, isolated, and self-cleaning', () => {
    const workflow = YAML.parse(readFileSync('.github/workflows/updater-acceptance-e2e.yml', 'utf8')) as {
      env: Record<string, string>
      jobs: Record<string, any>
    }
    const matrix = workflow.jobs['native-update'].strategy.matrix.include as Array<Record<string, string>>
    expect(matrix.map((entry) => `${entry.platform}-${entry.arch}`)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'win32-x64'
    ])
    expect(workflow.env.WORKWISE_RELEASE_PREFIX).toContain('workwise/acceptance/')
    const baselines = JSON.parse(
      readFileSync('release/updater-acceptance-baselines.json', 'utf8')
    ) as {
      schemaVersion: number
      versions: Record<string, Record<string, { name: string; sha256: string; size: number }>>
    }
    expect(baselines.schemaVersion).toBe(1)
    expect(Object.keys(baselines.versions)).toEqual(['0.3.5', '0.4.0', '0.4.1'])
    expect(baselines.versions['0.4.0']).toEqual({
      'darwin-arm64': {
        name: 'WorkWise-0.4.0-mac-Apple-Silicon.dmg',
        sha256: 'ba8ae699e968c3929f71f47f5a09285d64612963020158ebdf258629876a074a',
        size: 292705261
      },
      'darwin-x64': {
        name: 'WorkWise-0.4.0-mac-Intel.dmg',
        sha256: '4d2545d36641233bb612ddbb21e23f547ed049c38116ae775160cba48b2996bc',
        size: 297909271
      },
      'win32-x64': {
        name: 'WorkWise-0.4.0-win-x64.exe',
        sha256: 'e60f2d56916a9b75438275b55cf0d847cb44b0fecd67469693775a891b6ccb7e',
        size: 232521558
      }
    })
    expect(baselines.versions['0.4.1']).toEqual({
      'darwin-arm64': {
        name: 'WorkWise-0.4.1-mac-Apple-Silicon.dmg',
        sha256: 'a076d5786ba1178b1c9b35a7b323046b5ab2c6e2b78e9e726df9badad992a3c6',
        size: 274016020
      },
      'darwin-x64': {
        name: 'WorkWise-0.4.1-mac-Intel.dmg',
        sha256: '2b645bdbc4f490ca886f94a625cbda54b5947f861809a70fff9c6f360af38732',
        size: 279203128
      },
      'win32-x64': {
        name: 'WorkWise-0.4.1-win-x64.exe',
        sha256: '06e37d5d6000f909dce3bc23c476217d788457595db7dab08ff8ef061d3f374f',
        size: 232522014
      }
    })
    expect(workflow.jobs['build-macos'].env.MAC_CODESIGN_P12_BASE64).toContain('secrets.MAC_CODESIGN_P12_BASE64')
    const sidecarTransfer = workflow.jobs['build-document-sidecars'].steps.map((step: any) => step.run || '').join('\n')
    expect(sidecarTransfer).toContain('tar -czf')
    const macBuild = workflow.jobs['build-macos'].steps.map((step: any) => step.run || '').join('\n')
    expect(macBuild).toContain('tar -xzf')
    expect(macBuild).toContain('test -L')
    expect(macBuild).toContain('@napi-rs/canvas-darwin-x64@0.1.100')
    expect(macBuild).not.toContain('acceptance-artifacts/base-mac')
    const windowsBuild = workflow.jobs['build-windows'].steps.map((step: any) => step.run || '').join('\n')
    expect(windowsBuild).not.toContain('acceptance-artifacts/base-win')
    expect(workflow.jobs['publish-test-feed'].env.WORKWISE_WEBSITE_SSH_PRIVATE_KEY)
      .toContain('secrets.WORKWISE_WEBSITE_SSH_PRIVATE_KEY')
    const publication = workflow.jobs['publish-test-feed'].steps.map((step: any) => step.run || '').join('\n')
    const promotion = workflow.jobs['publish-test-feed'].steps.find((step: any) => step.name === 'Atomically promote isolated feed')
    expect(promotion['timeout-minutes']).toBe(20)
    expect(publication).toContain('deploy-website-release.mjs stage')
    expect(publication).toContain('--transport r2')
    expect(publication).toContain('deploy-website-release.mjs promote')
    expect(publication).toContain('deploy-website-release.mjs verify-public')
    expect(publication).toContain('--metadata-cache deferred')
    expect(publication).toContain('verify-metadata-cache')
    expect(workflow.jobs['acceptance-gate'].needs).toContain('publish-test-feed')
    const finalGate = workflow.jobs['acceptance-gate'].steps.map((step: any) => step.run || '').join('\n')
    expect(finalGate).toContain('single short/no-cache policy')
    expect(workflow.jobs['cleanup-test-feed'].steps.at(-1).run).toContain('cleanup-acceptance')
    expect(workflow.jobs['cleanup-test-feed'].steps.at(-1).run).toContain('github.run_id')
    const nativeUpdate = workflow.jobs['native-update'].steps.map((step: any) => step.run || '').join('\n')
    expect(nativeUpdate).toContain('release/updater-acceptance-baselines.json')
    expect(nativeUpdate).toContain('releases/download/v${{ inputs.base_version }}')
    expect(nativeUpdate).toContain('EXPECTED_SHA256')
    expect(nativeUpdate).toContain('EXPECTED_SIZE')
    const harness = readFileSync('scripts/run-native-updater-acceptance.mjs', 'utf8')
    expect(harness).toContain("'--env', 'WORKWISE_STARTUP_TRACE=1'")
    expect(harness).toContain("WORKWISE_STARTUP_TRACE: '1'")
    expect(harness).toContain("'Contents', 'Resources', 'app-update.yml'")
    expect(harness).toContain('Installed macOS baseline lacks Contents/Resources/app-update.yml')
    expect(harness).toContain('an updater-disabled candidate cannot be used as a native updater acceptance baseline.')
    expect(harness).toContain('report.userDataPreserved !== true')
    expect(harness).toContain("'user_data_preserved'")
  })

  it('isolates notarized Survey builds even when other dispatch actions are requested', () => {
    const release = YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8'))
    const inputs = Object.fromEntries(Object.entries(release.on.workflow_dispatch.inputs).map(([key, value]) => [key, (value as { default?: unknown }).default]))
    Object.assign(inputs, { isolated_survey_candidate: true, candidate_only: false, run_updater_acceptance: true,
      cleanup_acceptance_run_id: '123', repair_website_cache: true, repair_website_cache_mode: 'apply',
      repair_website_cache_confirmation: 'REPAIR-WORKWISE-METADATA-CACHE', rollback_stable_tag: 'v0.5.0',
      rollback_stable_confirmation: 'ROLLBACK-STABLE-TO-v0.5.0' })
    const enabled = (name: string) => runInNewContext(release.jobs[name].if.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
      github: { event_name: 'workflow_dispatch', ref_type: 'branch' }, inputs
    }, { timeout: 100 })
    expect(enabled('isolated-survey-candidate')).toBe(true)
    for (const name of ['native-updater-acceptance', 'cleanup-updater-acceptance', 'repair-website-cache', 'rollback-stable', 'prepare']) {
      expect(enabled(name), name).toBe(false)
    }
    const candidate = YAML.parse(readFileSync('.github/workflows/isolated-survey-candidate.yml', 'utf8'))
    expect(candidate.permissions).toEqual({ contents: 'read' })
    expect(release.jobs['isolated-survey-candidate'].permissions).toEqual({ contents: 'read' })
    const steps = candidate.jobs.candidate.steps as Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>
    expect(steps.find(step => step.uses?.startsWith('actions/checkout'))?.with?.['fetch-depth']).toBe(0)
    const commands = steps.map(step => step.run ?? '').join('\n')
    expect(commands).toContain('authorize-workwise-candidate.sh --prepare')
    expect(commands).toContain('--publish never')
    expect(commands).toContain("['xcrun', 'stapler', 'validate', str(app)]")
    expect(commands).not.toMatch(/publish-r2|deploy-website|gh release|git tag|compute-ci-release-version/)
    const artifact = steps.find(step => step.uses?.startsWith('actions/upload-artifact'))!
    expect(artifact.with?.path).not.toMatch(/\.p8|\.p12|candidate\.env|\/home/)
  })

  it('dispatches branch-only updater acceptance through the registered release workflow', () => {
    const release = YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } }
      jobs: Record<string, any>
    }
    expect(release.on.workflow_dispatch.inputs).toHaveProperty('run_updater_acceptance')
    expect(release.on.workflow_dispatch.inputs).toHaveProperty('cleanup_acceptance_run_id')
    expect(release.jobs['native-updater-acceptance'].uses).toBe('./.github/workflows/updater-acceptance-e2e.yml')
    expect(release.jobs['cleanup-updater-acceptance'].uses).toBe('./.github/workflows/updater-acceptance-cleanup.yml')
    expect(release.jobs.prepare.if).toContain('run_updater_acceptance')
    expect(release.jobs.publish.env.WORKWISE_WEBSITE_SSH_PRIVATE_KEY)
      .toContain('secrets.WORKWISE_WEBSITE_SSH_PRIVATE_KEY')
    const publication = release.jobs.publish.steps.map((step: any) => step.run || '').join('\n')
    expect(publication).toContain('deploy-website-release.mjs stage')
    expect(publication).toContain('--transport r2')
    expect(publication).toContain('deploy-website-release.mjs promote')
    expect(publication).toContain('deploy-website-release.mjs verify-public')
    const sidecarTransfer = release.jobs['build-document-sidecars'].steps.map((step: any) => step.run || '').join('\n')
    expect(sidecarTransfer).toContain('tar -czf')
    const macBuild = release.jobs['build-macos'].steps.map((step: any) => step.run || '').join('\n')
    expect(macBuild).toContain('tar -xzf')
    expect(macBuild).toContain('test -L')
    expect(macBuild).toContain('verify-mac-release-artifacts.cjs dist arm64 x64')
    const finalMacCandidate = release.jobs['verify-candidate-macos']
    expect(finalMacCandidate['runs-on']).toBe('macos-26')
    expect(finalMacCandidate.steps.map((step: any) => step.run || '').join('\n'))
      .toContain('verify-mac-release-artifacts.cjs candidate-installers --dmg-only arm64 x64')
  })

  it('provides an exact-scope cleanup workflow for canceled updater acceptance runs', () => {
    const cleanup = YAML.parse(readFileSync('.github/workflows/updater-acceptance-cleanup.yml', 'utf8')) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } }
      jobs: Record<string, any>
    }
    expect(cleanup.on.workflow_dispatch.inputs).toHaveProperty('run_id')
    const command = cleanup.jobs.cleanup.steps.map((step: any) => step.run || '').join('\n')
    expect(command).toContain('publish-r2.mjs cleanup-acceptance')
    expect(command).toContain('deploy-website-release.mjs cleanup-acceptance')
    expect(command).toContain('^[1-9][0-9]*$')
  })

  it('keeps website cache repair scoped, backed up, and validated before reload', () => {
    const repair = readFileSync('scripts/repair-website-cache.mjs', 'utf8')
    expect(repair).toContain('WorkWise updater metadata cache policy v2 begin')
    expect(repair).toContain('validateDiagnostics')
    expect(repair).toContain('Remote cache inspection returned incomplete diagnostics')
    expect(repair).toContain('apply=blocked_missing_python3')
    expect(repair).toContain('config_temp="$server_file.workwise-cache-edit.$$"')
    expect(repair).toContain('server_write_file "$config_temp" <"$edit_file"')
    expect(repair).toContain('server_run mv -f -- "$config_temp" "$server_file"')
    expect(repair).toContain('server_run cat "$server_file" >"$edit_file"')
    expect(repair).toContain("target_host='www.railwise.cn'")
    expect(repair).toContain('www[.]railwise[.]cn')
    expect(repair).toContain('nginx_candidate_count')
    expect(repair).toContain('target_server_name_count')
    expect(repair).toContain('legacy_cache_rule_count')
    expect(repair).toContain("target_host in match.group(1).split()")
    expect(repair).toContain('location = /downloads/workwise/channels/stable/latest/latest.json')
    expect(repair).toContain('location = /downloads/workwise/channels/frontier/latest/latest-mac.yml')
    expect(repair).toContain('location ^~ /downloads/workwise/acceptance/')
    expect(repair).not.toContain("target_host = 'railwise.cn'")
    expect(repair).toContain('workwise-cache-backup')
    expect(repair).toContain('backup="$server_file.workwise-cache-backup.')
    expect(repair).toContain("re.finditer(r'(?m)^\\s*server\\s*\\{'")
    expect(repair).toContain('text[:server_open + 1] + location + server_body + text[server_close:]')
    expect(repair).toContain("marker_line_start = server_body.rfind('\\n', 0, marker_index) + 1")
    expect(repair).not.toContain('backup="\\${server_file}')
    expect(repair).toContain("if char == '\\n': comment = False")
    expect(repair).not.toContain("if char == '\\\\n': comment = False")
    expect(repair).toContain('*) "$@" ;;')
    expect(repair).toContain('nginx_bin" -t')
    expect(repair).toContain('apply=rolled_back')
    expect(repair).toContain('apply=rolled_back_reload_failed')
    expect(repair).toContain('nginx_bin" -s reload')
    expect(repair).toContain('/downloads/workwise/')
    expect(repair).not.toContain('rm -rf')
  })
  it('requires final macOS DMG and ZIP artifacts to pass strict verification in CI', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(packageJson.scripts['verify:mac-release-artifacts']).toBe(
      'node ./scripts/verify-mac-release-artifacts.cjs'
    )
    const workflow = readFileSync('.github/workflows/updater-acceptance-e2e.yml', 'utf8')
    expect(workflow).toContain('node scripts/verify-mac-release-artifacts.cjs dist arm64 x64')
  })

  it('installs verifier dependencies before checking repaired public headers', () => {
    const repairWorkflow = readFileSync('.github/workflows/repair-website-cache.yml', 'utf8')
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(repairWorkflow).toContain('npm ci --ignore-scripts')
    expect(releaseWorkflow).toContain('npm ci --ignore-scripts')
  })

  it('allows the replacement 0.4.0 release on the product page', () => {
    const deployment = readFileSync('scripts/deploy-workwise-product-page.mjs', 'utf8')
    expect(deployment).not.toContain('withdrawn version 0.4.0')
    expect(deployment).not.toContain("grep -R -n -F '0.4.0'")
  })

  it('requires an exact confirmation before restoring an immutable Stable release', () => {
    const release = YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } }
      jobs: Record<string, any>
    }
    expect(release.on.workflow_dispatch.inputs).toHaveProperty('rollback_stable_tag')
    expect(release.on.workflow_dispatch.inputs).toHaveProperty('rollback_stable_confirmation')
    const rollback = release.jobs['rollback-stable']
    const command = rollback.steps.map((step: any) => step.run || '').join('\n')
    expect(command).toContain('ROLLBACK-STABLE-TO-${ROLLBACK_TAG}')
    expect(command).toContain('publish-r2.mjs verify')
    expect(command).toContain('publish-r2.mjs rollback')
    expect(command).toContain('deploy-website-release.mjs promote')
    expect(command).toContain('verify-stable-feed-version.mjs')
    expect(command).not.toContain('gh release delete')
  })
})

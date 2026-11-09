import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign
} from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstalledPackagePermissionV1 } from '../../shared/marketplace'
import { PackageInstallationService } from './package-installation-service'
import {
  installPreparedPluginPackage,
  preparePluginArchive,
  type PreparedPluginPackageV1
} from './plugin-package-formats'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempTarget(label: string): Promise<{ root: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), `workwise-${label}-`))
  roots.push(root)
  return { root, target: join(root, 'prepared') }
}

async function archive(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) zip.file(path, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' })
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const item = value as Record<string, unknown>
  return '{' + Object.keys(item).sort().map((key) =>
    JSON.stringify(key) + ':' + canonicalJson(item[key])
  ).join(',') + '}'
}

function decisions(prepared: PreparedPluginPackageV1): InstalledPackagePermissionV1[] {
  return prepared.package.permissions.map((permission) => ({
    permissionId: permission.id,
    decision: 'granted'
  }))
}

function wwxManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'example-wwx',
    name: 'Example WWX',
    description: 'A signed WorkWise plugin fixture.',
    version: '1.2.3',
    publisher: { id: 'example', name: 'Example Publisher', url: 'https://example.test' },
    license: 'MIT',
    components: [{
      id: 'example-skill',
      name: 'Example Skill',
      type: 'skill',
      runtime: { kind: 'bundled', entrypoint: 'skills/example' },
      skillNames: ['example']
    }],
    resources: ['skills/example/SKILL.md'],
    permissions: [{
      id: 'workspace-read',
      kind: 'filesystem',
      access: 'read',
      default: 'review',
      reviewRequired: true,
      description: 'Read files selected by the user.',
      resources: ['workspace']
    }],
    dependencies: [],
    update: { strategy: 'manual', channel: 'stable', allowMajor: false },
    compatibility: {
      workwise: '>=0.3.5',
      platforms: ['darwin', 'win32', 'linux'],
      architectures: ['arm64', 'x64']
    }
  }
}

async function prepare(files: Record<string, string | Buffer>, label: string, format?: 'wwx' | 'codex' | 'mcpb') {
  const { target } = await tempTarget(label)
  return preparePluginArchive({
    archive: await archive(files),
    targetDirectory: target,
    ...(format ? { format } : {}),
    catalogSourceId: 'test-imports',
    sourceLocation: `/fixtures/${label}`,
    sourceKind: 'local'
  })
}

describe('plugin package formats', () => {
  it('prepares a WWX archive and installs it through the atomic package service', async () => {
    const prepared = await prepare({
      'workwise.plugin.json': json(wwxManifest()),
      'skills/example/SKILL.md': '# Example\n',
      LICENSE: 'MIT License\n'
    }, 'wwx-install')
    const installRoot = await tempTarget('wwx-install-root')
    const service = new PackageInstallationService({ rootDirectory: installRoot.target })

    const installed = await installPreparedPluginPackage(service, prepared, {
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: decisions(prepared),
      idempotencyKey: 'install-example-wwx'
    })

    expect(prepared).toMatchObject({
      format: 'wwx',
      package: {
        id: 'example-wwx',
        version: '1.2.3',
        signature: { status: 'unsigned' },
        availability: { status: 'available' },
        installation: { mode: 'direct-mirror' }
      },
      compatibility: { workwiseCompatible: true, reasons: [] }
    })
    expect(installed).toMatchObject({
      packageId: 'example-wwx',
      version: '1.2.3',
      artifact: { sha256: prepared.contentSha256 }
    })
  })

  it('verifies signed WWX file manifests and rejects content tampering', async () => {
    const manifest = json(wwxManifest())
    const files: Record<string, string | Buffer> = {
      LICENSE: 'MIT License\n',
      'assets/model.bin': randomBytes(1024 * 1024 + 1),
      'skills/example/SKILL.md': '# Example\n',
      'workwise.plugin.json': manifest
    }
    const digests = Object.fromEntries(Object.entries(files).sort().map(([path, content]) => [
      path,
      createHash('sha256').update(content).digest('hex')
    ]))
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const signedMetadata = {
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId: 'workwise-test-key',
      signer: 'WorkWise Test',
      files: digests
    }
    const signature = sign(null, Buffer.from(canonicalJson(signedMetadata)), privateKey).toString('base64')
    const { target } = await tempTarget('wwx-signature')
    const prepared = await preparePluginArchive({
      archive: await archive({
        ...files,
        'workwise.signature.json': json({ ...signedMetadata, signature })
      }),
      targetDirectory: target,
      catalogSourceId: 'test-imports',
      sourceLocation: '/fixtures/signed.wwx',
      trustedSigningKeys: [{
        keyId: 'workwise-test-key',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        signer: 'WorkWise Release'
      }]
    })

    expect(prepared.package.signature).toEqual({
      status: 'verified',
      algorithm: 'ed25519',
      keyId: 'workwise-test-key',
      signer: 'WorkWise Release'
    })

    await expect(prepare({
      ...files,
      'skills/example/SKILL.md': '# Tampered\n',
      'workwise.signature.json': json({ ...signedMetadata, signature })
    }, 'wwx-signature-tampered')).rejects.toThrow(/digest does not match/i)
  })

  it('adapts Codex skills and token-authenticated remote MCP without requiring its App Connector', async () => {
    const prepared = await prepare({
      '.codex-plugin/plugin.json': json({
        name: 'github-tools',
        version: '0.1.6',
        description: 'GitHub workflows.',
        author: { name: 'OpenAI', url: 'https://openai.com' },
        license: 'MIT',
        skills: './skills/',
        apps: './.app.json',
        mcpServers: './.mcp.json',
        interface: {
          displayName: 'GitHub Tools',
          shortDescription: 'Triage repositories and CI.',
          category: 'Developer Tools'
        }
      }),
      '.mcp.json': json({
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.githubcopilot.com/mcp/',
            bearer_token_env_var: 'GITHUB_PAT_TOKEN'
          }
        }
      }),
      '.app.json': json({ apps: { github: { id: 'connector-only-in-codex' } } }),
      'skills/github/SKILL.md': '# GitHub\n',
      LICENSE: 'MIT License\n'
    }, 'codex-github')

    expect(prepared.package).toMatchObject({
      id: 'github-tools',
      auth: {
        type: 'token',
        environmentVariables: ['GITHUB_PAT_TOKEN']
      },
      availability: { status: 'available' }
    })
    expect(prepared.package.components.map((component) => component.type)).toEqual(['skill', 'mcp'])
    expect(prepared.package.permissions.map((permission) => permission.kind)).toEqual(
      expect.arrayContaining(['network', 'credentials'])
    )
    expect(prepared.warnings).toContain('Codex App Connector metadata is preserved but cannot run in RailWise AI.')
    expect(prepared.compatibility).toEqual({ workwiseCompatible: true, reasons: [] })
  })

  it('imports bundled Codex MCP and keeps every hook disabled pending review', async () => {
    const prepared = await prepare({
      '.codex-plugin/plugin.json': json({
        name: 'local-tools',
        version: '1.0.0',
        description: 'Local tools.',
        author: { name: 'Example' },
        license: 'Apache-2.0',
        mcpServers: './.mcp.json'
      }),
      '.mcp.json': json({
        mcpServers: {
          local: { cwd: '.', command: 'node', args: ['./mcp/server.mjs'] }
        }
      }),
      'mcp/server.mjs': 'console.log("ready")\n',
      'hooks.json': json({
        hooks: {
          PostToolUse: [{
            matcher: 'Write|Edit',
            hooks: [{ type: 'command', command: './scripts/check.sh' }]
          }]
        }
      }),
      'scripts/check.sh': '#!/bin/sh\nexit 0\n',
      LICENSE: 'Apache License 2.0\n'
    }, 'codex-local')

    expect(prepared.package.components[0]).toMatchObject({
      type: 'mcp',
      runtime: { kind: 'bundled', entrypoint: 'mcp/server.mjs', executable: 'node' }
    })
    expect(prepared.package.hooks).toEqual([expect.objectContaining({
      event: 'PostToolUse',
      enabledByDefault: false,
      execution: 'disabled-pending-review',
      permissionIds: ['hook-process', 'hook-filesystem']
    })])
    expect(prepared.package.availability.status).toBe('available')
  })

  it('marks connector-only Codex plugins unavailable while accepting discoverable OAuth MCP', async () => {
    const connector = await prepare({
      '.codex-plugin/plugin.json': json({
        name: 'connector-only',
        version: '1.0.0',
        description: 'Connector only.',
        author: { name: 'Example' },
        license: 'MIT',
        apps: './.app.json'
      }),
      '.app.json': json({ apps: { example: { id: 'connector' } } }),
      LICENSE: 'MIT License\n'
    }, 'codex-connector')
    const oauth = await prepare({
      '.codex-plugin/plugin.json': json({
        name: 'oauth-mcp',
        version: '1.0.0',
        description: 'OAuth MCP.',
        author: { name: 'Example' },
        license: 'MIT',
        mcpServers: './.mcp.json'
      }),
      '.mcp.json': json({
        mcpServers: {
          figma: {
            type: 'http',
            url: 'https://mcp.figma.com/mcp',
            oauth_resource: 'https://mcp.figma.com/mcp'
          }
        }
      }),
      LICENSE: 'MIT License\n'
    }, 'codex-oauth')

    expect(connector.compatibility.reasons).toContain('codex-app-connector-required')
    expect(connector.package.availability.status).toBe('unavailable')
    expect(oauth.compatibility).toEqual({ workwiseCompatible: true, reasons: [] })
    expect(oauth.package.availability.status).toBe('available')
    expect(oauth.package.auth).toMatchObject({ type: 'oauth', discovery: 'ready' })
  })

  it('adapts MCPB v0.3 configuration and binds v0.4 uv to the managed runtime', async () => {
    const node = await prepare({
      'manifest.json': json({
        manifest_version: '0.3',
        name: 'example-mcpb',
        display_name: 'Example MCPB',
        version: '2.1.0',
        description: 'An MCPB fixture.',
        author: { name: 'Example', url: 'https://example.test' },
        license: 'BSD-3-Clause',
        server: {
          type: 'node',
          entry_point: 'server/index.js',
          mcp_config: {
            command: 'node',
            args: ['${__dirname}/server/index.js'],
            env: { API_TOKEN: '${API_TOKEN}' }
          }
        },
        user_config: {
          API_TOKEN: {
            type: 'string',
            title: 'API token',
            description: 'Token used by the fixture.',
            required: true,
            sensitive: true
          },
          ROOT: {
            type: 'directory',
            title: 'Root',
            description: 'Allowed root.',
            required: true
          }
        },
        compatibility: { platforms: ['darwin', 'win32'] }
      }),
      'server/index.js': 'console.log("ready")\n',
      LICENSE: 'BSD 3-Clause License\n'
    }, 'mcpb-node')
    const uv = await prepare({
      'manifest.json': json({
        manifest_version: '0.4',
        name: 'uv-mcpb',
        version: '1.0.0',
        description: 'A uv MCPB fixture.',
        author: { name: 'Example' },
        license: 'ISC',
        server: {
          type: 'uv',
          entry_point: 'server/main.py',
          mcp_config: { command: 'uv', args: ['run', '${__dirname}/server/main.py'] }
        }
      }),
      'server/main.py': 'print("ready")\n',
      'pyproject.toml': '[project]\nname = "uv-mcpb"\nversion = "1.0.0"\n',
      'uv.lock': 'version = 1\nrevision = 1\nrequires-python = ">=3.12"\n',
      LICENSE: 'ISC License\n'
    }, 'mcpb-uv')

    expect(node.package).toMatchObject({
      id: 'example-mcpb',
      auth: { type: 'token', environmentVariables: ['API_TOKEN'] },
      availability: { status: 'available' },
      compatibility: { platforms: ['darwin', 'win32'] }
    })
    expect(node.package.configuration?.map((field) => field.key)).toEqual(['API_TOKEN', 'ROOT'])
    expect(uv.compatibility.reasons).toEqual([])
    expect(uv.package).toMatchObject({
      availability: { status: 'available' },
      components: [{ runtime: { kind: 'bundled', managedRuntime: 'uv' } }],
      dependencies: [{ id: 'uv-runtime', managedBy: 'workwise' }]
    })
  })

  it('does not claim runtime compatibility when an MCP environment contains uncaptured fixed values', async () => {
    const prepared = await prepare({
      'manifest.json': json({
        manifest_version: '0.3',
        name: 'fixed-env-mcpb',
        version: '1.0.0',
        description: 'An MCPB with fixed environment configuration.',
        author: { name: 'Example' },
        license: 'MIT',
        server: {
          type: 'node',
          entry_point: 'server/index.js',
          mcp_config: { command: 'node', env: { MODE: 'strict' } }
        }
      }),
      'server/index.js': 'console.log("ready")\n',
      LICENSE: 'MIT License\n'
    }, 'mcpb-fixed-env')

    expect(prepared.compatibility.reasons).toContain('fixed-environment-value-unsupported:MODE')
    expect(prepared.package.availability.status).toBe('unavailable')
  })

  it('rejects conflicting root manifests and removes failed extraction targets', async () => {
    const { target } = await tempTarget('conflicting-manifests')
    await expect(preparePluginArchive({
      archive: await archive({
        'workwise.plugin.json': json(wwxManifest()),
        'manifest.json': '{}',
        LICENSE: 'MIT License\n'
      }),
      targetDirectory: target,
      catalogSourceId: 'test-imports',
      sourceLocation: '/fixtures/conflicting.zip'
    })).rejects.toThrow(/conflicting root manifests/i)
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const SUPPORTED_ARCHES = new Set(['arm64', 'x64'])
const TRANSIENT_TIMESTAMP_PATTERNS = [
  /timestamp service is not available/i,
  /timestamp authority is not available/i,
  /timestamp server is (?:currently )?unavailable/i,
  /a timestamp was expected but was not found/i
]

export function isTransientMacSigningFailure(output) {
  return TRANSIENT_TIMESTAMP_PATTERNS.some((pattern) => pattern.test(String(output)))
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe']
    })
    let output = ''
    const capture = (chunk, stream) => {
      stream.write(chunk)
      output = `${output}${chunk}`.slice(-2_000_000)
    }
    child.stdout.on('data', (chunk) => capture(chunk, process.stdout))
    child.stderr.on('data', (chunk) => capture(chunk, process.stderr))
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, output }))
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runMacArtifactBuildWithRetry(arch, options = {}) {
  if (!SUPPORTED_ARCHES.has(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`)
  const attempts = positiveInteger(options.attempts ?? process.env.WORKWISE_MAC_SIGN_RETRY_ATTEMPTS, 3)
  const baseDelayMs = positiveInteger(options.baseDelayMs ?? process.env.WORKWISE_MAC_SIGN_RETRY_DELAY_MS, 20_000)
  const execute = options.execute ?? (() => run('npm', ['run', `dist:mac:${arch}:artifacts`]))
  const wait = options.wait ?? delay

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await execute(attempt)
    if (result.code === 0) return
    if (!isTransientMacSigningFailure(result.output) || attempt === attempts) {
      const signal = result.signal ? ` (signal ${result.signal})` : ''
      throw new Error(`macOS ${arch} artifact build failed with exit code ${result.code}${signal}`)
    }
    const waitMs = baseDelayMs * attempt
    console.warn(
      `[mac-sign-retry] Timestamp signing failed for ${arch}; retrying attempt ${attempt + 1}/${attempts} in ${Math.round(waitMs / 1000)}s.`
    )
    await wait(waitMs)
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  runMacArtifactBuildWithRetry(process.argv[2]).catch((error) => {
    console.error(`[mac-sign-retry] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

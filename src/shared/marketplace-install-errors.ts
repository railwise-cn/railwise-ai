const marketplaceInstallCodes = [
  'package-unavailable', 'download-unavailable', 'verification-failed', 'bundled-package-damaged',
  'review-expired', 'install-failed', 'refresh-failed'
] as const

export type MarketplaceInstallCode = typeof marketplaceInstallCodes[number]

export class MarketplaceInstallError extends Error {
  constructor(code: MarketplaceInstallCode, detail: string, cause?: unknown) {
    // Electron forwards only Error.message on an invoked IPC rejection.
    super(`[marketplace:${code}] ${detail}`, { cause })
    this.name = 'MarketplaceInstallError'
  }
}

export function marketplaceInstallCode(message: string): MarketplaceInstallCode | undefined {
  return marketplaceInstallCodes.find(code => message.includes(`[marketplace:${code}]`))
}

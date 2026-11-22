export function shouldStopServicesWhenAllWindowsClose(
  platform: NodeJS.Platform,
  candidateMode = false
): boolean {
  return candidateMode || platform !== 'darwin'
}

export function shouldCloseMainWindowToTray(
  closeToTray: boolean,
  candidateMode = false,
  quittingForUpdate = false
): boolean {
  return closeToTray && !candidateMode && !quittingForUpdate
}

export function shouldShowStartupErrorDialog(candidateHeadless = false): boolean {
  return !candidateHeadless
}

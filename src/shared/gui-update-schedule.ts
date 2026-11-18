export const GUI_UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000

export function nextGuiUpdateCheckDelay(
  lastCheckedAtMs: number | null | undefined,
  nowMs = Date.now()
): number {
  if (!Number.isFinite(lastCheckedAtMs) || !lastCheckedAtMs || lastCheckedAtMs <= 0 || lastCheckedAtMs > nowMs) return 0
  return Math.max(0, lastCheckedAtMs + GUI_UPDATE_CHECK_INTERVAL_MS - nowMs)
}

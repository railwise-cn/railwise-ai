/** All dimensions are layout CSS pixels, after the application's UI zoom. */
export const WORKBENCH_NAV_DRAWER_BELOW = 1024
export const WORKBENCH_INSPECTOR_DRAWER_BELOW = 1280
export const WORKBENCH_MAIN_MIN = 480
export const WORKBENCH_NAV_MIN = 224
export const WORKBENCH_NAV_MAX = 360
export const WORKBENCH_INSPECTOR_MIN = 320
export const WORKBENCH_INSPECTOR_MAX = 760

export function clampPanelWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

/** Preferred widths survive a smaller window; fitted widths are never saved as preferences. */
export function computeWorkbenchLayout(width: number, preferredLeft: number, preferredRight: number,
  panels: { leftVisible: boolean; rightVisible: boolean }) {
  const available = Math.max(0, Number.isFinite(width) ? width : 0)
  const leftOverlay = available < WORKBENCH_NAV_DRAWER_BELOW
  const rightOverlay = available < WORKBENCH_INSPECTOR_DRAWER_BELOW
  let left = clampPanelWidth(preferredLeft, WORKBENCH_NAV_MIN, WORKBENCH_NAV_MAX)
  let right = clampPanelWidth(preferredRight, WORKBENCH_INSPECTOR_MIN, WORKBENCH_INSPECTOR_MAX)
  if (leftOverlay) left = Math.min(left, Math.max(0, available - 24))
  if (rightOverlay) right = Math.min(right, Math.max(0, available - 24))
  const dockLeft = panels.leftVisible && !leftOverlay
  const dockRight = panels.rightVisible && !rightOverlay
  const separators = Number(dockLeft) + Number(dockRight)
  let overflow = Math.max(0, (dockLeft ? left : 0) + (dockRight ? right : 0) + separators + WORKBENCH_MAIN_MIN - available)
  if (dockRight) {
    const shrink = Math.min(overflow, right - WORKBENCH_INSPECTOR_MIN)
    right -= shrink; overflow -= shrink
  }
  if (dockLeft) left -= Math.min(overflow, left - WORKBENCH_NAV_MIN)
  return { left, right, leftOverlay, rightOverlay }
}

import type { ReactElement } from 'react'
import workwiseLogo from '../../../../asset/img/workwise-symbol.svg'

/** Compact RailWise AI activity mark used in the conversation timeline. */
export function AnimatedWorkLogo({
  active = false,
  className = '',
  phase = 'lead',
  size = 'sm'
}: {
  active?: boolean
  className?: string
  phase?: 'lead' | 'trail'
  size?: 'sm' | 'md'
}): ReactElement {
  const classes = [
    'ds-work-logo',
    `ds-work-logo-${size}`,
    `ds-work-logo-phase-${phase}`,
    active ? 'is-active' : '',
    className
  ].filter(Boolean).join(' ')

  return (
    <span className={classes} aria-hidden="true">
      <span className="ds-work-logo-halo" />
      <span className="ds-work-logo-orbit ds-work-logo-orbit-outer" />
      <span className="ds-work-logo-orbit ds-work-logo-orbit-inner" />
      <span className="ds-work-logo-signal ds-work-logo-signal-a" />
      <span className="ds-work-logo-signal ds-work-logo-signal-b" />
      <span className="ds-work-logo-node ds-work-logo-node-a" />
      <span className="ds-work-logo-node ds-work-logo-node-b" />
      <span className="ds-work-logo-node ds-work-logo-node-c" />
      <span className="ds-work-logo-scan" />
      <span className="ds-work-logo-spark ds-work-logo-spark-a" />
      <span className="ds-work-logo-spark ds-work-logo-spark-b" />
      <img className="ds-work-logo-echo" src={workwiseLogo} alt="" draggable={false} decoding="async" />
      <span className="ds-work-logo-track">
        <span className="ds-work-logo-body">
          <img className="ds-work-logo-image" src={workwiseLogo} alt="" draggable={false} decoding="async" />
        </span>
      </span>
    </span>
  )
}

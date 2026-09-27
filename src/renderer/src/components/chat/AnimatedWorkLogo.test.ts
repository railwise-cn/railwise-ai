import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnimatedWorkLogo } from './AnimatedWorkLogo'
import { WorkMetaRow } from './message-timeline-cards'

describe('AnimatedWorkLogo', () => {
  it('uses the RAILWISE mark at the compatible resource path', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const logoSvg = await readFile(new URL('../../../../asset/img/workwise.svg', import.meta.url), 'utf8')

    expect(logoSvg).toContain('RailWise AI')
    expect(logoSvg).not.toContain('WorkWise')
    expect(logoSvg).toContain('viewBox="0 0 1024 1024"')
    expect(logoSvg).not.toContain('Layer_2')
  })

  it('renders layered logo markup for swim animation', () => {
    const html = renderToStaticMarkup(
      createElement(AnimatedWorkLogo, { active: true, className: 'extra-class', size: 'md' })
    )

    expect(html).toContain('ds-work-logo')
    expect(html).toContain('ds-work-logo-md')
    expect(html).toContain('ds-work-logo-phase-lead')
    expect(html).toContain('is-active')
    expect(html).toContain('extra-class')
    expect(html).toContain('ds-work-logo-halo')
    expect(html).toContain('ds-work-logo-orbit-outer')
    expect(html).toContain('ds-work-logo-orbit-inner')
    expect(html).toContain('ds-work-logo-signal-a')
    expect(html).toContain('ds-work-logo-signal-b')
    expect(html).toContain('ds-work-logo-node-a')
    expect(html).toContain('ds-work-logo-node-b')
    expect(html).toContain('ds-work-logo-node-c')
    expect(html).toContain('ds-work-logo-scan')
    expect(html).toContain('ds-work-logo-spark-a')
    expect(html).toContain('ds-work-logo-spark-b')
    expect(html).toContain('ds-work-logo-echo')
    expect(html).toContain('ds-work-logo-track')
    expect(html).toContain('ds-work-logo-body')
    expect(html).toContain('ds-work-logo-image')
  })

  it('defaults to a static logo unless active', () => {
    const html = renderToStaticMarkup(createElement(AnimatedWorkLogo))

    expect(html).toContain('ds-work-logo')
    expect(html).toContain('ds-work-logo-phase-lead')
    expect(html).not.toContain('is-active')
  })

  it('keeps pulse layers mounted in static state to avoid layout churn', () => {
    const html = renderToStaticMarkup(createElement(AnimatedWorkLogo, { size: 'sm' }))

    expect(html).toContain('ds-work-logo-sm')
    expect(html).toContain('ds-work-logo-halo')
    expect(html).toContain('ds-work-logo-orbit-outer')
    expect(html).toContain('ds-work-logo-signal-a')
    expect(html).toContain('ds-work-logo-node-a')
    expect(html).toContain('ds-work-logo-scan')
    expect(html).toContain('ds-work-logo-spark-a')
    expect(html).not.toContain('is-active')
  })

  it('can render a desynchronized trailing phase', () => {
    const html = renderToStaticMarkup(createElement(AnimatedWorkLogo, { active: true, phase: 'trail' }))

    expect(html).toContain('is-active')
    expect(html).toContain('ds-work-logo-phase-trail')
  })

  it('keeps the processing work row as text-only status', () => {
    const html = renderToStaticMarkup(
      createElement(WorkMetaRow, {
        processing: true,
        stepCount: 3,
        expanded: true,
        onToggle: () => undefined
      })
    )

    expect(html).toContain('ds-shiny-text')
    expect(html).not.toContain('ds-work-logo-slot')
  })

  it('keeps the workflow pulse animation layers wired in CSS', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const workLogoCss = await readFile(new URL('../../styles/work-logo.css', import.meta.url), 'utf8')

    for (const layer of [
      'halo',
      'orbit-outer',
      'orbit-inner',
      'signal-a',
      'signal-b',
      'node-a',
      'node-b',
      'node-c',
      'scan',
      'spark-a',
      'spark-b'
    ]) {
      expect(workLogoCss).toContain(`ds-work-logo-${layer}`)
    }

    expect(workLogoCss).toContain('.ds-work-logo-body::after')
    expect(workLogoCss).toContain('@keyframes ds-work-logo-scan')
    expect(workLogoCss).toContain('@media (prefers-reduced-motion: reduce)')
  })
})

import { Clock3, Code2, Compass, LayoutGrid, Package, Palette, PencilLine, Server, Sparkles, Terminal, Workflow, Wrench, type LucideIcon, type LucideProps } from 'lucide-react'
import type { ReactElement } from 'react'

export const productIconRegistry: Readonly<Record<string, LucideIcon>> = Object.freeze({
  code: Code2, engineering: Compass, write: PencilLine, design: Palette, flow: Workflow,
  plugins: LayoutGrid, schedule: Clock3, tools: Wrench, mcp: Server, cli: Terminal, skill: Sparkles
})

/** Unknown catalog values always resolve to a real icon, never a blank glyph. */
export function ProductIcon({ name, ...props }: LucideProps & { name: string }): ReactElement {
  const Icon = Object.prototype.hasOwnProperty.call(productIconRegistry, name) ? productIconRegistry[name] : Package
  return <Icon {...props} />
}

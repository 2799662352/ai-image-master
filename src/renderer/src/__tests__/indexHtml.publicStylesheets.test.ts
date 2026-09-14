import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard for the 4.9.0 production regression: `public/css/main.css` (which
 * `@import`s base / components / animations / responsive / changelog) was
 * referenced from index.html as a *relative* `<link rel="preload" href="css/main.css?v=…">`.
 * The Vite production build drops relative stylesheet links into publicDir
 * instead of bundling them, so the packaged app never loaded any of those
 * files — the D6 top bar and VendorModelPanel shipped unstyled while `pnpm dev`
 * looked fine. Root-absolute `/css/main.css` goes through publicDir and is
 * rewritten to `./css/main.css` at build time, which `file://` can load.
 */
const html = readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8')

const localStylesheetHrefs = (): string[] =>
  Array.from(html.matchAll(/<link\b[^>]*>/g))
    .map((m) => m[0])
    .filter((tag) => /rel="(stylesheet|preload)"/.test(tag) && /\.css(\?|")/.test(tag))
    .map((tag) => /href="([^"]+)"/.exec(tag)?.[1] ?? '')
    .filter((href) => href && !/^https?:\/\//.test(href))

describe('index.html public stylesheets', () => {
  it('links public/css/main.css as a root-absolute plain stylesheet (not a relative preload)', () => {
    const main = localStylesheetHrefs().filter((h) => /main\.css/.test(h))
    expect(main).toHaveLength(1)
    expect(main[0]).toBe('/css/main.css')
    expect(html).not.toMatch(/rel="preload"[^>]*main\.css/)
  })

  it('main.css still chains the component stylesheets the top bar depends on', () => {
    const mainCss = readFileSync(path.resolve(__dirname, '../../public/css/main.css'), 'utf8')
    for (const name of ['base.css', 'components.css', 'animations.css', 'responsive.css']) {
      expect(mainCss).toContain(`@import url('${name}')`)
    }
    const components = readFileSync(path.resolve(__dirname, '../../public/css/components.css'), 'utf8')
    expect(components).toMatch(/\.nav-ctl\b/)
  })
})

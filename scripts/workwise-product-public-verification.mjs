import { basename } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const PRODUCT_URL = 'https://www.railwise.cn/products/workwise/'

export const NGINX_VHOST_ROOTS_PYTHON = String.raw`import re,shlex,sys

def directives(text):
    value=[]
    quote=None
    escaped=False
    comment=False
    for char in text:
        if comment:
            if char=='\n':
                comment=False
                value.append(' ')
            continue
        if quote:
            value.append(char)
            if escaped: escaped=False
            elif char=='\\': escaped=True
            elif char==quote: quote=None
            continue
        if escaped:
            value.append(char)
            escaped=False
        elif char=='\\':
            value.append(char)
            escaped=True
        elif char in (chr(39),chr(34)):
            quote=char
            value.append(char)
        elif char=='#':
            comment=True
        elif char in '{};':
            yield ''.join(value).strip(),char
            value=[]
        else:
            value.append(char)

roots=set()
stack=[]
server=None
for value,separator in directives(open(sys.argv[1],encoding='utf-8',errors='replace').read()):
    try:
        words=shlex.split(value)
    except ValueError:
        words=[]
    if separator=='{':
        if server is None and words and words[0]=='server':
            server={'depth':len(stack),'names':[],'roots':[]}
        stack.append(words[0] if words else '')
    elif separator==';' and server is not None and len(stack)==server['depth']+1 and words:
        if words[0]=='server_name':
            server['names'].extend(words[1:])
        elif words[0]=='root' and len(words)==2:
            server['roots'].append(words[1])
    elif separator=='}':
        if server is not None and len(stack)==server['depth']+1:
            if 'www.railwise.cn' in server['names']:
                for root in server['roots']:
                    if re.fullmatch(r'/www/audit-releases/audit-[A-Za-z0-9_-]+/site',root):
                        roots.add(root)
            server=None
        if stack:
            stack.pop()
print('\n'.join(sorted(roots)))`

export async function verifyProductPublication(manifest, {
  fetcher = fetch,
  attempts = 10,
  delay = () => setTimeout(5_000),
  log = console.log
} = {}) {
  const version = manifest.version
  const required = [
    `softwareVersion":"v${version}`,
    `${manifest.name || 'WorkWise'} v${version} 已发布`,
    `releases/tag/v${version}`,
    ...manifest.platforms.map((item) => item.url)
  ]
  let verified = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Check the normal user URL as well as a cache-busting request. A fresh
      // query response alone must not mask an outdated default download page.
      for (const url of [PRODUCT_URL, `${PRODUCT_URL}?release=${encodeURIComponent(version)}&t=${Date.now()}`]) {
        const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error(`Product page returned HTTP ${response.status}.`)
        const html = await response.text()
        const observed = html.match(/"softwareVersion"\s*:\s*"([^"]+)"/)?.[1] || 'missing'
        for (const value of required) {
          if (!html.includes(value)) throw new Error(`Observed page version ${observed}; missing expected content: ${value}`)
        }
      }
      const response = await fetcher(new URL('/data/workwise-product.json', PRODUCT_URL), { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`Public manifest returned HTTP ${response.status}.`)
      const live = await response.json()
      if (live.version !== version || live.releaseCommit !== manifest.releaseCommit) {
        throw new Error(`Public manifest version ${live.version}; release commit matches: ${live.releaseCommit === manifest.releaseCommit}`)
      }
      for (const expected of manifest.platforms) {
        const actual = live.platforms?.find((item) => item.file === expected.file)
        if (actual?.url !== expected.url || actual?.sha256 !== expected.sha256) throw new Error(`Public installer metadata mismatch: ${expected.file}`)
      }
      verified = true
      break
    } catch (error) {
      log(`Public verification attempt ${attempt}/${attempts}: ${error.message}`)
      if (attempt === attempts) throw error
      await delay()
    }
  }
  if (!verified) throw new Error('No public verification attempt completed.')
  for (const item of manifest.platforms) {
    const url = new URL(item.url, PRODUCT_URL)
    const range = await fetcher(url, {
      headers: { Range: 'bytes=0-1023' }, redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(30_000)
    })
    if (range.status !== 206 || !/^bytes 0-\d+\/\d+$/i.test(range.headers.get('content-range') || '')) {
      throw new Error(`Installer Range verification failed for ${basename(url.pathname)}.`)
    }
    await range.arrayBuffer()
  }
  log(`Verified public WorkWise product page, manifest and three immutable ${version} installers.`)
}

/**
 * Stub npm registry for testing upgrade failover.
 *
 * It answers the version query exactly like a real registry so it can be chosen
 * as the preferred download source, then fails every other request. That is the
 * shape of a real broken mirror: metadata that looks fine, downloads that do
 * not work.
 *
 * Usage: node fake-registry.mjs <port> [version]
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 4999)
const version = process.argv[3] ?? '0.1.5-rc.1'

const packument = {
  name: '@deepseek-ai/dsh',
  'dist-tags': { latest: version },
  versions: {
    [version]: {
      name: '@deepseek-ai/dsh',
      version,
      dist: { tarball: `http://127.0.0.1:${String(port)}/@deepseek-ai/dsh/-/dsh-${version}.tgz` },
    },
  },
}

createServer((request, response) => {
  const path = decodeURIComponent(request.url ?? '')
  if (path.replace(/\/+$/u, '').endsWith('@deepseek-ai/dsh')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(packument))
    return
  }
  // Anything else — every dependency packument and every tarball — fails, which
  // is what forces npm to give up on this source.
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{"error":"this stub registry serves metadata only"}')
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`stub registry on http://127.0.0.1:${String(port)} reporting ${version}\n`)
})

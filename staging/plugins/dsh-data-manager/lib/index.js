/**
 * dsh-data-manager host half.
 *
 * Everything the application keeps — sessions, settings, credentials,
 * attachments, stored objects and the plugin profile — lives under one
 * directory, and that directory is chosen outside the running process by the
 * launcher's `config.json`. This plugin serves it: a status route the settings
 * page reads, a migration route that copies the data to another drive and
 * rewrites that `config.json`, and a restart route that relaunches the launcher
 * so the new location takes effect.
 *
 * The write path deliberately targets `config.json` rather than this plugin's
 * own settings namespace: a setting stored inside the data directory cannot
 * describe where the data directory is.
 * @module dsh-data-manager
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Cordis plugin name; the bundle patch inserts this same specifier. */
export const name = 'dsh-data-manager'

/** The route table lives on the web server, so the card has something to read. */
export const inject = ['webServer']

/** Path prefix every route of this plugin owns. */
const PREFIX = '/dsh-data'

/** A request body larger than this is refused rather than buffered. */
const MAX_BODY_BYTES = 64 * 1024

/** How long a computed directory usage stays usable, so polling while migrating is not a full walk each time. */
const USAGE_TTL_MS = 5_000

/** One migration at a time, described to the settings page while it runs. */
const migration = {
  active: false,
  phase: 'idle',
  copied: 0,
  total: 0,
  bytes: 0,
  totalBytes: 0,
  error: undefined,
  done: false,
  target: undefined,
  startedAt: 0,
}

let usageCache

/**
 * Answer one request with JSON.
 * @param response - the HTTP response.
 * @param status - HTTP status code.
 * @param payload - value serialized as the body.
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Read a JSON request body.
 * @param request - the HTTP request.
 * @returns the parsed object; an empty body reads as an empty object.
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

/**
 * Find the installation directory this server is running from.
 *
 * The launcher exports it, and it is the only place the launcher's own settings
 * live: `config.json` beside `bin\dsh-app.mjs` is what the next start reads.
 * @returns the absolute installation directory, or undefined outside a packaged install.
 */
function installRoot() {
  const candidates = []
  const exported = process.env.DSH_INSTALL_ROOT
  if (typeof exported === 'string' && exported !== '') candidates.push(exported)
  const entry = process.argv[1]
  if (typeof entry === 'string') {
    for (let dir = dirname(entry), depth = 0; depth < 8; depth += 1) {
      candidates.push(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  candidates.push(dirname(dirname(process.execPath)))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'config.json')) && existsSync(join(candidate, 'bin', 'dsh-app.mjs'))) {
      return candidate
    }
  }
  return undefined
}

/**
 * Read the launcher settings.
 * @returns the parsed settings, or an empty record when there are none or they are malformed.
 */
function launcherConfig() {
  const root = installRoot()
  if (root === undefined) return {}
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // A missing or malformed settings file is reported through `configPath`
    // being absent from the status payload; the card needs no other signal.
    return {}
  }
}

/**
 * The directory the running server actually reads and writes.
 * @returns the absolute data directory.
 */
function dataDirectory() {
  const inherited = process.env.DSH_HOME
  if (typeof inherited === 'string' && inherited.trim() !== '') return resolve(inherited.trim())
  return join(homedir(), '.dsh')
}

/**
 * Describe where the data directory came from, using the launcher's precedence.
 * @param configured - the `dataDirectory` value from the launcher settings.
 * @returns a human-readable description of the deciding input.
 */
function dataSource(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return 'config.json 的 dataDirectory'
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') return '环境变量 DSH_HOME'
  return '默认位置（%USERPROFILE%\\.dsh）'
}

/**
 * Whether `child` is `parent` or lies inside it.
 * @param parent - the containing directory.
 * @param child - the candidate directory.
 * @returns true when the child path is within the parent path.
 */
function contains(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Measure one directory.
 *
 * Every level is counted, but the breakdown keeps only the first level: a report
 * that stops at the top of the tree undercounts exactly the directories that
 * grow (a profile's `node_modules`, a session store's nested files), and the
 * migration's completeness check reads the same number.
 *
 * Symbolic links and junctions are skipped: the profile's module index is a
 * directory of junctions into the installation, and following them would report
 * the whole application as user data and copy it during a migration.
 * @param dir - the directory to measure.
 * @param depth - current recursion depth; only level 0 contributes a breakdown.
 * @returns bytes, file count, and the first-level breakdown.
 */
function measure(dir, depth = 0) {
  let bytes = 0
  let files = 0
  const children = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // Unreadable directories count as empty; the measured total is a report,
    // not an authority, and one locked subdirectory must not fail the page.
    return { bytes, files, children }
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      const child = measure(path, depth + 1)
      bytes += child.bytes
      files += child.files
      if (depth === 0) children.push({ name: entry.name, bytes: child.bytes, files: child.files })
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = statSync(path)
      bytes += info.size
      files += 1
      if (depth === 0) {
        const bucket = children.find(child => child.name === '(根目录文件)')
        if (bucket === undefined) children.push({ name: '(根目录文件)', bytes: info.size, files: 1 })
        else {
          bucket.bytes += info.size
          bucket.files += 1
        }
      }
    } catch {
      // A file removed between the listing and the stat is simply not counted.
    }
  }
  return { bytes, files, children }
}

/**
 * Measure the data directory, reusing a recent result.
 * @param dir - the data directory.
 * @param fresh - ignore the cache, for a refresh the user asked for.
 * @returns bytes, file count, and the first-level breakdown.
 */
function usage(dir, fresh = false) {
  const now = Date.now()
  if (!fresh && usageCache !== undefined && usageCache.dir === dir && now - usageCache.at < USAGE_TTL_MS) {
    return usageCache.value
  }
  const value = measure(dir)
  usageCache = { dir, at: now, value }
  return value
}

/**
 * Whether a directory can receive a migration.
 * @param target - the resolved candidate directory.
 * @param current - the current data directory.
 * @param root - the installation directory, when one was found.
 * @returns an error message, or undefined when the target is usable.
 */
function targetProblem(target, current, root) {
  if (!isAbsolute(target)) return '请填写绝对路径，例如 D:\\dsh-data'
  if (resolve(target) === resolve(current)) return '新位置与当前位置相同，无需迁移。'
  if (contains(current, target)) return '新位置不能在当前数据目录里面。'
  if (contains(target, current)) return '新位置不能是当前数据目录的上级目录。'
  if (root !== undefined && contains(root, target)) return '新位置不能放在程序安装目录里面。'
  if (!existsSync(dirname(target))) return `上级目录不存在：${dirname(target)}`
  if (existsSync(target)) {
    const entries = readdirSync(target)
    if (entries.length > 0) return '目标目录不是空的。请换一个空目录，避免和已有数据混在一起。'
  }
  return undefined
}

/**
 * Copy the data directory to another drive, then point the launcher at it.
 *
 * The copy skips symlinks and junctions, so the profile's module index is left
 * behind and rebuilt from the installation on the next start. The old directory
 * is kept: a migration that deletes the source before the user has seen the new
 * location working is not a trade worth making.
 * @param from - the current data directory.
 * @param to - the destination directory.
 * @param removeSource - delete the source tree once the copy is verified.
 */
async function migrate(from, to, removeSource) {
  migration.active = true
  migration.phase = 'copying'
  migration.copied = 0
  migration.bytes = 0
  migration.error = undefined
  migration.done = false
  migration.target = to
  migration.startedAt = Date.now()
  const planned = usage(from, true)
  migration.total = planned.files
  migration.totalBytes = planned.bytes
  try {
    mkdirSync(to, { recursive: true })
    await cp(from, to, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: false,
      filter: (source) => {
        let info
        try {
          info = lstatSync(source)
        } catch {
          return false
        }
        if (info.isSymbolicLink()) return false
        if (info.isDirectory()) return true
        migration.copied += 1
        migration.bytes += info.size
        return true
      },
    })
    migration.phase = 'verifying'
    const copied = measure(to)
    if (copied.files < planned.files) {
      throw new Error(`复制不完整：源目录 ${String(planned.files)} 个文件，目标目录只有 ${String(copied.files)} 个`)
    }
    migration.phase = 'switching'
    const root = installRoot()
    if (root === undefined) throw new Error('找不到程序安装目录，无法写入 config.json')
    const configPath = join(root, 'config.json')
    const settings = launcherConfig()
    settings.dataDirectory = to
    writeFileSync(configPath, `${JSON.stringify(settings, undefined, 2)}\n`, 'utf8')
    if (removeSource === true) {
      migration.phase = 'removing'
      const { rm } = await import('node:fs/promises')
      await rm(from, { recursive: true, force: true })
    }
    migration.phase = 'restart-required'
    migration.done = true
  } catch (error) {
    migration.phase = 'failed'
    migration.error = error instanceof Error ? error.message : String(error)
  } finally {
    migration.active = false
    usageCache = undefined
  }
}

/**
 * Relaunch the application so the new data directory takes effect.
 *
 * The restart has to outlive the server it stops, and a detached Node child on
 * Windows brings the visible console window this package works to avoid, so the
 * launcher is started through a script host that gives it a hidden console —
 * the same technique its own entry points use.
 * @returns whether a restart was scheduled.
 */
function scheduleRestart() {
  const root = installRoot()
  if (root === undefined) return false
  const runner = join(root, 'run')
  mkdirSync(runner, { recursive: true })
  const script = join(runner, 'restart.vbs')
  const command = `"${process.execPath}" "${join(root, 'bin', 'dsh-app.mjs')}" restart`
  writeFileSync(
    script,
    `WScript.CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`,
    'utf8',
  )
  const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
  spawn(wscript, [script], { cwd: root, windowsHide: true, stdio: 'ignore' }).unref()
  return true
}

/**
 * The status payload the settings card renders.
 * @param fresh - recompute the directory usage instead of reusing a recent result.
 * @returns the current location, its deciding input, and its contents.
 */
function statusPayload(fresh) {
  const current = dataDirectory()
  const settings = launcherConfig()
  const root = installRoot()
  const exists = existsSync(current)
  const measured = exists ? usage(current, fresh) : { bytes: 0, files: 0, children: [] }
  return {
    path: current,
    source: dataSource(settings.dataDirectory),
    configured: typeof settings.dataDirectory === 'string' ? settings.dataDirectory : '',
    exists,
    bytes: measured.bytes,
    files: measured.files,
    children: [...measured.children].sort((left, right) => right.bytes - left.bytes),
    installRoot: root ?? null,
    configPath: root === undefined ? null : join(root, 'config.json'),
    writable: exists ? canWrite(current) : false,
    migration: { ...migration },
  }
}

/**
 * Whether the process may create files in a directory.
 * @param dir - the directory to probe.
 * @returns true when a probe file could be written and removed.
 */
function canWrite(dir) {
  const probe = join(dir, `.dsh-write-probe-${String(process.pid)}`)
  try {
    writeFileSync(probe, 'probe')
    rmSync(probe, { force: true })
    return true
  } catch {
    // An unwritable directory is a report, not an error: the card shows it so
    // the user learns the location cannot hold session data before a migration.
    return false
  }
}

/** The routes this plugin owns. */
const ROUTES = [
  {
    kind: 'exact',
    path: `${PREFIX}/status`,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      sendJson(response, 200, statusPayload(true))
    },
  },
  {
    kind: 'exact',
    path: `${PREFIX}/migrate`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      try {
        const body = await readJson(request)
        const target = typeof body.target === 'string' ? resolve(body.target.trim()) : ''
        if (target === '') {
          sendJson(response, 400, { error: '请填写新的数据目录。' })
          return
        }
        if (migration.active) {
          sendJson(response, 409, { error: '已有一次迁移正在进行。' })
          return
        }
        const current = dataDirectory()
        const problem = targetProblem(target, current, installRoot())
        if (problem !== undefined) {
          sendJson(response, 400, { error: problem })
          return
        }
        // Fire and forget: a copy of an interactive-sized data directory takes
        // longer than a request should, so progress is reported through status.
        void migrate(current, target, body.removeSource === true)
        sendJson(response, 202, { started: true, target })
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  },
  {
    kind: 'exact',
    path: `${PREFIX}/open`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      const current = dataDirectory()
      if (!existsSync(current)) {
        sendJson(response, 400, { error: `目录还不存在：${current}` })
        return
      }
      // Explorer is asked to show the directory; the server keeps serving.
      spawn('explorer.exe', [current], { stdio: 'ignore', windowsHide: false }).unref()
      sendJson(response, 200, { opened: current })
    },
  },
  {
    kind: 'exact',
    path: `${PREFIX}/restart`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      const scheduled = scheduleRestart()
      sendJson(response, scheduled ? 202 : 500, scheduled
        ? { started: true }
        : { error: '找不到程序安装目录，请手动重启：开始菜单 → 停止 DeepSeek Harness，再双击图标。' })
    },
  },
]

/**
 * Mount the data routes once the web server exists.
 * @param ctx - host context carrying the web server service.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = ROUTES.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-data-manager: http routes')
}

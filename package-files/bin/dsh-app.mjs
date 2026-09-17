/**
 * One-click lifecycle host for the locally installed DeepSeek Harness Web UI.
 *
 * The Harness ships as a command-line program. This script turns that program
 * into a launchable local application: it boots `dsh web` as a background
 * process, shows a window while it comes up, waits until the Web UI answers,
 * and reports where it runs. Because `dsh web` mints the browser session cookie
 * itself, this script never opens a URL it cannot authenticate — a cold start
 * lets the Harness perform its own authenticated browser handoff, and a warm
 * start reuses the cookie the browser already holds.
 *
 * Commands: start (default), stop, restart, status, open, console, logs,
 * check, update, autostart.
 *
 * The Harness is an ordinary npm package, so an upgrade is an ordinary install:
 * `update` resolves the newest published release, installs it into a staging
 * directory, swaps it in only after the current server stops, and restores the
 * previous directory unless the new release actually boots.
 * @module dsh-app
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(BIN_DIR)
const DSH_ENTRY = join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const BUNDLED_NODE = join(ROOT, 'runtime', 'node', 'node.exe')
/**
 * Manifest the packaging build writes beside the bundled runtime.
 *
 * Its presence marks a packaged install, whose dependencies are native-module
 * builds for one exact Node version. Such an install must run on its own
 * runtime; a source install has no manifest and no bundled runtime, and may use
 * whichever Node.js launched it.
 */
const RUNTIME_MANIFEST = join(ROOT, 'runtime', 'node-runtime.json')
const LOGS = join(ROOT, 'logs')
const RUN = join(ROOT, 'run')
const LOG_FILE = join(LOGS, 'dsh-web.log')
const ERROR_FILE = join(LOGS, 'launcher.error.txt')
const RESULT_FILE = join(LOGS, 'launcher.result.txt')
const LOCK_FILE = join(RUN, 'start.lock')
/**
 * One line naming what the startup window is currently waiting for.
 *
 * Overwritten rather than appended: the window shows the current phase beside
 * the application icon, not a log, so only the latest line is ever wanted.
 */
const BOOT_STATUS_FILE = join(RUN, 'boot-status.txt')
/** The same, for the window that shows an upgrade running. */
const UPGRADE_STATUS_FILE = join(RUN, 'upgrade-status.txt')
const CONFIG_FILE = join(ROOT, 'config.json')
/** Community plugins this installer carries, so no network install is needed. */
const PLUGINS = join(ROOT, 'plugins')
const PLUGINS_MANIFEST = join(PLUGINS, 'preinstalled.json')
const PLUGINS_MODULES = join(PLUGINS, 'node_modules')
/** File inside a profile recording which bundle entries this launcher added. */
const PREINSTALLED_STATE = '.dsh-preinstalled.json'

/** Loopback authority the Harness Web UI serves on. */
const HOST = '127.0.0.1'

/**
 * Read the optional deployment settings.
 *
 * An unreadable or malformed file is reported rather than silently ignored,
 * because a mistyped override would otherwise show up as an unexplained
 * workspace or port much later.
 * @returns the configured settings, or an empty record when none exist.
 */
function readConfig() {
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the top level must be a JSON object')
    }
    return parsed
  } catch (error) {
    process.stderr.write(`配置文件无法读取，将使用默认值：${CONFIG_FILE}\n${String(error)}\n`)
    return {}
  }
}

/**
 * Resolve where the user's data lives.
 *
 * The order is the deployment's explicit choice first, then the variable `dsh`
 * itself reads, then the per-user default. A relative configured or inherited
 * path is resolved against the working directory the launcher runs in, so the
 * reported location is always absolute and comparable between runs.
 * @returns the absolute directory and a human-readable description of where the choice came from.
 */
function resolveDataDirectory() {
  const configured = typeof CONFIG.dataDirectory === 'string' ? CONFIG.dataDirectory.trim() : ''
  if (configured !== '') return { path: resolve(configured), source: `${CONFIG_FILE} 的 dataDirectory` }
  const inherited = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (inherited !== '') return { path: resolve(inherited), source: '环境变量 DSH_HOME' }
  return { path: join(homedir(), '.dsh'), source: '默认位置（%USERPROFILE%\\.dsh）' }
}

const CONFIG = readConfig()
/**
 * Directory holding every piece of user state: sessions, settings, credentials,
 * attachments, stored objects, and the profile the server boots.
 *
 * `config.json` decides it first, so a deployment can move the data to another
 * drive; the `DSH_HOME` variable is honoured second, which is the contract `dsh`
 * itself implements; the per-user default is last. Resolving it once, in the
 * launcher, and handing the same value to the server is what keeps the two from
 * ever disagreeing about where the data is.
 */
const DATA = resolveDataDirectory()
const PORT = Number(process.env.DSH_APP_PORT ?? CONFIG.port ?? 3080)
const APP_URL = `http://${HOST}:${String(PORT)}/`
/**
 * Process id of the server on this port.
 *
 * Keyed by port because the launcher can serve more than one port across
 * configuration changes and tests; a single file would let a stop request for
 * one port kill the server of another.
 */
const PID_FILE = join(RUN, `dsh-${String(PORT)}.pid`)

/**
 * Directory a new Session is rooted in.
 *
 * `dsh web` roots Sessions at the launching process directory, so the install
 * directory would otherwise become the default workspace and the `.env`
 * fallback for credentials would resolve there too.
 */
const WORK_DIR = typeof CONFIG.workingDirectory === 'string' && existsSync(CONFIG.workingDirectory)
  ? CONFIG.workingDirectory
  : homedir()

/**
 * Node executable that runs the Harness.
 *
 * A packaged install always uses the runtime it ships, even if that runtime is
 * missing — the resulting failure is reported instead of being masked by the
 * machine's own Node.js, whose version the packaged native modules were not
 * built for. A source install without a bundled runtime uses the Node that
 * started this launcher.
 */
const NODE_EXE = pinnedRuntimeVersion() !== undefined || existsSync(BUNDLED_NODE)
  ? BUNDLED_NODE
  : process.execPath

/**
 * Read the Node version the packaging build pinned, if this is a packaged install.
 * @returns the pinned version without its leading `v`, or undefined for a source install.
 */
function pinnedRuntimeVersion() {
  if (!existsSync(RUNTIME_MANIFEST)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(RUNTIME_MANIFEST, 'utf8'))
    const version = typeof manifest?.version === 'string' ? manifest.version.replace(/^v/u, '') : ''
    return version === '' ? undefined : version
  } catch {
    return undefined
  }
}

/**
 * Confirm the install can run on the runtime it shipped.
 *
 * This is what turns "works here, fails on another computer" into a clear
 * message: a runtime that was not copied, was replaced by a different Node.js,
 * or does not run at all is reported before anything else is attempted.
 * @returns a user-facing problem description, or undefined when the install is sound.
 */
function runtimeProblem() {
  const pinned = pinnedRuntimeVersion()
  if (pinned === undefined) return undefined
  if (!existsSync(BUNDLED_NODE)) {
    return `内置的 Node.js 运行时缺失：\n${BUNDLED_NODE}\n\n`
      + '安装不完整或文件被删除。请重新运行安装程序修复。'
  }
  const probe = spawnSync(BUNDLED_NODE, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  const actual = (probe.stdout ?? '').trim().replace(/^v/u, '')
  if (probe.status !== 0 || actual === '') {
    return `内置的 Node.js 运行时无法执行（退出码 ${String(probe.status ?? 'unknown')}）：\n${BUNDLED_NODE}\n\n`
      + '请确认安装目录未被安全软件拦截，或重新运行安装程序修复。'
  }
  if (actual !== pinned) {
    return `内置 Node.js 版本不符：安装程序固定的是 v${pinned}，当前文件是 v${actual}。\n\n`
      + '这通常意味着安装目录被其他版本的 Node.js 覆盖过。请重新运行安装程序修复。'
  }
  return undefined
}

/**
 * npm registries the Harness is upgraded from.
 *
 * The official registry leads because it is the only one guaranteed to hold a
 * complete release: mirrors synchronize the top-level package quickly but can
 * lag on the sibling packages a release depends on, which makes npm refuse the
 * whole install. They stay listed as fallbacks, and a deployment that prefers a
 * mirror's speed can reorder them in `config.json`.
 */
const DEFAULT_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
  'https://mirrors.cloud.tencent.com/npm',
  'https://mirrors.huaweicloud.com/repository/npm',
]

/**
 * Read the configured registries.
 *
 * `registries` takes a list; the older single-valued `registry` is still
 * accepted so an existing `config.json` keeps working.
 * @returns distinct registry origins, in the order they should be tried.
 */
function resolveRegistries() {
  const configured = Array.isArray(CONFIG.registries)
    ? CONFIG.registries
    : typeof CONFIG.registry === 'string' && CONFIG.registry !== '' ? [CONFIG.registry] : []
  const candidates = configured.length > 0 ? configured : DEFAULT_REGISTRIES
  const cleaned = candidates
    .filter(entry => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => entry.trim().replace(/\/+$/u, ''))
  return cleaned.length > 0 ? [...new Set(cleaned)] : DEFAULT_REGISTRIES
}

const REGISTRIES = resolveRegistries()
/** Distribution tag selecting which published release to follow. */
const CHANNEL = typeof CONFIG.channel === 'string' && CONFIG.channel !== '' ? CONFIG.channel : 'latest'
/** Whether a cold start may offer an available upgrade. */
const CHECK_UPDATES = CONFIG.checkUpdates !== false
/** How long a previous registry answer stays usable before it is refreshed. */
const CHECK_HOURS = Number.isFinite(CONFIG.updateCheckHours) ? CONFIG.updateCheckHours : 6

const NPM_CLI = join(ROOT, 'runtime', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const PACKAGE_JSON = join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const STAGE_DIR = join(ROOT, 'update')
const STAGE_APP = join(STAGE_DIR, 'app')
const PREVIOUS_APP = join(ROOT, 'app.previous')
const STATE_FILE = join(RUN, 'update-state.json')
const STARTUP_LINK = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'DeepSeek Harness.lnk',
)

mkdirSync(LOGS, { recursive: true })
mkdirSync(RUN, { recursive: true })

/** How long a cold start may take before the launcher reports failure. */
const READY_TIMEOUT_MS = 120_000
/**
 * Delays before rebuilding the profile module index and starting again.
 *
 * Spaced rather than immediate because the failure this repairs is transient:
 * the first start after an installation fails while the freshly written tree is
 * still being indexed by the system, and the same start succeeds seconds later.
 * Four closely spaced attempts were measured failing one after another while a
 * launch about a minute later succeeded, so the later delays are the ones that
 * matter.
 */
const BOOT_RETRY_DELAYS_MS = [3000, 6000, 10_000, 15_000, 20_000, 25_000, 30_000]
/**
 * How long a start waits for an existing module index to become readable again.
 *
 * A first run has no index and the server builds one, which needs no wait; an
 * index that exists but cannot be read yet is the transient case, and waiting is
 * what turns it into a slow start instead of a failure.
 */
const PROFILE_READY_TIMEOUT_MS = 45_000
/** How long a stop may take before the launcher leaves the process to the OS. */
const STOP_TIMEOUT_MS = 20_000
/** How long a start lock survives without its owner before it is abandoned. */
const LOCK_STALE_MS = 180_000
/**
 * How long an unanswered upgrade question may stay on screen.
 *
 * Effectively indefinite — it only exists so a forgotten dialog cannot pin a
 * process forever.
 */
const DIALOG_TIMEOUT_MS = 12 * 60 * 60_000
const POLL_INTERVAL_MS = 400

/** Report a fatal condition to the console, to disk, and to the caller. */
function fail(message, detail) {
  const text = detail === undefined ? message : `${message}\n${detail}`
  writeFileSync(ERROR_FILE, text, 'utf8')
  // The wrapper scripts report through one file, so a failure has to land there
  // too; otherwise the dialog would repeat the previous action's message.
  writeFileSync(RESULT_FILE, text, 'utf8')
  process.stderr.write(`${text}\n`)
  process.exitCode = 1
}

/** Print a line to the console, the persistent log, and the last-result file. */
function note(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  process.stdout.write(line)
  writeFileSync(join(LOGS, 'launcher.log'), line, { encoding: 'utf8', flag: 'a' })
  writeFileSync(RESULT_FILE, `${message}\n`, 'utf8')
  progress(message)
}

/**
 * Record the phase a status window should show.
 *
 * The window is a convenience, so a status write that fails is reported nowhere
 * and changes nothing: a read-only or deleted `run\` directory must not be able
 * to stop an application start or an upgrade.
 * @param file - the status file the window reads.
 * @param message - the phase to show.
 */
function writeStatus(file, message) {
  try {
    writeFileSync(file, message, 'utf8')
  } catch {
    // Nothing to do and nothing to report: the operation itself is unaffected.
  }
}

/** Record the startup phase the startup window should show. */
function progress(message) {
  writeStatus(BOOT_STATUS_FILE, message)
}

/** Record the upgrade phase the upgrade window should show. */
function upgradeProgress(message) {
  writeStatus(UPGRADE_STATUS_FILE, message)
}

/** Sleep for a fixed interval without holding a timer beyond it. */
function sleep(milliseconds) {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

/**
 * Read a JSON file.
 * @param path - the file to read.
 * @returns the parsed value, or undefined when the file is absent or malformed.
 */
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Read a package's declared version.
 * @param dir - the package directory.
 * @returns the version, or undefined when the directory holds no readable manifest.
 */
function packageVersion(dir) {
  const version = readJsonFile(join(dir, 'package.json'))?.version
  return typeof version === 'string' && version !== '' ? version : undefined
}

/**
 * Create the web profile when the machine does not have one yet.
 *
 * `dsh` owns the profile template, so the launcher asks `dsh` for it instead of
 * writing a manifest of its own: a hand-written one would silently pin the
 * bundle list of whichever release this installer happened to ship. The dump
 * command composes nothing and opens nothing — it initializes the profile and
 * prints it, which measured at about 0.1 s.
 * @returns true when the profile manifest exists afterwards.
 */
function initializeWebProfile() {
  const manifestPath = join(DATA.path, 'profiles', 'web', 'package.json')
  if (existsSync(manifestPath)) return true
  if (!existsSync(DSH_ENTRY)) return false
  const result = spawnSync(NODE_EXE, [DSH_ENTRY, '--profile', 'web', '--dump-default-config'], {
    // The data directory is exported here too: `dsh` reads `DSH_HOME`, and a
    // launcher that resolved the directory from `config.json` would otherwise
    // have this call create a second profile under the default location.
    env: serverEnvironment(),
    windowsHide: true,
    stdio: 'ignore',
    timeout: 120_000,
  })
  if (result.status !== 0 || !existsSync(manifestPath)) {
    note('无法创建 web profile，本次不启用预装插件。')
    return false
  }
  return true
}

/**
 * Place one carried plugin inside the profile's own `node_modules`.
 *
 * Node resolves a package's imports from the directory the package really lives
 * in, not from a link path, so a plugin left in `plugins\` could see none of the
 * installation's shared packages, and one linked there would resolve back to
 * `plugins\`. A copy is what makes the profile's parent walk reach them — the
 * same place `dsh plugin add` installs a plugin, so the plugin shares the single
 * instance of everything the running installation provides.
 *
 * The copy is replaced only when the carried version differs, so an ordinary
 * start costs one manifest read per plugin.
 * @param name - the plugin package name.
 * @param modulesDir - the profile's `node_modules`.
 * @returns the installed version, or undefined when the plugin could not be placed.
 */
function installPreinstalledPlugin(name, modulesDir) {
  const source = join(PLUGINS_MODULES, name)
  const version = packageVersion(source)
  if (version === undefined || !existsSync(join(source, 'cordis.patch.yml'))) {
    note(`预装插件 ${name} 的文件不完整，已跳过。`)
    return undefined
  }
  const target = join(modulesDir, name)
  if (packageVersion(target) !== version) {
    try {
      rmSync(target, { recursive: true, force: true })
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true })
    } catch (error) {
      note(`预装插件 ${name} 无法写入 profile，已跳过：${String(error)}`)
      return undefined
    }
  }
  return version
}

/**
 * Enable the plugins this installer carries, as real profile bundles.
 *
 * A bundle is how `dsh` itself installs a plugin: the profile names it, and
 * every reader of that profile — the plugin market included — then agrees the
 * plugin is installed, which is what lets the market update or remove itself.
 *
 * The launcher owns exactly the entries it wrote, records them beside the
 * profile, and removes any it can no longer place. That rule is what keeps a
 * carried plugin from breaking the boot: a profile naming a bundle whose
 * directory is gone does not start at all, so the manifest may only ever name a
 * plugin that is present.
 *
 * A plugin this launcher added and that the user has since removed is recorded
 * as declined and never put back; removing the name from `plugins\preinstalled.json`
 * is the supported way to drop a carried plugin for good.
 * @returns how many carried plugins the profile ends up with.
 */
function ensurePreinstalledPlugins() {
  const declared = readJsonFile(PLUGINS_MANIFEST)
  const wanted = Array.isArray(declared?.bundles)
    ? declared.bundles.filter(name => typeof name === 'string' && name !== '')
    : []
  if (wanted.length === 0) return 0
  if (!initializeWebProfile()) return 0

  const profileDir = join(DATA.path, 'profiles', 'web')
  const manifestPath = join(profileDir, 'package.json')
  const manifest = readJsonFile(manifestPath)
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : undefined
  if (bundles === undefined) {
    note(`profile 清单无法解析，本次不启用预装插件：${manifestPath}`)
    return 0
  }
  const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object'
    && !Array.isArray(manifest.dependencies) ? { ...manifest.dependencies } : {}

  const statePath = join(profileDir, PREINSTALLED_STATE)
  const state = readJsonFile(statePath)
  const added = new Set(Array.isArray(state?.added) ? state.added : [])
  const declined = new Set(Array.isArray(state?.declined) ? state.declined : [])
  // An entry this launcher wrote and that is gone now was removed on purpose.
  for (const name of added) {
    if (!bundles.includes(name)) declined.add(name)
  }
  // A declined plugin the profile names again was reinstalled on purpose.
  for (const name of declined) {
    if (bundles.includes(name)) declined.delete(name)
  }

  const modulesDir = join(profileDir, 'node_modules')
  let enabled = 0
  for (const name of wanted) {
    if (declined.has(name)) continue
    const version = installPreinstalledPlugin(name, modulesDir)
    const at = bundles.indexOf(name)
    if (version === undefined) {
      // A plugin that cannot be placed must not stay named in the manifest.
      if (at !== -1) bundles.splice(at, 1)
      delete dependencies[name]
      added.delete(name)
      continue
    }
    if (at === -1) bundles.push(name)
    if (dependencies[name] === undefined) dependencies[name] = `^${version}`
    added.add(name)
    enabled += 1
  }
  // Entries this launcher wrote for plugins the package no longer carries.
  for (const name of [...added]) {
    if (wanted.includes(name)) continue
    const at = bundles.indexOf(name)
    if (at !== -1) bundles.splice(at, 1)
    delete dependencies[name]
    added.delete(name)
  }

  const next = { ...manifest, dependencies, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles } } }
  // The manifest is written before the state that describes it: recording an
  // entry that never reached the file would make the next start treat it as
  // user-removed and stop enabling the plugin for good.
  if (JSON.stringify(next) !== JSON.stringify(manifest)) {
    try {
      writeFileSync(manifestPath, `${JSON.stringify(next, undefined, 2)}\n`, 'utf8')
    } catch (error) {
      note(`profile 清单写入失败，本次不记录预装状态：${String(error)}`)
      return 0
    }
  }
  const nextState = { added: [...added], declined: [...declined] }
  if (JSON.stringify(state) !== JSON.stringify(nextState)) {
    try {
      writeFileSync(statePath, `${JSON.stringify(nextState, undefined, 2)}\n`, 'utf8')
    } catch (error) {
      note(`预装状态写入失败，下次启动会重新计算：${String(error)}`)
    }
  }
  return enabled
}

/** Test whether a process id names a live process on this host. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Read the recorded server pid, or undefined when no run is tracked. */
function readTrackedPid() {
  if (!existsSync(PID_FILE)) return undefined
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Find the process listening on the application port.
 *
 * A Harness started from a terminal — the usual case before the launcher has
 * ever run — leaves no pid file, so the port itself is the only way to find the
 * process the user is asking to stop.
 * @returns the owning process id, or undefined when it cannot be determined.
 */
function portOwnerPid() {
  const primary = runPowerShell(
    `(Get-NetTCPConnection -LocalPort ${String(PORT)} -State Listen -ErrorAction SilentlyContinue `
    + '| Select-Object -First 1 -ExpandProperty OwningProcess)',
  )
  const fromCmdlet = Number(primary.stdout.trim())
  if (Number.isInteger(fromCmdlet) && fromCmdlet > 0) return fromCmdlet
  const fallback = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
  const line = (fallback.stdout ?? '')
    .split(/\r?\n/u)
    .find(entry => new RegExp(`[:.]${String(PORT)}\\s+\\S+\\s+LISTENING`, 'u').test(entry))
  const fromNetstat = Number(line?.trim().split(/\s+/u).at(-1))
  return Number.isInteger(fromNetstat) && fromNetstat > 0 ? fromNetstat : undefined
}

/**
 * Ask the Web UI how it answers an unauthenticated request.
 * @param timeoutMs - request budget; a refused connection fails fast.
 * @returns the HTTP status and body, or undefined when nothing is listening.
 */
async function probe(timeoutMs = 2000) {
  try {
    const response = await fetch(APP_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.text().catch(() => '')
    return { status: response.status, body }
  } catch {
    return undefined
  }
}

/** True when the port answers and the answer carries the Harness auth marker. */
function isHarness(answer) {
  return answer !== undefined
    && (answer.body.includes('dsh web') || answer.body.includes('deepseek') || answer.status === 303)
}

/** Open a URL in the user's default browser. */
function openBrowser(url = APP_URL) {
  // Not detached for the same reason as the server: on Windows that flag asks
  // for the child's own console, which would flash a window on every launch.
  spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true }).unref()
}

/**
 * Run a PowerShell script without showing a console window.
 *
 * The script travels as UTF-16LE base64 so Chinese text and quoting survive the
 * command line untouched; `-EncodedCommand` takes no other arguments.
 *
 * `windowsHide` stays off deliberately. It makes the child inherit `SW_HIDE`,
 * and a Windows Forms window honours that inherited state on its first show, so
 * the console-free flag would also make every dialog invisible. `-WindowStyle
 * Hidden` suppresses the console instead, without touching the window a script
 * creates later.
 * @param script - complete PowerShell source to execute.
 * @param timeoutMs - how long the child may run before it is killed.
 * @returns the child's exit code and captured standard output.
 */
function runPowerShell(script, timeoutMs = 120_000) {
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(shell, [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: false, timeout: timeoutMs })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Quote one value as a PowerShell single-quoted literal. */
function psLiteral(text) {
  return `'${String(text).replaceAll("'", "''")}'`
}

/** Read the installed Harness version, or undefined when it cannot be read. */
function installedVersion() {
  if (!existsSync(PACKAGE_JSON)) return undefined
  try {
    const version = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Compare two semantic versions by the ordering npm uses.
 * @param left - first version, optionally carrying a prerelease suffix.
 * @param right - second version.
 * @returns a negative number, zero, or a positive number as left sorts before, with, or after right.
 */
function compareVersions(left, right) {
  const parse = (value) => {
    const [core, prerelease = ''] = String(value).split('-', 2)
    const numbers = core.split('.').map(part => Number.parseInt(part, 10))
    while (numbers.length < 3) numbers.push(0)
    return { numbers, prerelease: prerelease === '' ? [] : prerelease.split('.') }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  // A release outranks any of its prereleases; otherwise each dot-separated
  // identifier compares numerically when both are numeric, and textually after.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const one = a.prerelease[index]
    const two = b.prerelease[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    if (one === two) continue
    const oneNumber = /^\d+$/u.test(one) ? Number.parseInt(one, 10) : undefined
    const twoNumber = /^\d+$/u.test(two) ? Number.parseInt(two, 10) : undefined
    if (oneNumber !== undefined && twoNumber !== undefined) return oneNumber - twoNumber
    if (oneNumber !== undefined) return -1
    if (twoNumber !== undefined) return 1
    return one < two ? -1 : 1
  }
  return 0
}

/**
 * Read one registry's published metadata.
 *
 * The abbreviated packument keeps the request small and still carries both the
 * dist-tags and the version list — and the version list is the part a channel
 * needs. A maintainer publishes a release and moves whichever tags it belongs to
 * afterwards, so the tags alone can sit below the newest published version for
 * days; reading only `dist-tags[channel]` is what made the application report
 * "already current" while two newer releases existed.
 * @param registry - registry origin to query.
 * @param timeoutMs - request budget.
 * @returns the tags and versions, or undefined when this registry cannot answer.
 */
async function fetchPackument(registry, timeoutMs = 8_000) {
  try {
    const url = `${registry}/@deepseek-ai%2Fdsh`
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const packument = await response.json()
    const versions = Object.keys(packument?.versions ?? {})
    if (versions.length === 0) return undefined
    const tags = {}
    for (const [name, version] of Object.entries(packument?.['dist-tags'] ?? {})) {
      if (typeof version === 'string' && version !== '') tags[name] = version
    }
    return { registry, tags, versions }
  } catch {
    return undefined
  }
}

/**
 * Resolve the release the configured channel names.
 *
 * `newest` (the default) is the highest published version; any other value is
 * either a dist-tag such as `latest` or `next`, or an exact published version.
 * Querying in parallel means one slow or unreachable registry costs nothing, and
 * taking the maximum per tag means a mirror that has not synchronized yet cannot
 * make the application claim it is already current.
 * @returns the resolved version and its registry, the answering origins, and
 * every channel's current version; or `unknownChannel` when the value names
 * neither a tag nor a published version.
 */
async function resolveLatest() {
  const answers = (await Promise.all(REGISTRIES.map(registry => fetchPackument(registry))))
    .filter(answer => answer !== undefined)
  if (answers.length === 0) return undefined
  const reachable = answers.map(answer => answer.registry)
  const tags = {}
  for (const answer of answers) {
    for (const [name, version] of Object.entries(answer.tags)) {
      if (tags[name] === undefined || compareVersions(version, tags[name]) > 0) tags[name] = version
    }
  }
  const versions = [...new Set(answers.flatMap(answer => answer.versions))]
  const highest = versions.reduce((best, version) => compareVersions(version, best) > 0 ? version : best)
  let version
  if (CHANNEL === 'newest') version = highest
  else if (tags[CHANNEL] !== undefined) version = tags[CHANNEL]
  else if (versions.includes(CHANNEL)) version = CHANNEL
  else return { unknownChannel: true, tags, highest, reachable }
  const reporter = answers.find(answer => answer.versions.includes(version))?.registry ?? reachable[0]
  return { version, registry: reporter, reachable, tags, highest }
}

/**
 * Order the registries for one install attempt.
 *
 * Sources that answered the version query come first, because a source that
 * cannot answer metadata is very unlikely to serve a dependency tree; they stay
 * on the end of the list rather than being dropped, since a single failed
 * request is not proof that a source is permanently unusable.
 * @param preferred - registry that reported the wanted version, tried first.
 * @param reachable - origins that answered the version query.
 * @returns the origins to try, in order, without duplicates.
 */
function installOrder(preferred, reachable) {
  const ordered = []
  for (const entry of [preferred, ...(Array.isArray(reachable) ? reachable : []), ...REGISTRIES]) {
    if (typeof entry === 'string' && entry !== '' && !ordered.includes(entry)) ordered.push(entry)
  }
  return ordered
}

/** Read the cached last registry answer. */
function readUpdateState() {
  if (!existsSync(STATE_FILE)) return {}
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return state !== null && typeof state === 'object' ? state : {}
  } catch {
    return {}
  }
}

/**
 * Decide whether a newer Harness release is available.
 *
 * A cached answer keeps ordinary launches off the network. `suppressed` records
 * the one version the user asked never to be prompted about again; every other
 * version still asks, and the manual check ignores it entirely.
 *
 * `source` distinguishes a live answer from a remembered one. When no registry
 * answers, the remembered version is still reported for display but never as a
 * verdict: claiming "up to date" from a stale cache would hide exactly the
 * failure the user needs to know about.
 * @param options - `force` skips the cache and asks the registries directly.
 * @returns the installed and available versions, where the answer came from, and whether an upgrade applies.
 */
async function checkForUpdate(options = {}) {
  const installed = installedVersion()
  const state = readUpdateState()
  const declined = state.suppressed
  const fresh = Number.isFinite(state.checkedAt)
    && Date.now() - state.checkedAt < CHECK_HOURS * 3_600_000
  const verdict = (latest, registry, source, reachable = [], tags = {}) => ({
    installed,
    latest,
    registry,
    source,
    reachable,
    tags,
    channel: CHANNEL,
    declined,
    updateAvailable: source !== 'stale' && source !== 'unknown' && source !== 'bad-channel'
      && latest !== undefined && installed !== undefined
      && compareVersions(latest, installed) > 0,
  })

  if (!options.force && fresh && state.latest !== undefined) {
    // A remembered source is only useful while it is still configured: the
    // answer outlives an edit to `registries`, and a source that was removed —
    // or that only ever existed for a test — must not be preferred again.
    const remembered = REGISTRIES.includes(state.registry) ? state.registry : undefined
    return verdict(state.latest, remembered, 'cache')
  }
  const resolved = await resolveLatest()
  if (resolved !== undefined && resolved.unknownChannel === true) {
    // Fail loud rather than silently following the newest release: a channel the
    // user typed by hand is a configuration error, not a preference.
    return verdict(undefined, undefined, 'bad-channel', resolved.reachable, resolved.tags)
  }
  if (resolved !== undefined) {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ ...state, checkedAt: Date.now(), latest: resolved.version, registry: resolved.registry }, null, 2),
      'utf8',
    )
    return verdict(resolved.version, resolved.registry, 'registry', resolved.reachable, resolved.tags)
  }
  return verdict(state.latest, state.registry, state.latest === undefined ? 'unknown' : 'stale')
}

/** Record the version the user asked never to be prompted about again. */
function suppressVersion(version) {
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ ...readUpdateState(), suppressed: version }, null, 2),
    'utf8',
  )
}

/**
 * Ask what to do about an available release, with one button per answer.
 *
 * A standard message box only offers 是/否/取消, which cannot say what each
 * answer does, so this builds the three-way choice explicitly. The chosen
 * button comes back as the process exit code.
 * @param update - versions reported by `checkForUpdate`.
 * @returns `upgrade`, `later`, or `never`.
 */
function askUpgradeChoice(update) {
  const heading = `发现新版本 DeepSeek Harness ${String(update.latest)}`
  const names = Object.keys(update.tags ?? {}).sort()
  const table = names.length === 0
    ? ''
    : `\n\n各发布通道：${names.map(name => `${name} ${String(update.tags[name])}`).join('、')}`
  const body = `当前版本：${String(update.installed)}\n`
    + `升级通道：${String(update.channel)} → ${String(update.latest)}${table}\n\n`
    + '「立即升级」会下载新版本并自动重启服务，下载期间会显示进度窗口；'
    + '升级失败会自动回滚到当前版本。'
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = ${psLiteral(heading)}`,
    '$form.Size = New-Object System.Drawing.Size(520, 300)',
    "$form.StartPosition = 'CenterScreen'",
    "$form.FormBorderStyle = 'FixedDialog'",
    '$form.MaximizeBox = $false',
    '$form.MinimizeBox = $false',
    "$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)",
    '$title = New-Object System.Windows.Forms.Label',
    `$title.Text = ${psLiteral(heading)}`,
    '$title.Font = New-Object System.Drawing.Font(\'Microsoft YaHei UI\', 11, [System.Drawing.FontStyle]::Bold)',
    '$title.SetBounds(24, 18, 460, 28)',
    '$form.Controls.Add($title)',
    '$text = New-Object System.Windows.Forms.Label',
    `$text.Text = ${psLiteral(body)}`,
    '$text.SetBounds(24, 56, 460, 110)',
    '$form.Controls.Add($text)',
    '$upgrade = New-Object System.Windows.Forms.Button',
    "$upgrade.Text = '立即升级'",
    '$upgrade.SetBounds(24, 190, 120, 34)',
    "$upgrade.Add_Click({ $script:choice = 'upgrade'; $form.Close() })",
    '$form.Controls.Add($upgrade)',
    '$later = New-Object System.Windows.Forms.Button',
    "$later.Text = '以后再说'",
    '$later.SetBounds(156, 190, 120, 34)',
    "$later.Add_Click({ $script:choice = 'later'; $form.Close() })",
    '$form.Controls.Add($later)',
    '$never = New-Object System.Windows.Forms.Button',
    "$never.Text = '不再提示此版本'",
    '$never.SetBounds(288, 190, 160, 34)',
    "$never.Add_Click({ $script:choice = 'never'; $form.Close() })",
    '$form.Controls.Add($never)',
    "$form.AcceptButton = $upgrade",
    '$form.ShowDialog() | Out-Null',
    "switch ($script:choice) { 'upgrade' { exit 6 } 'never' { exit 8 } default { exit 7 } }",
  ].join('; ')
  // An unanswered question must stay on screen indefinitely: this runs in a
  // background process whose whole purpose is to wait for the user, and the
  // default budget would close the dialog out from under them.
  const code = runPowerShell(script, DIALOG_TIMEOUT_MS).status
  if (code === 6) return 'upgrade'
  if (code === 8) return 'never'
  return 'later'
}

/**
 * Offer an available upgrade and apply it when the user agrees.
 * @param update - versions reported by `checkForUpdate`.
 * @param assumeYes - skip the question, for unattended upgrades.
 * @returns what happened, so the caller can report or act on it.
 */
async function offerUpgrade(update, assumeYes = false) {
  if (!assumeYes) {
    const answer = askUpgradeChoice(update)
    if (answer === 'never') {
      suppressVersion(update.latest)
      note(`已设置不再提示 ${String(update.latest)}；手动「检查更新」仍可升级。`)
      return { status: 'suppressed' }
    }
    if (answer === 'later') {
      note(`本次跳过 ${String(update.latest)}，下次启动仍会提示。`)
      return { status: 'later' }
    }
  }
  // The prompt closes the moment a choice is made, so without this the screen
  // shows nothing for the minutes a download takes. An unattended upgrade has
  // nobody watching, so it gets no window.
  const statusWindow = assumeYes ? undefined : showUpgradeProgress(update.latest)
  try {
    const upgraded = await upgradeTo(update.latest, update.registry, update.reachable)
    // The closing line is the only evidence the run finished; hold it long
    // enough to be read rather than closing the window in the same instant.
    if (statusWindow !== undefined) await sleep(4000)
    return { status: upgraded ? 'upgraded' : 'failed' }
  } finally {
    closeSplash(statusWindow)
  }
}

/** Run one npm command with the packaged runtime, showing its own progress. */
function runNpm(args) {
  // A packaged install runs on the runtime it ships and nothing else. Falling
  // back to a machine-wide npm.cmd would start a foreign Node.js against native
  // modules built for the pinned one, which is the failure the pin exists to
  // prevent; report it instead.
  if (!existsSync(NPM_CLI)) {
    if (pinnedRuntimeVersion() !== undefined || existsSync(BUNDLED_NODE)) {
      note(`内置的 npm 缺失，无法升级或安装：${NPM_CLI}`)
      return { status: 1, stdout: '', stderr: '' }
    }
    return spawnSync('npm.cmd', args, { stdio: 'inherit', windowsHide: false, timeout: 20 * 60_000 })
  }
  return spawnSync(NODE_EXE, [NPM_CLI, ...args], {
    stdio: 'inherit',
    windowsHide: false,
    timeout: 20 * 60_000,
  })
}

/**
 * Install one Harness release into a staging tree and prove it can be read.
 *
 * Registries are tried in order. A mirror can serve the release's own metadata
 * while still lagging on a package that release depends on, so a failure here
 * is expected rather than exceptional and simply moves on to the next source.
 * Every attempt starts from an empty staging directory, so a partial download
 * from one registry can never be mixed into the next attempt's result.
 *
 * npm's own retry policy is overridden: it stretches a failing source across
 * several minutes of backoff, which is the wrong trade when the launcher can
 * switch sources instead. Bounding it keeps a dead registry to seconds.
 * @param version - exact version to install.
 * @param preferred - registry that reported this version, tried first.
 * @param reachable - origins that answered the version query.
 * @returns true only when the staged tree holds a runnable Harness entry.
 */
function stageRelease(version, preferred, reachable) {
  const order = installOrder(preferred, reachable)
  note(`正在下载 DeepSeek Harness ${String(version)}（可能需要几分钟）…`)
  upgradeProgress(`正在下载 ${String(version)}…`)
  const failures = []
  for (const registry of order) {
    rmSync(STAGE_DIR, { recursive: true, force: true })
    mkdirSync(STAGE_DIR, { recursive: true })
    note(`  从 ${registry} 下载…`)
    upgradeProgress(`正在从 ${registry} 下载 ${String(version)}…`)
    const result = runNpm([
      'install', `@deepseek-ai/dsh@${String(version)}`,
      '--prefix', STAGE_APP,
      '--registry', registry,
      '--prefer-online',
      '--fetch-retries', '2',
      '--fetch-retry-mintimeout', '5000',
      '--fetch-retry-maxtimeout', '15000',
      '--no-audit', '--no-fund', '--loglevel=error',
    ])
    if (result.status !== 0) {
      failures.push(`${registry}（npm 退出码 ${String(result.status ?? 'unknown')}）`)
      continue
    }
    const staged = join(STAGE_APP, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (!existsSync(staged)) {
      failures.push(`${registry}（下载结果不完整）`)
      continue
    }
    const stagedVersion = JSON.parse(readFileSync(staged, 'utf8')).version
    if (stagedVersion !== version) {
      failures.push(`${registry}（得到 ${String(stagedVersion)}，不是 ${String(version)}）`)
      continue
    }
    note(`  已从 ${registry} 下载完成。`)
    upgradeProgress(`已下载 ${String(version)}，正在替换程序文件…`)
    return true
  }
  note(`所有 npm 源都下载失败：\n  ${failures.join('\n  ')}`)
  upgradeProgress('下载失败，保留当前版本。')
  return false
}

/** Stop the server and wait until the port stops answering. */
async function stopForUpgrade() {
  const pid = readTrackedPid()
  if (pid !== undefined && isAlive(pid)) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    rmSync(PID_FILE, { force: true })
  }
  await waitForStop(STOP_TIMEOUT_MS)
}

/**
 * Environment the server runs with.
 *
 * `DSH_HOME` is exported explicitly from the resolved data directory. The server
 * reads that variable, so setting it is what keeps the two agreeing even when
 * `config.json` placed the data somewhere the ambient variable does not point.
 * `DSH_INSTALL_ROOT` is what lets a plugin that edits this installation's own
 * settings find them without guessing from the process arguments.
 * @returns the inherited environment with the data directory pinned.
 */
function serverEnvironment() {
  return {
    ...process.env,
    DSH_HOME: DATA.path,
    DSH_INSTALL_ROOT: ROOT,
  }
}

/**
 * Boot the installed Harness and confirm it answers.
 *
 * The server starts through `run-server.vbs`, which gives it its own hidden
 * console. Starting it directly is not an option on Windows: a detached child
 * outlives this launcher but is also given a visible console that every process
 * the agent spawns inherits — the black windows users see — while a
 * non-detached child is console-free but dies with the launcher.
 * @returns `{ ok: true }` once the Web UI answers, otherwise the log offset this attempt started at.
 */
async function startAndVerify() {
  const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
  const runner = join(BIN_DIR, 'run-server.vbs')
  if (!existsSync(runner)) {
    note(`缺少启动脚本：${runner}`)
    return { ok: false, mark: 0 }
  }
  const mark = logMark()
  // The carried plugins are a property of the profile, so they are reconciled
  // before the server reads it — and any failure leaves a profile that still
  // boots, because the reconciler only ever names a plugin it placed.
  progress('同步随包插件…')
  ensurePreinstalledPlugins()
  progress('启动服务进程…')
  const launcher = spawn(
    wscript,
    [runner, String(PORT)],
    { cwd: WORK_DIR, env: serverEnvironment(), windowsHide: true, stdio: 'ignore' },
  )
  launcher.unref()
  // A crashed boot leaves nothing listening, so the readiness poll can only time
  // out. Watching the log ends the wait in seconds and lets the caller act on the
  // failure while the user is still looking at the splash window.
  const ready = await waitForReady(READY_TIMEOUT_MS, () => isFatalBootOutput(logSince(mark)))
  return ready ? { ok: true } : { ok: false, mark }
}

/**
 * Record the process serving the application port.
 *
 * The runner script exits immediately, so the serving process is identified from
 * the port it holds rather than from a child handle. That lookup starts Windows
 * PowerShell and costs seconds, so callers run it after reporting readiness.
 */
function recordServerPid() {
  const pid = portOwnerPid()
  if (pid !== undefined) writeFileSync(PID_FILE, String(pid), 'utf8')
}

/**
 * Upgrade the installed Harness to one version, or restore the previous one.
 *
 * The new release is fully installed and verified in a staging directory before
 * the running one is touched, and the directory swap is undone unless the
 * upgraded Harness actually boots. A failed upgrade therefore leaves a working
 * installation behind rather than a half-replaced one.
 * @param version - exact version to upgrade to.
 * @returns true only when the upgraded Harness is serving requests.
 */
async function upgradeTo(version, registry, reachable) {
  if (!stageRelease(version, registry, reachable)) {
    rmSync(STAGE_DIR, { recursive: true, force: true })
    return false
  }

  const wasRunning = await probe() !== undefined
  upgradeProgress('正在停止服务…')
  await stopForUpgrade()

  rmSync(PREVIOUS_APP, { recursive: true, force: true })
  const app = join(ROOT, 'app')
  try {
    upgradeProgress('正在替换程序文件…')
    renameSync(app, PREVIOUS_APP)
    renameSync(STAGE_APP, app)
  } catch (error) {
    note(`替换程序目录失败：${String(error)}`)
    upgradeProgress('替换程序文件失败，保留当前版本。')
    if (!existsSync(app) && existsSync(PREVIOUS_APP)) renameSync(PREVIOUS_APP, app)
    rmSync(STAGE_DIR, { recursive: true, force: true })
    return false
  }

  note(`已安装 ${String(version)}，正在验证…`)
  upgradeProgress('正在验证新版本（会先启动一次）…')
  let healthy
  if (wasRunning) {
    healthy = (await startAndVerify()).ok
    if (healthy) recordServerPid()
  } else {
    healthy = await verifyOnce()
  }
  if (healthy) {
    rmSync(PREVIOUS_APP, { recursive: true, force: true })
    rmSync(STAGE_DIR, { recursive: true, force: true })
    note(`已升级到 DeepSeek Harness ${String(version)}。`)
    upgradeProgress(`已升级到 ${String(version)}，正在打开界面…`)
    return true
  }

  note('新版本无法正常启动，正在回滚…')
  upgradeProgress('新版本无法启动，正在回滚…')
  await stopForUpgrade()
  rmSync(app, { recursive: true, force: true })
  renameSync(PREVIOUS_APP, app)
  if (wasRunning && (await startAndVerify()).ok) recordServerPid()
  rmSync(STAGE_DIR, { recursive: true, force: true })
  note('已回滚到升级前的版本。')
  upgradeProgress('已回滚到升级前的版本。')
  return false
}

/**
 * Prove the freshly swapped release boots, without leaving it running.
 *
 * A cold start offers the upgrade before anything is serving, so the check must
 * not leave a server the caller did not ask for.
 * @returns true only when the swapped-in Harness reached readiness.
 */
async function verifyOnce() {
  const started = (await startAndVerify()).ok
  // The pid file is what lets the stop that follows find and end this server.
  if (started) recordServerPid()
  await stopForUpgrade()
  return started
}

/**
 * Hold the start lock so two simultaneous shortcuts cannot both boot a server.
 *
 * The lock carries its age as well as its owner. A launcher killed mid-start
 * leaves the file behind, and the recorded process id can later belong to an
 * unrelated process, so an old lock is treated as abandoned rather than
 * blocking every future start until the wait times out.
 * @returns the lock handle, or undefined when another start already holds it.
 */
function acquireLock() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = tryCreateLock()
    if (handle !== undefined) return handle
    const [holder, stamp] = readFileSync(LOCK_FILE, 'utf8').split(/\s+/u)
    const age = Date.now() - Number(stamp)
    const abandoned = !Number.isFinite(age) || age > LOCK_STALE_MS || !isAlive(Number(holder))
    if (!abandoned) return undefined
    note(`清理上一次残留的启动锁（进程 ${holder}）。`)
    rmSync(LOCK_FILE, { force: true })
  }
  return undefined
}

/**
 * Create the lock file exclusively.
 * @returns the open handle, or undefined when the file already exists.
 */
function tryCreateLock() {
  try {
    const handle = openSync(LOCK_FILE, 'wx')
    writeFileSync(handle, `${String(process.pid)} ${String(Date.now())}`, 'utf8')
    return handle
  } catch (error) {
    if (error.code === 'EEXIST') return undefined
    throw error
  }
}

/** Release the start lock. */
function releaseLock(handle) {
  if (handle === undefined) return
  closeSync(handle)
  rmSync(LOCK_FILE, { force: true })
}

/** Wait until the Web UI answers, or until the attempt budget runs out. */
async function waitForReady(budgetMs, onLost) {
  const startedAt = Date.now()
  const deadline = startedAt + budgetMs
  let reported = 0
  while (Date.now() < deadline) {
    const answer = await probe(800)
    if (isHarness(answer)) return true
    if (answer !== undefined) return true
    if (onLost?.() === true) return false
    // A line every few seconds is what tells the window the start is alive
    // rather than hung, without burying the module list under timestamps.
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    if (elapsed >= 3 && elapsed - reported >= 3) {
      reported = elapsed
      progress(`等待服务就绪…（已 ${String(elapsed)} 秒）`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

/** Wait until nothing answers on the application port. */
async function waitForStop(budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await probe(600) === undefined) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

/** Print the tail of the Harness server log for a failed start. */
function logTail(lines = 20) {
  if (!existsSync(LOG_FILE)) return '(no server log yet)'
  const content = readFileSync(LOG_FILE, 'utf8').trimEnd().split(/\r?\n/u)
  return content.slice(-lines).join('\n')
}

/** Byte offset the server log currently ends at. */
function logMark() {
  try {
    return statSync(LOG_FILE).size
  } catch {
    // No log yet: the next attempt writes the whole file, so every byte counts.
    return 0
  }
}

/** Read what the server appended since `mark`, or an empty string when it wrote nothing. */
function logSince(mark) {
  try {
    return readFileSync(LOG_FILE).subarray(mark).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Whether the log text ends a boot attempt with an uncaught failure.
 *
 * Node prints its version banner after an uncaught exception, and the boot glue
 * prefixes its own fatal error with the program name. Both mean the server is
 * gone and no further polling can succeed.
 * @param text - the log text this attempt produced.
 * @returns true when the server has already failed fatally.
 */
function isFatalBootOutput(text) {
  return /^Node\.js v\d/mu.test(text) || /^dsh: /mu.test(text)
}

/**
 * Whether a failed boot could not resolve a plugin from the profile directory.
 *
 * This is the one boot failure that leaves the installation itself intact: the
 * packages are present, but the profile's module index pointing at them is
 * missing or stale. It is also the failure the packaged launcher can rebuild on
 * its own.
 * @param text - the log text this attempt produced.
 * @returns true when the profile module index should be discarded and the boot retried.
 */
function isProfileResolutionFailure(text) {
  return /Cannot find package '[^']+' imported from .*profiles/u.test(text)
}

/**
 * Compose the part of a failed boot's log that states the cause.
 *
 * A Cordis boot failure nests one error per loader entry, each with a stack, so
 * the end of the log is closing braces and indentation. The first message lines
 * are what name the reason, and they are what a reader can act on.
 * @param mark - the log offset the failed attempt started at.
 * @returns the cause lines, or the log tail when the attempt logged no message.
 */
function bootFailureDetail(mark) {
  const text = logSince(mark).trimEnd()
  if (text === '') return logTail()
  const lines = text.split(/\r?\n/u)
  const causes = lines.filter(line =>
    /^(?:dsh: |Error: |AggregateError: )/u.test(line) || /Cannot find package /u.test(line))
  const shown = (causes.length > 0 ? causes : lines.slice(-12)).slice(0, 8)
  return `${shown.join('\n')}\n\n完整日志：${LOG_FILE}`
}

/**
 * Discard the profile module index so the next boot rebuilds it.
 *
 * the data directory's `profiles/node_modules` and each profile's `.dsh-module-fallback`
 * hold only links that `dsh` derives from the running installation on every
 * boot, so removing them cannot lose user data — and a link left over from a
 * previous installation directory is the one thing that makes a present plugin
 * unresolvable.
 * @returns the paths that were removed.
 */
function discardProfileModuleFallback() {
  const profiles = join(DATA.path, 'profiles')
  const candidates = [join(profiles, 'node_modules')]
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(profiles, entry.name, '.dsh-module-fallback'))
    }
  } catch {
    // No profiles directory yet means there is no stale index to remove.
  }
  const removed = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    rmSync(candidate, { recursive: true, force: true })
    removed.push(candidate)
  }
  return removed
}

/** Boot the Harness Web UI as a background process. */
async function start() {
  rmSync(ERROR_FILE, { force: true })
  rmSync(BOOT_STATUS_FILE, { force: true })
  progress('开始启动 DeepSeek Harness')

  // The pinned runtime is checked before anything else so a broken install says
  // so, rather than failing later in a way that looks like a Harness bug.
  progress(`检查内置 Node.js 运行时（${BUNDLED_NODE}）`)
  const runtimeIssue = runtimeProblem()
  if (runtimeIssue !== undefined) {
    fail(runtimeIssue)
    return
  }

  if (!existsSync(DSH_ENTRY)) {
    fail('找不到 DeepSeek Harness 程序文件，安装可能不完整。', `缺失：${DSH_ENTRY}`)
    return
  }

  const answer = await probe()
  if (answer !== undefined) {
    if (isHarness(answer)) {
      note('DeepSeek Harness 已在运行，正在打开浏览器。')
      openBrowser()
      return
    }
    fail(`端口 ${String(PORT)} 已被其他程序占用，无法启动 DeepSeek Harness。`, `该端口的响应状态：${String(answer.status)}`)
    return
  }

  const lock = acquireLock()
  if (lock === undefined) {
    note('另一个启动请求正在进行，等待服务就绪。')
    if (await waitForReady(READY_TIMEOUT_MS)) openBrowser()
    else fail('等待已有的启动请求完成时超时。', logTail())
    return
  }

  try {
    note('正在启动 DeepSeek Harness…')
    const splash = showSplash()
    let attempt
    try {
      attempt = await bootWithRepair()
    } finally {
      closeSplash(splash)
    }
    if (!attempt.ok) {
      progress('启动失败，详见错误提示。')
      fail('DeepSeek Harness 启动失败。', bootFailureDetail(attempt.mark))
      return
    }
    note(`DeepSeek Harness 已就绪：${APP_URL}`)
    progress(`启动完成：${APP_URL}`)
    // After readiness is on screen: this lookup starts Windows PowerShell, which
    // costs seconds the user does not have to wait for.
    recordServerPid()
  } finally {
    releaseLock(lock)
  }

  // The upgrade offer runs after the server is up and in its own process, so a
  // prompt the user never answers delays nothing: the application is already
  // usable, and the browser handoff has happened.
  if (CHECK_UPDATES) spawnUpdateNotice()
}

/**
 * Whether the profile's shared module index can actually be read.
 *
 * The index is a directory of junctions into the installation, so a package it
 * names resolves only while the target can be read. Reading one manifest is
 * therefore a direct test of "will the loader be able to resolve anything",
 * which a path existence check cannot answer: the path exists while the file is
 * still unreadable.
 * @returns true when the index is absent (a first run builds it) or readable.
 */
function profileModulesReadable() {
  const modules = join(DATA.path, 'profiles', 'node_modules')
  if (!existsSync(modules)) return true
  const candidates = []
  let entries
  try {
    entries = readdirSync(modules, { withFileTypes: true })
  } catch {
    // An index that cannot even be listed is exactly what this waits for.
    return false
  }
  for (const entry of entries) {
    if (!entry.name.startsWith('@')) {
      candidates.push(join(entry.name, 'package.json'))
      continue
    }
    try {
      for (const scoped of readdirSync(join(modules, entry.name), { withFileTypes: true })) {
        candidates.push(join(entry.name, scoped.name, 'package.json'))
      }
    } catch {
      // A scope that cannot be listed contributes no candidate; the rest do.
    }
  }
  // Any readable manifest proves the index's targets are readable. Naming one
  // package would make a future rename look like a permanently broken index and
  // stall every start for the whole wait budget.
  for (const candidate of candidates.slice(0, 20)) {
    try {
      const manifest = JSON.parse(readFileSync(join(modules, candidate), 'utf8'))
      if (typeof manifest.name === 'string') return true
    } catch {
      // Unreadable entry: try the next one.
    }
  }
  return false
}

/**
 * Wait for an existing module index to become readable before starting.
 *
 * Nothing else in the launcher can rebuild it, so a wait is the only action
 * available — and it is the right one: the index is rebuilt from the running
 * installation whenever the server boots, so a stale one is not the problem, an
 * unreadable one is. If it stays unreadable the index is discarded, which leaves
 * the server to build a fresh one instead of failing the same way again.
 */
async function waitForProfileModules() {
  if (profileModulesReadable()) return
  progress('已安装文件尚未就绪，正在等待…')
  const deadline = Date.now() + PROFILE_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(1000)
    if (profileModulesReadable()) {
      progress('已安装文件就绪，继续启动。')
      return
    }
  }
  const removed = discardProfileModuleFallback()
  progress(`等待超时，已重建插件索引（${String(removed.length)} 个目录）。`)
}

/**
 * Boot the server, rebuilding the profile module index and trying again when the
 * boot failed because a plugin could not be resolved.
 *
 * The first start after an installation is the one that fails this way, and it
 * fails only for a while: measured on the reporting machine, four attempts
 * inside 27 seconds all failed and a launch about a minute later succeeded, so
 * the retries are spread over roughly two minutes instead of back to back.
 * @returns the last attempt's result.
 */
async function bootWithRepair() {
  await waitForProfileModules()
  let attempt = await startAndVerify()
  for (let retry = 0; retry < BOOT_RETRY_DELAYS_MS.length && !attempt.ok; retry += 1) {
    if (!isProfileResolutionFailure(logSince(attempt.mark))) break
    // Let the failed process finish exiting, so the retry cannot collide with it
    // on the port or on the profile it was reading.
    await waitForStop(STOP_TIMEOUT_MS)
    progress(`启动未完成，${String(BOOT_RETRY_DELAYS_MS[retry] / 1000)} 秒后重试（第 ${String(retry + 1)} 次）…`)
    await sleep(BOOT_RETRY_DELAYS_MS[retry])
    discardProfileModuleFallback()
    attempt = await startAndVerify()
  }
  return attempt
}

/**
 * Start the background process that offers an available upgrade.
 *
 * It has to outlive this launcher, which exits as soon as the server is up, so
 * it is only unref'd — not detached, which on Windows would give it the visible
 * console window this whole arrangement exists to avoid.
 */
function spawnUpdateNotice() {
  try {
    const child = spawn(NODE_EXE, [fileURLToPath(import.meta.url), 'notify-update'], {
      cwd: WORK_DIR,
      env: serverEnvironment(),
      windowsHide: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (error) {
    // A missing notice is not worth failing a successful start over.
    note(`无法启动升级提示进程：${String(error)}`)
  }
}

/**
 * Offer an available upgrade in the background, after the application is running.
 *
 * The upgrade itself needs the server stopped, so the notice takes the same
 * start lock: a user double-clicking the shortcut mid-upgrade then waits for the
 * swap to finish instead of racing it.
 */
async function notifyUpdate() {
  const update = await checkForUpdate()
  if (!update.updateAvailable) return
  if (update.declined === update.latest) {
    note(`${String(update.latest)} 已被设置为不再提示，跳过自动检查。`)
    return
  }
  const lock = acquireLock()
  if (lock === undefined) {
    note('另一个启动请求正在进行，本次不提示升级。')
    return
  }
  try {
    const outcome = await offerUpgrade(update)
    if (outcome.status === 'upgraded') note(`已升级到 DeepSeek Harness ${String(update.latest)}。`)
  } finally {
    releaseLock(lock)
  }
}

/**
 * Show a small status window: the application icon, a heading, and the phase the
 * launcher is in right now.
 *
 * Both long operations use it — starting the server and upgrading the release —
 * because both leave the user staring at nothing for minutes otherwise. The
 * window owns no logic: it reads one status line from a file the launcher
 * overwrites, and shows how long it has been up. It closes itself if the launcher
 * dies before removing it, so a crash cannot leave it on screen forever.
 *
 * The window is requested explicitly by the shortcut wrapper rather than
 * inferred from the terminal, because a shortcut launch still has a hidden
 * console attached and would otherwise look interactive.
 * @param options - window title, heading, hint, the status file to read, how long it may stay up, and whether it may be minimized.
 * @returns the window process, or undefined when it could not start.
 */
function showStatusWindow(options) {
  const icon = [join(ROOT, 'assets', 'dsh-256.png'), join(ROOT, 'assets', 'dsh.ico')]
    .find(candidate => existsSync(candidate))
  // A tool-window border shows no minimize button whatever `MinimizeBox` says,
  // so a window that may be minimized needs the ordinary single-line border —
  // and a taskbar button, or minimizing it would leave no way back to it.
  const minimizable = options.minimizable === true
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = ${psLiteral(options.title)}`,
    '$form.Size = New-Object System.Drawing.Size(440, 190)',
    "$form.StartPosition = 'CenterScreen'",
    `$form.FormBorderStyle = ${psLiteral(minimizable ? 'FixedSingle' : 'FixedToolWindow')}`,
    `$form.ShowInTaskbar = $${String(minimizable)}`,
    `$form.MinimizeBox = $${String(minimizable)}`,
    '$form.MaximizeBox = $false',
    '$form.TopMost = $true',
    "$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)",
    // The application's own icon, so the window is recognizably the application
    // rather than a generic dialog; a missing asset just leaves the space empty.
    '$picture = New-Object System.Windows.Forms.PictureBox',
    '$picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom',
    '$picture.SetBounds(20, 22, 40, 40)',
    ...(icon === undefined ? [] : [`try { $picture.Image = [System.Drawing.Image]::FromFile(${psLiteral(icon)}) } catch { }`]),
    '$form.Controls.Add($picture)',
    '$title = New-Object System.Windows.Forms.Label',
    `$title.Text = ${psLiteral(options.heading)}`,
    '$title.SetBounds(70, 22, 350, 26)',
    '$form.Controls.Add($title)',
    '$status = New-Object System.Windows.Forms.Label',
    `$status.Text = ${psLiteral('正在准备…')}`,
    '$status.ForeColor = [System.Drawing.Color]::DimGray',
    '$status.SetBounds(70, 50, 350, 22)',
    '$form.Controls.Add($status)',
    '$hint = New-Object System.Windows.Forms.Label',
    `$hint.Text = ${psLiteral(options.hint)}`,
    '$hint.ForeColor = [System.Drawing.Color]::Gray',
    '$hint.SetBounds(24, 96, 400, 44)',
    '$form.Controls.Add($hint)',
    `$statusFile = ${psLiteral(options.statusFile)}`,
    '$started = Get-Date',
    // The elapsed seconds are the motion here: the icon is a still image, and a
    // number that keeps changing is what says the wait is progressing.
    '$tick = {',
    '  try {',
    '    $text = ""',
    '    if (Test-Path -LiteralPath $statusFile) { $text = [System.IO.File]::ReadAllText($statusFile).Trim() }',
    '    $elapsed = [int]((Get-Date) - $started).TotalSeconds',
    '    $status.Text = if ($text -eq "") { "已等待 $elapsed 秒" } else { "$text（已等待 $elapsed 秒）" }',
    '  } catch { }',
    '}',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 150',
    '$timer.Add_Tick($tick)',
    '$timer.Start()',
    '$tick.Invoke()',
    '$watchdog = New-Object System.Windows.Forms.Timer',
    `$watchdog.Interval = ${String(options.watchdogMs)}`,
    "$watchdog.Add_Tick({ $watchdog.Stop(); $form.Close() })",
    '$watchdog.Start()',
    'if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { }',
  ].join('; ')
  try {
    const child = spawn(process.env.SystemRoot === undefined
      ? 'powershell.exe'
      : join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { stdio: 'ignore', windowsHide: false })
    child.unref()
    return child
  } catch {
    return undefined
  }
}

/**
 * Show the startup window, when this launch asked for one.
 * @returns the window process, or undefined when it is not wanted or could not start.
 */
function showSplash() {
  if (!WANT_SPLASH) return undefined
  return showStatusWindow({
    title: 'DeepSeek Harness',
    heading: '正在启动 DeepSeek Harness，请稍候…',
    hint: '首次启动需要十几秒；完成后会自动打开浏览器。',
    statusFile: BOOT_STATUS_FILE,
    watchdogMs: 300_000,
  })
}

/**
 * Show the upgrade window while a release is downloaded and swapped in.
 *
 * Without it the prompt closes and nothing happens on screen for minutes, which
 * reads as "the upgrade did nothing" even though it is working.
 * @param version - the release being installed.
 * @returns the window process, or undefined when it could not start.
 */
function showUpgradeProgress(version) {
  upgradeProgress(`正在准备升级到 ${String(version)}…`)
  return showStatusWindow({
    title: 'DeepSeek Harness 升级中',
    heading: `正在升级到 DeepSeek Harness ${String(version)}`,
    hint: '升级期间应用仍可继续使用。\n下载并验证完成后会自动重启服务；失败会自动回滚。',
    statusFile: UPGRADE_STATUS_FILE,
    // An upgrade downloads a whole dependency tree, so the window has to outlast
    // a slow source rather than closing on the startup window's budget. It is
    // also the one window worth minimizing: the whole point is that the
    // application keeps working while it runs.
    watchdogMs: 3_600_000,
    minimizable: true,
  })
}

/** Close a status window, if one is showing. */
function closeSplash(splash) {
  if (splash?.pid === undefined) return
  spawnSync('taskkill', ['/PID', String(splash.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

/** Stop the background server this launcher started. */
async function stop() {
  rmSync(ERROR_FILE, { force: true })
  const pid = readTrackedPid()
  const answer = await probe()

  if (pid === undefined || !isAlive(pid)) {
    rmSync(PID_FILE, { force: true })
    if (answer !== undefined && isHarness(answer)) {
      const owner = portOwnerPid()
      if (owner === undefined) {
        fail(
          `端口 ${String(PORT)} 上有一个 DeepSeek Harness，但无法确定它的进程号。`,
          '请在启动它的终端里按 Ctrl+C 结束。',
        )
        return
      }
      note(`正在停止 DeepSeek Harness（进程 ${String(owner)}，由终端启动）…`)
      spawnSync('taskkill', ['/PID', String(owner), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      if (await waitForStop(STOP_TIMEOUT_MS)) note('DeepSeek Harness 已停止。')
      else fail('停止请求已发出，但端口仍在响应。', logTail())
      return
    }
    note('DeepSeek Harness 当前没有运行。')
    return
  }

  note(`正在停止 DeepSeek Harness（进程 ${String(pid)}）…`)
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  rmSync(PID_FILE, { force: true })
  if (await waitForStop(STOP_TIMEOUT_MS)) note('DeepSeek Harness 已停止。')
  else fail('停止请求已发出，但端口仍在响应。', logTail())
}

/** Report what the launcher currently knows about the server and releases. */
async function status() {
  const pid = readTrackedPid()
  const answer = await probe(1200)
  const running = answer !== undefined
  const update = await checkForUpdate()
  note(`地址：${APP_URL}`)
  note(`状态：${running ? '运行中' : '未运行'}`)
  note(`本程序启动的进程：${pid !== undefined && isAlive(pid) ? String(pid) : '无'}`)
  const pinned = pinnedRuntimeVersion()
  const runtimeIssue = runtimeProblem()
  if (pinned === undefined) {
    note(`Node 运行时：未固定（源码安装），使用 ${NODE_EXE}`)
  } else if (runtimeIssue === undefined) {
    note(`Node 运行时：v${pinned}（已固定，随安装包附带）`)
  } else {
    note(`Node 运行时：异常 —— ${runtimeIssue.split('\n')[0]}`)
  }
  note(`已安装版本：${update.installed ?? '未知'}`)
  const live = update.source === 'registry' || update.source === 'cache'
  const latestText = live
    ? String(update.latest)
    : update.latest === undefined ? '未能查询' : `${String(update.latest)}（上次结果，未连上 npm 源）`
  note(`最新版本：${latestText}`)
  note(`可升级：${update.updateAvailable ? `是（${String(update.latest)}）` : '否'}`)
  note(`npm 源：${REGISTRIES.join('  ')}`)
  note(`开机自启：${existsSync(STARTUP_LINK) ? '已开启' : '未开启'}`)
  note(`新会话工作目录：${WORK_DIR}`)
  note(`数据目录：${DATA.path}（${DATA.source}）`)
  note(`程序目录：${ROOT}`)
  note(`日志文件：${LOG_FILE}`)
  if (running && pid === undefined) note('提示：该服务由终端启动，不是由本程序启动。')
}

/**
 * Describe a failed registry lookup, naming every source that was tried.
 * @returns the message and detail used by both the console and the dialog.
 */
function unreachableReport(update) {
  const remembered = update.latest === undefined
    ? ''
    : `\n上次成功查询到的版本：${String(update.latest)}（仅供参考）`
  return {
    message: `当前版本：${String(update.installed)}\n\n无法连接任何 npm 源，暂时查不到最新版本。${remembered}`,
    detail: `已尝试：\n  ${REGISTRIES.join('\n  ')}\n\n请检查网络，或在 config.json 里更换 registries。`,
  }
}

/**
 * Report whether a newer release exists, without changing anything.
 * @param force - query the registries even when a recent answer is cached.
 */
async function check(force = false) {
  const update = await checkForUpdate({ force })
  if (update.installed === undefined) {
    fail('读不到已安装的版本，程序目录可能不完整。', `缺少：${PACKAGE_JSON}`)
    return
  }
  if (update.source === 'bad-channel') {
    const report = badChannelReport(update)
    fail(report.message, report.detail)
    return
  }
  if (update.source === 'stale' || update.source === 'unknown') {
    const report = unreachableReport(update)
    fail(report.message, report.detail)
    return
  }
  note(versionReport(update))
}

/**
 * Compose the version summary every update answer starts with.
 *
 * The channel table is the part that answers "but the releases page shows newer
 * versions": it lists what each published channel currently points at, so a
 * release that exists under `next` or `alpha` is visible instead of being
 * invisible behind the one tag the application happens to follow.
 * @param update - versions reported by `checkForUpdate`.
 * @returns a multi-line report naming the versions, the verdict, and the channels.
 */
function versionReport(update) {
  const verdict = update.updateAvailable
    ? `发现新版本 ${String(update.latest)}，可以升级。`
    : '已是最新版本。'
  const names = Object.keys(update.tags ?? {}).sort()
  const table = names.length === 0
    ? ''
    : `\n\n各发布通道当前版本：\n${names
      .map(name => `  ${name.padEnd(8)}${String(update.tags[name])}${update.tags[name] === update.installed ? '（当前）' : ''}`)
      .join('\n')}`
  return `当前版本：${String(update.installed)}\n`
    + `升级通道：${String(update.channel)}（解析为 ${String(update.latest)}）\n\n${verdict}${table}\n\n`
    + '换通道：改 config.json 的 channel —— newest（最新发布）/ latest / next / alpha，或某个具体版本号。'
}

/**
 * Answer an unrecognised channel without pretending a version was resolved.
 * @param update - the `bad-channel` answer from `checkForUpdate`.
 * @returns the message and detail used by both the console and the dialog.
 */
function badChannelReport(update) {
  const names = Object.keys(update.tags ?? {}).sort()
  const options = names.length === 0 ? '（未能读到任何通道）' : names.join('、')
  return {
    message: `config.json 里的 channel 无法识别：${String(update.channel)}`,
    detail: `可选值：newest、${options}，或一个已发布的具体版本号。\n\n` +
      `可用的通道版本：\n${names.map(name => `  ${name.padEnd(8)}${String(update.tags[name])}`).join('\n')}`,
  }
}

/**
 * Upgrade to the newest release on the configured channel, asking first.
 * @param assumeYes - skip the confirmation question, for unattended upgrades.
 */
async function update(assumeYes = false) {
  // Upgrading shells out through the pinned runtime, so a broken one has to be
  // reported here rather than surfacing later as a download failure.
  const runtimeIssue = runtimeProblem()
  if (runtimeIssue !== undefined) {
    fail(runtimeIssue)
    return
  }
  const updateState = await checkForUpdate({ force: true })
  if (updateState.installed === undefined) {
    fail('读不到已安装的版本，程序目录可能不完整。', `缺少：${PACKAGE_JSON}`)
    return
  }
  if (updateState.source === 'bad-channel') {
    const report = badChannelReport(updateState)
    fail(report.message, report.detail)
    return
  }
  if (updateState.source === 'stale' || updateState.source === 'unknown') {
    const report = unreachableReport(updateState)
    fail(report.message, report.detail)
    return
  }
  const report = versionReport(updateState)
  if (!updateState.updateAvailable) {
    note(report)
    return
  }
  const outcome = await offerUpgrade(updateState, assumeYes)
  if (outcome.status === 'upgraded') {
    note(`${report}\n\n升级完成，已更新到 ${String(updateState.latest)}。`)
    return
  }
  if (outcome.status === 'later') {
    note(`${report}\n\n已跳过本次升级，当前仍是 ${String(updateState.installed)}。`)
    return
  }
  if (outcome.status === 'suppressed') {
    note(`${report}\n\n已设置不再提示该版本，当前仍是 ${String(updateState.installed)}。`)
    return
  }
  note(`${report}\n\n升级失败，已回滚，当前仍是 ${String(updateState.installed)}。`)
  process.exitCode = 1
}

/**
 * Turn the startup entry on or off, or report its state.
 * @param action - `on`, `off`, or `status`.
 */
function autostart(action) {
  const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
  const icon = join(ROOT, 'assets', 'dsh.ico')
  const vbs = join(BIN_DIR, 'start.vbs')
  if (action === 'on') {
    const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psLiteral(STARTUP_LINK)}); `
      + `$s.TargetPath = ${psLiteral(wscript)}; `
      + `$s.Arguments = ${psLiteral(`"${vbs}"`)}; `
      + `$s.WorkingDirectory = ${psLiteral(ROOT)}; `
      + `$s.IconLocation = ${psLiteral(`${icon},0`)}; `
      + `$s.Description = ${psLiteral('DeepSeek Harness')}; `
      + '$s.Save()'
    if (runPowerShell(script).status !== 0) {
      fail('创建开机自启快捷方式失败。', '请确认当前用户对「启动」文件夹有写入权限。')
      return
    }
    note('已开启开机自动启动。')
    return
  }
  if (action === 'off') {
    rmSync(STARTUP_LINK, { force: true })
    note('已关闭开机自动启动。')
    return
  }
  if (action !== undefined && action !== 'status') {
    fail(`无法识别的自启参数：${String(action)}`, '用法：dsh.cmd autostart on|off|status')
    return
  }
  note(`开机自启：${existsSync(STARTUP_LINK) ? '已开启' : '未开启'}`)
}

/** Print the server log path and its most recent lines. */
function logs() {
  note(`日志文件：${LOG_FILE}`)
  if (existsSync(LOG_FILE)) process.stdout.write(`${logTail(40)}\n`)
  else note('尚无日志。')
}

/** Run the server in the foreground for troubleshooting. */
function runInForeground() {
  note('前台运行 DeepSeek Harness，按 Ctrl+C 结束。')
  ensurePreinstalledPlugins()
  const result = spawnSync(NODE_EXE, [DSH_ENTRY, 'web', '--port', String(PORT)], {
    cwd: WORK_DIR,
    env: serverEnvironment(),
    stdio: 'inherit',
    windowsHide: false,
  })
  process.exitCode = result.status ?? 0
}

/** Ensure a server is running, then open it in the browser. */
async function open() {
  if (await probe() === undefined) await start()
  else openBrowser()
  if (existsSync(ERROR_FILE)) process.exitCode = 1
}

/** Total bytes and file count below one directory, skipping linked entries. */
function directoryUsage(dir) {
  let bytes = 0
  let files = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) { files += 1; bytes += statSync(path).size }
    }
  }
  try {
    walk(dir)
  } catch {
    // A directory that disappears mid-walk still leaves a useful partial count.
  }
  return { bytes, files }
}

/** Human-readable size for the data report. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Report where the application keeps the user's data.
 *
 * Sessions, settings, credentials, attachments and the profile all live under
 * one directory, and this command exists because "where is my data" should never
 * require reading the source. `data open` reveals the same directory in Explorer.
 * @param action - `open` to reveal the directory, anything else to only report it.
 */
function data(action) {
  note(`数据目录：${DATA.path}`)
  note(`来源：${DATA.source}`)
  if (!existsSync(DATA.path)) {
    note('状态：尚未创建（首次启动时自动建立）')
    return
  }
  const usage = directoryUsage(DATA.path)
  note(`状态：已存在，${formatBytes(usage.bytes)} / ${String(usage.files)} 个文件`)
  const children = readdirSync(DATA.path, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => entry.name)
  if (children.length > 0) note(`子目录：${children.join('、')}`)
  note(`同级文件：settings.yaml（设置）、.credentials.yaml（API Key）、.anonymous-user-id`)
  note(`决定位置的地方：${CONFIG_FILE} 的 dataDirectory（留空则用 %USERPROFILE%\\.dsh）`)
  if (action === 'open') {
    spawn('explorer.exe', [DATA.path], { stdio: 'ignore', windowsHide: false }).unref()
  }
}

/** `--yes` / `-y` answers the upgrade question in advance. */
const UNATTENDED = process.argv.slice(3).some(argument => argument === '--yes' || argument === '-y')
/** `--splash` asks for the startup window, which only a shortcut launch wants. */
const WANT_SPLASH = process.argv.slice(2).includes('--splash')

const COMMANDS = {
  start: async () => { await start() },
  stop,
  restart: async () => { await stop(); await start() },
  status,
  data: async () => { data(process.argv[3]) },
  open,
  logs: async () => { logs() },
  console: async () => { runInForeground() },
  check: async () => { await check(true) },
  update: async () => { await update(UNATTENDED) },
  'notify-update': notifyUpdate,
  autostart: async () => { autostart(process.argv[3]) },
}

const command = process.argv[2] ?? 'start'
const handler = COMMANDS[command]
if (handler === undefined) {
  process.stderr.write(`未知命令：${command}\n可用命令：${Object.keys(COMMANDS).join(', ')}\n`)
  process.exitCode = 2
} else {
  await handler()
  process.exit(process.exitCode ?? 0)
}

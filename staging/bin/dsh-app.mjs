/**
 * One-click lifecycle host for the locally installed DeepSeek Harness Web UI.
 *
 * The Harness ships as a command-line program. This script turns that program
 * into a launchable local application: it boots `dsh web` as a detached
 * background process, waits until the Web UI answers, and reports where it
 * runs. Because `dsh web` mints the browser session cookie itself, this script
 * never opens a URL it cannot authenticate — a cold start lets the Harness
 * perform its own authenticated browser handoff, and a warm start reuses the
 * cookie the browser already holds.
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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(BIN_DIR)
const DSH_ENTRY = join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const BUNDLED_NODE = join(ROOT, 'runtime', 'node', 'node.exe')
const LOGS = join(ROOT, 'logs')
const RUN = join(ROOT, 'run')
const LOG_FILE = join(LOGS, 'dsh-web.log')
const ERROR_FILE = join(LOGS, 'launcher.error.txt')
const RESULT_FILE = join(LOGS, 'launcher.result.txt')
const LOCK_FILE = join(RUN, 'start.lock')
const CONFIG_FILE = join(ROOT, 'config.json')

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

const CONFIG = readConfig()
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
 * A distributed package carries its own runtime so the receiving machine needs
 * nothing preinstalled, and so every machine runs the same Node version the
 * packaged dependencies were installed for. A source checkout without that
 * directory falls back to whichever Node started this launcher.
 */
const NODE_EXE = existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath

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
}

/** Sleep for a fixed interval without holding a timer beyond it. */
function sleep(milliseconds) {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
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
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
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
 * Read one registry's version for the configured channel.
 *
 * The abbreviated packument keeps the request small; the Harness has hundreds
 * of published versions and the full document is far larger than needed.
 * @param registry - registry origin to query.
 * @param timeoutMs - request budget.
 * @returns the channel's version, or undefined when this registry cannot answer.
 */
async function fetchChannelVersion(registry, timeoutMs = 8_000) {
  try {
    const url = `${registry}/@deepseek-ai%2Fdsh`
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const packument = await response.json()
    const version = packument?.['dist-tags']?.[CHANNEL]
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask every registry at once and keep the newest release any of them reports.
 *
 * Querying in parallel means one slow or unreachable registry costs nothing,
 * and taking the maximum means a mirror that has not synchronized yet cannot
 * make the application claim it is already current. The origins that answered
 * are returned too: they are the only ones an install should try, because a
 * registry that cannot answer a metadata request cannot serve tarballs either.
 * @returns the newest version, the registry that reported it, and the responders.
 */
async function resolveLatest() {
  const answers = await Promise.all(REGISTRIES.map(async (registry) => {
    const version = await fetchChannelVersion(registry)
    return version === undefined ? undefined : { registry, version }
  }))
  const reachable = answers.filter(answer => answer !== undefined)
  if (reachable.length === 0) return undefined
  const newest = reachable.reduce(
    (best, answer) => compareVersions(answer.version, best.version) > 0 ? answer : best,
  )
  return {
    version: newest.version,
    registry: newest.registry,
    reachable: reachable.map(answer => answer.registry),
  }
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
  const verdict = (latest, registry, source, reachable = []) => ({
    installed,
    latest,
    registry,
    source,
    reachable,
    declined,
    updateAvailable: source !== 'stale' && source !== 'unknown'
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
  if (resolved !== undefined) {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ ...state, checkedAt: Date.now(), latest: resolved.version, registry: resolved.registry }, null, 2),
      'utf8',
    )
    return verdict(resolved.version, resolved.registry, 'registry', resolved.reachable)
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
  const body = `当前版本：${String(update.installed)}\n\n`
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
  return {
    status: await upgradeTo(update.latest, update.registry, update.reachable) ? 'upgraded' : 'failed',
  }
}

/** Run one npm command with the packaged runtime, showing its own progress. */
function runNpm(args) {
  const command = existsSync(NPM_CLI)
    ? { file: NODE_EXE, args: [NPM_CLI, ...args] }
    : { file: 'npm.cmd', args }
  return spawnSync(command.file, command.args, {
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
  const failures = []
  for (const registry of order) {
    rmSync(STAGE_DIR, { recursive: true, force: true })
    mkdirSync(STAGE_DIR, { recursive: true })
    note(`  从 ${registry} 下载…`)
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
    return true
  }
  note(`所有 npm 源都下载失败：\n  ${failures.join('\n  ')}`)
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
 * Boot the installed Harness and confirm it answers.
 * @returns true only when the Web UI becomes reachable.
 */
async function startAndVerify() {
  const out = openSync(LOG_FILE, 'a')
  const child = spawn(NODE_EXE, [DSH_ENTRY, 'web', '--port', String(PORT)], {
    cwd: WORK_DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, DSH_WEB_APP_LAUNCHER: '1' },
  })
  closeSync(out)
  if (child.pid === undefined) return false
  let exited = false
  child.once('exit', () => { exited = true })
  writeFileSync(PID_FILE, String(child.pid), 'utf8')
  child.unref()
  return await waitForReady(READY_TIMEOUT_MS, () => exited)
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
  await stopForUpgrade()

  rmSync(PREVIOUS_APP, { recursive: true, force: true })
  const app = join(ROOT, 'app')
  try {
    renameSync(app, PREVIOUS_APP)
    renameSync(STAGE_APP, app)
  } catch (error) {
    note(`替换程序目录失败：${String(error)}`)
    if (!existsSync(app) && existsSync(PREVIOUS_APP)) renameSync(PREVIOUS_APP, app)
    rmSync(STAGE_DIR, { recursive: true, force: true })
    return false
  }

  note(`已安装 ${String(version)}，正在验证…`)
  const healthy = wasRunning ? await startAndVerify() : await verifyOnce()
  if (healthy) {
    rmSync(PREVIOUS_APP, { recursive: true, force: true })
    rmSync(STAGE_DIR, { recursive: true, force: true })
    note(`已升级到 DeepSeek Harness ${String(version)}。`)
    return true
  }

  note('新版本无法正常启动，正在回滚…')
  await stopForUpgrade()
  rmSync(app, { recursive: true, force: true })
  renameSync(PREVIOUS_APP, app)
  if (wasRunning) await startAndVerify()
  rmSync(STAGE_DIR, { recursive: true, force: true })
  note('已回滚到升级前的版本。')
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
  const started = await startAndVerify()
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
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const answer = await probe(800)
    if (isHarness(answer)) return true
    if (answer !== undefined) return true
    if (onLost?.() === true) return false
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

/** Boot the Harness Web UI as a detached background process. */
async function start() {
  rmSync(ERROR_FILE, { force: true })

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
    if (!await startAndVerify()) {
      fail('DeepSeek Harness 启动失败。', logTail())
      return
    }
    note(`DeepSeek Harness 已就绪：${APP_URL}`)
  } finally {
    releaseLock(lock)
  }

  // The upgrade offer runs after the server is up and in its own process, so a
  // prompt the user never answers delays nothing: the application is already
  // usable, and the browser handoff has happened.
  if (CHECK_UPDATES) spawnUpdateNotice()
}

/**
 * Start the background process that offers an available upgrade.
 *
 * It is detached because this launcher exits as soon as the server is up; the
 * notice has to outlive it to keep its dialog on screen.
 */
function spawnUpdateNotice() {
  try {
    const child = spawn(NODE_EXE, [fileURLToPath(import.meta.url), 'notify-update'], {
      cwd: WORK_DIR,
      detached: true,
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
  if (update.source === 'stale' || update.source === 'unknown') {
    const report = unreachableReport(update)
    fail(report.message, report.detail)
    return
  }
  note(versionReport(update))
}

/**
 * Compose the version summary every update answer starts with.
 * @param update - versions reported by `checkForUpdate`.
 * @returns a multi-line report naming both versions and the verdict.
 */
function versionReport(update) {
  const verdict = update.updateAvailable
    ? `发现新版本 ${String(update.latest)}，可以升级。`
    : '已是最新版本。'
  return `当前版本：${String(update.installed)}\n最新版本：${String(update.latest)}\n\n${verdict}`
}

/**
 * Upgrade to the newest release on the configured channel, asking first.
 * @param assumeYes - skip the confirmation question, for unattended upgrades.
 */
async function update(assumeYes = false) {
  const updateState = await checkForUpdate({ force: true })
  if (updateState.installed === undefined) {
    fail('读不到已安装的版本，程序目录可能不完整。', `缺少：${PACKAGE_JSON}`)
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
  const result = spawnSync(NODE_EXE, [DSH_ENTRY, 'web', '--port', String(PORT)], {
    cwd: WORK_DIR,
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

/** `--yes` / `-y` answers the upgrade question in advance. */
const UNATTENDED = process.argv.slice(3).some(argument => argument === '--yes' || argument === '-y')

const COMMANDS = {
  start: async () => { await start() },
  stop,
  restart: async () => { await stop(); await start() },
  status,
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

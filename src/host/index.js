/**
 * Host half of the dsh-restart bundle.
 *
 * Every path is derived at runtime instead of being hardcoded:
 * - the plugin directory comes from import.meta.url;
 * - the app executable and process name come from process.execPath;
 * - runtime scripts, logs and markers go to a per-user temp directory.
 *
 * The host lives inside the desktop app's process job, so a classic child
 * process is killed together with the app before it can start the next
 * instance. The relauncher therefore asks the WMI service to create a
 * detached wscript process outside that job; wscript then runs the generated
 * PowerShell helper with no console window.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, extname, join } from 'node:path'
import os from 'node:os'

const ROUTE_PATH = '/plugins/dsh-restart/restart'
const RELAUNCH_DELAY_MS = 600
const PS_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

const HERE = dirname(fileURLToPath(import.meta.url))

function pickRuntimeDir() {
  const candidates = [
    join(os.tmpdir(), 'dsh-restart'),
    join(HERE, '.runtime'),
    join(os.homedir(), '.dsh-restart'),
  ]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, '.write-probe')
      writeFileSync(probe, 'ok')
      rmSync(probe, { force: true })
      return dir
    } catch {
      // Try the next candidate.
    }
  }
  return candidates[0]
}

const RUNTIME_DIR = pickRuntimeDir()
const LOG_PATH = join(RUNTIME_DIR, 'restart.log')
const MARKER_PATH = join(RUNTIME_DIR, 'restart-marker.txt')
const PS1_PATH = join(RUNTIME_DIR, 'relaunch.ps1')
const VBS_PATH = join(RUNTIME_DIR, 'relaunch.vbs')

const EXE_PATH = process.execPath
const PROCESS_NAME = basename(EXE_PATH, extname(EXE_PATH))
const APP_DIR = dirname(EXE_PATH)
const IS_DESKTOP = Boolean(process.versions && process.versions.electron)
  && !/^electron(\.exe)?$/i.test(basename(EXE_PATH))

function log(line) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging must never break the route.
  }
}

function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

/** Regenerate the helper scripts with the current exe/process/log paths. */
function ensureScripts() {
  mkdirSync(RUNTIME_DIR, { recursive: true })
  const ps1 = [
    `$log = '${psQuote(LOG_PATH)}'`,
    'function Log($m) {',
    "  Add-Content -Path $log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' relaunch-helper ' + $m)",
    '}',
    '',
    "Log 'start'",
    'Start-Sleep -Seconds 2',
    "Log 'killing'",
    `Get-Process '${psQuote(PROCESS_NAME)}' -ErrorAction SilentlyContinue | Stop-Process -Force`,
    'Start-Sleep -Milliseconds 1500',
    "Log 'starting'",
    `Start-Process -FilePath '${psQuote(EXE_PATH)}' -WorkingDirectory '${psQuote(APP_DIR)}'`,
    'Start-Sleep -Seconds 3',
    `if (Get-Process '${psQuote(PROCESS_NAME)}' -ErrorAction SilentlyContinue) {`,
    "  Log 'app running'",
    '} else {',
    "  Log 'app not running after start'",
    '}',
    '',
  ].join('\r\n')
  // UTF-8 BOM: Windows PowerShell 5.1 otherwise reads script files as ANSI,
  // which mangles non-ASCII user names and install paths.
  writeFileSync(PS1_PATH, `\ufeff${ps1}`, 'utf8')

  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${PS1_PATH}""", 0, False`,
    '',
  ].join('\r\n')
  // Windows Script Host reads UTF-16LE with a BOM reliably; plain UTF-8 does
  // not survive non-ASCII paths.
  writeFileSync(
    VBS_PATH,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]),
  )
}

function spawnViaWmi(innerCommand, tag) {
  const escaped = String(innerCommand).replace(/'/g, "''")
  const script = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}' }`
  log(`${tag} wmi`)
  try {
    const child = spawn(
      PS_PATH,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { stdio: 'ignore', windowsHide: true },
    )
    child.on('error', error => log(`${tag} error ${error && error.message}`))
    child.on('exit', (code, signal) => log(`${tag} exit ${code} ${signal}`))
    log(`${tag} launcher pid ${child.pid}`)
  } catch (error) {
    log(`${tag} throw ${error && error.message}`)
  }
}

function relaunchWithPowerShell() {
  spawnViaWmi(`C:\\Windows\\System32\\wscript.exe //nologo "${VBS_PATH}"`, 'relaunch')
}

function scheduleRestart() {
  const timer = setTimeout(() => {
    relaunchWithPowerShell()
  }, RELAUNCH_DELAY_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return 'powershell'
}

export const inject = ['webServer']

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function sameOrigin(req, origin) {
  const header = req.headers.origin
  if (!header) return true
  return header === origin
}

export function apply(ctx) {
  ensureScripts()
  log(`loaded here=${HERE} exe=${EXE_PATH} name=${PROCESS_NAME} runtime=${RUNTIME_DIR} desktop=${IS_DESKTOP}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    async handler(req, res) {
      const method = String(req.method || 'GET').toUpperCase()
      if (method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, reason: 'method' })
        return
      }

      if (!sameOrigin(req, ctx.webServer.getOrigin())) {
        sendJson(res, 403, { ok: false, reason: 'origin' })
        return
      }

      if (String(req.headers['x-dsh-restart'] || '') !== '1') {
        sendJson(res, 400, { ok: false, reason: 'missing-header' })
        return
      }

      log(`hit ${method} ${String(req.url || '')}`)

      if (String(req.url || '').includes('dry=1')) {
        spawnViaWmi(
          `powershell.exe -NoProfile -Command "'ok' | Out-File -FilePath '${MARKER_PATH}' -Encoding utf8"`,
          'dry',
        )
        sendJson(res, 200, { ok: true, dry: true })
        return
      }

      if (!IS_DESKTOP) {
        log('refused: not a desktop executable')
        sendJson(res, 409, { ok: false, reason: 'not-desktop' })
        return
      }

      const transport = scheduleRestart()
      sendJson(res, 200, { ok: true, method: transport })
    },
  }))
}

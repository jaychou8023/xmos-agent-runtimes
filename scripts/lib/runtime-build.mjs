import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import extractZip from 'extract-zip'

export const projectRoot = resolve(import.meta.dirname, '../..')
export const xmosBuildCacheRoot = resolve(process.env.XMOS_BUILD_CACHE || join(homedir(), '.cache', 'xmos-build'))

export function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`)
    const key = item.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    result[key] = value
    index += 1
  }
  return result
}

export async function pathExists(path) {
  try { await access(path); return true } catch { return false }
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

export async function readRuntimeLock(path = resolve(projectRoot, 'runtimes/runtime-sources.lock.json')) {
  const lockPath = resolve(path)
  const raw = await readFile(lockPath, 'utf8')
  const lock = JSON.parse(raw)
  if (lock.schemaVersion !== 'xmos-runtime-sources/1') throw new Error(`Unsupported runtime source lock: ${lock.schemaVersion}`)
  return { lock, lockPath, lockSha256: createHash('sha256').update(raw).digest('hex') }
}

export async function verifySha256(path, expected, label = basename(path)) {
  const actual = await sha256File(path)
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`)
  return actual
}

export async function downloadLockedArtifact(spec, cacheRoot) {
  await mkdir(cacheRoot, { recursive: true })
  const target = resolve(cacheRoot, spec.file)
  if (await pathExists(target)) {
    await verifySha256(target, spec.sha256, spec.file)
    return target
  }
  const temporary = `${target}.partial-${process.pid}`
  await rm(temporary, { force: true })
  const response = await fetch(spec.url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed ${response.status}: ${spec.url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(temporary, bytes, { mode: 0o600 })
  await verifySha256(temporary, spec.sha256, spec.file)
  await rename(temporary, target)
  return target
}

export async function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let stdout = ''
    let stderr = ''
    if (options.capture) {
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
    }
    child.on('error', rejectPromise)
    child.on('exit', code => {
      if (code === 0) resolvePromise({ stderr, stdout })
      else rejectPromise(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

export async function extractArchive(archivePath, destination) {
  await rm(destination, { force: true, recursive: true })
  await mkdir(destination, { recursive: true })
  if (/\.(?:zip|whl)$/i.test(archivePath)) {
    await extractZip(archivePath, { dir: destination })
    return
  }
  await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archivePath, '-C', destination])
}

export function hostRuntimePlatform() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64'
  return `${process.platform}-${process.arch}`
}

export async function assertDirectory(path, label) {
  const value = await stat(path)
  if (!value.isDirectory()) throw new Error(`${label} must be a directory: ${path}`)
  return path
}

export async function writeBuildMetadata(output, { licenses, provenance, sbom }) {
  const root = resolve(output, '.xmos-build')
  await mkdir(resolve(root, 'licenses'), { recursive: true })
  for (const [name, source] of Object.entries(licenses)) {
    const content = await readFile(source)
    await writeFile(resolve(root, 'licenses', name), content)
  }
  await writeFile(resolve(root, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
  await writeFile(resolve(root, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8')
}

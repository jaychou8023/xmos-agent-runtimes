import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

export const ignoredArtifactNames = new Set([
  '.DS_Store',
  '__MACOSX',
  '.pytest_cache',
  '__pycache__',
])

export async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

export async function sha256(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

export async function listFiles(root, prefix = '', options = {}) {
  const files = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) {
    if (ignoredArtifactNames.has(entry.name)) continue
    const child = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(root, child, options))
    else if (entry.isFile()) files.push(child)
    else if (entry.isSymbolicLink() && options.skipSymbolicLinks) continue
    else throw new Error(`Unsupported source entry: ${child}`)
  }
  return files
}

export async function directoryStats(root) {
  let bytes = 0
  let files = 0
  if (!(await exists(root))) return { bytes, files }
  for (const relativePath of await listFiles(root, '', { skipSymbolicLinks: true })) {
    bytes += (await stat(join(root, relativePath))).size
    files += 1
  }
  return { bytes, files }
}

export async function copyFilteredTree(source, destination) {
  await rm(destination, { force: true, recursive: true })
  await mkdir(destination, { recursive: true })
  for (const relativePath of await listFiles(source)) {
    const target = join(destination, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(source, relativePath), target, { preserveTimestamps: true })
  }
}

export async function copyFileWithParents(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { preserveTimestamps: true })
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export function relativeTo(root, path) {
  return relative(resolve(root), resolve(path)).split('\\').join('/')
}

export async function removeIfExists(path) {
  if (await exists(path)) await rm(path, { force: true, recursive: true })
}

export async function assertRegularFile(path, label = path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
}

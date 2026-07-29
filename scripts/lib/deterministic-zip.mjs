import { deflateRawSync } from 'node:zlib'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const UTF8_FLAG = 0x0800
const ZIP_VERSION = 20
const UNIX_VERSION = (3 << 8) | ZIP_VERSION
const MAX_UINT16 = 0xffff
const MAX_UINT32 = 0xffffffff

const crcTable = new Uint32Array(256)
for (let value = 0; value < 256; value += 1) {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  crcTable[value] = crc >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function fixedDate(sourceDateEpoch) {
  const epoch = Number(sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH ?? 1577836800)
  const date = new Date(Math.max(epoch, 315532800) * 1000)
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()))
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2)
  return { dosDate, dosTime }
}

async function listFiles(root, prefix = '') {
  const files = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(root, relative))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`ZIP source contains unsupported entry: ${relative}`)
  }
  return files
}

function localHeader(entry, name) {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(ZIP_VERSION, 4)
  header.writeUInt16LE(UTF8_FLAG, 6)
  header.writeUInt16LE(entry.method, 8)
  header.writeUInt16LE(entry.dosTime, 10)
  header.writeUInt16LE(entry.dosDate, 12)
  header.writeUInt32LE(entry.crc, 14)
  header.writeUInt32LE(entry.compressedSize, 18)
  header.writeUInt32LE(entry.size, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return header
}

function centralHeader(entry, name) {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(UNIX_VERSION, 4)
  header.writeUInt16LE(ZIP_VERSION, 6)
  header.writeUInt16LE(UTF8_FLAG, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(entry.dosTime, 12)
  header.writeUInt16LE(entry.dosDate, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.compressedSize, 20)
  header.writeUInt32LE(entry.size, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE((entry.mode << 16) >>> 0, 38)
  header.writeUInt32LE(entry.offset, 42)
  return header
}

export async function createDeterministicZip(sourceRoot, outputPath, options = {}) {
  const files = await listFiles(sourceRoot)
  if (files.length > MAX_UINT16) throw new Error('ZIP64 is not supported: too many entries')
  const { dosDate, dosTime } = fixedDate(options.sourceDateEpoch)
  const localParts = []
  const entries = []
  let offset = 0
  for (const relative of files) {
    if (relative.includes('\\')) throw new Error(`ZIP entry must use POSIX separators: ${relative}`)
    const sourcePath = join(sourceRoot, relative)
    const sourceStat = await stat(sourcePath)
    const data = await readFile(sourcePath)
    const compressed = deflateRawSync(data, { level: 9 })
    const useCompression = compressed.length < data.length
    const body = useCompression ? compressed : data
    if (data.length > MAX_UINT32 || body.length > MAX_UINT32 || offset > MAX_UINT32) {
      throw new Error(`ZIP64 is not supported: ${relative}`)
    }
    const name = Buffer.from(relative, 'utf8')
    const executable = (sourceStat.mode & 0o111) !== 0
    const entry = {
      compressedSize: body.length,
      crc: crc32(data),
      dosDate,
      dosTime,
      method: useCompression ? 8 : 0,
      mode: executable ? 0o100755 : 0o100644,
      offset,
      size: data.length,
    }
    const header = localHeader(entry, name)
    localParts.push(header, name, body)
    offset += header.length + name.length + body.length
    entries.push({ entry, name })
  }
  const centralOffset = offset
  const centralParts = []
  let centralSize = 0
  for (const item of entries) {
    const header = centralHeader(item.entry, item.name)
    centralParts.push(header, item.name)
    centralSize += header.length + item.name.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, Buffer.concat([...localParts, ...centralParts, end]))
}

export const deterministicZipInternals = { crc32, listFiles }

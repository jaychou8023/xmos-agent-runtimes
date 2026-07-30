import { spawnSync } from 'node:child_process'
import { stdin as input, stdout as output } from 'node:process'

export const releaseCatalogSchemaVersion = 'xmos-runtime-catalog/1'
export const supportedPlatforms = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']

export function normalizeRuntimePrefix(value = 'runtimes') {
  const normalized = String(value || 'runtimes').trim().replace(/^\/+|\/+$/g, '')
  return normalized || 'runtimes'
}

export function parsePublishArgs(argv) {
  const result = {
    runtime: 'all',
    endpoint: 'https://s3.sgcc.zip',
    bucket: 'xmos',
    prefix: 'runtimes',
    region: 'us-east-1',
    dryRun: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--dry-run') {
      result.dryRun = true
      continue
    }
    if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`)
    const key = item.slice(2)
    if (key === 'secret-key' || key === 'minio-secret-key') {
      throw new Error('不要通过命令行传入 MinIO secretKey；请使用环境变量、macOS Keychain 或隐藏输入')
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    result[key.replaceAll('-', '_')] = value
    index += 1
  }

  return {
    ...result,
    prefix: normalizeRuntimePrefix(result.prefix),
  }
}

export function runtimeReleaseTargets(lock, runtime = 'all') {
  const targets = []
  const include = new Set(runtime === 'all'
    ? ['aion-cli', 'hermes-lite', 'hermes-max']
    : String(runtime).split(',').map(item => item.trim()).filter(Boolean))

  if (include.has('aion-cli')) {
    const version = lock.aionCli.artifactVersion || lock.aionCli.version
    for (const platform of supportedPlatforms) {
      targets.push({
        runtimeSlug: 'aion-cli',
        packageRuntime: 'aion-cli',
        runtimeId: lock.aionCli.runtimeId,
        displayName: 'Aion CLI',
        edition: null,
        version,
        platform,
        runtimeEntry: platform === 'win32-x64' ? 'aioncore.exe' : 'aioncore',
        filename: `xmos.aion-cli-${version}-${platform}.zip`,
      })
    }
  }

  if (include.has('hermes-lite')) {
    const version = lock.hermes.artifactVersions.lite
    for (const platform of supportedPlatforms) {
      targets.push({
        runtimeSlug: 'hermes-lite',
        packageRuntime: 'hermes',
        runtimeId: lock.hermes.runtimeId,
        displayName: 'Hermes Lite',
        edition: 'lite',
        version,
        platform,
        runtimeEntry: lock.hermes.python?.platforms?.[platform]?.entry?.replace(/^python[\\/]/, 'python/') || 'python/bin/python3',
        filename: `xmos.hermes-lite-${version}-${platform}.zip`,
      })
    }
  }

  if (include.has('hermes-max')) {
    const platform = 'darwin-arm64'
    const version = lock.hermes.artifactVersions.max
    targets.push({
      runtimeSlug: 'hermes-max',
      packageRuntime: 'hermes',
      runtimeId: lock.hermes.runtimeId,
      displayName: 'Hermes Max',
      edition: 'max',
      version,
      platform,
      runtimeEntry: lock.hermes.python?.platforms?.[platform]?.entry?.replace(/^python[\\/]/, 'python/') || 'python/bin/python3',
      filename: `xmos.hermes-max-${version}-${platform}.zip`,
    })
  }

  for (const requested of include) {
    if (!['aion-cli', 'hermes-lite', 'hermes-max'].includes(requested)) {
      throw new Error(`Unsupported --runtime: ${requested}`)
    }
  }
  return targets
}

function catalogKey(release) {
  return `${release.runtimeSlug}:${release.version}`
}

export function mergeRuntimeCatalog(previousCatalog, { bucket, prefix, source, entries }) {
  const grouped = new Map()
  for (const release of previousCatalog?.releases || []) {
    grouped.set(catalogKey(release), {
      runtimeSlug: release.runtimeSlug,
      runtimeId: release.runtimeId,
      displayName: release.displayName,
      edition: release.edition ?? null,
      version: release.version,
      platforms: [...(release.platforms || [])],
    })
  }

  for (const entry of entries) {
    const key = `${entry.runtimeSlug}:${entry.version}`
    const release = grouped.get(key) || {
      runtimeSlug: entry.runtimeSlug,
      runtimeId: entry.runtimeId,
      displayName: entry.displayName,
      edition: entry.edition ?? null,
      version: entry.version,
      platforms: [],
    }
    release.platforms = release.platforms.filter(platform => platform.platform !== entry.platform.platform)
    release.platforms.push(entry.platform)
    release.platforms.sort((left, right) => left.platform.localeCompare(right.platform, 'en'))
    grouped.set(key, release)
  }

  return {
    schemaVersion: releaseCatalogSchemaVersion,
    generatedAt: new Date().toISOString(),
    bucket,
    prefix: normalizeRuntimePrefix(prefix),
    source,
    releases: [...grouped.values()].sort((left, right) => `${left.runtimeSlug}:${left.version}`.localeCompare(`${right.runtimeSlug}:${right.version}`, 'en')),
  }
}

export function requireGhAuthentication({ skip = false } = {}) {
  if (skip) return
  const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error('请先在本机执行 gh auth login 完成 GitHub 手动认证后再发布 Runtime release')
  }
}

async function promptHidden(question) {
  if (!input.isTTY) return ''
  output.write(question)
  input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')
  let value = ''
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const onData = (chunk) => {
        for (const char of chunk) {
          if (char === '\u0003') {
            input.off('data', onData)
            rejectPromise(new Error('已取消输入 MinIO secretKey'))
            return
          }
          if (char === '\r' || char === '\n') {
            input.off('data', onData)
            output.write('\n')
            resolvePromise(value)
            return
          }
          if (char === '\u007f') {
            value = value.slice(0, -1)
            continue
          }
          value += char
        }
      }
      input.on('data', onData)
    })
  } finally {
    input.setRawMode(false)
    input.pause()
  }
}

export async function resolveMinioCredentials({ accessKey, secretKey, keychainService = 'xmos-runtime-minio', keychainAccount = 'default' } = {}) {
  const resolvedAccessKey = accessKey || process.env.MINIO_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || ''
  let resolvedSecretKey = secretKey || process.env.MINIO_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || ''

  if (!resolvedSecretKey && process.platform === 'darwin') {
    const found = spawnSync('security', ['find-generic-password', '-s', keychainService, '-a', keychainAccount, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (found.status === 0) resolvedSecretKey = found.stdout.trim()
  }

  if (!resolvedSecretKey) {
    resolvedSecretKey = await promptHidden('MinIO secretKey（隐藏输入，不会回显）: ')
  }

  if (!resolvedAccessKey || !resolvedSecretKey) {
    throw new Error('缺少 MinIO 凭据：请配置 MINIO_ACCESS_KEY/MINIO_SECRET_KEY，或把 secretKey 存入 macOS Keychain')
  }

  return { accessKey: resolvedAccessKey, secretKey: resolvedSecretKey }
}

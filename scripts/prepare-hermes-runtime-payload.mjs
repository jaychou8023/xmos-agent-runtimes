#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import {
  downloadLockedArtifact,
  extractArchive,
  hostRuntimePlatform,
  parseArgs,
  readRuntimeLock,
  run,
  sha256File,
  verifySha256,
  writeBuildMetadata,
  xmosBuildCacheRoot,
} from './lib/runtime-build.mjs'
import {
  HERMES_ALLOWED_BUILD_REMOVALS,
  HERMES_EXCLUDED_DESKTOP_SHELLS,
  hermesCapabilityCatalog,
  hermesEditionArtifactVersion,
  hermesEditionPayloadProfile,
} from './lib/hermes-offline-layout.mjs'

function pythonEnvironment(pythonRoot, extra = {}) {
  return {
    ...process.env,
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    HERMES_SKIP_NODE_BOOTSTRAP: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INDEX: extra.allowIndex ? undefined : '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONHOME: pythonRoot,
    PYTHONNOUSERSITE: '1',
    UV_OFFLINE: extra.allowIndex ? undefined : '1',
    XMOS_RUNTIME_OFFLINE: '1',
    ...extra,
  }
}

async function pythonValue(python, pythonRoot, expression) {
  const result = await run(python, ['-I', '-c', `import sysconfig; print(${expression})`], {
    capture: true,
    env: pythonEnvironment(pythonRoot),
  })
  return result.stdout.trim().split(/\r?\n/).at(-1)
}

async function relativeInside(root, target, label) {
  const result = relative(await realpath(root), await realpath(target))
  if (!result || result === '..' || result.startsWith(`..${sep}`)) {
    throw new Error(`${label} escaped the embedded Python root`)
  }
  return result
}

async function findLicenseFiles(root, prefix = '') {
  const result = {}
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await findLicenseFiles(root, child))
    else if (entry.isFile()) result[child.replaceAll('/', '__')] = join(root, child)
  }
  return result
}

async function findNodeLicenseFiles(root, prefix = '') {
  const result = {}
  let entries
  try { entries = await readdir(join(root, prefix), { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await findNodeLicenseFiles(root, child))
    else if (entry.isFile() && /^(?:copying|license|notice)(?:[._-].*)?$/i.test(entry.name)) {
      const flat = child.replaceAll('/', '__')
      const name = flat.length <= 160 ? flat : `${flat.slice(0, 120)}__${createHash('sha256').update(child).digest('hex').slice(0, 16)}__${entry.name}`
      result[name] = join(root, child)
    }
  }
  return result
}

async function nodePackageComponents(nodeModulesRoots) {
  const packages = new Map()
  async function scanNodeModules(root) {
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue
      if (entry.name.startsWith('@')) {
        await scanNodeModules(join(root, entry.name))
        continue
      }
      const packageRoot = join(root, entry.name)
      try {
        const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
        if (metadata.name && metadata.version) {
          const key = `${metadata.name}@${metadata.version}`
          packages.set(key, {
            type: 'library',
            name: metadata.name,
            version: metadata.version,
            ...(typeof metadata.license === 'string' && metadata.license.length < 128
              ? { licenses: [{ expression: metadata.license }] }
              : {}),
            purl: `pkg:npm/${encodeURIComponent(metadata.name)}@${encodeURIComponent(metadata.version)}`,
          })
        }
      } catch {}
      await scanNodeModules(join(packageRoot, 'node_modules'))
    }
  }
  for (const root of nodeModulesRoots) await scanNodeModules(root)
  return [...packages.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'))
}

async function pythonComponents(sitePackages) {
  const components = []
  const licenses = {}
  for (const entry of await readdir(sitePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue
    const metadataPath = join(sitePackages, entry.name, 'METADATA')
    let metadata
    try { metadata = await readFile(metadataPath, 'utf8') } catch { continue }
    const name = /^Name:\s*(.+)$/mi.exec(metadata)?.[1]?.trim() || entry.name.replace(/\.dist-info$/, '')
    const version = /^Version:\s*(.+)$/mi.exec(metadata)?.[1]?.trim() || 'unknown'
    const licenseExpression = /^License-Expression:\s*(.+)$/mi.exec(metadata)?.[1]?.trim()
      || /^License:\s*(.+)$/mi.exec(metadata)?.[1]?.trim()
    components.push({
      type: 'library',
      name,
      version,
      ...(licenseExpression && licenseExpression.length < 128 ? { licenses: [{ expression: licenseExpression }] } : {}),
      purl: `pkg:pypi/${encodeURIComponent(name.toLowerCase())}@${encodeURIComponent(version)}`,
    })
    const distLicenses = join(sitePackages, entry.name, 'licenses')
    try {
      const found = await findLicenseFiles(distLicenses)
      for (const [file, path] of Object.entries(found)) licenses[`python__${entry.name}__${file}`] = path
    } catch {
      // License-Expression remains in the SBOM when a wheel has no license file.
    }
  }
  components.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  return { components, licenses }
}

async function removeGeneratedPythonFiles(root) {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const child = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__' || entry.name === 'test' || entry.name === 'tests') {
        await rm(child, { force: true, recursive: true })
      } else {
        await removeGeneratedPythonFiles(child)
      }
    } else if (entry.isFile() && /\.(?:py[co]|a|lib|o|obj)$/i.test(entry.name)) {
      await rm(child, { force: true })
    }
  }
}

async function pruneLocalInstallMetadata(sitePackages) {
  const entries = await readdir(sitePackages, { withFileTypes: true })
  for (const entry of entries.filter(item => item.isDirectory() && item.name.endsWith('.dist-info'))) {
    const root = join(sitePackages, entry.name)
    await rm(join(root, 'direct_url.json'), { force: true })
    const recordPath = join(root, 'RECORD')
    try {
      const rows = (await readFile(recordPath, 'utf8'))
        .split(/\r?\n/)
        .filter(row => row && !row.startsWith(`${entry.name}/direct_url.json,`))
      await writeFile(recordPath, `${rows.join('\n')}\n`, 'utf8')
    } catch {
      // RECORD is optional for imported distributions.
    }
  }
}

async function removeBuildOnlyContent(pythonRoot, sitePackages) {
  await removeGeneratedPythonFiles(pythonRoot)
  await pruneLocalInstallMetadata(sitePackages)
}

const HERMES_RUNTIME_SOURCE_TREES = Object.freeze([
  'acp_adapter', 'acp_registry', 'agent', 'assets', 'cron', 'gateway',
  'hermes_cli', 'infographic', 'plugins', 'providers', 'tools', 'tui_gateway',
])

async function overlayUpstreamRuntimeResources(sourceRoot, sitePackages) {
  for (const directory of HERMES_RUNTIME_SOURCE_TREES) {
    await cp(join(sourceRoot, directory), join(sitePackages, directory), {
      dereference: true,
      force: true,
      recursive: true,
    })
  }
}

async function inventoryFiles(root, prefix = '') {
  const files = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name
    const segments = child.split('/')
    if (segments.some(segment => segment === '__pycache__' || segment === 'test' || segment === 'tests')) continue
    if (entry.isDirectory()) files.push(...await inventoryFiles(root, child))
    else if (entry.isFile() && !/\.(?:py[co]|a|lib|o|obj)$/i.test(entry.name)) files.push(child)
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

async function upstreamRuntimeInventory(sourceRoot, profile) {
  const runtimeTrees = {}
  for (const directory of HERMES_RUNTIME_SOURCE_TREES) {
    runtimeTrees[directory] = await inventoryFiles(join(sourceRoot, directory))
  }
  const dataAssets = {}
  for (const directory of profile.includeOptionalAssets
    ? ['skills', 'optional-skills', 'optional-mcps', 'locales']
    : ['skills', 'locales']) {
    dataAssets[directory] = await inventoryFiles(join(sourceRoot, directory))
  }
  return {
    dataAssets,
    runtimeTrees,
    schemaVersion: 'xmos-hermes-upstream-inventory/1',
  }
}

async function copyManagedNode(lock, platform, cacheRoot, output) {
  const nodeSpec = lock.aionCli.managedNode.platforms[platform]
  if (!nodeSpec) throw new Error(`Managed Node is not locked for Hermes platform: ${platform}`)
  const archive = await downloadLockedArtifact(nodeSpec, cacheRoot)
  const extracted = await mkdtemp(join(tmpdir(), 'xmos-hermes-node-'))
  try {
    await extractArchive(archive, extracted)
    const source = join(extracted, nodeSpec.directory)
    const entry = join(source, nodeSpec.entry)
    if (!(await stat(entry)).isFile()) throw new Error(`Managed Node entry is missing: ${nodeSpec.entry}`)
    const target = join(output, 'managed-resources/node', nodeSpec.directory)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { dereference: true, recursive: true })
    if (platform !== 'win32-x64') await chmod(join(target, nodeSpec.entry), 0o755)
    return {
      directory: `managed-resources/node/${nodeSpec.directory}`,
      entry: `managed-resources/node/${nodeSpec.directory}/${nodeSpec.entry}`,
      sha256: nodeSpec.sha256,
      version: lock.aionCli.managedNode.version,
    }
  } finally {
    await rm(extracted, { force: true, recursive: true })
  }
}

async function buildDashboardStatic(lock, platform, output, sourceRoot, pythonRoot, sitePackages, managedNode) {
  await verifySha256(join(sourceRoot, 'package-lock.json'), lock.hermes.source.packageLockSha256, 'Archived Hermes package-lock.json')
  const nodeRoot = join(output, managedNode.directory)
  const targetNode = platform === 'win32-x64' ? join(nodeRoot, 'node.exe') : join(nodeRoot, 'bin/node')
  const targetNpmCli = platform === 'win32-x64'
    ? join(nodeRoot, 'node_modules/npm/bin/npm-cli.js')
    : join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js')
  if (!(await stat(targetNode)).isFile() || !(await stat(targetNpmCli)).isFile()) throw new Error('Managed Node does not include npm-cli.js')
  const nativeBuild = platform === hostRuntimePlatform()
  const node = nativeBuild ? targetNode : process.execPath
  const npmCli = nativeBuild ? targetNpmCli : null
  const configuredNpmCache = process.env.XMOS_HERMES_NPM_CACHE
  const npmCache = configuredNpmCache
    ? resolve(configuredNpmCache)
    : await mkdtemp(join(tmpdir(), 'xmos-hermes-npm-cache-'))
  if (configuredNpmCache) await mkdir(npmCache, { recursive: true })
  try {
    const env = {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_cache: npmCache,
      npm_config_fetch_timeout: process.env.npm_config_fetch_timeout || '30000',
      npm_config_fund: 'false',
      npm_config_maxsockets: process.env.npm_config_maxsockets || '4',
      npm_config_update_notifier: 'false',
      PATH: `${dirname(node)}${delimiter}${process.env.PATH || ''}`,
    }
    const runNpm = (args, cwd) => nativeBuild
      ? run(node, [npmCli, ...args], { cwd, env })
      : run('npm', args, { cwd, env })
    await runNpm(['ci', '--workspace', 'web', '--include-workspace-root=false', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], sourceRoot)
    await runNpm(['run', 'build', '--workspace', 'web'], sourceRoot)
    const source = join(sourceRoot, 'hermes_cli/web_dist')
    const index = join(source, 'index.html')
    if (!(await stat(index)).isFile()) throw new Error('Hermes Dashboard build did not produce web_dist/index.html')
    const relativeSitePackages = await relativeInside(pythonRoot, sitePackages, 'Hermes site-packages')
    const target = join(output, 'python', relativeSitePackages, 'hermes_cli/web_dist')
    await rm(target, { force: true, recursive: true })
    await cp(source, target, { dereference: true, recursive: true })
    const sidecarSource = join(sourceRoot, 'plugins/platforms/photon/sidecar')
    await verifySha256(join(sidecarSource, 'package-lock.json'), lock.hermes.source.photonSidecarLockSha256, 'Archived Photon sidecar package-lock.json')
    await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], sidecarSource)
    await run(node, [join(sidecarSource, 'patch-spectrum-mixed-attachments.mjs')], { cwd: sidecarSource, env })
    const photonTarget = join(output, 'python', relativeSitePackages, 'plugins/platforms/photon/sidecar')
    await rm(photonTarget, { force: true, recursive: true })
    await cp(sidecarSource, photonTarget, { dereference: true, recursive: true })
    return {
      entry: `${join('python', relativeSitePackages, 'hermes_cli/web_dist/index.html').split(sep).join('/')}`,
      packageLockSha256: lock.hermes.source.packageLockSha256,
      photonSidecar: {
        entry: `${join('python', relativeSitePackages, 'plugins/platforms/photon/sidecar/index.mjs').split(sep).join('/')}`,
        packageLockSha256: lock.hermes.source.photonSidecarLockSha256,
        spectrumVersion: '8.0.0',
      },
    }
  } finally {
    if (!configuredNpmCache) await rm(npmCache, { force: true, recursive: true })
  }
}

async function copyLockedRipgrep(lock, platform, cacheRoot, output) {
  const spec = lock.hermes.managedTools?.ripgrep?.platforms?.[platform]
  if (!spec) throw new Error(`Hermes ripgrep is not locked for ${platform}`)
  const archive = await downloadLockedArtifact(spec, join(cacheRoot, 'ripgrep'))
  const extracted = await mkdtemp(join(tmpdir(), 'xmos-hermes-ripgrep-'))
  try {
    await extractArchive(archive, extracted)
    const source = join(extracted, spec.directory)
    const sourceEntry = join(source, spec.entry)
    if (!(await stat(sourceEntry)).isFile()) throw new Error(`Locked ripgrep entry is missing: ${spec.entry}`)
    const target = join(output, 'managed-resources/tools/ripgrep')
    await cp(source, target, { dereference: true, recursive: true })
    const entryName = platform === 'win32-x64' ? 'rg.exe' : 'rg'
    if (platform !== 'win32-x64') await chmod(join(target, entryName), 0o755)
    return {
      directory: 'managed-resources/tools/ripgrep',
      entry: `managed-resources/tools/ripgrep/${entryName}`,
      sha256: spec.sha256,
      version: lock.hermes.managedTools.ripgrep.version,
    }
  } finally {
    await rm(extracted, { force: true, recursive: true })
  }
}

async function copyLockedFfmpeg(lock, platform, cacheRoot, output) {
  const tool = lock.hermes.managedTools?.ffmpeg
  const spec = tool?.platforms?.[platform]
  if (!spec) throw new Error(`Hermes ffmpeg is not locked for ${platform}`)
  const [archive, ffmpegLicense] = await Promise.all([
    downloadLockedArtifact(spec, join(cacheRoot, `imageio-ffmpeg-${tool.distributionVersion}`)),
    downloadLockedArtifact(tool.license, join(cacheRoot, `ffmpeg-${tool.version}`)),
  ])
  const extracted = await mkdtemp(join(tmpdir(), 'xmos-hermes-ffmpeg-'))
  try {
    await extractArchive(archive, extracted)
    const sourceEntry = join(extracted, spec.entry)
    const sourceLicense = join(extracted, spec.licenseEntry)
    if (!(await stat(sourceEntry)).isFile()) throw new Error(`Locked ffmpeg entry is missing: ${spec.entry}`)
    if (!(await stat(sourceLicense)).isFile()) throw new Error(`Locked ffmpeg license is missing: ${spec.licenseEntry}`)
    const target = join(output, 'managed-resources/tools/ffmpeg')
    await mkdir(target, { recursive: true })
    const entryName = platform === 'win32-x64' ? 'ffmpeg.exe' : 'ffmpeg'
    await cp(sourceEntry, join(target, entryName))
    await cp(sourceLicense, join(target, 'imageio-ffmpeg-LICENSE'))
    await cp(ffmpegLicense, join(target, 'FFmpeg-COPYING.GPLv3'))
    await writeFile(join(target, 'FFmpeg-NOTICE.txt'), [
      `FFmpeg ${tool.version} binary redistributed by ${tool.distribution} ${tool.distributionVersion}.`,
      'The binary reports an --enable-gpl build; FFmpeg and linked library license obligations apply.',
      'Upstream source and license information: https://ffmpeg.org/legal.html',
      '',
    ].join('\n'), 'utf8')
    if (platform !== 'win32-x64') await chmod(join(target, entryName), 0o755)
    return {
      directory: 'managed-resources/tools/ffmpeg',
      entry: `managed-resources/tools/ffmpeg/${entryName}`,
      sha256: spec.sha256,
      version: tool.version,
    }
  } finally {
    await rm(extracted, { force: true, recursive: true })
  }
}

function gitBuildFlags(prefix, platform) {
  return [
    `prefix=${prefix}`,
    'RUNTIME_PREFIX=YesPlease',
    ...(platform.startsWith('darwin-')
      ? ['HAVE_NS_GET_EXECUTABLE_PATH=YesPlease']
      : ['PROCFS_EXECUTABLE_PATH=/proc/self/exe']),
    'NO_GETTEXT=YesPlease',
    'NO_INSTALL_HARDLINKS=YesPlease',
    'NO_PERL=YesPlease',
    'NO_PYTHON=YesPlease',
    'NO_TCLTK=YesPlease',
  ]
}

async function copyLockedGit(lock, platform, cacheRoot, output) {
  const tool = lock.hermes.managedTools?.git
  if (!tool) throw new Error('Hermes managed Git is not locked')
  const target = join(output, 'managed-resources/tools/git')
  if (platform === 'win32-x64') {
    const spec = tool.platforms?.[platform]
    if (!spec) throw new Error(`Hermes MinGit is not locked for ${platform}`)
    const archive = await downloadLockedArtifact(spec, join(cacheRoot, 'mingit'))
    const extracted = await mkdtemp(join(tmpdir(), 'xmos-hermes-mingit-'))
    try {
      await extractArchive(archive, extracted)
      if (!(await stat(join(extracted, spec.entry))).isFile()) throw new Error(`Locked MinGit entry is missing: ${spec.entry}`)
      await cp(extracted, target, { dereference: true, recursive: true })
      return {
        directory: 'managed-resources/tools/git',
        entry: `managed-resources/tools/git/${spec.entry}`,
        sha256: spec.sha256,
        source: 'MinGit',
        version: tool.version,
      }
    } finally {
      await rm(extracted, { force: true, recursive: true })
    }
  }
  if (platform !== hostRuntimePlatform()) {
    throw new Error(`Managed Git for ${platform} must be built on its native CI runner`)
  }
  const sourceArchive = await downloadLockedArtifact(tool.source, join(cacheRoot, 'git-source'))
  const buildRoot = await mkdtemp(join(tmpdir(), 'xmos-hermes-git-'))
  try {
    await extractArchive(sourceArchive, buildRoot)
    const source = join(buildRoot, tool.source.directory)
    const prefix = join(buildRoot, 'install')
    const flags = gitBuildFlags(prefix, platform)
    await run('make', ['-C', source, `-j${process.env.XMOS_BUILD_JOBS || '4'}`, ...flags, 'all'])
    await run('make', ['-C', source, ...flags, 'install'])
    await cp(prefix, target, { dereference: true, recursive: true })
    await cp(join(source, 'COPYING'), join(target, 'COPYING'))
    const entry = join(target, 'bin/git')
    await chmod(entry, 0o755)
    return {
      directory: 'managed-resources/tools/git',
      entry: 'managed-resources/tools/git/bin/git',
      executableSha256: await sha256File(entry),
      sha256: tool.source.sha256,
      source: 'native-source-build',
      version: tool.version,
    }
  } finally {
    await rm(buildRoot, { force: true, recursive: true })
  }
}

async function copyLockedManagedTools(lock, platform, cacheRoot, output) {
  const ripgrep = await copyLockedRipgrep(lock, platform, cacheRoot, output)
  const ffmpeg = await copyLockedFfmpeg(lock, platform, cacheRoot, output)
  const git = await copyLockedGit(lock, platform, cacheRoot, output)
  return { ffmpeg, git, ripgrep }
}

async function copyLockedVoiceModel(lock, cacheRoot, output) {
  const model = lock.hermes.voiceModel
  if (!model?.revision || !Array.isArray(model.files) || model.files.length === 0) {
    throw new Error('Hermes faster-whisper voice model is not locked')
  }
  const target = join(output, 'managed-resources/models/faster-whisper-base')
  await mkdir(target, { recursive: true })
  for (const file of model.files) {
    const source = await downloadLockedArtifact(file, join(cacheRoot, 'faster-whisper-base'))
    await cp(source, join(target, file.file))
  }
  return {
    directory: 'managed-resources/models/faster-whisper-base',
    files: model.files.map(file => ({ file: file.file, sha256: file.sha256 })),
    repository: model.repository,
    revision: model.revision,
  }
}

async function copyLockedBrowserArchive(lock, platform, cacheRoot, output) {
  const driverSpec = lock.hermes.agentBrowser?.platforms?.[platform]
  const chromeSpec = lock.hermes.chromium?.platforms?.[platform]
  if (!driverSpec || !chromeSpec) throw new Error(`Hermes browser assets are not locked for ${platform}`)
  const [driverSource, chromeArchive, licenseSource] = await Promise.all([
    downloadLockedArtifact(driverSpec, join(cacheRoot, 'agent-browser')),
    downloadLockedArtifact(chromeSpec, join(cacheRoot, `chrome-for-testing-${lock.hermes.chromium.version}`)),
    downloadLockedArtifact(lock.hermes.agentBrowser.license, join(cacheRoot, 'agent-browser')),
  ])
  const toolsRoot = join(output, 'managed-resources/tools/agent-browser')
  await mkdir(toolsRoot, { recursive: true })
  const driverName = platform === 'win32-x64' ? 'agent-browser.exe' : 'agent-browser'
  await cp(driverSource, join(toolsRoot, driverName))
  await cp(licenseSource, join(toolsRoot, 'LICENSE'))
  if (platform !== 'win32-x64') await chmod(join(toolsRoot, driverName), 0o755)
  const browserRoot = join(output, 'managed-resources/browser')
  await mkdir(browserRoot, { recursive: true })
  await cp(chromeArchive, join(browserRoot, chromeSpec.file))
  await writeFile(join(browserRoot, 'NOTICE.txt'), [
    `Chrome for Testing ${lock.hermes.chromium.version} is distributed as the upstream archive ${chromeSpec.file}.`,
    'The Electron Main Host Bridge extracts this signed archive into Host-managed Runtime data at first use.',
    'Chrome for Testing terms: https://developer.chrome.com/docs/chromedriver/downloads',
    '',
  ].join('\n'), 'utf8')
  return {
    archive: `managed-resources/browser/${chromeSpec.file}`,
    archiveSha256: chromeSpec.sha256,
    chromiumVersion: lock.hermes.chromium.version,
    executable: chromeSpec.entry,
    extractedRoot: chromeSpec.directory,
    driverEntry: `managed-resources/tools/agent-browser/${driverName}`,
    driverSha256: driverSpec.sha256,
    driverVersion: lock.hermes.agentBrowser.version,
  }
}

function hermesExportArgs(lock, platform, profile, requirements) {
  return [
    'export', '--quiet', '--frozen',
    ...(profile.useAllExtras ? ['--all-extras'] : []),
    '--no-extra', 'dev',
    ...unsupportedExtras(lock, platform).flatMap(extra => ['--no-extra', extra]),
    '--no-dev', '--no-emit-project', '--format', 'requirements-txt', '--output-file', requirements,
  ]
}

function unsupportedExtras(lock, platform) {
  return lock.hermes.platformUnsupported?.[platform]?.extras || []
}

function lazyRequirements(source, lock, platform) {
  const start = source.indexOf('LAZY_DEPS:')
  const end = source.indexOf('\n_SAFE_SPEC', start)
  if (start < 0 || end < 0) throw new Error('Unable to locate Hermes LAZY_DEPS')
  const block = source.slice(start, end)
  const excluded = new Set((lock.hermes.platformUnsupported?.[platform]?.packages || [])
    .map(value => value.toLowerCase().replaceAll('_', '-')))
  const requirements = []
  for (const match of block.matchAll(/["']([A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,-]+\])?==[^"']+)["']/g)) {
    const requirement = match[1]
    const name = requirement.split(/[=[<>=!~]/, 1)[0].toLowerCase().replaceAll('_', '-')
    if (!excluded.has(name)) requirements.push(requirement)
  }
  return [...new Set(requirements)].sort((left, right) => left.localeCompare(right, 'en'))
}

function normalizedPythonPackageName(value) {
  return value.toLowerCase().replaceAll('_', '-')
}

async function filterUnsupportedRequirements(requirementsPath, lock, platform) {
  const excluded = new Set((lock.hermes.platformUnsupported?.[platform]?.packages || [])
    .map(normalizedPythonPackageName))
  if (excluded.size === 0) return 0
  const lines = (await readFile(requirementsPath, 'utf8')).split(/\r?\n/)
  let omitRequirementBlock = false
  const filtered = lines.filter(line => {
    const match = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==/.exec(line)
    if (match) {
      omitRequirementBlock = excluded.has(normalizedPythonPackageName(match[1]))
      return !omitRequirementBlock
    }
    if (/^\s+--hash=/.test(line)) return !omitRequirementBlock
    omitRequirementBlock = false
    return true
  })
  await writeFile(requirementsPath, `${filtered.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
  return lines.length - filtered.length
}

async function appendLazyRequirements(requirementsPath, sourceRoot, lock, platform) {
  const current = await readFile(requirementsPath, 'utf8')
  const lazy = lazyRequirements(await readFile(join(sourceRoot, 'tools/lazy_deps.py'), 'utf8'), lock, platform)
  const installedNames = new Set([...current.matchAll(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==/gm)]
    .map(match => match[1].toLowerCase().replaceAll('_', '-')))
  const missing = lazy.filter(requirement => {
    const name = requirement.split(/[=[<>=!~]/, 1)[0].toLowerCase().replaceAll('_', '-')
    return !installedNames.has(name)
  })
  await writeFile(requirementsPath, `${current.trim()}\n${missing.join('\n')}\n`, 'utf8')
  return { declared: lazy.length, added: missing.length, satisfiedByMainLock: lazy.length - missing.length }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.output || !['lite', 'max'].includes(options.edition)) {
    throw new Error('Usage: --edition <lite|max> --platform <target> --output <payload-dir> [--source-root <hermes checkout>]')
  }
  const { lock, lockPath, lockSha256 } = await readRuntimeLock(options.lock)
  if (!Array.isArray(lock.hermes.source.patches) || lock.hermes.source.patches.length !== 0) {
    throw new Error('Hermes Runtime 只能从无 XMOS 补丁的上游提交构建')
  }
  const platform = options.platform || hostRuntimePlatform()
  const edition = options.edition
  const profile = hermesEditionPayloadProfile(edition)
  const artifactVersion = hermesEditionArtifactVersion(lock.hermes, edition)
  const nativeBuild = platform === hostRuntimePlatform()
  const pythonSpec = lock.hermes.python.platforms[platform]
  if (!pythonSpec) throw new Error(`Unsupported Hermes platform: ${platform}`)
  const checkoutRoot = resolve(options['source-root'] || '/Users/liyc/Documents/hermes/hermes-agent')
  const sourceHead = (await run('git', ['rev-parse', 'HEAD'], { capture: true, cwd: checkoutRoot })).stdout.trim()
  if (sourceHead !== lock.hermes.source.commit) throw new Error(`Hermes source commit mismatch: ${sourceHead}`)
  const sourceStatus = (await run('git', ['status', '--porcelain=v1'], { capture: true, cwd: checkoutRoot })).stdout.trim()
  if (sourceStatus) throw new Error('Hermes 上游 checkout 存在本地修改；拒绝从非原样源码构建 Runtime')
  await verifySha256(join(checkoutRoot, 'uv.lock'), lock.hermes.source.uvLockSha256, 'Hermes uv.lock')

  const output = resolve(options.output)
  const cacheRoot = resolve(options['cache-root'] || join(xmosBuildCacheRoot, 'runtime-cache'))
  const archive = await downloadLockedArtifact(pythonSpec, cacheRoot)
  const extracted = await mkdtemp(join(tmpdir(), 'xmos-hermes-python-'))
  const exportRoot = await mkdtemp(join(tmpdir(), 'xmos-hermes-export-'))
  const sourceRoot = join(exportRoot, 'source')
  try {
    const sourceArchive = join(exportRoot, 'hermes-source.tar')
    await mkdir(sourceRoot, { recursive: true })
    await run('git', ['archive', '--format=tar', `--output=${sourceArchive}`, lock.hermes.source.commit], { cwd: checkoutRoot })
    await extractArchive(sourceArchive, sourceRoot)
    await verifySha256(join(sourceRoot, 'uv.lock'), lock.hermes.source.uvLockSha256, 'Archived Hermes uv.lock')
    await extractArchive(archive, extracted)
    const pythonRoot = join(extracted, 'python')
    const python = join(extracted, pythonSpec.entry)
    if (!(await stat(python)).isFile()) throw new Error(`Embedded CPython entry is missing: ${pythonSpec.entry}`)
    if (platform !== 'win32-x64') await chmod(python, 0o755)
    const requirements = join(exportRoot, 'requirements.txt')
    let sitePackages
    let scriptsDir
    let validationMode
    let lazyDependencyResolution
    if (nativeBuild) {
      const versionProbe = await run(python, ['--version'], { capture: true, env: pythonEnvironment(pythonRoot) })
      if (!versionProbe.stdout.includes(`Python ${lock.hermes.python.version}`) && !versionProbe.stderr.includes(`Python ${lock.hermes.python.version}`)) {
        throw new Error(`Embedded Python version mismatch: ${versionProbe.stdout || versionProbe.stderr}`)
      }
      await run(python, ['-m', 'ensurepip', '--upgrade'], { env: pythonEnvironment(pythonRoot, { allowIndex: true }) })
      await run(python, ['-m', 'pip', 'install', '--quiet', '--no-cache-dir', `uv==${lock.build.uvVersion}`], {
        env: pythonEnvironment(pythonRoot, { allowIndex: true }),
      })
      scriptsDir = await pythonValue(python, pythonRoot, 'sysconfig.get_path("scripts")')
      const uv = join(scriptsDir, platform === 'win32-x64' ? 'uv.exe' : 'uv')
      const exportArgs = hermesExportArgs(lock, platform, profile, requirements)
      await run(uv, exportArgs, {
        cwd: sourceRoot,
        env: pythonEnvironment(pythonRoot, { allowIndex: true }),
      })
      await filterUnsupportedRequirements(requirements, lock, platform)
      lazyDependencyResolution = profile.useAllExtras
        ? await appendLazyRequirements(requirements, sourceRoot, lock, platform)
        : { added: 0, declared: 0, satisfiedByMainLock: 0, skippedForEdition: edition }
      await run(uv, ['pip', 'install', '--quiet', '--no-cache', '--no-python-downloads', '--python', python, '--requirements', requirements], {
        env: pythonEnvironment(pythonRoot, { allowIndex: true }),
      })
      await run(uv, ['pip', 'install', '--quiet', '--no-cache', '--no-python-downloads', '--python', python, '--no-deps', sourceRoot], {
        env: pythonEnvironment(pythonRoot, { allowIndex: true }),
      })
      await run(python, ['-I', '-c', 'from unittest.mock import Mock; import certifi, cryptography, hermes_cli, PIL, psutil, pydantic_core, tui_gateway, websockets; print("Hermes native import closure OK")'], {
        env: pythonEnvironment(pythonRoot),
      })
      sitePackages = await pythonValue(python, pythonRoot, 'sysconfig.get_path("purelib")')
      validationMode = 'native-import-closure'
    } else {
      const uv = resolve(options.uv || join(xmosBuildCacheRoot, 'runtime-tooling/bin/uv'))
      if (!(await stat(uv)).isFile()) throw new Error(`Cross-build uv is missing: ${uv}`)
      const targetPlatform = platform === 'win32-x64' ? 'x86_64-pc-windows-msvc' : 'x86_64-manylinux_2_28'
      sitePackages = platform === 'win32-x64'
        ? join(pythonRoot, 'Lib/site-packages')
        : join(pythonRoot, 'lib/python3.11/site-packages')
      scriptsDir = platform === 'win32-x64' ? join(pythonRoot, 'Scripts') : join(pythonRoot, 'bin')
      await mkdir(sitePackages, { recursive: true })
      await mkdir(scriptsDir, { recursive: true })
      const exportArgs = hermesExportArgs(lock, platform, profile, requirements)
      await run(uv, exportArgs, {
        cwd: sourceRoot,
      })
      await filterUnsupportedRequirements(requirements, lock, platform)
      lazyDependencyResolution = profile.useAllExtras
        ? await appendLazyRequirements(requirements, sourceRoot, lock, platform)
        : { added: 0, declared: 0, satisfiedByMainLock: 0, skippedForEdition: edition }
      await run(uv, ['pip', 'install', '--quiet', '--target', sitePackages, '--python-version', '3.11', '--python-platform', targetPlatform, '--only-binary', ':all:', '--requirements', requirements])
      const wheelRoot = join(exportRoot, 'wheel')
      await mkdir(wheelRoot, { recursive: true })
      await run(uv, ['build', '--quiet', '--wheel', '--out-dir', wheelRoot, sourceRoot])
      const wheel = (await readdir(wheelRoot)).find(file => file.endsWith('.whl'))
      if (!wheel) throw new Error('Hermes wheel build did not produce a wheel')
      await run(uv, ['pip', 'install', '--quiet', '--target', sitePackages, '--python-version', '3.11', '--python-platform', targetPlatform, '--no-deps', join(wheelRoot, wheel)])
      validationMode = 'cross-assembled-native-gate-required'
    }

    await overlayUpstreamRuntimeResources(sourceRoot, sitePackages)
    const upstreamInventory = await upstreamRuntimeInventory(sourceRoot, profile)
    const { components, licenses } = await pythonComponents(sitePackages)
    licenses['Hermes-Agent-LICENSE.txt'] = join(sourceRoot, 'LICENSE')
    await removeBuildOnlyContent(pythonRoot, sitePackages)
    if (nativeBuild) {
      const importClosure = profile.useAllExtras
        ? 'from unittest.mock import Mock; import acp_adapter, certifi, cryptography, hermes_cli, PIL, plugins, psutil, pydantic_core, run_agent, tui_gateway, websockets; print("Hermes complete runtime and Agent import closure OK")'
        : 'import certifi, cryptography, hermes_cli, psutil, pydantic_core, tui_gateway, websockets; print("Hermes Lite chat import closure OK")'
      await run(python, ['-I', '-B', '-c', importClosure], {
        env: pythonEnvironment(pythonRoot),
      })
      await removeGeneratedPythonFiles(pythonRoot)
    }

    await rm(output, { force: true, recursive: true })
    await mkdir(output, { recursive: true })
    await cp(pythonRoot, join(output, 'python'), { dereference: true, recursive: true })
    const hermesAssetsRoot = join(output, 'hermes-assets')
    await mkdir(hermesAssetsRoot, { recursive: true })
    const assetDirectories = profile.includeOptionalAssets
      ? ['skills', 'optional-skills', 'optional-mcps', 'locales']
      : ['skills', 'locales']
    for (const directory of assetDirectories) {
      await cp(join(sourceRoot, directory), join(hermesAssetsRoot, directory), { dereference: true, recursive: true })
    }
    await writeFile(join(output, 'upstream-inventory.json'), `${JSON.stringify(upstreamInventory, null, 2)}\n`, 'utf8')
    const managedNode = profile.includeManagedNode ? await copyManagedNode(lock, platform, cacheRoot, output) : null
    const dashboardStatic = profile.includeManagedNode
      ? await buildDashboardStatic(lock, platform, output, sourceRoot, pythonRoot, sitePackages, managedNode)
      : null
    const relativeSitePackages = await relativeInside(pythonRoot, sitePackages, 'Hermes site-packages')
    if (!profile.includeManagedNode) {
      await rm(join(output, 'python', relativeSitePackages, 'hermes_cli/web_dist'), { force: true, recursive: true })
      await rm(join(output, 'python', relativeSitePackages, 'plugins/platforms/photon/sidecar/node_modules'), { force: true, recursive: true })
    }
    const dashboardNodeModules = join(sourceRoot, 'node_modules')
    const photonNodeModules = join(output, 'python', relativeSitePackages, 'plugins/platforms/photon/sidecar/node_modules')
    const nodeRuntimeComponents = profile.includeManagedNode ? await nodePackageComponents([dashboardNodeModules, photonNodeModules]) : []
    if (profile.includeManagedNode) {
      for (const [file, source] of Object.entries(await findNodeLicenseFiles(dashboardNodeModules))) {
        licenses[`dashboard-node__${file}`] = source
      }
      for (const [file, source] of Object.entries(await findNodeLicenseFiles(photonNodeModules))) {
        licenses[`photon-node__${file}`] = source
      }
    }
    const managedTools = profile.includeManagedTools ? await copyLockedManagedTools(lock, platform, cacheRoot, output) : null
    const voiceModel = profile.includeVoiceModel ? await copyLockedVoiceModel(lock, cacheRoot, output) : null
    const browser = profile.includeBrowserArchive ? await copyLockedBrowserArchive(lock, platform, cacheRoot, output) : null
    if (managedNode) licenses['Node.js-LICENSE.txt'] = join(output, managedNode.directory, 'LICENSE')
    if (managedTools) {
      licenses['Git-COPYING.txt'] = platform === 'win32-x64'
        ? join(output, managedTools.git.directory, 'LICENSE.txt')
        : join(output, managedTools.git.directory, 'COPYING')
      licenses['imageio-ffmpeg-LICENSE.txt'] = join(output, managedTools.ffmpeg.directory, 'imageio-ffmpeg-LICENSE')
      licenses['FFmpeg-COPYING.GPLv3.txt'] = join(output, managedTools.ffmpeg.directory, 'FFmpeg-COPYING.GPLv3')
      licenses['FFmpeg-NOTICE.txt'] = join(output, managedTools.ffmpeg.directory, 'FFmpeg-NOTICE.txt')
      licenses['ripgrep-LICENSE-MIT.txt'] = join(output, managedTools.ripgrep.directory, 'LICENSE-MIT')
      licenses['ripgrep-UNLICENSE.txt'] = join(output, managedTools.ripgrep.directory, 'UNLICENSE')
    }
    if (voiceModel) licenses['faster-whisper-base-README.txt'] = join(output, voiceModel.directory, 'README.md')
    if (browser) {
      licenses['agent-browser-LICENSE.txt'] = join(output, 'managed-resources/tools/agent-browser/LICENSE')
      licenses['Chrome-for-Testing-NOTICE.txt'] = join(output, 'managed-resources/browser/NOTICE.txt')
    }
    const capabilityCatalog = hermesCapabilityCatalog(platform, edition)
    await writeFile(join(output, 'capability-catalog.json'), `${JSON.stringify({
      capabilities: capabilityCatalog,
      runtimeId: lock.hermes.runtimeId,
      schemaVersion: 'xmos-agent-runtime-capabilities/1',
    }, null, 2)}\n`, 'utf8')
    await writeBuildMetadata(output, {
      licenses,
      provenance: {
        schemaVersion: 'xmos-runtime-provenance/1',
        runtimeId: lock.hermes.runtimeId,
        edition,
        version: artifactVersion,
        platform,
        source: lock.hermes.source,
        sourceLock: { file: basename(lockPath), sha256: lockSha256 },
        embeddedPython: { sha256: pythonSpec.sha256, version: lock.hermes.python.version },
        managedAssets: { browser, dashboardStatic, node: managedNode, tools: managedTools, voiceModel },
        payloadProfile: profile,
        upstreamDataAssets: [...assetDirectories, ...(dashboardStatic ? ['dashboard-static'] : [])],
        allowedBuildRemovals: HERMES_ALLOWED_BUILD_REMOVALS,
        capabilityCatalog,
        desktopShellsExcluded: HERMES_EXCLUDED_DESKTOP_SHELLS,
        distributionRevision: artifactVersion.split('+').at(-1),
        managedOfflinePolicy: {
          allowLazyInstalls: false,
          allowRuntimeDownloads: false,
          allowSelfUpdate: false,
        },
        lazyDependencyResolution: {
          ...lazyDependencyResolution,
          strategy: profile.useAllExtras
            ? 'complete-main-lock-wins-for-duplicate-distributions'
            : 'base-lock-only-for-lite',
        },
        upstreamCapabilitiesPhysicallyPruned: false,
        validationMode,
        builder: { arch: process.arch, node: process.version, platform: process.platform },
      },
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        serialNumber: `urn:uuid:xmos-hermes-${edition}-${platform}-${artifactVersion}`,
        version: 1,
        metadata: { component: { type: 'application', name: `Hermes ${edition === 'max' ? 'Max' : 'Lite'} Runtime`, version: artifactVersion } },
        components: [
          { type: 'application', name: 'Hermes Agent', version: lock.hermes.version, licenses: [{ license: { id: 'MIT' } }] },
          { type: 'application', name: 'CPython', version: lock.hermes.python.version, hashes: [{ alg: 'SHA-256', content: pythonSpec.sha256 }], licenses: [{ license: { id: 'PSF-2.0' } }] },
          ...(managedNode ? [{ type: 'application', name: 'Node.js', version: managedNode.version, hashes: [{ alg: 'SHA-256', content: managedNode.sha256 }], licenses: [{ license: { id: 'MIT' } }] }] : []),
          ...(managedTools ? [
            { type: 'application', name: 'Git', version: managedTools.git.version, hashes: [{ alg: 'SHA-256', content: managedTools.git.sha256 }], licenses: [{ license: { id: 'GPL-2.0-only' } }] },
            { type: 'application', name: 'ripgrep', version: managedTools.ripgrep.version, hashes: [{ alg: 'SHA-256', content: managedTools.ripgrep.sha256 }], licenses: [{ license: { expression: 'MIT OR Unlicense' } }] },
            { type: 'application', name: 'FFmpeg', version: managedTools.ffmpeg.version, hashes: [{ alg: 'SHA-256', content: managedTools.ffmpeg.sha256 }], licenses: [{ license: { id: 'GPL-3.0-or-later' } }] },
          ] : []),
          ...(voiceModel ? [{ type: 'machine-learning-model', name: 'Systran/faster-whisper-base', version: voiceModel.revision, licenses: [{ license: { id: 'MIT' } }] }] : []),
          ...(browser ? [
            { type: 'application', name: 'agent-browser', version: browser.driverVersion, hashes: [{ alg: 'SHA-256', content: browser.driverSha256 }], licenses: [{ license: { id: 'Apache-2.0' } }] },
            { type: 'application', name: 'Chrome for Testing', version: browser.chromiumVersion, hashes: [{ alg: 'SHA-256', content: browser.archiveSha256 }], licenses: [{ license: { name: 'Chrome for Testing terms' } }] },
          ] : []),
          ...nodeRuntimeComponents,
          ...components,
        ],
      },
    })
    const runtimeEntry = relative(output, join(output, pythonSpec.entry.replace(/^python[\\/]/, 'python/'))).split(sep).join('/')
    process.stdout.write(`${JSON.stringify({ output, platform, runtimeEntry }, null, 2)}\n`)
  } finally {
    await rm(extracted, { force: true, recursive: true })
    await rm(exportRoot, { force: true, recursive: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

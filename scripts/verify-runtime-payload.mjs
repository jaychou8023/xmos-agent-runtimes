#!/usr/bin/env node

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { hostRuntimePlatform, parseArgs, readRuntimeLock, run, sha256File } from './lib/runtime-build.mjs'
import {
  assertHermesEditionPayloadLayout,
  hermesEditionArtifactVersion,
  hermesEditionPayloadProfile,
} from './lib/hermes-offline-layout.mjs'

async function listFiles(root, prefix = '') {
  const result = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...await listFiles(root, child))
    else if (entry.isFile()) result.push(child)
    else throw new Error(`Payload contains unsupported entry: ${child}`)
  }
  return result.sort((left, right) => left.localeCompare(right, 'en'))
}

function compareVersion(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0)
  }
  return 0
}

async function linuxGlibcGate(root, files) {
  let maximum = null
  for (const file of files.filter(file => /(?:^|\/)(?:aioncore|agent-browser|chrome|ffmpeg|git|node|python3?|rg)$|\.so(?:\.|$)/.test(file))) {
    const bytes = await readFile(join(root, file))
    const text = bytes.toString('latin1')
    for (const match of text.matchAll(/GLIBC_(\d+\.\d+)/g)) {
      if (!maximum || compareVersion(match[1], maximum) > 0) maximum = match[1]
    }
  }
  if (maximum && compareVersion(maximum, '2.28') > 0) throw new Error(`Linux payload requires GLIBC ${maximum}; maximum allowed is 2.28`)
  return maximum
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  for (const key of ['runtime', 'platform', 'payload-root']) if (!options[key]) throw new Error(`Missing --${key}`)
  const { lock, lockSha256 } = await readRuntimeLock(options.lock)
  const root = resolve(options['payload-root'])
  if (!(await stat(root)).isDirectory()) throw new Error('Payload root is not a directory')
  const files = await listFiles(root)
  const provenance = JSON.parse(await readFile(join(root, '.xmos-build/provenance.json'), 'utf8'))
  const sbom = JSON.parse(await readFile(join(root, '.xmos-build/sbom.cdx.json'), 'utf8'))
  const licenseFiles = files.filter(file => file.startsWith('.xmos-build/licenses/'))
  if (!Array.isArray(sbom.components) || sbom.components.length < 2) throw new Error('Payload SBOM is incomplete')
  if (licenseFiles.length < 2) throw new Error('Payload licenses are incomplete')
  if (provenance.platform !== options.platform) throw new Error('Payload provenance platform mismatch')
  if (provenance.sourceLock?.sha256 !== lockSha256) throw new Error('Payload source lock hash mismatch')

  let entry
  if (options.runtime === 'aion-cli') {
    if (provenance.runtimeId !== lock.aionCli.runtimeId) throw new Error('Aion provenance Runtime ID mismatch')
    entry = options.platform === 'win32-x64' ? 'aioncore.exe' : 'aioncore'
    const forbidden = files.filter(file => /(^|\/)(acp|codex-acp|claude-agent-acp)(\/|$)/i.test(file))
    if (forbidden.length) throw new Error(`Aion payload contains future ACP resources: ${forbidden[0]}`)
    const nodeSpec = lock.aionCli.managedNode.platforms[options.platform]
    const nodeEntry = `managed-resources/node/${nodeSpec.directory}/${nodeSpec.entry}`
    if (!files.includes(nodeEntry)) throw new Error(`Aion payload is missing managed Node: ${nodeEntry}`)
    if (options.platform === hostRuntimePlatform()) {
      const aionVersion = await run(join(root, entry), ['--version'], { capture: true })
      const nodeVersion = await run(join(root, nodeEntry), ['--version'], { capture: true })
      if (!`${aionVersion.stdout}\n${aionVersion.stderr}`.includes(lock.aionCli.version)) throw new Error('Aion native version probe failed')
      if (!`${nodeVersion.stdout}\n${nodeVersion.stderr}`.includes(lock.aionCli.managedNode.version)) throw new Error('Managed Node native version probe failed')
    }
  } else if (options.runtime === 'hermes') {
    if (!['lite', 'max'].includes(options.edition)) throw new Error('Hermes payload verification requires --edition lite or max')
    const edition = options.edition
    const profile = hermesEditionPayloadProfile(edition)
    if (provenance.runtimeId !== lock.hermes.runtimeId) throw new Error('Hermes provenance Runtime ID mismatch')
    if (provenance.version !== hermesEditionArtifactVersion(lock.hermes, edition)) throw new Error('Hermes distribution revision mismatch')
    assertHermesEditionPayloadLayout({ edition, files, provenance })
    if (provenance.source?.commit !== lock.hermes.source.commit) throw new Error('Hermes upstream commit mismatch')
    if (provenance.source?.uvLockSha256 !== lock.hermes.source.uvLockSha256) throw new Error('Hermes upstream lock mismatch')
    if (!Array.isArray(lock.hermes.source.patches) || lock.hermes.source.patches.length !== 0) {
      throw new Error('Hermes source lock contains XMOS patches')
    }
    if (Array.isArray(provenance.source?.patches) && provenance.source.patches.length !== 0) {
      throw new Error('Hermes provenance contains XMOS patches')
    }
    if (provenance.upstreamCapabilitiesPhysicallyPruned !== false) throw new Error('Hermes payload declares physical capability pruning')
    entry = lock.hermes.python.platforms[options.platform].entry.replace(/^python[\\/]/, 'python/')
    const forbidden = files.filter(file => /(^|\/)(__pycache__|\.git)(\/|$)|\.(?:py[co]|a|lib|o|obj)$|\/direct_url\.json$/i.test(file))
    if (forbidden.length) throw new Error(`Hermes payload contains disallowed test/cache/build content: ${forbidden[0]}`)
    const sourceSitePackages = options.platform === 'win32-x64' ? 'python/Lib/site-packages/' : 'python/lib/python3.11/site-packages/'
    const requiredPythonSurfaces = profile.useAllExtras
      ? [
        'acp_adapter/', 'agent/', 'cron/', 'gateway/', 'hermes_cli/', 'plugins/', 'providers/', 'tools/',
        'run_agent.py', 'mcp_serve.py', 'model_tools.py', 'toolsets.py',
      ]
      : ['agent/', 'gateway/', 'hermes_cli/', 'providers/', 'run_agent.py', 'tui_gateway/']
    for (const surface of requiredPythonSurfaces) {
      if (!files.some(file => file.startsWith(`${sourceSitePackages}${surface}`))) {
        throw new Error(`Hermes payload is missing upstream Python surface: ${surface}`)
      }
    }
    const gatewayServer = await readFile(join(root, `${sourceSitePackages}tui_gateway/server.py`), 'utf8')
    if (gatewayServer.includes('Structured native Cron bridge') || gatewayServer.includes('disabled_toolsets_override')) {
      throw new Error('Hermes payload contains forbidden XMOS bridge or policy patch code')
    }
    if (profile.useAllExtras) {
      const requiredPluginSurfaces = [
        'browser', 'context_engine', 'cron_providers', 'dashboard_auth', 'hermes-achievements',
        'image_gen', 'kanban', 'memory', 'model-providers', 'observability', 'platforms',
        'security-guidance', 'teams_pipeline', 'video_gen', 'web',
      ]
      for (const surface of requiredPluginSurfaces) {
        if (!files.some(file => file.startsWith(`${sourceSitePackages}plugins/${surface}/`))) {
          throw new Error(`Hermes payload is missing upstream plugin surface: ${surface}`)
        }
      }
    }
    const upstreamInventory = JSON.parse(await readFile(join(root, 'upstream-inventory.json'), 'utf8'))
    if (upstreamInventory.schemaVersion !== 'xmos-hermes-upstream-inventory/1') {
      throw new Error('Hermes upstream inventory schema is invalid')
    }
    for (const [directory, entries] of Object.entries(upstreamInventory.runtimeTrees || {})) {
      for (const file of entries) {
        const installedFile = `${sourceSitePackages}${directory}/${file}`
        if (!files.includes(installedFile)) throw new Error(`Hermes payload omitted upstream runtime file: ${directory}/${file}`)
      }
    }
    for (const [directory, entries] of Object.entries(upstreamInventory.dataAssets || {})) {
      for (const file of entries) {
        const installedFile = `hermes-assets/${directory}/${file}`
        if (!files.includes(installedFile)) throw new Error(`Hermes payload omitted upstream data asset: ${directory}/${file}`)
      }
    }
    for (const directory of profile.includeOptionalAssets
      ? ['skills', 'optional-skills', 'optional-mcps', 'locales']
      : ['skills', 'locales']) {
      if (!files.some(file => file.startsWith(`hermes-assets/${directory}/`))) {
        throw new Error(`Hermes payload is missing upstream data assets: ${directory}`)
      }
    }
    if (profile.includeManagedNode) {
      const dashboardIndex = `${sourceSitePackages}hermes_cli/web_dist/index.html`
      const dashboardAssets = `${sourceSitePackages}hermes_cli/web_dist/assets/`
      const hasDashboardScript = files.some(file => file.startsWith(dashboardAssets) && file.endsWith('.js'))
      const hasDashboardStyles = files.some(file => file.startsWith(dashboardAssets) && file.endsWith('.css'))
      if (!files.includes(dashboardIndex) || !hasDashboardScript || !hasDashboardStyles) {
        throw new Error('Hermes payload is missing the built Dashboard static resources')
      }
      if (!files.some(file => file.startsWith(`${sourceSitePackages}plugins/platforms/photon/sidecar/node_modules/spectrum-ts/`))) {
        throw new Error('Hermes payload is missing the locked Photon spectrum-ts sidecar dependency')
      }
    }
    const capabilityCatalog = JSON.parse(await readFile(join(root, 'capability-catalog.json'), 'utf8'))
    const catalogIds = new Set((capabilityCatalog.capabilities || []).map(item => item.id))
    for (const capability of profile.capabilities) {
      if (!catalogIds.has(capability)) throw new Error(`Hermes capability catalog is missing: ${capability}`)
    }
    const nodeSpec = lock.aionCli.managedNode.platforms[options.platform]
    const nodeEntry = `managed-resources/node/${nodeSpec.directory}/${nodeSpec.entry}`
    const managedToolEntries = {
      ffmpeg: `managed-resources/tools/ffmpeg/${options.platform === 'win32-x64' ? 'ffmpeg.exe' : 'ffmpeg'}`,
      git: `managed-resources/tools/git/${options.platform === 'win32-x64' ? 'cmd/git.exe' : 'bin/git'}`,
      ripgrep: `managed-resources/tools/ripgrep/${options.platform === 'win32-x64' ? 'rg.exe' : 'rg'}`,
    }
    const browserDriver = `managed-resources/tools/agent-browser/${options.platform === 'win32-x64' ? 'agent-browser.exe' : 'agent-browser'}`
    const chromeSpec = lock.hermes.chromium.platforms[options.platform]
    const browserArchive = `managed-resources/browser/${chromeSpec.file}`
    if (profile.includeManagedNode && !files.includes(nodeEntry)) throw new Error(`Hermes payload is missing managed Node: ${nodeEntry}`)
    if (profile.includeManagedTools) {
      for (const [tool, toolEntry] of Object.entries(managedToolEntries)) {
        if (!files.includes(toolEntry)) throw new Error(`Hermes payload is missing managed ${tool}: ${toolEntry}`)
      }
    }
    if (profile.includeVoiceModel) {
      for (const file of lock.hermes.voiceModel.files) {
        const modelFile = `managed-resources/models/faster-whisper-base/${file.file}`
        if (!files.includes(modelFile)) throw new Error(`Hermes payload is missing locked voice model file: ${modelFile}`)
      }
    }
    if (profile.includeBrowserArchive) {
      if (!files.includes(browserDriver)) throw new Error(`Hermes payload is missing agent-browser: ${browserDriver}`)
      if (provenance.managedAssets?.browser?.archive !== browserArchive || provenance.managedAssets.browser.archiveSha256 !== chromeSpec.sha256) {
        throw new Error('Hermes browser archive provenance mismatch')
      }
      if (await sha256File(join(root, browserArchive)) !== chromeSpec.sha256) throw new Error('Hermes browser archive SHA-256 mismatch')
    }
    const unittestEntry = options.platform === 'win32-x64'
      ? 'python/Lib/unittest/__init__.py'
      : 'python/lib/python3.11/unittest/__init__.py'
    if (!files.includes(unittestEntry)) {
      throw new Error(`Hermes payload is missing production stdlib import closure: ${unittestEntry}`)
    }
    const sbomNames = new Set(sbom.components.map(component => String(component.name || '').toLowerCase()))
    const requiredSbomComponents = profile.useAllExtras
      ? ['hermes agent', 'cpython', 'node.js', 'git', 'ripgrep', 'ffmpeg', 'systran/faster-whisper-base', 'agent-browser', 'chrome for testing', 'anthropic', 'boto3', 'google-auth', 'mcp', 'agent-client-protocol']
      : ['hermes agent', 'cpython']
    for (const component of requiredSbomComponents) {
      if (!sbomNames.has(component)) throw new Error(`Hermes complete SBOM is missing component: ${component}`)
    }
    if (options.platform === hostRuntimePlatform()) {
      const pythonRoot = join(root, 'python')
      const probeHome = await mkdtemp(join(tmpdir(), 'xmos-hermes-import-probe-'))
      try {
        const importClosure = profile.useAllExtras
          ? 'from unittest.mock import Mock; import acp_adapter, anthropic, boto3, certifi, cryptography, gateway, google.auth, hermes_cli, mcp, PIL, plugins, psutil, pydantic_core, run_agent, tools, tui_gateway, websockets'
          : 'import certifi, cryptography, hermes_cli, psutil, pydantic_core, tui_gateway, websockets'
        await run(join(root, entry), ['-I', '-B', '-c', importClosure], {
          env: {
            ...process.env,
            HERMES_BUNDLED_SKILLS: join(root, 'hermes-assets/skills'),
            HERMES_DISABLE_LAZY_INSTALLS: '1',
            HERMES_HOME: probeHome,
            ...(profile.includeOptionalAssets ? { HERMES_OPTIONAL_SKILLS: join(root, 'hermes-assets/optional-skills') } : {}),
            HERMES_SKIP_NODE_BOOTSTRAP: '1', PIP_NO_INDEX: '1', PYTHONHOME: pythonRoot, PYTHONNOUSERSITE: '1', UV_OFFLINE: '1',
          },
        })
        if (profile.includeManagedNode) {
          const nodeVersion = await run(join(root, nodeEntry), ['--version'], { capture: true })
          if (!`${nodeVersion.stdout}\n${nodeVersion.stderr}`.includes(lock.aionCli.managedNode.version)) throw new Error('Hermes managed Node native version probe failed')
        }
        if (profile.includeManagedTools) {
          const gitVersion = await run(join(root, managedToolEntries.git), ['--version'], { capture: true })
          if (!`${gitVersion.stdout}\n${gitVersion.stderr}`.includes(lock.hermes.managedTools.git.version)) throw new Error('Hermes managed Git native version probe failed')
          const ripgrepVersion = await run(join(root, managedToolEntries.ripgrep), ['--version'], { capture: true })
          if (!`${ripgrepVersion.stdout}\n${ripgrepVersion.stderr}`.includes(lock.hermes.managedTools.ripgrep.version)) throw new Error('Hermes managed ripgrep native version probe failed')
          const ffmpegVersion = await run(join(root, managedToolEntries.ffmpeg), ['-version'], { capture: true })
          if (!`${ffmpegVersion.stdout}\n${ffmpegVersion.stderr}`.includes('ffmpeg version')) throw new Error('Hermes managed FFmpeg native version probe failed')
        }
        if (profile.includeBrowserArchive) {
          const browserVersion = await run(join(root, browserDriver), ['--version'], { capture: true })
          if (!`${browserVersion.stdout}\n${browserVersion.stderr}`.includes(lock.hermes.agentBrowser.version)) throw new Error('Hermes agent-browser native version probe failed')
        }
      } finally {
        await rm(probeHome, { force: true, recursive: true })
      }
    }
  } else {
    throw new Error('--runtime must be aion-cli or hermes')
  }
  if (!files.includes(entry)) throw new Error(`Payload runtime entry is missing: ${entry}`)
  const maximumGlibc = options.platform === 'linux-x64' ? await linuxGlibcGate(root, files) : null
  process.stdout.write(`${JSON.stringify({ entry, files: files.length, licenses: licenseFiles.length, maximumGlibc, platform: options.platform, runtime: options.runtime }, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

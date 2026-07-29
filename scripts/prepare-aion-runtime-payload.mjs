#!/usr/bin/env node

import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  assertDirectory,
  downloadLockedArtifact,
  extractArchive,
  hostRuntimePlatform,
  parseArgs,
  projectRoot,
  readRuntimeLock,
  run,
  sha256File,
  verifySha256,
  writeBuildMetadata,
  xmosBuildCacheRoot,
} from './lib/runtime-build.mjs'

function compareVersion(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0)
  }
  return 0
}

async function assertLinuxCompatibility(binary) {
  const result = await run('strings', [binary], { capture: true })
  const versions = [...result.stdout.matchAll(/GLIBC_(\d+\.\d+)/g)].map(match => match[1])
  const maximum = versions.sort(compareVersion).at(-1) ?? null
  if (maximum && compareVersion(maximum, '2.28') > 0) throw new Error(`Aion CLI requires GLIBC ${maximum}; Kylin gate is <= 2.28`)
  return maximum
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.output) throw new Error('Usage: --platform <target> --output <payload-dir> [--binary <aioncore>]')
  const { lock, lockPath, lockSha256 } = await readRuntimeLock(options.lock)
  const platform = options.platform || hostRuntimePlatform()
  const binarySpec = lock.aionCli.binaries[platform]
  const nodeSpec = lock.aionCli.managedNode.platforms[platform]
  if (!binarySpec || !nodeSpec) throw new Error(`Unsupported Aion CLI platform: ${platform}`)
  const source = resolve(options.binary || projectRoot, options.binary ? '' : binarySpec.path)
  let binaryProvenance = null
  if (options['binary-provenance']) {
    binaryProvenance = JSON.parse(await readFile(resolve(options['binary-provenance']), 'utf8'))
    if (binaryProvenance.schemaVersion !== 'xmos-aion-binary-provenance/1'
      || binaryProvenance.runtimeId !== lock.aionCli.runtimeId
      || binaryProvenance.version !== lock.aionCli.version
      || binaryProvenance.platform !== platform
      || binaryProvenance.source?.commit !== lock.aionCli.source.commit
      || binaryProvenance.sourceLockSha256 !== lockSha256) {
      throw new Error('Aion source-build provenance does not match runtimes/runtime-sources.lock.json')
    }
    await verifySha256(source, binaryProvenance.binarySha256, `Aion CLI ${platform}`)
  } else {
    await verifySha256(source, binarySpec.sha256, `Aion CLI ${platform}`)
  }
  const output = resolve(options.output)
  await rm(output, { force: true, recursive: true })
  await mkdir(output, { recursive: true })
  const targetName = platform === 'win32-x64' ? 'aioncore.exe' : 'aioncore'
  const target = join(output, targetName)
  await cp(source, target)
  if (platform !== 'win32-x64') await chmod(target, 0o755)

  const cacheRoot = resolve(options['cache-root'] || join(xmosBuildCacheRoot, 'runtime-cache'))
  const archive = await downloadLockedArtifact(nodeSpec, cacheRoot)
  const extracted = await mkdtemp(join(tmpdir(), 'xmos-node-runtime-'))
  try {
    await extractArchive(archive, extracted)
    const nodeRoot = join(extracted, nodeSpec.directory)
    await assertDirectory(nodeRoot, 'Managed Node archive root')
    const managedNodeRoot = join(output, 'managed-resources/node', nodeSpec.directory)
    await mkdir(join(output, 'managed-resources/node'), { recursive: true })
    await cp(nodeRoot, managedNodeRoot, { dereference: true, recursive: true })
    const nodeEntry = join(managedNodeRoot, nodeSpec.entry)
    if (!(await stat(nodeEntry)).isFile()) throw new Error(`Managed Node entry is missing: ${nodeSpec.entry}`)
    if (platform !== 'win32-x64') await chmod(nodeEntry, 0o755)

    let aionVersion = lock.aionCli.version
    let nodeVersion = lock.aionCli.managedNode.version
    if (platform === hostRuntimePlatform()) {
      const aionProbe = await run(target, ['--version'], { capture: true })
      const nodeProbe = await run(nodeEntry, ['--version'], { capture: true })
      aionVersion = /\b(\d+\.\d+\.\d+)\b/.exec(`${aionProbe.stdout}\n${aionProbe.stderr}`)?.[1] ?? aionVersion
      nodeVersion = /v(\d+\.\d+\.\d+)/.exec(`${nodeProbe.stdout}\n${nodeProbe.stderr}`)?.[1] ?? nodeVersion
    }
    if (aionVersion !== lock.aionCli.version) throw new Error(`Aion CLI version mismatch: ${aionVersion}`)
    if (nodeVersion !== lock.aionCli.managedNode.version) throw new Error(`Managed Node version mismatch: ${nodeVersion}`)

    let maximumGlibc = null
    if (platform === 'linux-x64') maximumGlibc = await assertLinuxCompatibility(target)
    const aionLicense = resolve(options.license || join(projectRoot, 'vendor/AionCore/LICENSE'))
    if (!(await stat(aionLicense)).isFile()) throw new Error(`AionCore LICENSE is missing: ${aionLicense}`)
    const nodeLicense = join(managedNodeRoot, 'LICENSE')
    const runtimeBinarySha256 = await sha256File(target)
    await writeBuildMetadata(output, {
      licenses: { 'AionCore-LICENSE.txt': aionLicense, 'Node.js-LICENSE.txt': nodeLicense },
      provenance: {
        schemaVersion: 'xmos-runtime-provenance/1',
        runtimeId: lock.aionCli.runtimeId,
        version: lock.aionCli.version,
        platform,
        source: lock.aionCli.source,
        sourceLock: { file: basename(lockPath), sha256: lockSha256 },
        binary: { format: binaryProvenance?.target || binarySpec.format, sha256: runtimeBinarySha256, maximumGlibc, sourceBuild: binaryProvenance },
        managedNode: { sha256: nodeSpec.sha256, version: nodeVersion },
        builder: { arch: process.arch, node: process.version, platform: process.platform },
      },
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        serialNumber: `urn:uuid:xmos-aion-cli-${platform}-${lock.aionCli.version}`,
        version: 1,
        metadata: { component: { type: 'application', name: 'Aion CLI Runtime', version: lock.aionCli.version } },
        components: [
          { type: 'application', name: 'AionCore', version: lock.aionCli.version, hashes: [{ alg: 'SHA-256', content: runtimeBinarySha256 }], licenses: [{ license: { id: 'MIT' } }] },
          { type: 'application', name: 'Node.js', version: nodeVersion, hashes: [{ alg: 'SHA-256', content: nodeSpec.sha256 }], licenses: [{ license: { id: 'MIT' } }] },
        ],
      },
    })
    await cp(lockPath, join(output, '.xmos-build', 'runtime-sources.lock.json'))
  } finally {
    await rm(extracted, { force: true, recursive: true })
  }
  process.stdout.write(`${JSON.stringify({ output, platform, runtimeEntry: targetName }, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

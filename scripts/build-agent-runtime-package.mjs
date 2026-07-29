#!/usr/bin/env node

import { createPrivateKey, sign } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { createDeterministicZip } from './lib/deterministic-zip.mjs'
import {
  HERMES_RUNTIME_CAPABILITIES,
  hermesCapabilityCatalog,
  hermesEditionArtifactVersion,
  hermesEditionPayloadProfile,
} from './lib/hermes-offline-layout.mjs'
import { parseArgs, readRuntimeLock, sha256File } from './lib/runtime-build.mjs'

const CAPABILITIES = {
  'aion-cli': ['chat.sessions', 'chat.history', 'chat.streaming', 'chat.cancel', 'reasoning', 'tools', 'approval', 'model.catalog', 'model.credentials', 'skills', 'mcp', 'cron'],
  hermes: HERMES_RUNTIME_CAPABILITIES,
}

function packageDefinition(kind, lock, edition) {
  if (kind === 'aion-cli') return {
    capabilities: CAPABILITIES[kind], displayName: 'Aion CLI',
    id: lock.aionCli.runtimeId, version: lock.aionCli.artifactVersion || lock.aionCli.version,
  }
  if (kind === 'hermes') return {
    capabilities: hermesEditionPayloadProfile(edition).capabilities, displayName: 'Hermes',
    id: lock.hermes.runtimeId, version: hermesEditionArtifactVersion(lock.hermes, edition),
  }
  throw new Error('--runtime must be aion-cli or hermes')
}

async function listFiles(directory, prefix = '') {
  const files = []
  const entries = await readdir(join(directory, prefix), { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(directory, path))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`Payload contains unsupported file type: ${path}`)
  }
  return files
}

function safePayloadEntry(payloadRoot, candidate) {
  const resolved = resolve(payloadRoot, candidate)
  const fromRoot = relative(payloadRoot, resolved)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith('../')) {
    throw new Error('--runtime-entry must name a file inside --payload-root')
  }
  return { relative: fromRoot.split(sep).join('/'), resolved }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ['runtime', 'platform', 'payload-root', 'runtime-entry', 'output', 'private-key']) {
    if (!args[required]) throw new Error(`Missing --${required}`)
  }
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'].includes(args.platform)) throw new Error('Unsupported --platform')
  const { lock } = await readRuntimeLock(args.lock)
  const isHermes = args.runtime === 'hermes'
  if (isHermes && !['lite', 'max'].includes(args.edition)) {
    throw new Error('Hermes Runtime packaging requires --edition lite or max')
  }
  const edition = isHermes ? args.edition : undefined
  const definition = packageDefinition(args.runtime, lock, edition)
  const sourceDefinition = args.runtime === 'hermes' ? lock.hermes.source : lock.aionCli.source
  if (!Array.isArray(sourceDefinition.patches) || sourceDefinition.patches.length !== 0) {
    throw new Error('纯净 Runtime ZIP 不允许 source patches；请先将 XMOS 业务改造迁移到客户端 Host Bridge')
  }
  const payloadRoot = resolve(args['payload-root'])
  if (!(await stat(payloadRoot)).isDirectory()) throw new Error('--payload-root must be a directory')
  const runtimeEntry = safePayloadEntry(payloadRoot, args['runtime-entry'])
  if (!(await stat(runtimeEntry.resolved)).isFile()) throw new Error('--runtime-entry must point to a file')

  const buildMetadataRoot = join(payloadRoot, '.xmos-build')
  const sbomPath = join(buildMetadataRoot, 'sbom.cdx.json')
  const provenancePath = join(buildMetadataRoot, 'provenance.json')
  const licenseRoot = join(buildMetadataRoot, 'licenses')
  const [sbom, provenance, licenseFiles] = await Promise.all([
    readFile(sbomPath, 'utf8').then(JSON.parse),
    readFile(provenancePath, 'utf8').then(JSON.parse),
    listFiles(licenseRoot),
  ])
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new Error('Payload must provide a non-empty CycloneDX SBOM')
  }
  if (provenance.runtimeId !== definition.id || provenance.platform !== args.platform) {
    throw new Error('Payload provenance does not match Runtime ID/platform')
  }
  if (isHermes && (provenance.edition !== edition || provenance.version !== definition.version)) {
    throw new Error('Payload provenance does not match the requested Hermes edition/version')
  }
  if (provenance.source?.patches != null && (!Array.isArray(provenance.source.patches) || provenance.source.patches.length !== 0)) {
    throw new Error('Payload provenance contains source patches; refusing to package bridge business code')
  }
  if (licenseFiles.length === 0) throw new Error('Payload must include third-party license files')

  const stage = await mkdtemp(join(tmpdir(), `xmos-${args.runtime}-runtime-`))
  const output = resolve(args.output)
  try {
    await Promise.all([
      mkdir(join(stage, 'licenses'), { recursive: true }),
      mkdir(dirname(output), { recursive: true }),
    ])
    await cp(payloadRoot, join(stage, 'payload'), { dereference: true, recursive: true })
    await rm(join(stage, 'payload/.xmos-build'), { force: true, recursive: true })
    await cp(licenseRoot, join(stage, 'licenses'), { dereference: true, recursive: true })
    await cp(sbomPath, join(stage, 'sbom.cdx.json'))
    await cp(provenancePath, join(stage, 'provenance.json'))
    if (args.platform !== 'win32-x64') {
      await chmod(join(stage, 'payload', runtimeEntry.relative), 0o755)
    }
    const version = args.version || definition.version
    if (isHermes && version !== definition.version) {
      throw new Error(`Hermes ${edition} must use signed lock version ${definition.version}`)
    }
    const releaseGeneration = isHermes ? (edition === 'max' ? 'V2' : 'V1') : undefined
    const displayName = isHermes
      ? (args['display-name'] || (edition === 'max' ? 'Hermes Max' : 'Hermes Lite'))
      : definition.displayName
    const capabilityCatalog = isHermes ? hermesCapabilityCatalog(args.platform, edition) : undefined
    const manifest = {
      schemaVersion: 2,
      publisherKeyId: args['publisher-key-id'] || lock.publisherKeyId,
      runtime: {
        id: definition.id, displayName, kind: args.runtime,
        version, platform: args.platform, minAppVersion: args['min-app-version'] || lock.minimumAppVersion,
        dataCompatibilityVersion: Number(args['data-compatibility-version'] || (releaseGeneration === 'V2' ? 2 : 1)),
        capabilities: definition.capabilities,
        ...(isHermes ? {
          capabilityCatalog,
          distributionRevision: version.split('+').at(-1),
          edition,
          releaseGeneration,
          upstreamCommit: lock.hermes.source.commit,
          upstreamLockSha256: lock.hermes.source.uvLockSha256,
          upstreamVersion: lock.hermes.version,
        } : {}),
      },
      entry: { runtime: `payload/${runtimeEntry.relative}` },
      bridge: {
        id: isHermes ? `builtin.hermes-${edition}` : 'builtin.aion-cli',
        protocol: 'xmos-host-runtime-bridge/1',
      },
      requirements: { diskMiB: Number(args['disk-mib'] || (isHermes ? (edition === 'max' ? 8192 : 1024) : 1024)) },
    }
    await writeFile(join(stage, 'agent-runtime.yaml'), stringifyYaml(manifest, { lineWidth: 120 }), 'utf8')

    const files = (await listFiles(stage)).filter(path => path !== 'files.sha256' && path !== 'signature.ed25519')
    const hashes = `${(await Promise.all(files.map(async path => `${await sha256File(join(stage, path))}  ${path}`))).join('\n')}\n`
    await writeFile(join(stage, 'files.sha256'), hashes, 'utf8')
    const privateKey = createPrivateKey(await readFile(resolve(args['private-key']), 'utf8'))
    const signature = sign(null, Buffer.from(hashes, 'utf8'), privateKey).toString('base64')
    await writeFile(join(stage, 'signature.ed25519'), `${JSON.stringify({ algorithm: 'ed25519', keyId: manifest.publisherKeyId, signature }, null, 2)}\n`, 'utf8')

    await rm(output, { force: true })
    await createDeterministicZip(stage, output, { sourceDateEpoch: lock.build.sourceDateEpoch })
    process.stdout.write(`${JSON.stringify({ output, runtimeId: definition.id, version, sha256: await sha256File(output) }, null, 2)}\n`)
  } finally {
    await rm(stage, { force: true, recursive: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

#!/usr/bin/env node

import { createHash, createPublicKey, verify } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { listFiles, sha256 } from './lib/artifact-utils.mjs'
import { run } from './lib/runtime-build.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const activeKeyId = 'xmos-runtime-release-2026-07'

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('Usage: --candidate-archive <artifact.zip> --private-key <key.pem> --output-dir <directory>')
    }
    result[key.slice(2)] = value
    index += 1
  }
  return result
}

async function extractZipFile(archive, destination) {
  const entries = (await run('unzip', ['-Z1', archive], { capture: true })).stdout
    .split(/\r?\n/).filter(Boolean)
  if (entries.length === 0) throw new Error(`Candidate archive is empty: ${archive}`)
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error(`Unsafe archive entry: ${entry}`)
    }
  }
  await mkdir(destination, { recursive: true })
  await run('unzip', ['-q', archive, '-d', destination])
}

async function matchingHistoricalLock(expectedSha256, staging) {
  const commits = (await run('git', ['log', '--all', '--format=%H', '--', 'runtimes/runtime-sources.lock.json'], { capture: true, cwd: repositoryRoot })).stdout
    .trim().split(/\r?\n/).filter(Boolean)
  for (const commit of commits) {
    const source = await run('git', ['show', `${commit}:runtimes/runtime-sources.lock.json`], { capture: true, cwd: repositoryRoot })
    const bytes = Buffer.from(source.stdout, 'utf8')
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) continue
    const output = join(staging, 'matched-runtime-sources.lock.json')
    await writeFile(output, bytes)
    return output
  }
  return null
}

async function fileExists(path) {
  try { await access(path); return true } catch { return false }
}

async function validateLegacyCandidate(payload, provenance, staging) {
  const raw = await readFile(join(repositoryRoot, 'runtimes/runtime-sources.lock.json'), 'utf8')
  const lock = JSON.parse(raw)
  const candidateBinary = await sha256(join(payload, 'aioncore.exe'))
  const nodePath = `managed-resources/node/${lock.aionCli.managedNode.platforms['win32-x64'].directory}/node.exe`
  const sbom = JSON.parse(await readFile(join(payload, '.xmos-build', 'sbom.cdx.json'), 'utf8'))
  const licenseFiles = (await listFiles(join(payload, '.xmos-build', 'licenses'))).filter(Boolean)
  const binaryComponent = sbom.components?.find(component => component.name === 'AionCore')
  const nodeComponent = sbom.components?.find(component => component.name === 'Node.js')
  const binaryHash = binaryComponent?.hashes?.find(hash => hash.alg === 'SHA-256')?.content
  const nodeHash = nodeComponent?.hashes?.find(hash => hash.alg === 'SHA-256')?.content
  if (provenance.source?.commit !== lock.aionCli.source.commit
    || provenance.version !== lock.aionCli.version
    || provenance.source?.patches?.length !== 0
    || provenance.managedNode?.version !== lock.aionCli.managedNode.version
    || provenance.managedNode?.sha256 !== lock.aionCli.managedNode.platforms['win32-x64'].sha256
    || provenance.binary?.sha256 !== candidateBinary
    || provenance.binary?.sourceBuild?.binarySha256 !== candidateBinary
    || provenance.binary?.sourceBuild?.source?.commit !== lock.aionCli.source.commit
    || provenance.binary?.sourceBuild?.sourceLockSha256 !== provenance.sourceLock?.sha256
    || binaryHash !== candidateBinary
    || nodeHash !== provenance.managedNode.sha256
    || licenseFiles.length < 2
    || !(await fileExists(join(payload, nodePath)))) {
    throw new Error('Legacy candidate cannot be attested against the current source pins')
  }
  lock.aionCli.binaries['win32-x64'].sha256 = candidateBinary
  const output = join(staging, 'legacy-candidate-validation-lock.json')
  await writeFile(output, `${JSON.stringify(lock, null, 2)}\n`)
  return output
}

async function verifySignedPackage(zipPath, trustPath) {
  const scratch = await mkdtemp(join(tmpdir(), 'xmos-signed-runtime-verify-'))
  try {
    await extractZipFile(zipPath, scratch)
    const [trust, hashesRaw, signature] = await Promise.all([
      readFile(trustPath, 'utf8').then(JSON.parse),
      readFile(join(scratch, 'files.sha256'), 'utf8'),
      readFile(join(scratch, 'signature.ed25519'), 'utf8').then(JSON.parse),
    ])
    const manifest = parseYaml(await readFile(join(scratch, 'agent-runtime.yaml'), 'utf8'))
    const publicPem = trust.keys?.[signature.keyId]
    if (!publicPem || signature.algorithm !== 'ed25519' || manifest.publisherKeyId !== signature.keyId) {
      throw new Error('Signed Runtime publisher identity is invalid')
    }
    if (!verify(null, Buffer.from(hashesRaw, 'utf8'), createPublicKey(publicPem), Buffer.from(signature.signature, 'base64'))) {
      throw new Error('Signed Runtime Ed25519 verification failed')
    }
    const expected = new Map()
    for (const line of hashesRaw.trimEnd().split('\n')) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
      if (!match || expected.has(match[2])) throw new Error('Signed Runtime hash manifest is invalid')
      expected.set(match[2], match[1])
    }
    const files = (await listFiles(scratch)).filter(path => path !== 'files.sha256' && path !== 'signature.ed25519')
    if (files.length !== expected.size) throw new Error('Signed Runtime file list does not match files.sha256')
    for (const path of files) {
      if (expected.get(path) !== await sha256(join(scratch, path))) throw new Error(`Signed Runtime file hash mismatch: ${path}`)
    }
    return { runtimeId: manifest.runtime.id, version: manifest.runtime.version, platform: manifest.runtime.platform }
  } finally {
    await rm(scratch, { force: true, recursive: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const key of ['candidate-archive', 'private-key', 'output-dir']) if (!args[key]) throw new Error(`Missing --${key}`)
  const candidate = resolve(args['candidate-archive'])
  const privateKey = resolve(args['private-key'])
  const outputDirectory = resolve(args['output-dir'])
  const trustPath = join(repositoryRoot, 'runtimes/runtime-trust.json')
  const scratch = await mkdtemp(join(tmpdir(), 'xmos-aion-windows-sign-'))
  try {
    const payload = join(scratch, 'payload')
    process.stdout.write('1/5 解压并检查候选包…\n')
    await extractZipFile(candidate, payload)
    const provenance = JSON.parse(await readFile(join(payload, '.xmos-build', 'provenance.json'), 'utf8'))
    if (provenance.runtimeId !== 'xmos.aion-cli' || provenance.platform !== 'win32-x64') {
      throw new Error('Candidate is not an Aion CLI Windows x64 payload')
    }
    const embeddedLock = join(payload, '.xmos-build', 'runtime-sources.lock.json')
    let lockPath = await matchingHistoricalLock(provenance.sourceLock?.sha256, scratch)
    let exactSourceLock = Boolean(lockPath)
    if (!lockPath && await fileExists(embeddedLock)) {
      const raw = await readFile(embeddedLock)
      if (createHash('sha256').update(raw).digest('hex') === provenance.sourceLock?.sha256) {
        lockPath = embeddedLock
        exactSourceLock = true
      }
    }
    if (!lockPath) lockPath = await validateLegacyCandidate(payload, provenance, scratch)
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    const output = join(outputDirectory, `xmos.aion-cli-${lock.aionCli.artifactVersion}-win32-x64.zip`)
    process.stdout.write('2/5 校验候选包的来源、文件与 SBOM…\n')
    if (exactSourceLock) {
      await run(process.execPath, ['scripts/verify-runtime-payload.mjs', '--runtime', 'aion-cli', '--platform', 'win32-x64', '--payload-root', payload, '--lock', lockPath], { cwd: repositoryRoot })
    } else {
      process.stdout.write('  注：旧候选包未内置 source lock，已按上游提交、二进制、Node、SBOM 与许可证完成兼容校验。\n')
    }
    process.stdout.write('3/5 校验本地 Ed25519 签名私钥…\n')
    await run(process.execPath, ['scripts/verify-runtime-signing-key.mjs', '--private-key', privateKey, '--trust', trustPath, '--key-id', activeKeyId], { cwd: repositoryRoot })
    await mkdir(outputDirectory, { recursive: true })
    process.stdout.write('4/5 生成已签名 Runtime ZIP…\n')
    await run(process.execPath, [
      'scripts/build-agent-runtime-package.mjs', '--runtime', 'aion-cli', '--platform', 'win32-x64',
      '--payload-root', payload, '--runtime-entry', 'aioncore.exe', '--output', output,
      '--private-key', privateKey, '--publisher-key-id', activeKeyId, '--lock', lockPath,
      '--upstream-lock-sha', provenance.sourceLock.sha256,
    ], { cwd: repositoryRoot })
    process.stdout.write('5/5 复验签名与 ZIP 内全部文件哈希…\n')
    const verified = await verifySignedPackage(output, trustPath)
    const digest = await sha256(output)
    await writeFile(join(outputDirectory, 'SHA256SUMS'), `${digest}  ${basename(output)}\n`, 'utf8')
    await writeFile(join(outputDirectory, 'signing-attestation.json'), `${JSON.stringify({
      schemaVersion: 'xmos-runtime-signing-attestation/1',
      candidate: basename(candidate), candidateSha256: await sha256(candidate),
      sourceLockSha256: provenance.sourceLock.sha256, exactSourceLock,
      signedPackage: basename(output), signedPackageSha256: digest,
    }, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify({ output, sha256: digest, verified }, null, 2)}\n`)
  } finally {
    await rm(scratch, { force: true, recursive: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

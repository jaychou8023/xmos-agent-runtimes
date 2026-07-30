#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import extractZip from 'extract-zip'
import { parse as parseYaml } from 'yaml'
import { Client as MinioClient } from 'minio'
import {
  mergeRuntimeCatalog,
  parsePublishArgs,
  requireGhAuthentication,
  resolveMinioCredentials,
  runtimeReleaseTargets,
} from './lib/runtime-release-catalog.mjs'
import { readRuntimeLock, run, sha256File } from './lib/runtime-build.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')

async function listFiles(root, prefix = '') {
  const result = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...await listFiles(root, child))
    else if (entry.isFile()) result.push(child)
    else throw new Error(`Unsupported file type in release asset: ${child}`)
  }
  return result
}

function minioClient({ endpoint, region, accessKey, secretKey }) {
  const url = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`)
  return new MinioClient({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    useSSL: url.protocol === 'https:',
    accessKey,
    secretKey,
    region,
    pathStyle: true,
  })
}

async function objectExists(client, bucket, objectKey) {
  try {
    await client.statObject(bucket, objectKey)
    return true
  } catch (error) {
    if (['NotFound', 'NoSuchKey'].includes(error.code)) return false
    return false
  }
}

async function readObjectText(client, bucket, objectKey) {
  const stream = await client.getObject(bucket, objectKey)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function downloadPrefix(client, bucket, objectPrefix, destination) {
  await mkdir(destination, { recursive: true })
  const objects = []
  const stream = client.listObjectsV2(bucket, objectPrefix, true)
  for await (const item of stream) {
    if (!item.name) continue
    objects.push(item.name)
  }
  if (objects.length === 0) throw new Error(`MinIO candidate prefix is empty: s3://${bucket}/${objectPrefix}`)
  for (const objectKey of objects) {
    const target = join(destination, relative(objectPrefix, objectKey))
    await mkdir(dirname(target), { recursive: true })
    await client.fGetObject(bucket, objectKey, target)
  }
  return objects
}

async function uploadDirectory(client, bucket, sourceRoot, objectPrefix) {
  const files = await listFiles(sourceRoot)
  for (const file of files) {
    await client.fPutObject(bucket, `${objectPrefix}/${file}`, join(sourceRoot, file))
  }
  return files
}

async function sha256Stream(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

async function readManifestFromZip(zipPath) {
  const scratch = await mkdtemp(join(tmpdir(), 'xmos-runtime-manifest-'))
  try {
    await extractZip(zipPath, { dir: scratch })
    return parseYaml(await readFile(join(scratch, 'agent-runtime.yaml'), 'utf8'))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function gitCommit() {
  try {
    const result = await run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, capture: true })
    return result.stdout.trim()
  } catch {
    return 'unknown'
  }
}

function verifyArgs(args) {
  for (const required of ['run_id', 'private_key']) {
    if (!args[required]) throw new Error(`Missing --${required.replaceAll('_', '-')}`)
  }
  return args
}

async function signTarget(target, payloadRoot, outputDirectory, args) {
  const verifyArgsList = target.packageRuntime === 'hermes'
    ? ['scripts/verify-runtime-payload.mjs', '--runtime', 'hermes', '--edition', target.edition, '--platform', target.platform, '--payload-root', payloadRoot]
    : ['scripts/verify-runtime-payload.mjs', '--runtime', 'aion-cli', '--platform', target.platform, '--payload-root', payloadRoot]
  await run(process.execPath, verifyArgsList, { cwd: repositoryRoot })

  const outputZip = join(outputDirectory, target.filename)
  const packageArgs = [
    'scripts/build-agent-runtime-package.mjs',
    '--runtime', target.packageRuntime,
    '--platform', target.platform,
    '--payload-root', payloadRoot,
    '--runtime-entry', target.runtimeEntry,
    '--output', outputZip,
    '--private-key', resolve(args.private_key),
  ]
  if (target.edition) packageArgs.push('--edition', target.edition)
  await run(process.execPath, packageArgs, { cwd: repositoryRoot })

  await run('unzip', ['-t', outputZip], { cwd: repositoryRoot })
  const sha256 = await sha256File(outputZip)
  await writeFile(join(outputDirectory, 'SHA256SUMS'), `${sha256}  ${basename(outputZip)}\n`, 'utf8')
  const manifest = await readManifestFromZip(outputZip)
  const sizeBytes = (await stat(outputZip)).size
  return {
    filename: basename(outputZip),
    sha256,
    sizeBytes,
    publisherKeyId: manifest.publisherKeyId,
    minAppVersion: manifest.runtime?.minAppVersion,
  }
}

async function main() {
  const args = verifyArgs(parsePublishArgs(process.argv.slice(2)))
  requireGhAuthentication({ skip: args.skip_gh_auth_check === 'true' })
  const credentials = await resolveMinioCredentials({ accessKey: args.access_key })
  const { lock } = await readRuntimeLock()
  const targets = runtimeReleaseTargets(lock, args.runtime)
  const client = minioClient({ endpoint: args.endpoint, region: args.region, ...credentials })
  const exists = await client.bucketExists(args.bucket)
  if (!exists) throw new Error(`Bucket 不存在或不可访问: ${args.bucket}`)

  const stage = await mkdtemp(join(tmpdir(), 'xmos-runtime-release-publish-'))
  const entries = []
  try {
    for (const target of targets) {
      const candidatePrefix = `${args.prefix}/candidates/${target.runtimeSlug}/${target.version}/${args.run_id}/${target.platform}`
      const payloadRoot = join(stage, 'payloads', target.runtimeSlug, target.version, target.platform)
      const releaseRoot = join(stage, 'releases', target.runtimeSlug, target.version, target.platform)
      process.stdout.write(`准备 ${target.runtimeSlug} ${target.version} ${target.platform}\n`)
      await downloadPrefix(client, args.bucket, candidatePrefix, payloadRoot)
      await mkdir(releaseRoot, { recursive: true })
      const signed = await signTarget(target, payloadRoot, releaseRoot, args)
      const releasePrefix = `${args.prefix}/releases/${target.runtimeSlug}/${target.version}/${target.platform}`
      if (!args.dryRun) await uploadDirectory(client, args.bucket, releaseRoot, releasePrefix)
      entries.push({
        runtimeSlug: target.runtimeSlug,
        runtimeId: target.runtimeId,
        displayName: target.displayName,
        edition: target.edition,
        version: target.version,
        platform: {
          platform: target.platform,
          filename: signed.filename,
          objectKey: `${releasePrefix}/${signed.filename}`,
          sha256: signed.sha256,
          sizeBytes: signed.sizeBytes,
          publisherKeyId: signed.publisherKeyId,
          minAppVersion: signed.minAppVersion,
        },
      })
    }

    const catalogKey = `${args.prefix}/metadata/catalog.json`
    let previousCatalog = null
    if (await objectExists(client, args.bucket, catalogKey)) {
      previousCatalog = JSON.parse(await readObjectText(client, args.bucket, catalogKey))
    }
    const catalog = mergeRuntimeCatalog(previousCatalog, {
      bucket: args.bucket,
      prefix: args.prefix,
      source: {
        repository: 'xmos-agent-runtimes',
        githubRunId: String(args.run_id),
        commit: await gitCommit(),
      },
      entries,
    })
    const catalogPath = join(stage, 'catalog.json')
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    if (!args.dryRun) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      await client.fPutObject(args.bucket, catalogKey, catalogPath)
      await client.fPutObject(args.bucket, `${args.prefix}/metadata/catalog-${timestamp}.json`, catalogPath)
    }
    process.stdout.write(`${JSON.stringify({
      dryRun: args.dryRun,
      bucket: args.bucket,
      prefix: args.prefix,
      releases: entries.length,
      catalogSha256: await sha256Stream(catalogPath),
    }, null, 2)}\n`)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

#!/usr/bin/env node

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { hostRuntimePlatform, parseArgs, readRuntimeLock, run, sha256File } from './lib/runtime-build.mjs'

const TARGETS = {
  'darwin-arm64': { extension: '', target: null },
  'darwin-x64': { extension: '', target: null },
  'win32-x64': { extension: '.exe', target: 'x86_64-pc-windows-msvc' },
  'linux-x64': { extension: '', target: 'x86_64-unknown-linux-gnu' },
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
    if (!options.output) throw new Error('Usage: --platform <target> --output <aioncore> [--license-output <LICENSE>]')
  const { lock, lockSha256 } = await readRuntimeLock(options.lock)
  if (!Array.isArray(lock.aionCli.source.patches) || lock.aionCli.source.patches.length !== 0) {
    throw new Error('Aion Runtime 只能从无 XMOS 补丁的上游提交构建')
  }
  const platform = options.platform || hostRuntimePlatform()
  const target = TARGETS[platform]
  if (!target) throw new Error(`Unsupported Aion CLI build platform: ${platform}`)
  if (platform !== hostRuntimePlatform()) throw new Error(`Aion CLI native build requires ${platform}; current host is ${hostRuntimePlatform()}`)
  const checkout = await mkdtemp(join(tmpdir(), `xmos-aion-source-${platform}-`))
  try {
    await run('git', ['clone', '--filter=blob:none', '--no-checkout', lock.aionCli.source.repository, checkout])
    await run('git', ['checkout', '--detach', lock.aionCli.source.commit], { cwd: checkout })
    const toolchain = (await run('rustc', ['--version'], { capture: true })).stdout.trim()
    if (!toolchain.includes(`rustc ${lock.aionCli.source.rustToolchain}`)) {
      throw new Error(`Rust toolchain mismatch: expected ${lock.aionCli.source.rustToolchain}, got ${toolchain}`)
    }
    const buildArgs = ['build', '--release', '--locked', '-p', 'aionui-app']
    if (target.target) buildArgs.push('--target', target.target)
    await run('cargo', buildArgs, { cwd: checkout, env: { ...process.env, SOURCE_DATE_EPOCH: String(lock.build.sourceDateEpoch) } })
    const built = target.target
      ? join(checkout, 'target', target.target, 'release', `aioncore${target.extension}`)
      : join(checkout, 'target/release', `aioncore${target.extension}`)
    const output = resolve(options.output)
    await mkdir(dirname(output), { recursive: true })
    await cp(built, output)
    let licenseOutput
    if (options['license-output']) {
      licenseOutput = resolve(options['license-output'])
      await mkdir(dirname(licenseOutput), { recursive: true })
      await cp(join(checkout, 'LICENSE'), licenseOutput)
    }
    const binarySha256 = await sha256File(output)
    const provenance = {
      schemaVersion: 'xmos-aion-binary-provenance/1',
      runtimeId: lock.aionCli.runtimeId,
      version: lock.aionCli.version,
      platform,
      source: lock.aionCli.source,
      sourceLockSha256: lockSha256,
      binarySha256,
      target: target.target || 'native',
      toolchain,
    }
    const provenancePath = `${output}.provenance.json`
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify({ output, provenance: provenancePath, license: licenseOutput, sha256: binarySha256 }, null, 2)}\n`)
  } finally {
    await rm(checkout, { force: true, recursive: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

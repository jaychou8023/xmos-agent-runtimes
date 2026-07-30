import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergeRuntimeCatalog,
  normalizeRuntimePrefix,
  parsePublishArgs,
  runtimeReleaseTargets,
} from './runtime-release-catalog.mjs'

const lock = {
  minimumAppVersion: '0.1.2',
  aionCli: {
    runtimeId: 'xmos.aion-cli',
    artifactVersion: '0.1.36+xmos.1',
  },
  hermes: {
    runtimeId: 'xmos.hermes',
    artifactVersions: {
      lite: '0.18.2+xmos.3',
      max: '0.18.2+xmos.2',
    },
  },
}

test('runtimeReleaseTargets expands all currently release-validated runtimes', () => {
  const targets = runtimeReleaseTargets(lock, 'all')
  assert.deepEqual(
    targets.map(item => `${item.runtimeSlug}:${item.version}:${item.platform}`).sort(),
    [
      'aion-cli:0.1.36+xmos.1:darwin-arm64',
      'aion-cli:0.1.36+xmos.1:darwin-x64',
      'aion-cli:0.1.36+xmos.1:linux-x64',
      'aion-cli:0.1.36+xmos.1:win32-x64',
      'hermes-lite:0.18.2+xmos.3:darwin-arm64',
      'hermes-lite:0.18.2+xmos.3:darwin-x64',
      'hermes-lite:0.18.2+xmos.3:linux-x64',
      'hermes-lite:0.18.2+xmos.3:win32-x64',
      'hermes-max:0.18.2+xmos.2:darwin-arm64',
    ],
  )
})

test('parsePublishArgs rejects MinIO secret on the command line', () => {
  assert.throws(
    () => parsePublishArgs(['--run-id', '123', '--secret-key', 'plain-text']),
    /不要通过命令行传入 MinIO secretKey/,
  )
})

test('normalizeRuntimePrefix trims leading and trailing slashes', () => {
  assert.equal(normalizeRuntimePrefix('/runtimes/'), 'runtimes')
})

test('mergeRuntimeCatalog upserts platforms without dropping other releases', () => {
  const previous = {
    schemaVersion: 'xmos-runtime-catalog/1',
    bucket: 'xmos',
    prefix: 'runtimes',
    source: { repository: 'xmos-agent-runtimes', githubRunId: '1', commit: 'old' },
    releases: [{
      runtimeSlug: 'aion-cli',
      runtimeId: 'xmos.aion-cli',
      displayName: 'Aion CLI',
      edition: null,
      version: '0.1.35+xmos.1',
      platforms: [{ platform: 'darwin-arm64', sha256: 'a'.repeat(64) }],
    }],
  }
  const merged = mergeRuntimeCatalog(previous, {
    bucket: 'xmos',
    prefix: 'runtimes',
    source: { repository: 'xmos-agent-runtimes', githubRunId: '2', commit: 'new' },
    entries: [{
      runtimeSlug: 'aion-cli',
      runtimeId: 'xmos.aion-cli',
      displayName: 'Aion CLI',
      edition: null,
      version: '0.1.36+xmos.1',
      platform: {
        platform: 'darwin-arm64',
        filename: 'xmos.aion-cli-0.1.36+xmos.1-darwin-arm64.zip',
        objectKey: 'runtimes/releases/aion-cli/0.1.36+xmos.1/darwin-arm64/xmos.aion-cli-0.1.36+xmos.1-darwin-arm64.zip',
        sha256: 'b'.repeat(64),
        sizeBytes: 100,
        publisherKeyId: 'xmos-runtime-release-2026-07',
        minAppVersion: '0.1.2',
      },
    }],
  })

  assert.equal(merged.releases.length, 2)
  assert.equal(merged.source.githubRunId, '2')
  assert.equal(merged.releases.find(item => item.version === '0.1.36+xmos.1').platforms[0].objectKey.includes('/releases/'), true)
})

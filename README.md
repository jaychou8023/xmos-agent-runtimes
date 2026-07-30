# XMOS Agent Runtimes

This repository manages the source locks, reproducible builds, verification evidence and releases for XMOS Agent Runtime ZIP packages.

## Scope

- Aion CLI (`xmos.aion-cli`)
- Hermes Lite (`xmos.hermes`, V1 package generation)
- Hermes Max (`xmos.hermes`, V2 package generation)
- Offline payload provenance, SBOMs, licenses, hashes and signed ZIP releases

The XMOS desktop application's Host Bridges, permission system, credentials, session routing and audit implementation stay in the desktop repository. A Runtime ZIP must never contain dynamic XMOS adapter or hook code.

## Automation model

1. A scheduled Action checks upstream Aion and Hermes tags.
2. A detected tag creates a review PR under `automation/upstream-*`.
3. After review, native runners build unsigned candidate payloads and run verification.
4. Verified unsigned candidates are mirrored automatically to the private MinIO candidate path.
5. A trusted macOS machine signs reviewed candidates with Ed25519.
6. The signed ZIPs, SHA-256 sums and Runtime catalog are uploaded to the formal MinIO release path.

See [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md) for the release gate, [docs/MINIO.md](docs/MINIO.md) for object-storage configuration, and [docs/SIGNING_RUNNER.md](docs/SIGNING_RUNNER.md) to register the trusted signing Mac.

Candidate workflows are [Build Aion Runtime candidates](.github/workflows/build-aion-runtime-candidates.yml) and [Build Hermes Runtime candidates](.github/workflows/build-hermes-runtime-candidates.yml). They build and verify unsigned payloads before uploading them to GitHub Artifacts and the MinIO candidate prefix. Hermes Lite is built for all supported platforms; Hermes Max is limited to macOS ARM64 until its other platform dependency closures pass release validation.

## Publish signed releases from the trusted Mac

```bash
npm run runtime:release:publish -- \
  --runtime all \
  --run-id <github-run-id> \
  --endpoint https://s3.sgcc.zip \
  --bucket xmos \
  --prefix runtimes \
  --private-key ~/.xmos-signing/xmos-runtime-release-2026-07.pem
```

The script checks `gh auth status`, downloads candidates from `runtimes/candidates/...`, verifies payloads, signs ZIPs locally, uploads `runtimes/releases/...`, and refreshes `runtimes/metadata/catalog.json` for XMOS 云中心同步.

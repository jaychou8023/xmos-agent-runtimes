# Candidate build and signing handoff

## Aion candidate build

Run **Actions → Build Aion Runtime candidates → Run workflow**. The workflow builds `darwin-arm64`, `darwin-x64`, `win32-x64` and `linux-x64` from the exact source lock, validates each payload, uploads a GitHub Actions artifact and mirrors the verified unsigned payload to MinIO.

The MinIO destination is:

```text
s3://xmos-agent/runtimes/candidates/aion-cli/<version>/<run-id>/<platform>/
```

This directory is a build candidate, not a loadable Agent Runtime ZIP. It has no `signature.ed25519` and must not be imported into XMOS.

## Trusted-machine signing

After the candidate payload has passed runtime-host and clean-target checks, download it to the trusted release machine. Keep the Ed25519 private key outside this repository and use the retained package script there:

```bash
npm ci
node scripts/build-agent-runtime-package.mjs \
  --runtime aion-cli \
  --platform darwin-arm64 \
  --payload-root /verified/aion-cli/darwin-arm64 \
  --runtime-entry aioncore \
  --output /release/xmos.aion-cli-<version>-darwin-arm64.zip \
  --private-key /secure/path/xmos-runtime-release-private-key.pem
```

The script creates the manifest, files list, SBOM/license copy, Ed25519 signature and deterministic ZIP. Upload only the resulting signed ZIP and its checksum to the formal `releases/` prefix.

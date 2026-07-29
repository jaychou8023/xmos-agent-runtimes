# Trusted Runtime signing runner

The Aion candidate workflow produces unsigned payloads. The `Sign Aion Runtime release` workflow automatically turns a successful main-branch candidate run into importable signed ZIPs, but only on a dedicated macOS self-hosted runner.

## 1. Prepare the private key on the signing Mac

The trusted publisher public key already committed in `runtimes/runtime-trust.json` is `xmos-runtime-release-2026`. Copy its matching Ed25519 private key to a directory readable only by the signing account, for example:

```text
/Users/liyc/.xmos-signing/xmos-runtime-release-2026.pem
```

Do not put the private key in this repository, GitHub Secrets, MinIO, chat logs or a Runtime ZIP. Restrict the file to its owner:

```bash
chmod 600 /Users/liyc/.xmos-signing/xmos-runtime-release-2026.pem
```

Before registering the runner, verify that this is the private half of the already trusted key:

```bash
cd /Users/liyc/Documents/xmos-agent-runtimes
node scripts/verify-runtime-signing-key.mjs \
  --private-key /Users/liyc/.xmos-signing/xmos-runtime-release-2026.pem
```

If this check says the key does not match, stop. Do not create a new key until the XMOS desktop application's trusted public-key list is updated and released.

## 2. Register the current Mac as the signing runner

In GitHub: **xmos-agent-runtimes → Settings → Actions → Runners → New self-hosted runner → macOS**. Run the generated commands on this Mac. During configuration, add the custom label:

```text
xmos-runtime-signer
```

The workflow targets `self-hosted`, `macOS`, and `xmos-runtime-signer`, so ordinary developer runners cannot obtain signing work.

Install the runner as a background service under the same macOS user that can read the private key. Set these environment variables in that runner service environment, not in GitHub:

```text
XMOS_RUNTIME_SIGNING_KEY_PATH=/Users/liyc/.xmos-signing/xmos-runtime-release-2026.pem
XMOS_RUNTIME_SIGNING_KEY_ID=xmos-runtime-release-2026
```

The runner also needs Node.js 24 or permission for `actions/setup-node` to install it, plus outbound access to GitHub, MinIO, and locked dependency sources.

## 3. Result

When `Build Aion Runtime candidates` succeeds on `main`, GitHub automatically invokes the signing workflow. The signing Mac verifies the candidate and private-key/public-key match, then produces:

```text
xmos.aion-cli-<version>-<platform>.zip
SHA256SUMS
```

The formal importable ZIPs are mirrored to:

```text
s3://xmos/agent/runtimes/releases/aion-cli/<version>/<platform>/
```

Download the ZIP from this `releases/` path and import it from XMOS **Agent Runtime** management. Do not use the unsigned `candidates/` path as an import source.

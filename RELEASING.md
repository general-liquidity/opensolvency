# Releasing

Every package in this repo publishes from CI via [`.github/workflows/release.yml`](.github/workflows/release.yml)
using **OIDC Trusted Publishing** — there are **no tokens to store or rotate**. Each
registry trusts this workflow directly; GitHub mints a short-lived identity per run.

## One-time setup (per registry, on the registry's own website)

You configure a *trusted publisher* once. Nothing is stored in GitHub except an
opt-in variable. For all three, the publisher is: **GitHub** owner `general-liquidity`,
repo `agentworth`, workflow file `release.yml`.

| Registry | Where | Notes |
|---|---|---|
| **PyPI** | Account → Publishing → *Add a pending publisher* | Fully tokenless, **including the first publish** (pending publishers cover not-yet-existing projects). |
| **npm** | each package page → *Settings → Trusted Publisher* | The `agentworth` + `…-mcp` packages are new (renamed from `opensolvency`), and npm can only add a trusted publisher on an existing package, so do **one** initial `npm publish` with a token to claim each name, then configure the trusted publisher and never use a token again. Needs npm ≥ 11.5 (the workflow upgrades it). Provenance is automatic. |
| **crates.io** | crate → *Settings → Trusted Publishing* | A crate must exist before a trusted publisher can be added. The `agentworth` crate is new, so do **one** initial `cargo publish` with a token to claim the name, then add the trusted publisher and never use a token again. |

Then, in **Settings → Variables → Actions**, set the opt-in flag(s):
`PUBLISH_NPM=true`, `PUBLISH_PYPI=true`, `PUBLISH_CRATES=true`. With a variable unset
that job is skipped, so the workflow is safe to land before anything is configured.

## Cutting a release

1. Bump the version in each package you're releasing:
   - `package.json` + `src/version.ts` (npm main), `agentworth-mcp/package.json`
   - `clients/python/pyproject.toml`, `clients/rust/Cargo.toml`
2. Update `CHANGELOG.md`.
3. Commit, then tag and push:
   ```bash
   git tag v0.1.1 && git push origin v0.1.1
   ```
   The tag triggers `release.yml`; each enabled registry publishes. (Or run the
   workflow manually from the Actions tab via *workflow_dispatch*.)

With OIDC trusted publishing, npm attaches **provenance** automatically, so each
release carries a signed attestation that it was built from this repo + commit.

## Go (no registry — git is the registry)

The Go client is consumed straight from the repo, so "publishing" is just a tag in
the **subdirectory module** form Go expects:

```bash
git tag clients/go/v0.1.1 && git push origin clients/go/v0.1.1
```

Consumers then `go get github.com/general-liquidity/agentworth/clients/go@v0.1.1`.

## C / C++

No central registry. Distributed as source (`clients/c/agentworth.{c,h}`), vendored
into a build or packaged via vcpkg / Conan downstream. The release is the git tag.

## Name availability (check before the first publish)

The npm names are owned by the `general-liquidity` org. Verify the others are free
before enabling their jobs: `pip index versions agentworth` (PyPI) and
`cargo search agentworth` (crates.io). If taken, scope/rename in the manifest.

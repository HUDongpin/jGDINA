# Changelog

All notable changes to jGDINA are documented in this file. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); release candidates
are intentionally published under a prerelease version and npm `next` tag.

## [Unreleased]

No changes yet.

## [1.0.0-rc.1] - 2026-07-16

### Added

- A standalone TypeScript implementation of the binary, single-group GDINA,
  DINA, and DINO closed-form EM estimator.
- Saturated and fixed class priors, missing responses, deterministic starts,
  row aggregation, full and score-only posterior modes, classifications, fit
  statistics, typed-array kernels, and conservative resource guards.
- Direct, browser Web Worker, Node worker-pool, and Next.js App Router adapters.
- Independent base-R golden fixtures and upstream C++ fast-kernel comparison.
- ECPE and Tatsuoka real-data acceptance gates, a complete installed-package
  wrapper audit, and a browser-verified technical acceptance report.
- Seven separately packable GPL-3.0-only packages with frozen upstream
  provenance, complete preferred TypeScript source, standalone pinned rebuild
  controls, cancellation, structured errors, tests, and examples.
- A retained local offline RC bundle with deterministic package metadata,
  source/lock/toolchain provenance, a clean-commit gate, SHA-256 sums,
  repeated-pack and source-rebuild reproducibility checks, tree-shaken
  side-effect checks, clean-cache installed runtime smokes, and fixed-tarball
  Next 16 production browser E2E.
- Node 20/22/24 CI, independent oracle verification, Next.js 16 production
  builds, dependency audits, and installed-tarball release smoke tests.
- API, R-migration, Next.js production, statistical-responsibility, and v1.1
  evidence-roadmap documentation.

### Compatibility boundary

- This candidate does not implement multiple groups, sequential or polytomous
  responses, higher-order distributions, standard errors, DIF, bootstrap
  procedures, Q-matrix validation, or the full diagnostic surface of R GDINA.
- AICc follows the conventional correction documented in `README.md`; it is an
  intentional result-contract difference from the frozen upstream source.

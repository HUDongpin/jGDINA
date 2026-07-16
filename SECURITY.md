# Security policy

## Supported versions

Until the first stable release, only the newest `1.0.0-rc.*` candidate receives
security fixes. Earlier candidates and local development snapshots are not
supported. No release candidate should be used as a network service without
the request, memory, concurrency, and duration limits documented by jGDINA.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
private vulnerability-reporting or draft Security Advisory feature for this
repository. If that feature is not yet enabled, contact the repository owner
privately through their GitHub profile with only a request for a secure contact
channel; do not include exploit details in a public message.

Include the affected package and version, runtime and Node/browser versions,
impact, minimal reproduction, and any known mitigations. Remove respondent
records, credentials, tokens, private URLs, and other sensitive data. The
maintainers aim to acknowledge a complete report within seven days, then will
coordinate validation, remediation, advisory timing, and attribution with the
reporter. This is a target, not a guaranteed service-level agreement.

## Security scope

Security reports include, for example, bypasses of dimension or memory guards,
worker isolation or cancellation failures, malformed-input crashes that can
exhaust a service, unintended file/network access, dependency compromise, or
code execution through packaged artifacts.

Numerical disagreement, non-convergence, model fit, identifiability, Q-matrix
validity, and interpretation are important correctness or statistical issues,
but are not security vulnerabilities unless they create a concrete security or
privacy impact. jGDINA v1 does not collect telemetry or transmit fit data by
itself; applications remain responsible for access control, data retention,
logging, transport security, and applicable research/privacy requirements.

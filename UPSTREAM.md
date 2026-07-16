# Upstream reference

jGDINA v1 is validated against the following frozen upstream implementation:

- Project: [Wenchao-Ma/GDINA](https://github.com/Wenchao-Ma/GDINA)
- Version: `2.12.3`
- Date: `2026-07-10`
- Commit: [`ac5eca223a1ee32b6c2f595cfeaef9b330451425`](https://github.com/Wenchao-Ma/GDINA/commit/ac5eca223a1ee32b6c2f595cfeaef9b330451425)
- Local snapshot: `GDINA-master/`
- Upstream license: GPL-3

The downloaded tree was previously compared byte-for-byte at the file level
with the GitHub archive for this commit using `diff -qr`; no differences were
reported. The downloaded directory does not contain upstream `.git` metadata,
so that remote commit mapping is a recorded provenance fact rather than
something an offline checkout can independently derive.

The current local snapshot itself is fully and reproducibly pinned in
[`validation/upstream-snapshot.json`](./validation/upstream-snapshot.json).
That manifest records every tracked file's byte length and SHA-256 plus one
aggregate tree hash. Verify it without contacting GitHub:

```sh
node validation/upstream-snapshot.mjs --check
```

## Compatibility target

jGDINA v1 intentionally implements the closed-form subset represented by
upstream `fast_GDINA_EM`:

- one group;
- binary responses and binary attributes;
- identity-link GDINA, DINA, and DINO items;
- saturated estimated or fixed latent-class proportions;
- no monotonicity constraints; and
- missing-response likelihood handling.

The TypeScript API is idiomatic and JSON-oriented. It does not reproduce R S3
objects or every `extract()` alias. Numerical compatibility is established by
versioned golden fixtures generated from independent base-R equations and by
property tests.

## Intentional result-contract differences

jGDINA reports the conventional small-sample criterion
`AICc = AIC + 2q(q+1)/(N-q-1)` and returns `null` when `N <= q + 1` so the
result remains mathematically defined and JSON-safe. GDINA 2.12.3 instead
adds that correction directly to deviance in `SingleGroup_Estimation.R`.
The independent parity fixtures therefore treat AIC/BIC as compatibility
fields and test jGDINA's AICc contract separately.

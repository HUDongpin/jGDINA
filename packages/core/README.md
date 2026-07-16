# @jgdina/core

Environment-neutral contracts, input validation, resource guards, structured
errors, and backend orchestration for jGDINA v1. This package does not contain
the numerical estimator; use `jgdina` for the direct engine or inject a
`FitBackend` with `createJGDINA()`.

```ts
import { estimateFitMemory, validateFitInput } from "@jgdina/core";

const validated = validateFitInput({ responses, qMatrix, model: "GDINA" });
const estimate = estimateFitMemory({ respondents: 1_000, items: 20, attributes: 5 });
```

The memory estimate includes worker transport and a conservative runtime
reserve by default. It is an admission aid, not a measured peak-RSS guarantee.
Application code should normally use a high-level runtime package rather than
passing `ValidatedFitInput` across its own trust boundary.

License: GPL-3.0-only; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
Compatibility provenance is in [UPSTREAM.md](./UPSTREAM.md). The preferred
TypeScript source and exact package-local rebuild procedure are in
[SOURCE.md](./SOURCE.md).

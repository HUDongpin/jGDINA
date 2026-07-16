# jgdina

Standalone TypeScript estimation for the binary, single-group GDINA, DINA,
and DINO models. The package runs without R and returns a JSON-safe result with
item parameters, latent-class proportions, fit statistics, and MAP/MLE/EAP
person scores.

```ts
import { fit } from "jgdina";

const result = await fit({
  responses: [[0, 0], [0, 1], [1, 0], [1, 1]],
  qMatrix: [[1], [1]],
  model: "DINA",
});

console.log(result.estimates, result.statistics, result.scores);
```

This direct backend computes on the calling thread. UI and request-serving
applications should use `@jgdina/browser`, `@jgdina/node`, or `@jgdina/next`
to move fitting into a worker. The v1 scope is binary responses/attributes,
one group, GDINA/DINA/DINO items, saturated or fixed class priors, missing
responses, and deterministic starts.

The compatibility target and provenance are packaged in
[UPSTREAM.md](./UPSTREAM.md). License: GPL-3.0-only; see
[LICENSE](./LICENSE) and [NOTICE](./NOTICE). The preferred TypeScript source
and exact package-local rebuild procedure are in [SOURCE.md](./SOURCE.md).

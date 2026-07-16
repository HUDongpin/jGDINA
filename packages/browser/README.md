# @jgdina/browser

Dedicated Web Worker execution for jGDINA v1. Input matrices and the JSON-safe
result cross the worker boundary in transferable buffers, and aborting a fit
terminates its worker.

```ts
import { createBrowserJGDINA } from "@jgdina/browser";

const engine = createBrowserJGDINA();
const result = await engine.fit(input, { signal: controller.signal });
```

The bundler must emit `worker-entry.js`. Supply `workerFactory` when a CSP or
custom asset layout requires an explicit Worker URL.

Set `estimation.posteriorStorage` to `"scores-only"` for the normal production
path unless the dense respondent-by-class posterior is required. Cancellation
terminates the fit Worker; it does not create a resumable checkpoint. Verify
the emitted module Worker, CSP `worker-src`, memory, and cancellation on every
supported browser/device class.

License: GPL-3.0-only. Provenance is in `UPSTREAM.md`.

Source-repository guides: [browser/static deployment controls](../../docs/nextjs-production.md#browserstatic-deployment-controls)
and [full API reference](../../docs/api-reference.md).

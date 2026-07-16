# jGDINA Next.js App Router example

This GPL-3.0-only example demonstrates both supported deployments:

- `/api-fit` sends a fit to a reusable Node `worker_threads` pool through an
  App Router Route Handler.
- `/client` is force-static and performs the entire fit in a browser Web Worker.

From the repository root, build the jGDINA packages first. Then install and run
the example:

```sh
npm run build
cd examples/next-app
npm install
npm run dev
```

The example's `.npmrc` enables npm `install-links`, so local `file:` packages
are packed and installed like registry packages instead of being workspace
symlinks. This exercises the same adjacent worker assets and Next 16 Turbopack
externalization that a published install uses.

The API route explicitly exports `runtime = "nodejs"`; the Node adapter is not
compatible with the Next.js Edge runtime.

## What to verify

After starting the example:

- open `/api-fit` and run the server-worker fit;
- open `/client` and run the browser-worker fit;
- confirm both results report convergence and the expected `backendId`;
- cancel a running client fit and confirm the UI remains responsive; and
- run `npm run build` to verify the adjacent Node/browser worker assets survive
  the production bundle.

The example is a runtime integration demonstration, not a production service.
It has no authentication, tenancy, quota, persistence, durable queue, or
statistical diagnostic workflow.

## Production changes

Before adapting it for real data:

1. Make `estimation.posteriorStorage: "scores-only"` the normal endpoint policy.
2. Set `maxBodyBytes`, per-fit `resourceLimits`, pool
   `maxConcurrentEstimatedBytes`, provider memory, and provider duration from
   representative staging measurements.
3. Keep `size: 1` until concurrency benchmarks justify a larger pool.
4. Add authentication, authorization, rate limiting, sensitive-data logging
   rules, retention, and encrypted persistence as required.
5. Use a durable application job system when fits may approach a request
   deadline or must survive a disconnect, restart, or deploy.
6. Persist the result schema/package version and Q-matrix version with every
   accepted result; check `convergence.converged` rather than treating HTTP 200
   as statistical success.
7. Retain an external psychometric fit/Q/uncertainty workflow until those
   diagnostics are implemented and independently validated in jGDINA.

Detailed guidance:

- [Next.js production and deployment](../../docs/nextjs-production.md)
- [API and result-field reference](../../docs/api-reference.md)
- [Statistical responsibility](../../docs/statistical-responsibility.md)
- [R migration and acceptance](../../docs/migration-from-r.md)

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
externalization that a published install uses. It is not, however, an install
from the fixed release `.tgz` files; the release-bundle smoke covers that
separate boundary.

The API route explicitly exports `runtime = "nodejs"`; the Node adapter is not
compatible with the Next.js Edge runtime.

## Repeatable production smoke

From the repository root, install the Playwright CLI browser once, then run the
fresh-build acceptance command:

```sh
npm run smoke:next-production:install-browser
npm run accept:next-production
```

If a local Google Chrome installation should be used instead of downloading
Chromium, omit the install command and run:

```sh
PLAYWRIGHT_CLI_BROWSER=chrome npm run accept:next-production
```

The smoke starts `next start` on an available loopback port and uses the
Playwright CLI against the actual production server. It verifies:

- the home page and both fit paths;
- a converged `node-worker:js` result through `/api/jgdina`;
- structured `400`, `415`, and `422` API errors without stack disclosure;
- a converged `browser-worker:js` result and a successful hashed Turbopack
  Worker response;
- cancellation during a deliberately long Worker estimation followed by a
  successful recovery fit;
- no unexpected console errors, page errors, or failed requests during the
  successful UI flows; and
- the hashed browser worker asset and Node worker entry in the production build
  and route trace.

Machine-local snapshots, request logs, a screenshot, server logs, and
`report.json` are written under `output/playwright/next-production-smoke/`.
That directory is intentionally gitignored.

The cancellation guarantee applies while CPU-heavy numerical estimation is in
the Web Worker. Input validation/copying and transport packing happen
synchronously before Worker execution, and result parsing/assertion happen on
the main thread afterward; a click cannot interrupt those synchronous phases.

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

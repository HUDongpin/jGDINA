import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = process.env.DATA_ANALYTICS_PLUGIN_ROOT;
if (!pluginRoot) {
  throw new Error(
    "Set DATA_ANALYTICS_PLUGIN_ROOT to the installed Data Analytics plugin directory.",
  );
}

const scriptsDirectory = resolve(pluginRoot, "skills/build-report/scripts");
const { buildPortableArtifact } = await import(
  pathToFileURL(resolve(scriptsDirectory, "build_portable_artifact.mjs"))
);
const { deliverPortableArtifact } = await import(
  pathToFileURL(resolve(scriptsDirectory, "deliver_portable_artifact.mjs"))
);

const inputPath = resolve(
  process.argv[2] ?? "validation/real-data/report/artifact.json",
);
const outputPath = resolve(
  process.argv[3] ?? "validation/real-data/report/report.html",
);

const scrollbarSafeTopBar =
  "<style>.analytics-top-bar{margin-left:0!important;margin-right:0!important;width:100%!important}</style>";
const build = (input, options) =>
  buildPortableArtifact(input, options).replace(
    "</head>",
    `${scrollbarSafeTopBar}</head>`,
  );

const receipt = await deliverPortableArtifact(
  {
    inputPath,
    outputPath,
  },
  { build },
);

console.log(JSON.stringify(receipt));
if (!receipt.ok) process.exitCode = 1;

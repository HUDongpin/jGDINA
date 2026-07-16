import { readFile, readdir, writeFile } from "node:fs/promises";

const outputDirectory = new URL("../dist/", import.meta.url);

for (const entry of await readdir(outputDirectory)) {
  if (!entry.endsWith(".map")) continue;
  const path = new URL(entry, outputDirectory);
  const sourceMap = JSON.parse(await readFile(path, "utf8"));
  if (typeof sourceMap.file === "string") {
    sourceMap.file = sourceMap.file.replaceAll("\\", "/").split("/").at(-1);
  }
  sourceMap.sources = sourceMap.sources.map((source, index) => {
    if (sourceMap.sourcesContent?.[index] !== null) return source;
    if (!source.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(source)) return source;
    return source.replaceAll("\\", "/").split("/").at(-1);
  });
  await writeFile(path, `${JSON.stringify(sourceMap)}\n`);
}

import { copyFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [command, packageDirectory = "."] = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(packageDirectory);

if (command === "prepare") {
  await Promise.all([
    copyFile(resolve(root, "LICENSE"), resolve(destination, "LICENSE")),
    copyFile(resolve(root, "NOTICE"), resolve(destination, "NOTICE")),
    copyFile(resolve(root, "UPSTREAM.md"), resolve(destination, "UPSTREAM.md")),
  ]);
} else if (command === "clean") {
  await Promise.all([
    rm(resolve(destination, "LICENSE"), { force: true }),
    rm(resolve(destination, "NOTICE"), { force: true }),
    rm(resolve(destination, "UPSTREAM.md"), { force: true }),
  ]);
} else {
  throw new Error('Usage: package-license.mjs <prepare|clean> <package-directory>');
}

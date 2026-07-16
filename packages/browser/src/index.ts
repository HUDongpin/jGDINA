import { createJGDINA, type JGDINA } from "@jgdina/core";
import {
  BrowserWorkerBackend,
  createBrowserBackend,
  type BrowserBackendOptions,
  type BrowserWorkerFactory,
} from "./backend.js";

export {
  BrowserWorkerBackend,
  createBrowserBackend,
  type BrowserBackendOptions,
  type BrowserWorkerFactory,
};

/** Create a browser-safe jGDINA client whose fits run in dedicated Workers. */
export function createBrowserJGDINA(options: BrowserBackendOptions = {}): JGDINA {
  return createJGDINA(createBrowserBackend(options));
}

/**
 * Browser-only entry point. Importing this subpath never loads the Node worker
 * adapter used by the server Route Handler entry point.
 */
export * from "@jgdina/browser";
export { createBrowserJGDINA as createJGDINAClient } from "@jgdina/browser";

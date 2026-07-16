import { handleJGDINAPost } from "../../../lib/jgdina-route";

// @jgdina/node requires worker_threads; never deploy this handler to Edge.
export const runtime = "nodejs";

export const POST = handleJGDINAPost;

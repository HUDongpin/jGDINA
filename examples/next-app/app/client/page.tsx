import Link from "next/link";

import { ClientFitDemo } from "../../components/client-fit-demo";

export const dynamic = "force-static";

export default function ClientFitPage() {
  return (
    <main>
      <p><Link href="/">← Both examples</Link></p>
      <h1>Static, fully client-side fit</h1>
      <p>No response data leaves the browser; fitting runs in a dedicated Web Worker.</p>
      <ClientFitDemo />
    </main>
  );
}

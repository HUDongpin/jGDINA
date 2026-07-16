import Link from "next/link";

import { ApiFitDemo } from "../../components/api-fit-demo";

export default function ApiFitPage() {
  return (
    <main>
      <p><Link href="/">← Both examples</Link></p>
      <h1>Node Route Handler fit</h1>
      <p>The request is fitted off the server event loop in a reusable worker pool.</p>
      <ApiFitDemo />
    </main>
  );
}

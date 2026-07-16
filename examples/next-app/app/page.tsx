import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>jGDINA in Next.js</h1>
      <p>Choose where the statistical fit should run:</p>
      <ul>
        <li>
          <Link href="/api-fit">Reusable Node worker pool through an API route</Link>
        </li>
        <li>
          <Link href="/client">Fully client-side fit from a static page</Link>
        </li>
      </ul>
    </main>
  );
}

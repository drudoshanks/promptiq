import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col items-start justify-center gap-4 px-4">
      <h1>Page not found</h1>
      <p className="text-ink-soft">The link may be wrong, or the page belongs to another account.</p>
      <Link href="/app" className="btn btn-primary">
        Go to your overview
      </Link>
    </div>
  );
}

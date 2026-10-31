import { redirect } from "next/navigation";

/** Prompt intelligence now lives in the Studio; keep old links working. */
export default async function IntelligenceRedirect({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  const { prompt } = await searchParams;
  redirect(prompt ? `/app/studio?prompt=${encodeURIComponent(prompt)}` : "/app/studio");
}

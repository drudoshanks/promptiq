import Link from "next/link";

import { DiffView } from "@/components/diff-view";
import { EstimateBadge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { PLANS } from "@/lib/config/plans";
import { estimateTokens } from "@/lib/tokens";
import { formatNumber } from "@/lib/utils";

const SAMPLE_BEFORE =
  "write me an email to a client about the invoice they havent paid its invoice 4471 for $2,300 due on 12 Sept be polite but firm and keep it short";

const SAMPLE_AFTER = `Draft a short, polite but firm email to a client about an unpaid invoice.

Include these details exactly as written:
- Invoice number: 4471
- Amount: $2,300
- Due date: 12 Sept

Ask for payment or a payment date, and offer to resend the invoice. Keep it under 120 words.`;

const SAMPLE_CHANGES = [
  "Made the deliverable explicit: a short email with a polite but firm tone.",
  "Listed the invoice number, amount and due date so they cannot be lost.",
  "Added a concrete ask (payment or a payment date) and a length limit.",
];

export default function LandingPage() {
  const before = estimateTokens(SAMPLE_BEFORE);
  const after = estimateTokens(SAMPLE_AFTER);
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/" className="text-lg font-semibold tracking-tight no-underline">
          PromptIQ
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-2">
          <Link href="#pricing" className="nav-link hidden sm:inline-flex">
            Pricing
          </Link>
          <Link href="#privacy" className="nav-link hidden sm:inline-flex">
            Privacy
          </Link>
          <Link href="/sign-in" className="nav-link">
            Sign in
          </Link>
          <LinkButton href="/sign-up" variant="primary">
            Get started
          </LinkButton>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <section className="grid gap-10 py-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:py-20">
          <div>
            <h1>Better prompts. Nothing invented, nothing lost.</h1>
            <p className="mt-5 text-lg text-ink-soft">
              PromptIQ rewrites the prompt you give it so another AI assistant can follow it reliably. It shows every change,
              keeps every name, number and constraint you wrote, and leaves the final word to you: edit, accept, export.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/sign-up" variant="primary">
                Optimise a prompt
              </LinkButton>
              <LinkButton href="#how-it-works">See how it works</LinkButton>
            </div>
            <p className="mt-6 text-sm text-ink-faint">
              Works with ChatGPT and any other assistant: PromptIQ edits the prompt; it never runs it.
            </p>
          </div>

          <div aria-label="Example of a prompt before and after optimisation">
            <DiffView original={SAMPLE_BEFORE} proposed={SAMPLE_AFTER} />
            <div className="panel mt-4 p-4">
              <p className="text-sm font-medium text-ink-soft">What changed</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.9375rem]">
                {SAMPLE_CHANGES.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                <span>
                  Tokens before {before.tokens}, after {after.tokens}
                </span>
                <EstimateBadge method={before.method} />
                <span>Longer, and clearer. A shorter prompt is not automatically better.</span>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-24 py-12">
          <h2>How it works</h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {[
              {
                title: "Paste your prompt",
                body: "Pick the kind of task, or let PromptIQ classify it. Your saved preferences apply automatically; anything you say in the prompt itself wins.",
              },
              {
                title: "Review the proposal",
                body: "Original and proposed text sit side by side with every change marked. Assumptions and open questions are listed, never hidden in the rewrite.",
              },
              {
                title: "Edit, accept, export",
                body: "Change anything you like, then copy or export as text, Markdown or JSON. Each version is kept so you can go back.",
              },
            ].map((step, index) => (
              <li key={step.title} className="panel p-6">
                <span className="text-sm text-ink-faint">Step {index + 1}</span>
                <h3 className="mt-2">{step.title}</h3>
                <p className="mt-3 text-ink-soft">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="privacy" className="scroll-mt-24 py-12">
          <h2>Privacy and control</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {[
              ["Your prompt is sent to OpenAI's API to be rewritten, from our servers, with our key. We tell you this up front because it is true."],
              ["Prompts are stored only when history is on, or when you save one. Turn history off and nothing is kept beyond the request."],
              ["Preferences are only ever created by you: when you set them, or when you confirm a suggestion. Nothing is inferred silently."],
              ["Every stored preference shows where it came from, and you can edit, disable or delete it. Export your data or delete your account at any time."],
            ].map(([text]) => (
              <p key={text} className="panel-soft p-5 text-[0.9375rem]">
                {text}
              </p>
            ))}
          </div>
        </section>

        <section id="pricing" className="scroll-mt-24 py-12">
          <h2>Plans</h2>
          <p className="mt-3 text-ink-soft">Copying and plain-text export are never gated. Plans limit volume, not your access to your own prompts.</p>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {Object.values(PLANS).map((plan) => (
              <div key={plan.code} className="panel p-6">
                <div className="flex items-baseline justify-between">
                  <h3>{plan.name}</h3>
                  <span className="text-lg">{plan.priceLabel}</span>
                </div>
                <ul className="mt-5 space-y-2 text-[0.9375rem] text-ink-soft">
                  <li>{formatNumber(plan.optimisationsPerPeriod)} optimisations a month</li>
                  <li>Prompts up to {formatNumber(plan.maxPromptChars)} characters</li>
                  <li>
                    {formatNumber(plan.maxSavedPrompts)} saved prompts, {plan.maxVersionsPerPrompt} versions each
                  </li>
                  <li>Text, Markdown and JSON export</li>
                  {plan.code === "pro" ? <li>Usage analytics and billing-period quotas</li> : null}
                </ul>
                <div className="mt-6">
                  <LinkButton href="/sign-up" variant={plan.code === "pro" ? "primary" : "secondary"}>
                    {plan.code === "pro" ? "Start with Pro" : "Start free"}
                  </LinkButton>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            Paying from India? Pro is available with UPI in rupees: <Link href="/app/billing">see UPI plans</Link>. Payments are checked by hand before activation.
          </p>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-ink-soft sm:px-6">
          <span>PromptIQ</span>
          <nav aria-label="Footer" className="flex gap-4">
            <Link href="/sign-in">Sign in</Link>
            <Link href="#privacy">Privacy</Link>
            <Link href="#pricing">Pricing</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

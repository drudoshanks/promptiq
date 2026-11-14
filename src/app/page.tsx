import { ArrowRight, BadgeCheck, Check, ChevronDown, Coins, FileClock, Layers, Lock, Mail, MapPin, Phone, ScanSearch, ShieldCheck, Sparkles, UserCheck, Wand2 } from "lucide-react";
import Link from "next/link";

import { IMARWAR, ImarwarLogo, ProductLogo } from "@/components/brand";
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

const ASSISTANTS = ["ChatGPT", "Claude", "Gemini", "Copilot", "Llama", "Mistral"];

const FEATURES = [
  { icon: ScanSearch, title: "Analyse and score", body: "PromptIQ identifies the task, scores how completely your prompt states its goal, context and constraints, and lists exactly what's missing." },
  { icon: Wand2, title: "Optimise in five modes", body: "Detailed, balanced, token saver, quality first or your own objective. Each version is a proposal: you edit, accept or discard it." },
  { icon: Layers, title: "Break big prompts into steps", body: "Split a large request into focused step-by-step prompts, with the run order, what to paste between steps and what to check.", isNew: true },
  { icon: ShieldCheck, title: "Every requirement checked", body: "Names, numbers, restrictions and formats you wrote are checked in every result. Anything dropped is put back, and flagged." },
  { icon: Coins, title: "Tokens and cost, up front", body: "Exact token counts for the model you'll use and the cost per run, before you send anything. Estimates are always labelled." },
  { icon: FileClock, title: "A library with history", body: "Save prompts with tags and versions. Compare any two versions, restore an old one, and see how each prompt improved." },
];

const STEPS = [
  { title: "Paste your prompt", body: "Pick the kind of task or let PromptIQ detect it. Your saved preferences apply automatically; anything you say in the prompt wins." },
  { title: "Review the proposal", body: "Original and proposed sit side by side with every change marked. Assumptions and open questions are listed, never hidden." },
  { title: "Use it anywhere", body: "Copy, export as text, Markdown or JSON, or save it. Run it in ChatGPT or any assistant: PromptIQ edits prompts, it never runs them." },
];

const PRIVACY = [
  { icon: Lock, text: "Your prompt is sent from our servers to the AI model this workspace uses (Claude by Anthropic, an open-source model or OpenAI) to be analysed or rewritten. Nothing else is shared." },
  { icon: FileClock, text: "Prompts are stored only when history is on, or when you save one. Turn history off and nothing is kept beyond the request." },
  { icon: UserCheck, text: "Preferences are only ever created by you: when you set them, or when you confirm a suggestion. Nothing is inferred silently." },
  { icon: BadgeCheck, text: "Every stored preference shows where it came from, and you can edit, disable or delete it. Export your data or delete your account at any time." },
];

const FAQ = [
  { q: "Does PromptIQ run my prompt?", a: "No. PromptIQ improves the prompt itself. You copy the result into ChatGPT, Claude, Gemini or any other assistant and run it there." },
  { q: "Will it change what I asked for?", a: "It shouldn't, and it checks. Every requirement it finds in your prompt (values, restrictions, formats, length, tone) is checked in the result. Anything missing is put back and flagged, and you review every change before accepting it." },
  { q: "When should I break a prompt into steps?", a: "When one request asks for several things, or one big thing such as an app or a report. PromptIQ tells you when splitting is likely to help, then gives you a short sequence of self-contained prompts and how to run them." },
  { q: "Which AI models does PromptIQ use?", a: "PromptIQ runs on Claude by Anthropic, and can also use open-source models (such as Llama or Qwen) or OpenAI. Token counts and costs are shown for the model you plan to send your prompt to." },
  { q: "Can I pay from India?", a: "Yes. Pro is available in rupees with UPI. Pay with any UPI app, submit the reference, and your plan activates once the payment is verified. PromptIQ never asks for your UPI PIN or OTP." },
];

function Swoosh() {
  return (
    <svg aria-hidden="true" viewBox="0 0 300 24" preserveAspectRatio="none" className="absolute -bottom-2 left-0 h-3 w-full sm:-bottom-3 sm:h-4">
      <defs>
        <linearGradient id="swoosh" x1="0" x2="1">
          <stop offset="0" stopColor="#f06a08" />
          <stop offset="1" stopColor="#fd8a22" />
        </linearGradient>
      </defs>
      <path d="M4 18 C 80 4, 200 2, 296 12" stroke="url(#swoosh)" strokeWidth="6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export default function LandingPage() {
  const before = estimateTokens(SAMPLE_BEFORE);
  const after = estimateTokens(SAMPLE_AFTER);
  return (
    <div className="min-h-dvh bg-paper">
      <header className="sticky top-0 z-30 border-b border-line bg-panel/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:py-4">
          <ProductLogo />
          <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
            <a href="#features" className="top-link">
              Features
            </a>
            <a href="#how-it-works" className="top-link">
              How it works
            </a>
            <a href="#pricing" className="top-link">
              Pricing
            </a>
            <a href="#privacy" className="top-link">
              Privacy
            </a>
            <a href="#faq" className="top-link">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/sign-in" className="btn btn-outline btn-sm sm:min-h-[2.75rem] sm:px-5">
              Sign in
            </Link>
            <LinkButton href="/sign-up" variant="primary" className="hidden sm:inline-flex">
              Get started free
            </LinkButton>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="canvas-hero relative overflow-hidden">
          <div className="mx-auto grid max-w-7xl gap-12 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-[minmax(0,11fr)_minmax(0,10fr)] lg:items-center lg:gap-14 lg:pb-24 lg:pt-20">
            <div>
              <a href="#features" className="announce">
                <span className="announce-tag">New</span>
                <span>Break big prompts into step-by-step prompts</span>
                <ArrowRight className="h-4 w-4 text-accent" aria-hidden="true" />
              </a>
              <h1 className="mt-7 text-[2.75rem] leading-[1.02] sm:text-[3.75rem] lg:text-[4.5rem]">
                Write <span className="text-brand-gradient">AI-Ready</span> Prompts.{" "}
                <span className="relative inline-block whitespace-nowrap">
                  Nothing invented
                  <Swoosh />
                </span>
                , nothing lost.
              </h1>
              <p className="mt-7 text-lg text-ink-soft sm:text-xl">
                PromptIQ turns rough requests into prompts any AI assistant can follow. It analyses what&apos;s missing, rewrites for clarity, or splits big jobs into steps, and checks that every name, number and constraint you wrote survives.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <LinkButton href="/sign-up" variant="primary" size="lg">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                  Optimise a prompt free
                </LinkButton>
                <LinkButton href="#how-it-works" variant="outline" size="lg">
                  See how it works
                </LinkButton>
              </div>

              <div className="mt-10 rounded-[22px] border border-line bg-panel/80 p-5 shadow-[var(--shadow-card)] backdrop-blur">
                <p className="eyebrow">Works with any assistant</p>
                <ul className="mt-3 flex flex-wrap gap-2" aria-label="Assistants">
                  {ASSISTANTS.map((a) => (
                    <li key={a} className="rounded-xl border border-line bg-panel px-3.5 py-1.5 text-[0.9375rem] font-bold tracking-tight text-ink-soft">
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Product preview */}
            <div className="relative" aria-label="Example of a prompt before and after optimisation">
              <div aria-hidden="true" className="absolute -inset-6 -z-0 rounded-[40px] bg-[radial-gradient(closest-side,rgba(253,138,34,0.22),transparent)] blur-2xl" />
              <div className="relative rounded-[26px] border border-line bg-panel p-3 shadow-[var(--shadow-pop)]">
                <div className="flex items-center justify-between gap-2 px-2 pb-3 pt-1">
                  <div className="flex gap-1.5" aria-hidden="true">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ff6b5a]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ffc23d]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#3fd07a]" />
                  </div>
                  <span className="text-[0.8125rem] font-semibold text-ink-soft">PromptIQ Studio</span>
                  <span className="badge badge-accent">Balanced</span>
                </div>
                <DiffView original={SAMPLE_BEFORE} proposed={SAMPLE_AFTER} />
                <div className="mt-3 rounded-2xl bg-panel-soft p-4">
                  <p className="text-sm font-bold">What changed</p>
                  <ul className="mt-2 space-y-1.5 text-[0.9375rem] text-ink-soft">
                    {SAMPLE_CHANGES.map((change) => (
                      <li key={change} className="flex gap-2">
                        <Check className="mt-1 h-4 w-4 flex-none text-accent" aria-hidden="true" />
                        {change}
                      </li>
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
              <div className="absolute -left-8 top-[48%] hidden items-center gap-2 rounded-2xl border border-line bg-panel px-3.5 py-2.5 text-sm font-semibold shadow-[var(--shadow-pop)] xl:flex">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-success-soft text-success">
                  <Check className="h-4 w-4" aria-hidden="true" />
                </span>
                4471 · $2,300 · 12 Sept kept
              </div>
            </div>
          </div>
        </section>

        {/* Facts */}
        <section className="border-y border-line bg-panel">
          <dl className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-4">
            {[
              ["5", "optimisation modes"],
              ["10", "kinds of requirement checked"],
              ["2–8", "steps when you break a prompt down"],
              ["0", "prompts run on your behalf"],
            ].map(([n, label]) => (
              <div key={label}>
                <dt className="sr-only">{label}</dt>
                <dd className="text-[2.25rem] font-extrabold leading-none tracking-[-0.04em]">
                  <span className="text-brand-gradient">{n}</span>
                </dd>
                <dd className="mt-1.5 text-[0.9375rem] text-ink-soft">{label}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Features */}
        <section id="features" className="scroll-mt-24">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
            <div className="max-w-4xl">
              <p className="eyebrow">
                <span className="h-px w-8 bg-accent" aria-hidden="true" />
                Features
              </p>
              <h2 className="mt-4 text-[2rem] font-extrabold tracking-[-0.035em] sm:text-[2.75rem]">
                Everything you need to <span className="text-brand-gradient">prompt like a pro</span>
              </h2>
              <p className="mt-4 text-lg text-ink-soft">From a one-line idea to a reviewed, versioned prompt, without losing a single requirement on the way.</p>
            </div>
            <ul className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <li key={f.title} className="panel group relative p-7 transition-transform duration-200 hover:-translate-y-1">
                  <div className="flex items-center justify-between">
                    <span className="icon-tile">
                      <f.icon aria-hidden="true" />
                    </span>
                    {f.isNew ? <span className="announce-tag">New</span> : null}
                  </div>
                  <h3 className="mt-5 text-[1.25rem]">{f.title}</h3>
                  <p className="mt-2.5 text-ink-soft">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="scroll-mt-24 bg-panel">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
            <div className="max-w-3xl">
              <p className="eyebrow">
                <span className="h-px w-8 bg-accent" aria-hidden="true" />
                How it works
              </p>
              <h2 className="mt-4 text-[2rem] font-extrabold tracking-[-0.035em] sm:text-[2.75rem]">From rough idea to reliable prompt in three steps</h2>
            </div>
            <ol className="mt-12 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="relative rounded-[22px] border border-line bg-paper p-7">
                  <span className="text-[3.5rem] font-extrabold leading-none tracking-[-0.05em] text-brand-gradient">0{index + 1}</span>
                  <h3 className="mt-4 text-[1.25rem]">{step.title}</h3>
                  <p className="mt-2.5 text-ink-soft">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Break-down showcase */}
        <section className="bg-ink text-white">
          <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center lg:py-24">
            <div>
              <p className="eyebrow text-white/60">
                <span className="h-px w-8 bg-brand" aria-hidden="true" />
                New in the Studio
              </p>
              <h2 className="mt-4 text-[2rem] font-extrabold tracking-[-0.035em] sm:text-[2.75rem]">
                Big request? <span className="text-brand-gradient">Break it down.</span>
              </h2>
              <p className="mt-4 text-lg text-white/70">
                Assistants rush or skip parts of long, multi-part requests. PromptIQ splits yours into focused prompts that each work in a fresh chat, tells you what to paste between them, and checks that every requirement lands in a step.
              </p>
              <ul className="mt-7 space-y-3 text-white/85">
                {["Run order, including steps you can run in parallel", "What a good answer looks like, and what to check before moving on", "Copy, download as Markdown, or save all steps to your library"].map((t) => (
                  <li key={t} className="flex gap-3">
                    <span className="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full bg-brand/20 text-brand-light">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div aria-hidden="true" className="rounded-[26px] border border-white/10 bg-white/[0.04] p-6">
              <p className="text-sm font-semibold text-white/60">Run order</p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-semibold">
                  <span className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-brand text-xs text-white">1</span>Write the blog post
                </div>
                <ArrowRight className="hidden h-4 w-4 flex-none text-white/40 sm:block" />
                <div className="space-y-2 rounded-2xl border border-dashed border-white/20 p-2">
                  <p className="px-1 text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-white/40">Any order</p>
                  {["Create 5 captions", "Draft the email"].map((t, i) => (
                    <div key={t} className="rounded-xl border border-white/15 bg-white/5 px-3.5 py-2.5 text-sm font-semibold">
                      <span className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-white/15 text-xs">{i + 2}</span>
                      {t}
                    </div>
                  ))}
                </div>
                <ArrowRight className="hidden h-4 w-4 flex-none text-white/40 sm:block" />
                <div className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-semibold">
                  <span className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-white/15 text-xs">4</span>Final check
                </div>
              </div>
              <div className="mt-5 rounded-2xl bg-white/[0.06] p-4 font-mono text-[0.8125rem] leading-relaxed text-white/80">
                Task (part 2 of 3): Create 5 Instagram captions promoting the post.
                <br />
                Build on the result of step 1:
                <br />
                <span className="rounded bg-brand/25 px-1 text-brand-light">[Paste the output of step 1 here]</span>
              </div>
            </div>
          </div>
        </section>

        {/* Privacy */}
        <section id="privacy" className="scroll-mt-24">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
            <div className="max-w-3xl">
              <p className="eyebrow">
                <span className="h-px w-8 bg-accent" aria-hidden="true" />
                Privacy and control
              </p>
              <h2 className="mt-4 text-[2rem] font-extrabold tracking-[-0.035em] sm:text-[2.75rem]">Your prompts, your rules</h2>
            </div>
            <ul className="mt-12 grid gap-5 md:grid-cols-2">
              {PRIVACY.map(({ icon: Icon, text }) => (
                <li key={text} className="panel flex gap-4 p-6">
                  <span className="icon-tile">
                    <Icon aria-hidden="true" />
                  </span>
                  <p className="text-[0.9375rem] text-ink-soft">{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-24 bg-panel">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
            <div className="mx-auto max-w-2xl text-center">
              <p className="eyebrow justify-center">Plans</p>
              <h2 className="mt-4 text-[2rem] font-extrabold tracking-[-0.035em] sm:text-[2.75rem]">Simple plans. Your prompts are always yours.</h2>
              <p className="mx-auto mt-4 text-lg text-ink-soft">Copying and plain-text export are never gated. Plans limit volume, not your access to your own prompts.</p>
            </div>
            <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
              {Object.values(PLANS).map((plan) => {
                const pro = plan.code === "pro";
                return (
                  <div key={plan.code} className={pro ? "relative rounded-[24px] bg-gradient-to-b from-brand-light to-accent p-[2px] shadow-[var(--shadow-brand)]" : ""}>
                    <div className={pro ? "h-full rounded-[22px] bg-panel p-8" : "panel h-full p-8"}>
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-[1.375rem]">{plan.name}</h3>
                        {pro ? <span className="badge badge-accent">For daily use</span> : null}
                      </div>
                      <p className="mt-4 text-[2.5rem] font-extrabold leading-none tracking-[-0.04em]">{plan.priceLabel}</p>
                      <ul className="mt-6 space-y-3 text-[0.9375rem] text-ink-soft">
                        {[
                          `${formatNumber(plan.optimisationsPerPeriod)} optimisations a month`,
                          `${formatNumber(plan.analysesPerPeriod)} analyses and breakdowns a month`,
                          `Prompts up to ${formatNumber(plan.maxPromptChars)} characters`,
                          `${formatNumber(plan.maxSavedPrompts)} saved prompts, ${plan.maxVersionsPerPrompt} versions each`,
                          "Text, Markdown and JSON export",
                          ...(pro ? ["Usage analytics and billing-period quotas"] : []),
                        ].map((item) => (
                          <li key={item} className="flex gap-2.5">
                            <Check className="mt-0.5 h-4 w-4 flex-none text-accent" aria-hidden="true" />
                            {item}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-8">
                        <LinkButton href="/sign-up" variant={pro ? "primary" : "secondary"} className="w-full">
                          {pro ? "Start with Pro" : "Start free"}
                        </LinkButton>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-ink-soft">
              Paying from India? Pro is available with UPI in rupees: <Link href="/app/billing" className="font-semibold text-accent-deep">see UPI plans</Link>. Payments are checked by hand before activation.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-24">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:py-28">
            <div>
              <p className="eyebrow">
                <span className="h-px w-8 bg-accent" aria-hidden="true" />
                FAQ
              </p>
              <h2 className="mt-4 text-[2rem] font-extrabold tracking-[-0.035em] sm:text-[2.5rem]">Still have questions? We&apos;re here to help.</h2>
              <p className="mt-4 text-ink-soft">
                Talk to the iMarwar team at{" "}
                <a href={`mailto:${IMARWAR.email}`} className="font-semibold text-accent-deep">
                  {IMARWAR.email}
                </a>
                .
              </p>
            </div>
            <div className="space-y-3">
              {FAQ.map((item, i) => (
                <details key={item.q} className="group panel p-0" open={i === 0}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-[1.0625rem] font-bold [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-sunken transition-transform group-open:rotate-180 group-open:bg-accent-soft group-open:text-accent-deep">
                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </summary>
                  <p className="px-6 pb-6 text-ink-soft">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Call to action */}
        <section className="px-4 pb-20 sm:px-6">
          <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[32px] bg-gradient-to-br from-brand-light via-accent to-[#d95300] px-6 py-14 text-white shadow-[var(--shadow-brand)] sm:px-14">
            <div aria-hidden="true" className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/15 blur-2xl" />
            <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-2xl">
                <h2 className="text-[2rem] font-extrabold tracking-[-0.035em] sm:text-[2.5rem]">Ready to write prompts that work the first time?</h2>
                <p className="mt-3 text-lg text-white/90">Free to start. No card needed.</p>
              </div>
              <div className="flex flex-none flex-wrap gap-3">
                <Link href="/sign-up" className="btn btn-lg bg-white text-accent-deep hover:bg-white/90">
                  Get started free
                </Link>
                <Link href="/sign-in" className="btn btn-lg border-white/60 text-white hover:bg-white/10">
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-ink text-white/70">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-2 lg:grid-cols-[minmax(0,5fr)_repeat(3,minmax(0,3fr))]">
          <div>
            <ImarwarLogo tone="light" width={168} />
            <p className="mt-5 text-[0.9375rem]">
              PromptIQ is built by iMarwar, an AI-powered digital product company from Jodhpur building AI agents, SaaS platforms and enterprise software.
            </p>
          </div>
          <nav aria-label="Product">
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-white">PromptIQ</p>
            <ul className="mt-4 space-y-2.5 text-[0.9375rem]">
              <li><a href="#features" className="no-underline hover:text-white">Features</a></li>
              <li><a href="#pricing" className="no-underline hover:text-white">Pricing</a></li>
              <li><a href="#privacy" className="no-underline hover:text-white">Privacy</a></li>
              <li><Link href="/sign-in" className="no-underline hover:text-white">Sign in</Link></li>
            </ul>
          </nav>
          <nav aria-label="Company">
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-white">iMarwar</p>
            <ul className="mt-4 space-y-2.5 text-[0.9375rem]">
              <li><a href={IMARWAR.url} target="_blank" rel="noopener" className="no-underline hover:text-white">About iMarwar</a></li>
              <li><a href={`mailto:${IMARWAR.email}`} className="no-underline hover:text-white">Contact us</a></li>
              <li><a href={IMARWAR.linkedin} target="_blank" rel="noopener" className="no-underline hover:text-white">LinkedIn</a></li>
            </ul>
          </nav>
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-white">Get in touch</p>
            <ul className="mt-4 space-y-3 text-[0.9375rem]">
              <li className="flex gap-2.5"><Mail className="mt-1 h-4 w-4 flex-none text-brand" aria-hidden="true" /><a href={`mailto:${IMARWAR.email}`} className="no-underline hover:text-white">{IMARWAR.email}</a></li>
              <li className="flex gap-2.5"><Phone className="mt-1 h-4 w-4 flex-none text-brand" aria-hidden="true" /><a href={IMARWAR.phoneHref} className="no-underline hover:text-white">{IMARWAR.phone}</a></li>
              <li className="flex gap-2.5"><MapPin className="mt-1 h-4 w-4 flex-none text-brand" aria-hidden="true" /><span>{IMARWAR.address}</span></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm sm:px-6">
            <span>© {new Date().getFullYear()} iMarwar. All rights reserved.</span>
            <span>PromptIQ is a product of iMarwar · {IMARWAR.hours}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

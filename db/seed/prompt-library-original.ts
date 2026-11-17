/**
 * Original prompts written for PromptIQ by iMarwar. Each uses {{field}}
 * placeholders that the library turns into fill-in-the-blank inputs.
 * Topics follow the most common real-world uses of AI assistants reported
 * by OpenAI's and Anthropic's 2025–26 usage studies: practical guidance,
 * writing and editing, information seeking, coding, learning, and business
 * work such as sales outreach, memos and customer support.
 */
export interface SeedPrompt {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  prompt: string;
  featured?: boolean;
}

const p = (slug: string, category: string, title: string, description: string, tags: string[], prompt: string, featured = false): SeedPrompt => ({ slug, title, description, category, tags, prompt: prompt.trim(), featured });

export const ORIGINAL_PROMPTS: SeedPrompt[] = [
  // ---------------------------------------------------------------- Writing
  p("polish-my-draft", "writing", "Polish my draft", "Tighten and clarify any piece of writing while keeping your voice and every fact.", ["editing", "clarity", "proofreading"], `
Edit the draft below for clarity, flow and correctness.

Audience: {{audience}}
Goal of the piece: {{goal}}

Rules:
- Keep my voice and meaning. Do not add facts, numbers or claims that aren't in the draft.
- Fix grammar, spelling and punctuation.
- Cut filler and repetition; prefer short, concrete sentences.
- Keep names, figures, dates and quotes exactly as written.

Return the edited version first, then a short bulleted list of the main changes.

Draft:
"""
{{draft}}
"""`, true),
  p("rewrite-in-a-different-tone", "writing", "Rewrite in a different tone", "Change the tone of a text (friendlier, more formal, more confident) without changing what it says.", ["tone", "rewriting"], `
Rewrite the text below in a {{tone}} tone for {{audience}}.

Keep every fact, figure and request exactly as it is. Keep roughly the same length unless a shorter version reads better. Don't add new information.

Text:
"""
{{text}}
"""`),
  p("summarise-a-document", "writing", "Summarise a document", "Get a clear summary with the key points, decisions and open questions.", ["summary", "reading"], `
Summarise the document below for {{audience}}.

Give me:
1. A one-sentence summary.
2. The key points as 3–7 bullets.
3. Any decisions, deadlines, numbers or commitments, quoted exactly.
4. Open questions or anything unclear.

Only use information in the document. If something important is missing, say so instead of guessing.

Document:
"""
{{document}}
"""`, true),
  p("blog-post-from-outline", "writing", "Blog post from an outline", "Turn your outline or notes into a structured, readable blog post.", ["blog", "article", "content"], `
Write a blog post from my outline.

Topic: {{topic}}
Audience: {{audience}}
Length: about {{word_count}} words
Tone: {{tone}}

Structure: a headline, a short hook, sections with subheadings that follow my outline, and a conclusion with one clear takeaway. Use examples only where my notes give them; mark anything you'd want me to fill in as [ADD: …] rather than inventing it.

Outline and notes:
"""
{{outline}}
"""`),
  p("translate-naturally", "writing", "Translate naturally", "Translate text so it reads naturally to native speakers, not word for word.", ["translation", "language"], `
Translate the text below from {{source_language}} into {{target_language}}.

Make it read naturally to a native speaker in {{region}}, keeping the meaning, tone and formality. Keep names, numbers, product names and links unchanged. If a phrase has no direct equivalent, choose the closest natural expression and list it under "Translator's notes" at the end.

Text:
"""
{{text}}
"""`),
  p("explain-like-im-new", "writing", "Explain a complex text simply", "Rewrite technical or legal text in plain language anyone can follow.", ["plain language", "simplify"], `
Rewrite the text below in plain language for {{audience}}.

- Use short sentences and everyday words; explain any term you have to keep.
- Keep every obligation, number, date and exception. Don't soften or drop conditions.
- End with "What this means for you" in 2–3 bullets.

Text:
"""
{{text}}
"""`),
  p("write-a-speech", "writing", "Write a short speech", "A speech or toast that sounds natural when spoken aloud.", ["speech", "toast", "public speaking"], `
Write a {{length_minutes}}-minute speech for {{occasion}}.

Speaker: {{speaker}}
Audience: {{audience}}
Points to include: {{key_points}}
Tone: {{tone}}

Write it to be spoken: short sentences, a strong opening line, natural pauses, and a memorable close. Don't invent personal stories; where a story would help, leave a bracketed prompt like [Your story about …].`),
  p("headline-options", "writing", "Headline and title options", "Ten headline options in different styles, with the best pick explained.", ["headlines", "titles", "copywriting"], `
Write 10 headline options for {{content_description}}, aimed at {{audience}}.

Mix styles: direct benefit, question, number/list, curiosity, and plain descriptive. Keep each under {{max_characters}} characters and avoid clickbait or claims the content can't back up.

Then pick the 2 strongest and explain why in one sentence each.`),

  // ---------------------------------------------------------------- Marketing
  p("social-media-posts", "marketing", "Social media posts for a launch", "Platform-specific posts for LinkedIn, Instagram and X from one brief.", ["social media", "linkedin", "instagram", "launch"], `
Write social media posts announcing {{announcement}} for {{brand}}.

Audience: {{audience}}
Key message: {{key_message}}
Call to action: {{call_to_action}}
Link: {{link}}

Write:
- LinkedIn: 120–180 words, professional, with a hook in the first line.
- Instagram: a caption under 120 words with 3–5 relevant hashtags.
- X: two options under 260 characters.

Use only the facts above. Don't invent statistics, testimonials or prices.`, true),
  p("product-description", "marketing", "Product description that sells", "Benefit-led product copy for a store page or marketplace listing.", ["ecommerce", "product", "copywriting"], `
Write a product description for {{product_name}}.

Who it's for: {{customer}}
Key features: {{features}}
What makes it different: {{differentiator}}
Where it will appear: {{channel}}

Lead with the main benefit, then 3–5 benefit-led bullets that each tie a feature to an outcome, then a short closing line. Keep it under {{word_count}} words. Use only the features listed; no superlatives you can't prove ("best", "#1").`),
  p("seo-blog-brief", "marketing", "SEO content brief", "A complete brief for an article that answers what searchers want.", ["seo", "content strategy", "brief"], `
Create a content brief for an article targeting the search query "{{keyword}}" for {{website}}.

Include:
1. Search intent: what the searcher is trying to do.
2. A working title and meta description (under 155 characters).
3. An H2/H3 outline that fully answers the query.
4. Questions the article must answer.
5. Related terms to cover naturally.
6. Suggested internal links to: {{related_pages}}
7. What would make this better than a typical article on the topic.

Audience: {{audience}}. Don't invent statistics; mark facts that need a source as [SOURCE NEEDED].`),
  p("email-newsletter", "marketing", "Email newsletter", "A newsletter people actually open and read.", ["email", "newsletter"], `
Write an email newsletter for {{brand}} to {{audience}}.

Main story: {{main_story}}
Other updates: {{other_updates}}
Call to action: {{call_to_action}}

Give me 3 subject line options (under 50 characters) and a preview line, then the email: a friendly opening, the main story, short sections for the other updates, and one clear call to action. Keep it scannable and under {{word_count}} words.`),
  p("ad-copy-variations", "marketing", "Ad copy variations", "Ad variations to A/B test, each within platform limits.", ["ads", "google ads", "meta ads", "a/b testing"], `
Write ad copy for {{product}} on {{platform}}.

Audience: {{audience}}
Offer: {{offer}}
Landing page: {{landing_page}}

Give me 5 variations, each testing a different angle (benefit, pain point, social proof without inventing numbers, urgency, curiosity). For each: headline, primary text and a call-to-action button label. Respect {{platform}}'s character limits and ad policies; no misleading claims.`),
  p("customer-persona", "marketing", "Customer persona", "A practical persona built from what you know about your customers.", ["persona", "audience research"], `
Build a customer persona for {{business}} from the information below.

What we know about our customers:
"""
{{customer_notes}}
"""

Include: a name and short summary, goals, frustrations, what triggers a purchase, objections, where they spend time online, and the words they use to describe the problem. Separate what comes from my notes from your assumptions, and label assumptions clearly so I can verify them.`),
  p("content-calendar", "marketing", "30-day content calendar", "A month of content ideas mapped to your goals and channels.", ["content calendar", "planning", "social media"], `
Create a 30-day content calendar for {{brand}}.

Goal: {{goal}}
Channels: {{channels}}
Audience: {{audience}}
Posting frequency: {{frequency}}
Themes or launches this month: {{themes}}

Return a table with: date, channel, content type, topic/hook, and call to action. Mix educational, behind-the-scenes, social proof and promotional posts (no more than 1 in 5 promotional).`),
  p("brand-voice-guide", "marketing", "Brand voice guide", "A short, usable guide to how your brand writes.", ["brand", "voice", "style guide"], `
Write a one-page brand voice guide for {{brand}}, which {{what_the_brand_does}}.

Our audience: {{audience}}
Three words for how we want to sound: {{voice_words}}
Examples of our writing:
"""
{{examples}}
"""

Include: voice principles (with "we are / we are not"), vocabulary to use and avoid, sentence style, and 3 before/after rewrites showing the voice in action.`),

  // ---------------------------------------------------------------- Business
  p("cold-outreach-email", "business", "Personalised cold email", "A short, specific first email that earns a reply.", ["sales", "outreach", "email"], `
Write a cold email from {{sender}} at {{company}} to {{recipient_role}} at {{prospect_company}}.

What we offer: {{offer}}
Why this prospect, specifically: {{relevance}}
The ask: {{ask}}

Keep it under 120 words, with a specific subject line, a first line about them (not us), one clear benefit, and a low-effort ask. No fake familiarity, no invented results or client names. Then give a 60-word follow-up for 4 days later.`, true),
  p("meeting-notes-to-actions", "business", "Meeting notes to action items", "Turn messy notes or a transcript into decisions and owners.", ["meetings", "notes", "action items"], `
Turn these meeting notes into a clear summary.

Return:
1. Summary (3–5 bullets).
2. Decisions made.
3. Action items as a table: task, owner, due date. Use "Unassigned" or "No date" when the notes don't say.
4. Open questions and risks.

Only use what's in the notes; don't invent owners or dates.

Notes:
"""
{{notes}}
"""`, true),
  p("swot-analysis", "business", "SWOT analysis", "A grounded SWOT with the actions that follow from it.", ["strategy", "swot", "analysis"], `
Do a SWOT analysis for {{business}} in {{market}}.

Context:
"""
{{context}}
"""

Give 3–5 points for each of strengths, weaknesses, opportunities and threats, based on the context. Mark anything that is your assumption. Then suggest the 3 most important actions, each linking a strength to an opportunity or addressing a weakness or threat.`),
  p("business-plan-outline", "business", "One-page business plan", "A lean plan covering customer, problem, offer and numbers to validate.", ["startup", "business plan"], `
Draft a one-page business plan for {{business_idea}}.

Target customer: {{customer}}
Location/market: {{market}}
Budget available: {{budget}}

Cover: the problem, the solution, target customer, how it makes money, pricing approach, main competitors and how we differ, channels to reach customers, key costs, and the 3 riskiest assumptions with a cheap way to test each in the next 30 days. Don't invent market-size figures; list what I should research instead.`),
  p("investment-memo", "business", "Decision memo", "A structured memo to recommend a decision to leadership.", ["memo", "management", "decision"], `
Write a decision memo for {{audience}} recommending {{recommendation}}.

Background:
"""
{{background}}
"""
Options considered: {{options}}
Constraints: {{constraints}}

Structure: the decision needed, recommendation in one sentence, background, options compared (pros, cons, cost, risk), why the recommendation wins, risks and mitigations, and next steps with owners. Keep it under 2 pages and use only the facts provided.`),
  p("sales-objection-handling", "business", "Handle sales objections", "Honest responses to the objections your prospects actually raise.", ["sales", "objections"], `
I sell {{product}} to {{customer}}. Help me respond to these objections:
{{objections}}

For each objection: what's likely behind it, a short, honest response, a question to understand the prospect better, and proof I could offer (only kinds of proof I'd really have, such as a trial or a reference customer). No pressure tactics.`),
  p("pricing-strategy", "business", "Pricing options", "Compare pricing models for a product or service.", ["pricing", "strategy"], `
Help me price {{product}} for {{customer}}.

Costs: {{costs}}
Competitor prices I know of: {{competitor_prices}}
Goal: {{goal}}

Compare 3 pricing approaches (for example tiered, usage-based, flat) with example price points derived from my numbers, the pros and cons of each for my situation, and which you'd test first and how. Show your arithmetic.`),
  p("startup-pitch", "business", "Investor pitch outline", "A 10-slide pitch outline with what each slide must prove.", ["fundraising", "pitch deck", "startup"], `
Outline a 10-slide investor pitch for {{startup}}, which {{what_it_does}}.

Traction so far: {{traction}}
Raising: {{amount}} for {{use_of_funds}}

For each slide give the title, the one message it must land, and the content to include. Use only the traction I gave; where investors will expect data I haven't provided, write [NEED: …].`),

  // ---------------------------------------------------------------- Coding
  p("code-review", "coding", "Code review", "A thorough review for bugs, security, performance and readability.", ["code review", "quality"], `
Review this {{language}} code.

What it should do: {{purpose}}

Check for, in order of importance: bugs and edge cases, security issues, performance problems, readability and naming, and missing tests. For each finding give the line or snippet, why it matters, and a corrected version. Finish with the 3 most important fixes. Don't rewrite code that is fine.

\`\`\`
{{code}}
\`\`\``, true),
  p("debug-an-error", "coding", "Debug an error", "Find the root cause of an error and fix it properly.", ["debugging", "errors"], `
Help me debug this error in my {{language}} / {{framework}} project.

What I was doing: {{what_happened}}
What I expected: {{expected}}

Error message and stack trace:
\`\`\`
{{error}}
\`\`\`

Relevant code:
\`\`\`
{{code}}
\`\`\`

Explain the most likely root cause, give a fix, and explain how to confirm it worked. If more than one cause is possible, list them in order of likelihood and what would tell them apart.`, true),
  p("write-unit-tests", "coding", "Write unit tests", "Tests that cover the behaviour, edge cases and failures.", ["testing", "unit tests"], `
Write unit tests for the code below using {{test_framework}}.

Cover: normal behaviour, edge cases (empty, zero, very large, unusual input), error handling, and any branches. Use descriptive test names that state the expected behaviour. Don't change the code under test; if something is hard to test, say why and suggest a change.

\`\`\`{{language}}
{{code}}
\`\`\``),
  p("explain-this-code", "coding", "Explain this code", "Walk through unfamiliar code step by step.", ["learning", "explanation"], `
Explain what this {{language}} code does for someone with {{experience_level}} experience.

Give: a one-paragraph overview, a step-by-step walkthrough of the important parts, any non-obvious tricks or gotchas, and how I would safely change {{change_i_want}}.

\`\`\`
{{code}}
\`\`\``),
  p("refactor-code", "coding", "Refactor for readability", "Cleaner code with the same behaviour.", ["refactoring", "clean code"], `
Refactor this {{language}} code for readability and maintainability.

Constraints:
- Behaviour must stay exactly the same, including edge cases and errors.
- Keep the public interface (names, parameters, return types) unless I say otherwise: {{interface_changes}}
- Follow {{style_guide}} conventions.

Return the refactored code, then a list of changes and why each helps.

\`\`\`
{{code}}
\`\`\``),
  p("design-an-api", "coding", "Design a REST API", "Endpoints, data model and error handling for a new API.", ["api", "architecture", "rest"], `
Design a REST API for {{feature}}.

Users and roles: {{roles}}
Main operations: {{operations}}
Constraints: {{constraints}}

Give: the resources and data model, endpoints (method, path, request and response bodies), authentication and authorisation rules, validation, error format and status codes, pagination, and rate limiting. Point out design decisions I need to make.`),
  p("sql-query", "coding", "Write a SQL query", "A correct, readable query from your schema and question.", ["sql", "database"], `
Write a {{database}} SQL query to answer: {{question}}

Schema:
\`\`\`sql
{{schema}}
\`\`\`

Return the query, a plain-English explanation, assumptions you made about the data, and any indexes that would help it run fast. Avoid SELECT *.`),
  p("regex-builder", "coding", "Build a regular expression", "A regex with tests and an explanation.", ["regex"], `
Write a regular expression for {{language_or_tool}} that matches {{what_to_match}}.

Should match:
{{should_match}}

Should not match:
{{should_not_match}}

Return the pattern, a part-by-part explanation, and a short test showing each example above passing or failing as expected. Mention edge cases it won't handle.`),
  p("project-scaffold-plan", "coding", "Plan a new app before coding", "Agree on architecture and steps before writing code.", ["architecture", "planning", "app"], `
I want to build {{app_description}} using {{tech_stack}}.

Users: {{users}}
Must-have features: {{features}}

Before writing code, give me: the architecture, the folder structure, the data model, the main libraries with reasons, the order to build things in (smallest working version first), and the risks or decisions I should make now. Ask me anything that would change the plan.`),

  // ---------------------------------------------------------------- Data
  p("analyse-a-dataset", "data", "Analyse a dataset", "Find patterns, outliers and insights in your data.", ["analysis", "insights", "csv"], `
Analyse this data about {{topic}}.

Question I want answered: {{question}}

Data:
"""
{{data}}
"""

Describe the data (rows, columns, gaps), answer my question with the numbers behind it, point out trends, outliers and anything suspicious, and suggest 3 follow-up analyses. Show calculations, and say when the data is too small or incomplete to support a conclusion.`, true),
  p("excel-formula", "data", "Excel or Sheets formula", "The right formula for a spreadsheet task, explained.", ["excel", "google sheets", "formulas"], `
I'm using {{spreadsheet_app}}. Write a formula that {{what_it_should_do}}.

My data: {{data_layout}}

Return the formula, where to put it, a plain-English explanation of each part, and how to adapt it if my data grows. If a pivot table or a different approach is simpler, say so.`),
  p("dashboard-kpis", "data", "Choose KPIs for a dashboard", "The metrics that actually reflect how a team or product is doing.", ["kpi", "metrics", "dashboard"], `
Suggest KPIs for a {{team_or_product}} dashboard.

Goals: {{goals}}
Data we have: {{available_data}}
Who will look at it: {{audience}}

Give 5–8 KPIs with: definition, how to calculate it, why it matters, a leading or lagging label, and the chart that suits it. Flag any vanity metrics to avoid.`),
  p("survey-analysis", "data", "Summarise survey responses", "Themes, sentiment and quotes from open-ended answers.", ["survey", "feedback", "qualitative"], `
Analyse these survey responses to the question "{{question}}".

Responses:
"""
{{responses}}
"""

Group them into themes with a count for each, give 1–2 representative quotes per theme (exact wording), note overall sentiment, and list surprising or minority views. End with 3 recommendations tied to the themes. Don't over-generalise from small numbers.`),
  p("explain-statistics", "data", "Interpret statistical results", "What a test result really means, in plain language.", ["statistics", "a/b testing"], `
Help me interpret these results from {{test_or_study}}:
{{results}}

Explain in plain language what they show, whether the result is statistically and practically significant, what they don't show, and the most likely ways I could be misreading them. If key information is missing (sample size, variance), say what you need.`),
  p("python-data-script", "data", "Python script to clean data", "A pandas script that cleans and summarises a file.", ["python", "pandas", "data cleaning"], `
Write a Python script using pandas to clean {{file_type}} data.

Columns: {{columns}}
Problems to fix: {{problems}}
Output: {{output}}

Load the file, fix the problems above, log what changed (rows dropped, values filled), and save the result. Add comments and keep it runnable as-is with a placeholder file path.`),

  // ---------------------------------------------------------------- Learning
  p("explain-a-concept", "education", "Explain a concept", "Understand any topic at the right level, with examples.", ["learning", "explanation", "study"], `
Explain {{concept}} to me. My current level: {{level}}.

Start with a one-sentence definition, then build up: an everyday analogy, how it works, a worked example, and common misconceptions. Finish with 3 questions to check my understanding (answers at the end).`, true),
  p("study-plan", "education", "Personal study plan", "A realistic week-by-week plan for learning something new.", ["study plan", "learning", "schedule"], `
Make a study plan for learning {{subject}}.

Goal: {{goal}}
Time available: {{hours_per_week}} hours a week for {{weeks}} weeks
Current level: {{level}}
How I like to learn: {{learning_style}}

Give a week-by-week plan with topics, practice activities and a checkpoint each week. Build in review sessions and one buffer week. Suggest free resource types to look for, rather than specific links.`),
  p("quiz-me", "education", "Quiz me", "Practice questions with feedback, one at a time.", ["quiz", "revision", "exam prep"], `
Quiz me on {{topic}} at {{level}} level to help me prepare for {{exam_or_goal}}.

Ask one question at a time, mixing multiple choice and short answer. After each answer, tell me if I'm right, explain why, and adjust the difficulty. After 10 questions, summarise my weak areas and what to review.`),
  p("lesson-plan", "education", "Lesson plan", "A complete lesson with objectives, activities and assessment.", ["teaching", "lesson plan"], `
Create a {{duration}}-minute lesson plan on {{topic}} for {{students}}.

Include: learning objectives, a starter activity, main teaching with timings, a hands-on or group activity, differentiation for students who need support or extension, an assessment check, and homework. List materials needed.`),
  p("feynman-check", "education", "Check my understanding", "Explain a topic in your own words and get feedback on gaps.", ["learning", "feedback", "feynman technique"], `
I'm learning {{topic}}. Here is my explanation in my own words:
"""
{{my_explanation}}
"""

Tell me what I got right, what's wrong or imprecise, and what important ideas I left out. Then ask me 2 questions that probe the weakest part of my understanding.`),
  p("flashcards", "education", "Make flashcards", "Question-and-answer flashcards from your notes.", ["flashcards", "revision"], `
Turn these notes into {{count}} flashcards.

Notes:
"""
{{notes}}
"""

Each card: a clear question on the front and a short, precise answer on the back. Cover definitions, key facts, and "why/how" questions, not just recall. Only use information in the notes. Format as a table with Front and Back columns.`),
  p("essay-feedback", "education", "Feedback on an essay", "Specific, constructive feedback against your criteria.", ["essay", "feedback", "writing"], `
Give feedback on my essay for {{course_or_purpose}}.

Assessment criteria: {{criteria}}

Essay:
"""
{{essay}}
"""

For each criterion: what works, what to improve, and a concrete example from the essay. Then the 3 changes that would improve it most. Don't rewrite the essay for me.`),

  // ---------------------------------------------------------------- Research
  p("research-briefing", "research", "Research briefing", "A balanced overview of a topic with what's known and debated.", ["research", "overview", "briefing"], `
Give me a research briefing on {{topic}} for {{purpose}}.

Cover: key background, the current state of knowledge, main debates and the strongest arguments on each side, important numbers (say how confident you are and how recent), and open questions. Separate well-established facts from contested claims. List the kinds of sources I should check to verify the important points.`, true),
  p("compare-options", "research", "Compare options side by side", "A fair comparison table to help you decide.", ["comparison", "decision", "pros and cons"], `
Compare {{options}} for {{use_case}}.

What matters most to me: {{criteria}}
Budget or constraints: {{constraints}}

Give a comparison table against my criteria, the main trade-offs, which option fits which kind of person, and your recommendation for my situation with reasons. Flag anything that may have changed recently (prices, features) so I can check it.`, true),
  p("literature-summary", "research", "Summarise a paper", "Key findings, methods and limitations of a research paper.", ["paper", "academic", "summary"], `
Summarise this research paper for {{audience}}.

"""
{{paper_text}}
"""

Include: the research question, method, sample, key findings with numbers, limitations, and what it means in practice. Quote numbers exactly. Note whether the conclusions go further than the data supports.`),
  p("fact-check-claim", "research", "Check a claim", "How to verify a claim and what would change the answer.", ["fact check", "verification"], `
Help me check this claim: "{{claim}}"

Explain what would need to be true for it to hold, what you know about it (with your confidence), common ways claims like this are misleading, and exactly what I should look for in primary sources to verify it. If you don't know, say so.`),
  p("interview-questions-research", "research", "User interview script", "Open, unbiased questions for customer or user research.", ["user research", "interviews", "ux"], `
Write a user interview script to learn about {{topic}} from {{participants}}.

Research goals: {{goals}}

Include a warm-up, 10–12 open questions that ask about past behaviour (not hypotheticals or leading questions), follow-up probes, and a wrap-up. Add a note on what to avoid saying.`),
  p("pros-cons-decision", "research", "Think through a decision", "Structured thinking for a hard personal or work decision.", ["decision making", "thinking"], `
Help me think through a decision: {{decision}}

My options: {{options}}
What matters to me: {{values}}
Constraints: {{constraints}}

For each option: likely outcomes, best and worst case, what I'd need to believe for it to be right, and how reversible it is. Then ask me the 3 questions that would most help me decide. Don't decide for me.`),

  // ---------------------------------------------------------------- Productivity
  p("plan-my-week", "productivity", "Plan my week", "Turn a messy to-do list into a realistic weekly plan.", ["planning", "time management", "to-do"], `
Help me plan my week.

My tasks:
{{tasks}}

Fixed commitments: {{commitments}}
Working hours: {{hours}}
Top priority this week: {{priority}}

Sort tasks by urgency and importance, estimate time for each, and schedule them into days with buffer time. Flag anything that won't fit and what I could drop, delegate or postpone.`, true),
  p("professional-email-reply", "productivity", "Reply to an email", "A clear, polite reply that gets to the point.", ["email", "reply", "communication"], `
Draft a reply to the email below.

What I want to say: {{my_points}}
Tone: {{tone}}

Keep it concise, answer every question they asked, and end with a clear next step. Don't commit me to anything I haven't mentioned.

Their email:
"""
{{email}}
"""`, true),
  p("break-down-a-project", "productivity", "Break a project into tasks", "A step-by-step task list with order and estimates.", ["project management", "tasks"], `
Break down this project into tasks: {{project}}

Deadline: {{deadline}}
People involved: {{people}}

Give phases, tasks within each phase with a time estimate and dependencies, milestones, and the critical path. Highlight the first 3 tasks to start today.`),
  p("meeting-agenda", "productivity", "Meeting agenda", "A focused agenda with timings and outcomes.", ["meetings", "agenda"], `
Create an agenda for a {{duration}}-minute meeting about {{purpose}} with {{attendees}}.

Outcome we need: {{outcome}}

Include: objective, pre-reading, agenda items with owner and timing, decisions to make, and a final 5 minutes for actions. Keep it achievable in the time.`),
  p("sop-writer", "productivity", "Write a standard operating procedure", "A clear step-by-step process anyone can follow.", ["process", "sop", "documentation"], `
Write a standard operating procedure for {{process}}.

Who does it: {{role}}
How it's done today (rough notes):
"""
{{notes}}
"""

Include: purpose, when to use it, tools needed, numbered steps (one action each), checks, common mistakes, and who to contact when something goes wrong. Don't add steps that aren't in my notes; mark gaps as [CONFIRM: …].`),
  p("decision-log-summary", "productivity", "Summarise a long thread", "The decisions, open questions and next steps from a long chat or email thread.", ["slack", "email thread", "summary"], `
Summarise this thread for someone who wasn't in it.

Give: what it's about (one line), decisions made, open questions, who is waiting on whom, and the next steps. Use names as they appear. Keep it under 150 words.

Thread:
"""
{{thread}}
"""`),

  // ---------------------------------------------------------------- Career
  p("tailor-my-resume", "career", "Tailor my CV to a job", "Match your CV to a job description without exaggerating.", ["resume", "cv", "job application"], `
Tailor my CV to this job.

Job description:
"""
{{job_description}}
"""

My CV:
"""
{{cv}}
"""

Suggest: a rewritten summary, bullet points rewritten to match the role's priorities (use strong verbs and keep my real numbers; never invent achievements), skills to move up, and gaps I should address in a cover letter. Then list the job's keywords I already cover and those I don't.`, true),
  p("cover-letter", "career", "Cover letter", "A specific, honest cover letter for one role.", ["cover letter", "job application"], `
Write a cover letter for the {{role}} role at {{company}}.

Why I want this role: {{motivation}}
My most relevant experience: {{experience}}
Job description highlights: {{job_highlights}}

Keep it under 300 words: a specific opening (not "I am writing to apply"), 2 short paragraphs connecting my experience to their needs with real examples, and a confident close. Use only the experience I gave.`),
  p("interview-prep", "career", "Interview practice", "Likely questions and a mock interview with feedback.", ["interview", "job search"], `
Help me prepare for a {{interview_type}} interview for {{role}} at {{company}}.

My background: {{background}}

First, list the 10 most likely questions, including 3 role-specific ones. Then run a mock interview: ask one question at a time, wait for my answer, and give feedback using the STAR method (situation, task, action, result) before the next question.`, true),
  p("salary-negotiation", "career", "Salary negotiation script", "What to say when negotiating an offer.", ["negotiation", "salary", "offer"], `
Help me negotiate a job offer.

Offer: {{offer}}
What I want: {{target}}
My leverage: {{leverage}}
What matters besides salary: {{other_priorities}}

Give me: a short email asking for more, a phone script with responses to likely pushback, and other things I could negotiate if salary is fixed. Keep it professional and honest.`),
  p("linkedin-profile", "career", "LinkedIn headline and About", "A profile that says clearly what you do and for whom.", ["linkedin", "personal brand"], `
Write my LinkedIn headline and About section.

What I do: {{role}}
Who I help and how: {{value}}
Achievements: {{achievements}}
What I'm looking for: {{goal}}

Give 3 headline options (under 220 characters) and an About section of 150–250 words in the first person, specific and without buzzwords. Use only the achievements I listed.`),
  p("career-change-plan", "career", "Plan a career change", "A practical route from your current role to a new one.", ["career change", "skills"], `
I want to move from {{current_role}} to {{target_role}}.

My skills and experience: {{skills}}
Time and money I can invest: {{resources}}

Map my transferable skills, the gaps, and a 6-month plan with concrete steps (learning, projects to build, people to talk to). Suggest how to describe my background for the new role.`),

  // ---------------------------------------------------------------- Customer support
  p("support-reply", "customer_support", "Customer support reply", "An empathetic, accurate reply to a customer message.", ["support", "customer service", "reply"], `
Write a reply to this customer on behalf of {{company}}.

Customer message:
"""
{{message}}
"""

What we can do: {{resolution}}
Policy to follow: {{policy}}

Acknowledge the issue in one line, explain what we'll do and when, give any steps they need to take, and close warmly. Keep it under 150 words. Don't promise anything beyond the resolution above.`, true),
  p("faq-from-tickets", "customer_support", "FAQ from support tickets", "Turn repeated questions into clear FAQ answers.", ["faq", "help center", "knowledge base"], `
Create FAQ entries from these customer questions for {{product}}.

Questions:
"""
{{questions}}
"""

Product facts to use:
"""
{{facts}}
"""

Group similar questions, write one clear question per group in the customer's words, and answer in 2–4 sentences with steps where useful. Only use the facts provided; mark anything else as [CONFIRM].`),
  p("angry-customer", "customer_support", "Respond to an upset customer", "Calm, de-escalating response that solves the problem.", ["complaints", "de-escalation"], `
A customer is upset. Help me respond.

Their message:
"""
{{message}}
"""

What went wrong on our side: {{our_mistake}}
What I can offer: {{offer}}

Write a reply that takes responsibility without over-apologising, explains what happens next and by when, and offers {{offer}}. No defensive language or blame. Under 140 words.`),
  p("help-article", "customer_support", "Help-centre article", "A step-by-step how-to article for your product.", ["documentation", "how-to", "help center"], `
Write a help-centre article: "How to {{task}} in {{product}}".

Steps (rough):
{{steps}}

Include: a one-line summary, who it's for, prerequisites, numbered steps (one action each, with the exact button names I gave), what to do if it doesn't work, and related articles to link. Mark screenshots as [Screenshot: …].`),
  p("support-macro-set", "customer_support", "Support reply templates", "Reusable replies for common situations.", ["macros", "templates"], `
Write support reply templates for {{product}} for these situations:
{{situations}}

Brand tone: {{tone}}

For each: a short title, the reply with [placeholders] for details, and an internal note on when not to use it. Keep each under 120 words.`),

  // ---------------------------------------------------------------- Personal
  p("trip-itinerary", "personal", "Plan a trip", "A day-by-day itinerary that fits your pace and budget.", ["travel", "itinerary", "planning"], `
Plan a {{days}}-day trip to {{destination}} in {{month}}.

Travellers: {{travellers}}
Budget: {{budget}}
Interests: {{interests}}
Pace: {{pace}}

Give a day-by-day plan (morning, afternoon, evening) grouped by area to limit travel time, food suggestions by type, getting around, and a packing list for the season. Flag anything that should be booked ahead, and remind me to check opening hours and prices before going.`, true),
  p("meal-plan", "personal", "Weekly meal plan", "Meals and a shopping list that fit your diet and time.", ["cooking", "meal plan", "recipes"], `
Make a 7-day meal plan for {{people}} people.

Diet and dislikes: {{diet}}
Cooking time on weekdays: {{weekday_time}}
Budget: {{budget}}
Cuisine I enjoy: {{cuisine}}

Give breakfast, lunch and dinner each day, reuse ingredients to cut waste, include 2 batch-cook meals, and finish with a shopping list grouped by aisle. This is general meal planning, not medical or nutrition advice.`),
  p("budget-planner", "personal", "Monthly budget", "A simple budget from your income and spending.", ["budget", "money", "personal finance"], `
Help me make a monthly budget.

Monthly income after tax: {{income}}
Fixed costs: {{fixed_costs}}
Variable spending I know of: {{variable_spending}}
Goal: {{goal}}

Organise this into categories, show what's left over, suggest realistic areas to cut, and a simple plan to reach my goal. Show the arithmetic. This is general budgeting help, not financial advice.`),
  p("gift-ideas", "personal", "Gift ideas", "Thoughtful gift ideas for a specific person and budget.", ["gifts", "shopping"], `
Suggest gift ideas for {{person}} for {{occasion}}.

About them: {{about_them}}
Budget: {{budget}}

Give 10 ideas across categories (experience, practical, personal, handmade), each with why it fits them. Avoid generic gifts unless they'd genuinely suit this person.`),
  p("home-repair-help", "personal", "Fix something at home", "Step-by-step guidance for a household problem, and when to call a pro.", ["home maintenance", "diy", "repairs"], `
Help me with a problem at home: {{problem}}

What I've noticed: {{symptoms}}
Tools I have: {{tools}}

List likely causes, simple checks to narrow it down, safe step-by-step fixes for the most likely cause, and clear signs that I should stop and call a professional (especially for anything involving gas, mains electricity or structural work).`),
  p("difficult-conversation", "personal", "Prepare for a difficult conversation", "Plan what to say in a hard conversation, calmly and kindly.", ["communication", "relationships"], `
Help me prepare for a difficult conversation with {{person}} about {{topic}}.

What happened: {{context}}
What I want from the conversation: {{goal}}

Suggest an opening line, how to describe the situation without blame, how to listen and respond if they react with {{likely_reaction}}, and a way to agree on next steps. Keep it respectful and honest.`),
  p("workout-plan", "personal", "Beginner workout routine", "A simple, safe routine to build a habit.", ["fitness", "exercise", "habits"], `
Create a beginner workout plan.

Goal: {{goal}}
Days per week: {{days}}
Time per session: {{minutes}} minutes
Equipment: {{equipment}}
Limitations: {{limitations}}

Give a weekly schedule with warm-up, exercises (sets, reps, rest) and cool-down, how to progress over 4 weeks, and form tips. Remind me to check with a doctor before starting if I have health conditions.`),

  // ---------------------------------------------------------------- Creative
  p("story-starter", "creative", "Short story", "An original short story from your idea, genre and length.", ["fiction", "story", "writing"], `
Write an original short story.

Idea: {{idea}}
Genre: {{genre}}
Length: about {{word_count}} words
Audience: {{audience}}
Point of view: {{point_of_view}}

Give it a strong opening line, a clear conflict, and an ending that pays off the setup. Show, don't tell; use dialogue where it helps.`),
  p("brainstorm-ideas", "creative", "Brainstorm ideas", "Lots of varied ideas, then the best ones developed.", ["brainstorming", "ideas", "creativity"], `
Brainstorm ideas for {{challenge}}.

Constraints: {{constraints}}
Audience: {{audience}}

Give 20 varied ideas: obvious, unusual, low-cost and ambitious. Then pick the 3 most promising, explain why, and outline the first step for each.`, true),
  p("name-generator", "creative", "Name ideas", "Name options for a product, business or project.", ["naming", "branding"], `
Suggest names for {{what_needs_a_name}}.

What it does: {{description}}
Personality: {{personality}}
Avoid: {{avoid}}

Give 20 options in different styles (descriptive, invented, metaphor, compound), with a one-line rationale each. Then pick the top 3. Remind me to check trademarks and domain availability myself.`),
  p("poem-writer", "creative", "Write a poem", "A poem in the style and form you choose.", ["poetry"], `
Write an original {{form}} poem about {{subject}}.

Mood: {{mood}}
Include these images or ideas: {{images}}

Use fresh, concrete imagery and avoid clichés. After the poem, add one line on the main image you built it around.`),
  p("video-script", "creative", "Short video script", "A script for a short-form video with hook and shots.", ["video", "youtube", "reels", "script"], `
Write a {{length_seconds}}-second video script about {{topic}} for {{platform}}.

Audience: {{audience}}
Goal: {{goal}}

Include: a hook in the first 3 seconds, the script with on-screen text and shot suggestions in a two-column table, and a call to action. Keep the language spoken and simple.`),
  p("kids-activity", "creative", "Activity ideas for children", "Fun, age-appropriate activities with what you need.", ["kids", "parenting", "activities"], `
Suggest activities for {{number}} children aged {{ages}} for {{setting}}.

Time available: {{time}}
Materials we have: {{materials}}

Give 8 activities with: what you need, how to do it, and what children get from it. Include quiet and active options, and safety notes where relevant.`),
];

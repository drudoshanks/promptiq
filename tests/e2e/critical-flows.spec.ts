import { expect, test } from "@playwright/test";

/**
 * Critical-flow E2E (SRS §13.1 E2E, §13.2 last criterion): sign-up, optimise,
 * edit, export, feedback, preference edit/delete, settings. Runs on desktop and
 * mobile projects (playwright.config.ts). Requires a database and the mock
 * optimiser (OPTIMISER_PROVIDER=mock).
 */
const unique = `${Date.now()}`;
const email = `e2e-${unique}@example.com`;
const password = "correct-horse-battery-staple";

test.describe.configure({ mode: "serial" });

test("landing page renders the before/after sample without savings claims", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nothing invented");
  await expect(page.getByText("Original")).toBeVisible();
  await expect(page.getByText("Proposed")).toBeVisible();
  await expect(page.getByText(/estimate/i).first()).toBeVisible();
  await expect(page.getByText(/save \d+%/i)).toHaveCount(0);
});

test("sign up, onboard, optimise, edit, copy, export, give feedback", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/app\/onboarding/);
  await page.getByLabel("Default tone").selectOption("professional_direct");
  await page.getByRole("button", { name: "Save and open the studio" }).click();
  await expect(page).toHaveURL(/\/app\/studio/);

  const prompt = "write me an email to a client about the invoice they havent paid its invoice 4471 for $2,300";
  await page.getByLabel("Your prompt").fill(prompt);
  await page.getByRole("button", { name: "Optimise prompt" }).click();

  await expect(page.getByRole("heading", { name: "Proposed rewrite" })).toBeVisible();
  await expect(page.getByText("4471").first()).toBeVisible();
  await expect(page.getByText("What changed")).toBeVisible();

  await page.getByRole("button", { name: "Edit proposal" }).click();
  const editor = page.getByLabel("Your version");
  await editor.fill((await editor.inputValue()) + "\n\nKeep it under 120 words.");
  await page.getByRole("button", { name: "Done editing" }).click();
  await expect(page.getByRole("button", { name: "Reset to proposal" })).toBeVisible();

  await page.getByRole("button", { name: "Copy prompt" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByLabel("Format").selectOption("md");
  await page.getByRole("button", { name: /Download MD/ }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);

  await page.getByRole("button", { name: "Helpful" }).click();
  await page.getByLabel("Reason (optional)").selectOption("CLEARER");
  await page.getByRole("button", { name: "Send feedback" }).click();
  await expect(page.getByText("feedback recorded")).toBeVisible();
});

test("library shows the saved optimisation with two versions", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto("/app/library");
  await page.getByRole("link", { name: /write me an email/ }).first().click();
  await expect(page.getByText(/versions\. Versions are immutable/)).toBeVisible();
  await expect(page.getByRole("option", { name: /Version 2/ })).toHaveCount(1);
});

test("preferences can be edited, disabled and deleted; settings toggles persist", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.goto("/app/preferences");
  await expect(page.getByText("Set by you").first()).toBeVisible();
  await page.getByRole("switch").first().click();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByText("No preferences yet")).toBeVisible();

  await page.goto("/app/settings");
  await page.getByRole("switch", { name: "Keep a history of my prompts" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Keep a history of my prompts" })).toHaveAttribute("aria-checked", "false");
});

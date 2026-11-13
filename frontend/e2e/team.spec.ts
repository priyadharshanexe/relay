import { expect, test } from "@playwright/test";

const PASSWORD = "an-end-to-end-test-passphrase";

/**
 * Two people, two browsers:
 *
 *   an owner signs up -> invites a teammate as a viewer -> the teammate opens
 *   the link, creates an account and lands in the owner's organisation,
 *   read-only -> the owner removes them -> their access ends.
 */
test("an owner invites a teammate by link, then removes them", async ({ page, browser }) => {
  const stamp = Date.now();
  const ownerEmail = `e2e-owner-${stamp}@example.com`;
  const teammateEmail = `e2e-teammate-${stamp}@example.com`;

  await test.step("the owner signs up", async () => {
    await page.goto("/register");
    await page.getByLabel("Organisation name").fill("Team E2E Org");
    await page.getByLabel("Email").fill(ownerEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Endpoints", exact: true })).toBeVisible();
  });

  const link = await test.step("the owner creates an invitation link", async () => {
    await page.getByRole("link", { name: "Team" }).click();
    await expect(page.getByLabel(`Role of ${ownerEmail}`)).toHaveValue("owner");

    await page.getByRole("button", { name: "Invite someone" }).click();
    const form = page.getByRole("dialog", { name: "Invite someone" });
    await form.getByLabel("Email").fill(teammateEmail);
    await form.getByLabel("Role").selectOption("viewer");
    await form.getByRole("button", { name: "Create invitation" }).click();

    const shown = page.getByRole("dialog", { name: "Send this invitation link" });
    const url = (await shown.getByTestId("secret-value").textContent()) ?? "";
    expect(url).toContain("/invite/");
    await shown.getByRole("button", { name: "I have copied it" }).click();

    // The link is gone from the page; the invitation is listed as pending.
    await expect(page.getByText("/invite/")).toHaveCount(0);
    await expect(page.getByRole("cell", { name: teammateEmail })).toBeVisible();
    return url;
  });

  // A second browser with its own cookies: the teammate's.
  const context = await browser.newContext();
  const theirs = await context.newPage();

  await test.step("the teammate opens the link and creates an account", async () => {
    await theirs.goto(link);
    await expect(theirs.getByRole("heading", { name: "Join Team E2E Org" })).toBeVisible();
    await theirs.getByRole("link", { name: "Create an account" }).click();

    // No organisation to name, and the address is the invited one.
    await expect(theirs.getByLabel("Organisation name")).toHaveCount(0);
    await expect(theirs.getByLabel("Email")).toHaveValue(teammateEmail);
    await theirs.getByLabel("Password").fill(PASSWORD);
    await theirs.getByRole("button", { name: "Create account and join" }).click();

    await expect(theirs.getByRole("heading", { name: "Endpoints", exact: true })).toBeVisible();
    await expect(theirs.getByLabel("Organisation")).toContainText("Team E2E Org");
    // A viewer can look, and change nothing.
    await expect(theirs.getByRole("button", { name: "Add endpoint" })).toHaveCount(0);
  });

  await test.step("the link cannot be used a second time", async () => {
    const stranger = await (await browser.newContext()).newPage();
    await stranger.goto(link);
    await expect(stranger.getByRole("alert")).toContainText("not valid any more");
    await stranger.context().close();
  });

  await test.step("the owner sees the new member and removes them", async () => {
    await page.reload();
    const row = page.getByRole("row", { name: new RegExp(teammateEmail) });
    await expect(row.getByLabel(`Role of ${teammateEmail}`)).toHaveValue("viewer");
    await expect(page.getByText("Nobody is waiting to join.")).toBeVisible();

    await row.getByRole("button", { name: "Remove" }).click();
    await page
      .getByRole("dialog", { name: "Remove this member?" })
      .getByRole("button", { name: "Remove member" })
      .click();
    await expect(page.getByRole("row", { name: new RegExp(teammateEmail) })).toHaveCount(0);
  });

  await test.step("the teammate has lost access", async () => {
    await theirs.reload();
    await expect(
      theirs.getByRole("heading", { name: "You are not in any organisation" }),
    ).toBeVisible();
  });

  await context.close();
});

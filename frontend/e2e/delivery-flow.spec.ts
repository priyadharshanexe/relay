import { expect, test } from "@playwright/test";

/**
 * The story a customer and a support engineer live through:
 *
 *   sign up -> create a receiver that fails -> point an endpoint at it ->
 *   send an event -> watch it fail and land in the dead-letter queue ->
 *   fix the receiver -> replay -> see it succeed, with the full history kept.
 */
test("a failing delivery is dead-lettered, then replayed successfully", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;

  await test.step("sign up", async () => {
    await page.goto("/register");
    await page.getByLabel("Organisation name").fill("E2E Org");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("an-end-to-end-test-passphrase");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Endpoints", exact: true })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
  });

  const receiverUrl = await test.step("create a test receiver that fails", async () => {
    await page.getByRole("link", { name: "Test receivers" }).click();
    await page.getByRole("button", { name: "Create test receiver" }).first().click();
    await page.getByRole("dialog").getByLabel("Name").fill("Flaky customer");
    await page.getByRole("dialog").getByRole("button", { name: "Create receiver" }).click();
    await expect(page.getByText("Flaky customer")).toBeVisible();

    await page.getByLabel("Behaviour").selectOption({ label: "Fail (500)" });
    await expect(page.getByText("Rejects every webhook, so Relay retries.")).toBeVisible();

    const url = (await page.locator("code").first().textContent()) ?? "";
    expect(url).toContain("/receiver/");
    return url;
  });

  await test.step("add an endpoint and see its secret once", async () => {
    await page.getByRole("link", { name: "Endpoints" }).click();
    await page.getByRole("button", { name: "Add endpoint" }).first().click();
    await page.getByRole("dialog").getByLabel("URL").fill(receiverUrl);
    await page.getByRole("dialog").getByRole("button", { name: "Create endpoint" }).click();

    const secret = page.getByRole("dialog", { name: "Save this secret" });
    await expect(secret.getByTestId("secret-value")).toContainText("whsec_");
    await secret.getByRole("button", { name: "I have saved it" }).click();
    await expect(page.getByText("whsec_")).toHaveCount(0);
    await expect(page.getByText(receiverUrl)).toBeVisible();
  });

  await test.step("send an event", async () => {
    await page.getByRole("button", { name: "Send test event" }).click();
    await expect(page.getByText(/Test event queued\./)).toBeVisible();
  });

  await test.step("the delivery fails every attempt and is dead-lettered", async () => {
    await page.getByRole("link", { name: "Dead-letter queue" }).click();
    // The worker needs a few seconds to run out of attempts.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("link", { name: "relay.test" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await expect(page.getByText("The receiver answered HTTP 500")).toBeVisible();

    await page.getByRole("link", { name: "relay.test" }).click();
    await expect(page.getByText("Dead", { exact: true })).toBeVisible();
    await expect(page.getByText("Attempt 3")).toBeVisible();
    await expect(page.getByText("HTTP 500", { exact: true })).toHaveCount(3);
    await expect(page.getByText("Attempt 4")).toHaveCount(0);
  });

  const deliveryUrl = page.url();

  await test.step("the request log shows a masked signature", async () => {
    await page.getByRole("button", { name: "Show request and response" }).first().click();
    await expect(page.getByText(/^v1,.{6}\*{4}$/)).toBeVisible();
    await expect(page.getByText("webhook-id:")).toBeVisible();
  });

  await test.step("fix the receiver", async () => {
    await page.getByRole("link", { name: "Test receivers" }).click();
    await page.getByLabel("Behaviour").selectOption({ label: "Succeed (200)" });
    await expect(page.getByText("Accepts every webhook.")).toBeVisible();
    await expect(page.getByText("3 requests received")).toBeVisible();
  });

  await test.step("replay, and the delivery succeeds with its history kept", async () => {
    await page.goto(deliveryUrl);
    await page.getByRole("button", { name: "Replay" }).click();
    await expect(page.getByText(/Queued for replay/)).toBeVisible();

    await expect(page.getByText("Succeeded", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Attempt 4")).toBeVisible();
    await expect(page.getByText("HTTP 200", { exact: true })).toHaveCount(1);
    await expect(page.getByText("HTTP 500", { exact: true })).toHaveCount(3); // failures remain
  });

  await test.step("the dead-letter queue is empty again", async () => {
    await page.getByRole("link", { name: "Dead-letter queue" }).click();
    await expect(page.getByText("The dead-letter queue is empty")).toBeVisible();
  });

  await test.step("the delivery explorer filter is kept in the URL", async () => {
    await page.getByRole("link", { name: "Deliveries", exact: true }).click();
    await page.getByLabel("Status").selectOption({ label: "Succeeded" });
    await expect(page).toHaveURL(/status=succeeded/);
    await expect(page.getByRole("link", { name: "relay.test" })).toBeVisible();
    await page.reload(); // a shared or bookmarked link shows the same view
    await expect(page.getByLabel("Status")).toHaveValue("succeeded");
    await expect(page.getByRole("link", { name: "relay.test" })).toBeVisible();
  });

  await test.step("a new delivery shows up on the live feed", async () => {
    await page.getByRole("link", { name: "Live feed" }).click();
    await expect(page.getByRole("status")).toHaveText("Live");

    const second = await page.context().newPage();
    await second.goto("/endpoints");
    await second.getByRole("button", { name: "Send test event" }).click();
    await expect(second.getByText(/Test event queued\./)).toBeVisible();
    await second.close();

    const row = page.getByRole("row").filter({ hasText: "relay.test" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("HTTP 200")).toBeVisible();
    await expect(row.getByText("Succeeded")).toBeVisible();
  });

  await test.step("log out", async () => {
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await page.goto("/deliveries");
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  });
});

import { expect, test } from "@playwright/test";

/**
 * The tab bar scrolls sideways on a phone but never draws a scrollbar, and on
 * a wide screen it does not overflow at all (a stray vertical scrollbar once
 * showed at its right end on Windows Chrome).
 */
test("the tab bar never shows a scrollbar", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Organisation name").fill("Tab Strip Org");
  await page.getByLabel("Email").fill(`e2e-tabs-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("an-end-to-end-test-passphrase");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Main" });
  const measure = () =>
    nav.evaluate((el: HTMLElement) => ({
      scrollbar: getComputedStyle(el).scrollbarWidth,
      overflowY: getComputedStyle(el).overflowY,
      tallerThanBox: el.scrollHeight > el.clientHeight,
      widerThanBox: el.scrollWidth > el.clientWidth,
      barHeight: el.offsetHeight - el.clientHeight,
    }));

  for (const width of [1366, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const m = await measure();
    expect(m.scrollbar).toBe("none");
    expect(m.overflowY).toBe("hidden");
    expect(m.tallerThanBox).toBe(false);
    expect(m.widerThanBox).toBe(false);
    expect(m.barHeight).toBe(0);
  }

  // On a phone the tabs still scroll sideways, with no visible bar.
  await page.setViewportSize({ width: 375, height: 812 });
  const phone = await measure();
  expect(phone.widerThanBox).toBe(true);
  expect(phone.barHeight).toBe(0);
  await nav.evaluate((el) => el.scrollBy({ left: 200 }));
  expect(await nav.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});

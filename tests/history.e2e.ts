import { expect, test } from "playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

test("feature add can be undone and redone", async ({ page }) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  const featureRows = page.locator("tbody tr.tr-feature");
  const before = await featureRows.count();

  await page.locator(".cv-toolbar .btn-sm", { hasText: "+ Feature" }).click();
  await expect(featureRows).toHaveCount(before + 1);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(featureRows).toHaveCount(before);

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(featureRows).toHaveCount(before + 1);
});

test("new edits after undo clear redo history", async ({ page }) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  await page.locator(".cv-toolbar .btn-sm", { hasText: "+ Feature" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Redo" })).toBeEnabled();

  await page.locator(".cv-toolbar .btn-sm", { hasText: "+ Feature" }).click();
  await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();
});

test("ctrl+z inside a text input does not trigger app undo", async ({
  page,
}) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  const featureRows = page.locator("tbody tr.tr-feature");
  const before = await featureRows.count();
  await page.locator(".cv-toolbar .btn-sm", { hasText: "+ Feature" }).click();
  await expect(featureRows).toHaveCount(before + 1);

  await featureRows.last().locator(".feature-name").click();
  const input = page.locator(".feature-name-input");
  await input.fill("Draft name");
  await page.keyboard.press("Control+Z");

  await expect(featureRows).toHaveCount(before + 1);
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
});

test("capacity cell edits can be undone and redone", async ({ page }) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  if ((await page.locator("th.th-quarter").count()) === 0) {
    await page.locator(".cv-toolbar .btn-sm", { hasText: "+ Quarter" }).click();
    await expect(page.locator("th.th-quarter")).toHaveCount(1);
  }

  const featureRows = page.locator("tbody tr.tr-feature");
  const before = await featureRows.count();
  await page.locator(".cv-toolbar .btn-sm", { hasText: "+ Feature" }).click();
  await expect(featureRows).toHaveCount(before + 1);
  const row = featureRows.last();
  const cell = row.locator(".hm-cell").first();

  await cell.click();
  const input = page.locator(".hm-input");
  await input.fill("");
  await input.pressSequentially("0.5");
  await input.press("Enter");
  await expect(cell).toContainText("0.5");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(cell).not.toContainText("0.5");

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(cell).toContainText("0.5");
});

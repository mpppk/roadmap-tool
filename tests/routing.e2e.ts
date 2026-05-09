import { expect, test } from "playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

test("/ redirects to features view", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForLoadState("networkidle");

  // Should show Features nav tab as active
  const featuresBtn = page.locator(".cv-nav-link.active");
  await expect(featuresBtn).toHaveText("Features");

  // Should show Feature column header
  await expect(page.locator("th.th-label")).toHaveText("Feature");
});

test("/features shows features capacity view", async ({ page }) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator(".cv-nav-link.active")).toHaveText("Features");
  await expect(page.locator("th.th-label")).toHaveText("Feature");
  await expect(
    page.getByRole("button", { name: "Quarter", exact: true }),
  ).toHaveClass(/active/);
});

test("/members shows members capacity view", async ({ page }) => {
  await page.goto(`${BASE}/members`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator(".cv-nav-link.active")).toHaveText("Members");
  await expect(page.locator("th.th-label")).toHaveText("Member");
  await expect(
    page.getByRole("button", { name: "Quarter", exact: true }),
  ).toHaveClass(/active/);
});

test("period toggle switches between quarter and month columns", async ({
  page,
}) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Month" }).click();
  await expect(page.getByRole("button", { name: "Month" })).toHaveClass(
    /active/,
  );

  await page.getByRole("button", { name: "Quarter", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Quarter", exact: true }),
  ).toHaveClass(/active/);
});

test("+ Quarter adds three columns in month view", async ({ page }) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Month" }).click();
  const before = await page.locator("th.th-quarter").count();

  await page.locator(".cv-toolbar .btn-sm", { hasText: "+ Quarter" }).click();
  await expect(page.locator("th.th-quarter")).toHaveCount(before + 3);
});

test("nav tab switches from features to members", async ({ page }) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  // Click Members tab
  await page.locator(".cv-nav-link", { hasText: "Members" }).click();
  await page.waitForLoadState("networkidle");

  expect(page.url()).toBe(`${BASE}/members`);
  await expect(page.locator(".cv-nav-link.active")).toHaveText("Members");
  await expect(page.locator("th.th-label")).toHaveText("Member");
});

test("nav tab switches from members to features", async ({ page }) => {
  await page.goto(`${BASE}/members`);
  await page.waitForLoadState("networkidle");

  // Click Features tab
  await page.locator(".cv-nav-link", { hasText: "Features" }).click();
  await page.waitForLoadState("networkidle");

  expect(page.url()).toBe(`${BASE}/features`);
  await expect(page.locator(".cv-nav-link.active")).toHaveText("Features");
  await expect(page.locator("th.th-label")).toHaveText("Feature");
});

test("/members shows member rows with expand toggle", async ({ page }) => {
  await page.goto(`${BASE}/members`);
  await page.waitForLoadState("networkidle");

  const rows = page.locator("tbody .tr-feature");
  const count = await rows.count();

  if (count === 0) {
    // No members yet — toolbar should have + Member button
    await expect(
      page.locator(".cv-toolbar .btn-sm", { hasText: "+ Member" }),
    ).toBeVisible();
    return;
  }

  // Expand first member row
  const toggleBtn = rows.first().locator(".toggle-btn");
  await expect(toggleBtn).toHaveText("+");
  await toggleBtn.click();
  await expect(toggleBtn).toHaveText("−");

  // Collapse
  await toggleBtn.click();
  await expect(toggleBtn).toHaveText("+");
});

test("/features shows feature rows with expand toggle", async ({ page }) => {
  await page.goto(`${BASE}/features`);
  await page.waitForLoadState("networkidle");

  const rows = page.locator("tbody .tr-feature");
  const count = await rows.count();

  if (count === 0) {
    await expect(
      page.locator(".cv-toolbar .btn-sm", { hasText: "+ Feature" }),
    ).toBeVisible();
    return;
  }

  const toggleBtn = rows.first().locator(".toggle-btn");
  await expect(toggleBtn).toHaveText("+");
  await toggleBtn.click();
  await expect(toggleBtn).toHaveText("−");
});

test("feature label column resizes from a feature row border", async ({
  page,
}) => {
  await page.goto(`${BASE}/features`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("th.th-label")).toHaveText("Feature");

  const featureRows = page.locator("tbody tr.tr-feature");
  if ((await featureRows.count()) === 0) {
    await page.locator(".tr-assign-member .btn-assign", {
      hasText: "+ Feature",
    }).click();
    await expect(featureRows).toHaveCount(1);
  }

  const header = page.locator("th.th-label");
  const initialWidth = await header.evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  const resizeBorder = featureRows
    .first()
    .locator(".td-label .col-resize-border");
  const box = await resizeBorder.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2);
  await page.mouse.up();

  await expect
    .poll(() => header.evaluate((el) => el.getBoundingClientRect().width))
    .toBeGreaterThan(initialWidth + 40);
});

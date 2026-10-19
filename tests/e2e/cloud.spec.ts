import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

test.afterAll(() => {
  const e2eDir = path.resolve(process.cwd(), '.local-cloud-e2e');
  if (fs.existsSync(e2eDir)) {
    fs.rmSync(e2eDir, { recursive: true, force: true });
  }
});

test('Full end-to-end flow: First-run setup, Dashboard, My Drive folder creation, Guest Upload link without login, and responsive mobile UI', async ({
  page,
  browser,
}) => {
  await page.goto('/');

  // 1. First-run Administrator Setup
  await expect(page.getByText('First-Run Raspberry Pi 4 Administrator Setup')).toBeVisible();
  await page.getByPlaceholder('e.g. anvith', { exact: true }).fill('adminpi');
  await page.getByPlaceholder('e.g. Anvith Gopa', { exact: true }).fill('Anvith Pi Admin');
  const passwordInputs = page.locator('input[type="password"]');
  await passwordInputs.nth(0).fill('SuperSecurePi#2026');
  await passwordInputs.nth(1).fill('SuperSecurePi#2026');
  await page.getByRole('button', { name: 'Initialize Administrator Account' }).click();

  // 2. Verify Personal Cloud Dashboard loads with live backend statistics
  await expect(page.getByText('Personal Cloud Dashboard')).toBeVisible();
  await expect(page.getByText('Total HDD Capacity')).toBeVisible();
  await expect(page.getByText('Physical HDD Utilization vs. Indexed Cloud Files')).toBeVisible();

  // 3. Navigate to My Drive and create a folder
  await page.getByRole('link', { name: 'My Drive' }).click();
  await expect(page.getByRole('heading', { name: 'My Drive' })).toBeVisible();

  await page.getByRole('button', { name: 'New Folder' }).click();
  await page.getByPlaceholder('Folder name').fill('Guest Submissions');
  await page.getByRole('button', { name: 'Create Folder' }).click();

  await expect(page.getByText('Guest Submissions')).toBeVisible();

  // 4. Create a Public Guest Upload Link for "Guest Submissions"
  await page.getByRole('link', { name: 'Shared with Upload Permission' }).click();
  await page.getByRole('button', { name: 'New Guest Upload Link' }).click();
  await page.getByRole('button', { name: 'Generate Secure Link' }).click();

  await expect(page.getByText('Public Share Link Ready')).toBeVisible();
  const shareUrlInput = page.locator('input[readonly]');
  const shareUrl = await shareUrlInput.inputValue();
  expect(shareUrl).toContain('/s/');

  await page.getByRole('button', { name: 'Done' }).click();

  // 5. Open a separate unauthenticated guest browser context (Mobile viewport) and visit the share URL
  const guestContext = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14 mobile viewport
  });
  const guestPage = await guestContext.newPage();
  await guestPage.goto(shareUrl);

  await expect(guestPage.getByText('No account required')).toBeVisible();
  await expect(guestPage.getByText('Remaining Quota:')).toBeVisible();

  // Upload a file as an anonymous guest
  const fileInput = guestPage.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: 'guest-submission.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Uploaded by external guest without login!'),
  });

  await guestPage.getByRole('button', { name: /Upload 1 File Now/i }).click();
  await expect(guestPage.getByText('Successfully Uploaded (1)')).toBeVisible();
  await expect(guestPage.getByText('guest-submission.txt')).toBeVisible();

  await guestContext.close();

  // 6. Verify the guest-uploaded file appears in Admin's My Drive inside "Guest Submissions"
  await page.getByRole('link', { name: 'My Drive' }).click();
  await page.getByRole('button', { name: 'Guest Submissions' }).click();
  await expect(page.getByText('guest-submission.txt')).toBeVisible();
});

import { expect, test } from '@playwright/test';

test.describe('dashboard renders every route', () => {
  test('overview page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Dejavas');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    // Sidebar navigation lists every route
    for (const label of [
      'Overview',
      'Agents',
      'Policies',
      'Approvals',
      'Actions',
      'Webhooks',
      'Audit',
    ]) {
      await expect(page.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('agents page renders register form', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(page.getByPlaceholder('research-agent')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
  });

  test('approvals page renders', async ({ page }) => {
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  });

  test('actions page renders', async ({ page }) => {
    await page.goto('/actions');
    await expect(page.getByRole('heading', { name: 'Actions' })).toBeVisible();
  });

  test('audit page renders', async ({ page }) => {
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  });

  test('webhooks page renders create form', async ({ page }) => {
    await page.goto('/webhooks');
    await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible();
    await expect(page.getByPlaceholder('pagerduty-prod')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create webhook' })).toBeVisible();
  });
});

test.describe('policy editor live YAML validation', () => {
  test('shows valid status for the placeholder YAML', async ({ page }) => {
    await page.goto('/policies');
    await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();
    // The pre-filled YAML is the placeholder, which is valid.
    await expect(page.locator('text=/valid/').first()).toBeVisible();
  });

  test('flips to "invalid YAML" when typing garbage', async ({ page }) => {
    await page.goto('/policies');
    const ta = page.locator('textarea[name="yaml"]');
    await ta.fill(': : :');
    // Debounced 200ms — wait a beat then assert the invalid badge appears.
    // Cold compile of /policies in CI can push the first validate() past the
    // default 5s expect timeout.
    await expect(
      page.locator('text=/invalid YAML|schema mismatch/').first(),
    ).toBeVisible({ timeout: 10_000 });
    // Save button disables on invalid input.
    await expect(page.getByRole('button', { name: 'Save and activate' })).toBeDisabled();
  });
});

test.describe('dev mode signal', () => {
  test('shows the "dev mode (no auth)" badge in the sidebar', async ({ page }) => {
    await page.goto('/');
    // Without NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, the nav renders the dev badge.
    // With Clerk wired, there's a UserButton instead — either is fine.
    const dev = page.locator('text=/dev mode/');
    const userBtn = page.locator('[data-clerk-user-button], .cl-userButtonAvatarBox');
    await expect(dev.or(userBtn).first()).toBeVisible();
  });
});

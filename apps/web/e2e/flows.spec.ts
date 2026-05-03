import { expect, test } from '@playwright/test';

// Each run uses unique names so previous test data doesn't collide.
const STAMP = () => Date.now().toString(36);

test.describe('register an agent', () => {
  test('shows reveal-key-once banner, then dismisses cleanly', async ({ page }) => {
    const name = `e2e-register-${STAMP()}`;

    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();

    // Register
    await page.getByPlaceholder('research-agent').fill(name);
    await page.getByRole('button', { name: 'Register' }).click();

    // Banner appears with the dvk_ key. CI cold-compiles /agents on first
    // hit, so allow extra time before falling back to a retry.
    const banner = page.locator('text=/Agent .* registered/').first();
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`text=${name}`).first()).toBeVisible();
    const key = page.locator('code').filter({ hasText: /^dvk_/ }).first();
    await expect(key).toBeVisible();

    // Copy button is present
    await expect(page.getByRole('button', { name: /^Copy$/ })).toBeVisible();

    // Dismiss button (✕) clears the banner
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toBeHidden();

    // The new agent appears in the list below
    await expect(page.locator(`tr:has-text("${name}")`).first()).toBeVisible();
  });
});

test.describe('type-to-confirm revoke', () => {
  test('Revoke button stays disabled until the agent name is typed exactly', async ({
    page,
  }) => {
    // Seed: register an agent we'll revoke (separate from the previous test).
    const name = `e2e-revoke-${STAMP()}`;
    await page.goto('/agents');
    await page.getByPlaceholder('research-agent').fill(name);
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.locator('text=/Agent .* registered/').first()).toBeVisible({
      timeout: 20_000,
    });
    // Dismiss the banner so it doesn't intercept clicks on the row below.
    await page.getByRole('button', { name: 'Dismiss' }).click();

    // Find the row + click Revoke… to expand the confirm form
    const row = page.locator(`tr:has-text("${name}")`).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Revoke…' }).click();

    // The destructive button is rendered but disabled until inputs match
    const confirmBtn = row.getByRole('button', { name: 'Revoke permanently' });
    await expect(confirmBtn).toBeDisabled();

    // Wrong name → still disabled
    const nameInput = row.locator('input[type="text"]').first();
    await nameInput.fill('definitely-not-the-name');
    await expect(confirmBtn).toBeDisabled();

    // Email alone isn't enough — name still wrong
    await row.getByPlaceholder('your@email.com').fill('alice@dejavas.test');
    await expect(confirmBtn).toBeDisabled();

    // Exact name + valid email → enabled
    await nameInput.fill(name);
    await expect(confirmBtn).toBeEnabled();

    // Cancel collapses without revoking
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByRole('button', { name: 'Revoke…' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke permanently' })).toBeHidden();
  });
});

test.describe('webhooks: create + lifecycle', () => {
  test('create reveals secret once, then enable/disable + delete work', async ({
    page,
  }) => {
    const name = `e2e-wh-${STAMP()}`;
    const url = `https://example.test/${STAMP()}`;

    await page.goto('/webhooks');
    await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible();

    await page.getByPlaceholder('pagerduty-prod').fill(name);
    await page.getByPlaceholder('https://hooks.example.com/incoming').fill(url);
    // Default checkboxes (action.failed + approval.expired) satisfy "at least one event"
    await page.getByRole('button', { name: 'Create webhook' }).click();

    // Reveal-secret-once banner
    const banner = page.locator('text=/Webhook .* created/').first();
    await expect(banner).toBeVisible({ timeout: 20_000 });
    const secret = page.locator('code').filter({ hasText: /^dws_/ }).first();
    await expect(secret).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toBeHidden();

    const row = page.locator(`tr:has-text("${name}")`).first();
    await expect(row).toBeVisible();

    // Toggle disable
    await row.getByRole('button', { name: 'Disable' }).click();
    await expect(row.getByRole('button', { name: 'Enable' })).toBeVisible();
    // Re-enable
    await row.getByRole('button', { name: 'Enable' }).click();
    await expect(row.getByRole('button', { name: 'Disable' })).toBeVisible();

    // Delete
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator(`tr:has-text("${name}")`)).toHaveCount(0);
  });
});

test.describe('policy editor', () => {
  test('saves a new policy version and the active-version stat increments', async ({
    page,
  }) => {
    await page.goto('/policies');
    await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();

    // Read the current active version. Could be "v3", "v6", or "fallback" if
    // no policy is active yet. Capture as a starting point.
    const versionStat = page.locator('text=/^Active version$/i').locator('..').locator('div').nth(1);
    const before = (await versionStat.textContent())?.trim() ?? '';

    // Replace the YAML with a minimal but valid policy (unique reason so we
    // can tell two consecutive runs apart).
    const yaml = `version: 1
default: deny
rules:
  - match: { tool: 'hubspot.contacts.update' }
    effect: allow
    reason: 'e2e-saved-${STAMP()}'
`;
    const ta = page.locator('textarea[name="yaml"]');
    await ta.fill(yaml);

    // Live validation flips to valid (it was already valid on the placeholder
    // too, but the new content debounces through validate() once)
    await expect(page.locator('text=/valid · /').first()).toBeVisible();

    // Save
    await page.getByRole('button', { name: 'Save and activate' }).click();

    // Page revalidates; the new active version differs from the previous.
    await expect(versionStat).not.toHaveText(before, { timeout: 10_000 });
  });
});

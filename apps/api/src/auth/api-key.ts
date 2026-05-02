import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'dvk_';

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const plaintext = `${KEY_PREFIX}${raw}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: hashApiKey(plaintext),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function isValidKeyShape(plaintext: string): boolean {
  return plaintext.startsWith(KEY_PREFIX) && plaintext.length > KEY_PREFIX.length + 20;
}

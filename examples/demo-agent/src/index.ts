import { DejavasClient } from '@dejavas/sdk';

const apiKey = process.env.DEJAVAS_API_KEY;
const baseUrl = process.env.DEJAVAS_BASE_URL ?? 'http://localhost:3002';

if (!apiKey) {
  console.error('Set DEJAVAS_API_KEY (register an agent first via POST /v1/agents)');
  process.exit(1);
}

const client = new DejavasClient({ apiKey, baseUrl });

const result = await client.execute({
  tool: 'hubspot.contacts.update',
  params: {
    contactId: '123',
    properties: { lifecyclestage: 'salesqualifiedlead' },
  },
});

console.log(JSON.stringify(result, null, 2));

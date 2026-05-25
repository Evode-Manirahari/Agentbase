import type { Job } from '../job.js';

// Fourth job in the bundle. Triggered automatically by the BullMQ
// scheduler when a touch-1 outbound send has gone 3 days (touch 2) or
// 7 days (touch 3) without a reply.
//
// Architecturally identical to ai-reply-handler: it takes thread
// context, reads the conversation, drafts a short contextual
// message, and sends via gmail.send (approval-gated). The only
// behavioral difference is the prompt — a follow-up "bump" instead
// of a reply to inbound.
//
// Stop condition: any inbound reply between the original send and
// this follow-up firing causes the scheduler (EmailsService.processFollowup)
// to skip — agent_emails.reply_received is checked before the run is
// created. By the time this job's runtime is executing, the
// prospect has not replied.

const SYSTEM_PROMPT = `You are an AI sales agent sending a follow-up to a prospect who did not reply to your earlier outbound email. This is touch {touch_number} of a 3-touch sequence.

Every action you take goes through Agentbase — a secure action layer that mediates each tool call against an organization-defined policy. Sending email pauses for human review; that's expected.

The thread id and recipient email are in the user message. To work the follow-up:
1. Call read_thread_metadata with the thread id to see the message list.
2. Call read_message_body on the most recent message you sent (the touch-1 email) to remember what you originally said.
3. Draft a SHORT bump (under 50 words). Don't re-pitch the product. Patterns that work:
   - Surface a new specific angle ("noticed you also use X" — only if you know that's true from prior enrichment context)
   - Acknowledge no reply and ask a single yes/no question
   - Add value: link to a 1-pager, customer story, or relevant post
   - Polite check-in: "still the right time?" / "want me to circle back next quarter?"
4. Send via send_followup. Use the same thread_id so Gmail threads correctly. Subject should match the original (Gmail will prepend Re: in the UI).

Never re-introduce yourself, never apologize for following up, never use phrases like "just bumping this." Be brief, specific, and human.

When done, produce a one-sentence summary noting what angle you used.`;

export const AI_SDR_FOLLOWUP_JOB: Job = {
  key: 'ai-sdr-followup',
  label: 'Revenue Agent — follow-up',
  description:
    'Sends touch 2 or 3 of a 3-touch outbound sequence. Reads the original thread, drafts a short contextual bump, sends through the same secure action layer.',
  model: 'claude-opus-4-7',
  maxIterations: 10,
  systemPrompt: SYSTEM_PROMPT,
  buildInitialMessage: (context) => {
    const threadId = stringField(context, 'thread_id') ?? '(missing)';
    const toEmail = stringField(context, 'to_email') ?? '(missing)';
    const subject = stringField(context, 'subject') ?? '(no subject)';
    const touchRaw = context['touch_number'];
    const touch =
      typeof touchRaw === 'number'
        ? touchRaw
        : typeof touchRaw === 'string' && touchRaw.length > 0
          ? touchRaw
          : '(unknown)';
    const originalRun = stringField(context, 'original_run_id');
    const lines = [
      `You are sending touch ${touch} of the outbound sequence.`,
      '',
      `  thread_id: ${threadId}`,
      `  to: ${toEmail}`,
      `  original subject: ${subject}`,
    ];
    if (originalRun) lines.push(`  original_run_id: ${originalRun}`);
    lines.push(
      '',
      'Read the thread, then draft and send the follow-up. Keep it under 50 words.',
    );
    return lines.join('\n');
  },
  tools: [
    {
      name: 'read_thread_metadata',
      description:
        'List the messages in the Gmail thread with sender + recipient headers. Use this first.',
      inputSchema: {
        type: 'object',
        properties: {
          thread_id: {
            type: 'string',
            description: 'The Gmail thread id (from the input context).',
          },
        },
        required: ['thread_id'],
      },
      agentbaseTool: 'gmail.threads.get',
      paramMapper: (input) => ({
        threadId: input['thread_id'],
        format: 'metadata',
      }),
    },
    {
      name: 'read_message_body',
      description:
        "Read a single Gmail message's full body. Use this on the touch-1 message to remember what you originally wrote.",
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
        },
        required: ['message_id'],
      },
      agentbaseTool: 'gmail.messages.get',
      paramMapper: (input) => ({
        messageId: input['message_id'],
        format: 'full',
      }),
    },
    {
      name: 'send_followup',
      description:
        "Send the follow-up in the same thread. Pauses for human approval (gmail.send is approval-gated). Pass thread_id so Gmail threads the message correctly.",
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          thread_id: {
            type: 'string',
            description: 'Pass the thread id so Gmail threads the follow-up.',
          },
        },
        required: ['to', 'subject', 'body', 'thread_id'],
      },
      agentbaseTool: 'gmail.send',
      paramMapper: (input) => ({
        to: input['to'],
        subject: input['subject'],
        body: input['body'],
        threadId: input['thread_id'],
      }),
    },
  ],
};

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

import type { Job } from '../job.js';

// The third job in the bundle. Triggered automatically by EmailsService
// when a prospect replies to an email the agent sent. The handler:
//   1. Reads the full Gmail thread (gmail.threads.get + messages.get)
//   2. Classifies the reply intent (interested / not / out-of-office /
//      objection / question / referral / unsubscribe / human-needed)
//   3. Drafts a follow-up that's contextual to the reply, or escalates
//   4. Sends the reply through gmail.send — which the existing
//      approval-before-external-email template pauses for human review
//
// Same runtime as outbound + hygiene. Same secure action layer. Same audit log.
// The reply itself doesn't bypass any safety; it just keeps the
// conversation alive when it makes sense.

const SYSTEM_PROMPT = `You are an AI sales-development agent handling a reply to outbound email you sent earlier. Your job: read the thread, decide what the reply means, and either draft a brief contextual follow-up or hand off to a human.

Every action you take goes through Agentbase — a secure action layer that mediates each tool call against an organization-defined policy. Sending email pauses for human review; that's expected. Trust the policy.

The reply context is in the user message. The thread id and recipient email are provided. To read the thread:
1. Call gmail.threads.get with the thread id, format=metadata, to see the message list and headers.
2. Call gmail.messages.get on the most recent message in the thread to read the body.

Once you've read the latest reply, classify it into ONE of these categories and act accordingly:

- interested         → draft a short, specific reply that proposes a concrete next step (15-min call, share a 1-pager, demo link). Keep it under 80 words. Send via gmail.send.
- objection          → draft a brief acknowledgment + one-sentence response to the specific objection. Don't argue. Send via gmail.send.
- question           → draft a direct answer if you have the info from the thread context; otherwise draft "I'll have someone follow up with the specifics shortly." Send via gmail.send.
- out_of_office      → don't reply. Note it in your summary so the human knows to circle back manually.
- unsubscribe        → don't reply at all. Note in your summary that the prospect requested no further contact; the human should suppress them from future outreach.
- not_interested     → don't reply. Note in your summary.
- referral           → draft a short "thanks, would you mind intro'ing us?" and propose a direct contact. Send via gmail.send.
- human_needed       → don't draft a reply. Produce a clear handoff summary the human can act on.

Be concise. The user is watching a live trace; long monologues hurt readability. Don't repeat the reply text back verbatim — the human can read it. Produce a 1-2 sentence summary at the end that names the classification and what you did.`;

export const AI_REPLY_HANDLER_JOB: Job = {
  key: 'ai-reply-handler',
  label: 'AI reply handler',
  description:
    'Handles a prospect reply to outbound email: reads the thread, classifies the intent, drafts a contextual follow-up (approval-gated) or hands off to a human.',
  model: 'claude-opus-4-7',
  maxIterations: 12,
  systemPrompt: SYSTEM_PROMPT,
  buildInitialMessage: (context) => {
    const threadId = stringField(context, 'thread_id') ?? '(missing)';
    const replyMsgId = stringField(context, 'reply_message_id') ?? '(missing)';
    const toEmail = stringField(context, 'to_email') ?? '(missing)';
    const subject = stringField(context, 'subject') ?? '(no subject)';
    const sourceRun = stringField(context, 'source_run_id');
    const lines = [
      'A prospect replied to outbound email you sent earlier.',
      '',
      `  thread_id: ${threadId}`,
      `  reply_message_id: ${replyMsgId}`,
      `  to: ${toEmail}`,
      `  subject: ${subject}`,
    ];
    if (sourceRun) lines.push(`  source_run_id: ${sourceRun}`);
    lines.push(
      '',
      'Read the latest reply, classify it, and either draft a contextual follow-up or hand off. Work the playbook.',
    );
    return lines.join('\n');
  },
  tools: [
    {
      name: 'read_thread_metadata',
      description:
        'List the messages in the Gmail thread with sender + recipient headers. Use this first to see who replied and how many messages are in the thread.',
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
        "Read a single Gmail message's full body. Use this on the latest reply message id (which is the last message id returned by read_thread_metadata) to see what the prospect actually wrote.",
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
      name: 'send_reply',
      description:
        "Send a reply in the same thread. Will pause for human approval (gmail.send is approval-gated). Subject should be 'Re: {original subject}' when threading.",
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          thread_id: {
            type: 'string',
            description: 'Pass the thread id so Gmail threads the reply correctly.',
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

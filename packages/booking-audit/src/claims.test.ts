import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findBookingClaim } from './claims.js';

describe('booking claims', () => {
  const claims = [
    "You're all set for Tuesday at 9:45.",
    "I've booked you for tomorrow at 3 PM.",
    'Your appointment is confirmed for Friday.',
    "It's booked.",
    'Okay, you are scheduled with Dr. Lee on Monday.',
    "We've got you down for Thursday at 2:30.",
    'I have scheduled your consultation.',
    'Great. Your reservation has been made for 7 PM tonight.',
    'I booked you for the 14th.',
    // Curly apostrophes are what speech-to-text often emits.
    'You’re booked for Wednesday.',
  ];
  for (const text of claims) {
    it(`reads "${text}" as a claim`, () => assert.notEqual(findBookingClaim(text), null));
  }

  const notClaims = [
    'Would you like me to book that for you?',
    'I can get you booked for Tuesday, shall I?',
    "Once you're booked, you'll get a text.",
    "Let me know when you're all set.",
    "I'll go ahead and book that now.",
    'If your appointment is confirmed you will receive an email.',
    'Is your appointment booked?',
    'Let me check the calendar for Tuesday.',
    // "All set" with nothing about a booking or a time around it.
    "You're all set.",
    "You're all set, is there anything else?",
    '',
  ];
  for (const text of notClaims) {
    it(`does not read "${text}" as a claim`, () => assert.equal(findBookingClaim(text), null));
  }

  it('returns the one sentence that makes the claim', () => {
    assert.equal(
      findBookingClaim("Perfect. You're all set for Tuesday at 9:45. Anything else I can help with?"),
      "You're all set for Tuesday at 9:45.",
    );
  });

  it('uses the rest of the utterance as context for an ambiguous sentence', () => {
    assert.equal(findBookingClaim("You're all set. I'll text the details for Tuesday at 9:45."), "You're all set.");
  });
});

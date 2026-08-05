import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@agentbase/db';
import { users } from '@agentbase/db';
import type { FastifyRequest } from 'fastify';

/**
 * Who is acting, and what they are allowed to decide.
 *
 * Approvals and effect resolution both used to take the actor's word for it:
 * the decision endpoint accepted `decided_by_email` from the request body, so
 * any authenticated caller could write someone else's name into the audit
 * trail, and `approvals.required_role` was stored, selected, and never
 * compared to anyone. That made approval a workflow feature rather than an
 * authorization boundary — which is the opposite of what it is sold as.
 *
 * Everything here derives identity from the VERIFIED session and nothing from
 * the request body.
 */

export type Role = 'admin' | 'approver' | 'viewer';

// admin >= approver >= viewer. Ordered, not a set, because the question asked
// of it is "is this actor at least X".
const RANK: Record<Role, number> = { viewer: 0, approver: 1, admin: 2 };

export function roleSatisfies(actor: Role, required: Role): boolean {
  return RANK[actor] >= RANK[required];
}

export interface Actor {
  userId: string;
  email: string;
  role: Role;
  /** True when auth is not enforced — local dev and the demos. */
  devPassthrough: boolean;
}

// The guard already augments FastifyRequest with `clerkUser`; re-declaring it
// here would conflict with that declaration, so read it structurally instead.
type MaybeClerk = { clerkUser?: { userId?: string } | undefined };

/**
 * Resolve the acting user from the verified session, inside the org that owns
 * the resource.
 *
 * The guard attaches `req.clerkUser`. Two call sites were reading `req.auth`,
 * which is never set, so they silently fell back to the literal actor
 * "operator" — every effect resolution in enforced mode was attributed to a
 * user who does not exist.
 *
 * In dev passthrough the guard lets requests through without a session at all.
 * Rather than invent an identity there, that case is marked explicitly so the
 * audit trail says `dev-passthrough` instead of impersonating a real person,
 * and role checks are skipped because there is no identity to check.
 */
export async function resolveActor(
  db: Database,
  req: FastifyRequest,
  orgId: string,
): Promise<Actor> {
  const clerk = (req as unknown as MaybeClerk).clerkUser;
  if (!clerk?.userId) {
    return {
      userId: 'dev-passthrough',
      email: 'dev-passthrough',
      role: 'admin',
      devPassthrough: true,
    };
  }

  const [row] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.clerkId, clerk.userId)))
    .limit(1);

  if (!row) {
    // Authenticated against Clerk but not a member of this org. Denied rather
    // than auto-provisioned: silently creating a membership on first use would
    // make cross-org access a matter of guessing a URL.
    throw new UnauthorizedException(
      'authenticated user is not a member of this organization',
    );
  }

  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    devPassthrough: false,
  };
}

/** Throws 403 unless the actor meets the required role. */
export function requireRole(actor: Actor, required: Role, action: string): void {
  if (actor.devPassthrough) return;
  if (!roleSatisfies(actor.role, required)) {
    throw new ForbiddenException(
      `${action} requires role '${required}'; ${actor.email} is '${actor.role}'`,
    );
  }
}

/**
 * The Agentbase user behind a Slack button click.
 *
 * A valid Slack signature proves the request came from Slack. It says nothing
 * about whether the human who clicked is allowed to decide this approval, and
 * treating the two as the same thing makes the Slack card a way AROUND the
 * authorization boundary rather than a surface on top of it.
 *
 * Slack gives us a verified email for the clicking user. That email must
 * already correspond to a user in this org — the mapping is not created on the
 * fly, because auto-provisioning on first click would mean anyone who can see
 * the channel becomes a decider.
 */
export async function resolveSlackActor(
  db: Database,
  orgId: string,
  email: string | null | undefined,
): Promise<Actor> {
  if (!email) {
    throw new ForbiddenException(
      'Slack did not provide a verified email for this user, so the decision cannot be attributed',
    );
  }

  const [row] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.email, email)))
    .limit(1);

  if (!row) {
    throw new ForbiddenException(
      `${email} clicked from Slack but is not a user in this organization`,
    );
  }

  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    devPassthrough: false,
  };
}

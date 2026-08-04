import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector, ConnectorResult } from '@agentbase/connector-hubspot';
import { EffectReceiptsService } from './effect-receipts.service.js';
import {
  assertRequestUnchanged,
  providerIdempotencyKey,
} from './effect-commit.js';

export interface DispatchInput {
  actionId: string;
  tool: string;
  params: Record<string, unknown>;
  // The hash a human approved, when this action went through approval. Null for
  // actions the policy allowed outright.
  approvedRequestHash: string | null;
  connector: Connector | null;
}

export interface DispatchOutput {
  result: ConnectorResult;
  connectorName: string | null;
  idempotencyKeySent: string | null;
  // True when the result came from a recorded receipt rather than the provider.
  replayed: boolean;
}

/**
 * Commits one external effect, exactly once, with evidence.
 *
 * Everything here exists because of a single fact: between sending a request
 * and reading its response there is a window where the effect may or may not
 * exist, and nothing on our side of the network can close it. The protocol
 * therefore does not try to be atomic. It tries to be *honest and recoverable*:
 *
 *   - the attempt is recorded as `indeterminate` before the request leaves
 *   - the provider gets a key that makes our retry the SAME request, not a new one
 *   - an attempt we never learn the outcome of stays `indeterminate` forever
 *     unless a human or a provider lookup resolves it
 *   - in replay, the recorded receipt is returned and nothing is sent at all
 */
@Injectable()
export class EffectDispatcher {
  private readonly log = new Logger(EffectDispatcher.name);

  constructor(
    private readonly receipts: EffectReceiptsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Replay mode makes the dispatcher incapable of reaching a provider. It is a
   * hard mode switch rather than a per-call flag on purpose: the guarantee
   * being offered is "no live effect can occur in this process", and a
   * guarantee that depends on every caller remembering a parameter is not one.
   */
  isReplay(): boolean {
    return (
      (this.config.get<string>('AGENTBASE_REPLAY') ??
        process.env['AGENTBASE_REPLAY'] ??
        '') === '1'
    );
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    // A human approved a specific request. If what we are about to send is not
    // that request, we do not send it.
    assertRequestUnchanged(
      input.actionId,
      input.approvedRequestHash,
      input.tool,
      input.params,
    );

    if (this.isReplay()) {
      return this.replay(input);
    }

    if (!input.connector) {
      return {
        result: {
          ok: false,
          error: {
            code: 'no_connector',
            message: `no connector resolves tool ${input.tool}`,
          },
        },
        connectorName: null,
        idempotencyKeySent: null,
        replayed: false,
      };
    }

    const key = providerIdempotencyKey(input.actionId);
    const handle = await this.receipts.begin({
      actionId: input.actionId,
      connectorName: input.connector.name,
      idempotencyKeySent: key,
    });

    let result: ConnectorResult;
    try {
      result = await input.connector.invoke(input.tool, input.params, {
        idempotencyKey: key,
      });
    } catch (err) {
      // We threw somewhere around the call. We do NOT know whether the request
      // reached the provider, so the attempt stays `indeterminate` — settling
      // it `failed` here would assert that nothing happened, and that is
      // exactly the assertion we are not entitled to make.
      this.log.warn(
        `effect attempt ${handle.attempt} for action ${input.actionId} threw ` +
          `(${(err as Error).message}) — left indeterminate, not retried`,
      );
      throw err;
    }

    await this.receipts.settle(handle, result, result.providerRef ?? null);

    return {
      result,
      connectorName: input.connector.name,
      idempotencyKeySent: key,
      replayed: false,
    };
  }

  private async replay(input: DispatchInput): Promise<DispatchOutput> {
    const receipt = await this.receipts.committedReceipt(input.actionId);
    if (!receipt) {
      // No committed receipt means this effect never provably happened. In
      // replay we cannot find out, and we must not go and ask.
      return {
        result: {
          ok: false,
          error: {
            code: 'no_receipt',
            message:
              'replay: no committed receipt for this action — the effect was ' +
              'never confirmed, and replay will not contact the provider to find out',
          },
        },
        connectorName: null,
        idempotencyKeySent: null,
        replayed: true,
      };
    }

    const stored = (receipt.receipt ?? {}) as {
      ok?: boolean;
      data?: unknown;
      error?: { code: string; message: string };
    };
    this.log.debug(
      `replay: served recorded receipt attempt=${receipt.attempt} for action ${input.actionId}`,
    );
    return {
      result: stored.ok
        ? {
            ok: true,
            data: stored.data ?? null,
            ...(receipt.providerRef ? { providerRef: receipt.providerRef } : {}),
          }
        : {
            ok: false,
            error: stored.error ?? { code: 'unknown', message: 'recorded failure' },
          },
      connectorName: receipt.connectorName,
      idempotencyKeySent: receipt.idempotencyKeySent,
      replayed: true,
    };
  }
}

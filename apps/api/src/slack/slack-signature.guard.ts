import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

const REPLAY_WINDOW_SEC = 5 * 60;

@Injectable()
export class SlackSignatureGuard implements CanActivate {
  private readonly log = new Logger(SlackSignatureGuard.name);
  private readonly signingSecret: string | null;

  constructor(config: ConfigService) {
    const s = config.get<string>('SLACK_SIGNING_SECRET');
    this.signingSecret = s && s.length > 0 ? s : null;
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.signingSecret) {
      throw new ServiceUnavailableException('slack inbound disabled (SLACK_SIGNING_SECRET unset)');
    }

    const req = ctx.switchToHttp().getRequest();
    const ts = String(req.headers['x-slack-request-timestamp'] ?? '');
    const sig = String(req.headers['x-slack-signature'] ?? '');
    const raw = req.rawBody as Buffer | undefined;

    if (!ts || !sig || !raw) {
      throw new UnauthorizedException('missing slack signature headers or raw body');
    }

    const tsNum = Number(ts);
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (!Number.isFinite(tsNum) || ageSec > REPLAY_WINDOW_SEC) {
      throw new UnauthorizedException('slack timestamp out of window (replay protection)');
    }

    const baseString = `v0:${ts}:${raw.toString('utf8')}`;
    const expected = `v0=${createHmac('sha256', this.signingSecret).update(baseString).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.log.warn('slack signature mismatch');
      throw new UnauthorizedException('invalid slack signature');
    }
    return true;
  }
}

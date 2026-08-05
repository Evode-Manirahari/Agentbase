import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { closeDb, createDb, type Database } from '@agentbase/db';

export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Database => {
        const url = config.get<string>('DATABASE_URL');
        if (!url) {
          throw new Error('DATABASE_URL is not set');
        }
        return createDb(url);
      },
    },
  ],
  exports: [DB],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: Database) {}

  // Without this, `app.close()` leaves the postgres pool open: createDb hands
  // back only the drizzle wrapper, so nothing else can reach the client. A
  // server never noticed — it runs forever — but a test that boots the app
  // then hung the runner, which is why the suite carried --test-force-exit and
  // why green CI was not evidence every suite ran.
  async onModuleDestroy(): Promise<void> {
    await closeDb(this.db);
  }
}

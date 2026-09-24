import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { LINGUALOOP_QUERY_EXECUTOR } from './db/postgres';
import type { QueryExecutor } from './auth/identity-store';

@Controller()
export class HealthController {
  constructor(
    @Inject(LINGUALOOP_QUERY_EXECUTOR) private readonly database: QueryExecutor,
  ) {}

  @Get('health')
  getHealth(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async getReadiness(): Promise<{ status: string }> {
    try {
      await this.database.query('SELECT 1', []);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}

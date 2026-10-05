import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfiguredVerifiedRequestGuard } from '../auth/google-auth.providers';
import {
  LANGUAGE_PRACTICE_DURATIONS_MINUTES,
  LANGUAGE_PRACTICE_LEVELS,
  LANGUAGE_PRACTICE_TOPICS,
  LanguagePracticeSessionFinishError,
  LanguagePracticeSessionStore,
} from './language-practice-session-store';
import {
  LANGUAGE_PRACTICE_REPORT_SERVICE,
  LANGUAGE_PRACTICE_SESSION_STORE,
  LANGUAGE_PRACTICE_TURN_STORE,
} from './language-practice-session.providers';
import { LanguagePracticeReportAdmissionError } from './language-practice-report-store';
import { LanguagePracticeReportService } from './language-practice-report.service';
import { LanguagePracticeTurnStore } from './language-practice-turn-store';
import type { LanguagePracticeSetup } from './language-practice-session-store';

const INPUT_LANGUAGE = { code: 'en', label: 'English' };
const OUTPUT_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
];
const TOPIC_LABELS: Record<(typeof LANGUAGE_PRACTICE_TOPICS)[number], string> = {
  travel: 'Travel',
  work: 'Work',
  studies: 'Studies',
  'everyday-conversation': 'Everyday conversation',
};
const ACCEPTED_MIME_TYPES = [
  'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus',
  'audio/wav', 'audio/x-wav', 'audio/mp4',
];
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_DURATION_MS = 20_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type VerifiedRequest = { verifiedIdentity?: { ownerId: string } };

type SessionStore = Pick<LanguagePracticeSessionStore, 'createSession' | 'getSession' | 'finishSession'>;
type TurnStore = Pick<LanguagePracticeTurnStore, 'listCompletedTurns'>;
type ReportService = Pick<LanguagePracticeReportService, 'getOrCreate'>;

@Controller('language-practice')
@UseGuards(ConfiguredVerifiedRequestGuard)
export class LanguagePracticeSessionController {
  constructor(
    @Inject(LANGUAGE_PRACTICE_SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(LANGUAGE_PRACTICE_TURN_STORE) private readonly turns: TurnStore,
    @Inject(LANGUAGE_PRACTICE_REPORT_SERVICE) private readonly reports: ReportService,
  ) {}

  @Get('options')
  getOptions() {
    return {
      levels: [...LANGUAGE_PRACTICE_LEVELS],
      durationsMinutes: [...LANGUAGE_PRACTICE_DURATIONS_MINUTES],
      inputLanguage: INPUT_LANGUAGE,
      outputLanguages: OUTPUT_LANGUAGES,
      topics: LANGUAGE_PRACTICE_TOPICS.map((code) => ({ code, label: TOPIC_LABELS[code] })),
      acceptedMimeTypes: ACCEPTED_MIME_TYPES,
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      maxDurationMs: MAX_DURATION_MS,
    };
  }

  @Post('sessions/:sessionId/finish')
  @HttpCode(200)
  async finishSession(@Param('sessionId') sessionId: string, @Req() request: VerifiedRequest) {
    if (!UUID_PATTERN.test(sessionId)) throw new HttpException('Invalid session identifier.', 400);
    if (!request.verifiedIdentity || typeof request.verifiedIdentity.ownerId !== 'string') {
      throw new HttpException('Authentication service unavailable.', 503);
    }
    try {
      const result = await this.sessions.finishSession(request.verifiedIdentity.ownerId, sessionId);
      if (!result) throw new HttpException('Not found.', 404);
      return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof LanguagePracticeSessionFinishError && error.reason === 'turn_in_progress') {
        throw new HttpException('A turn is in progress.', 409);
      }
      throw new HttpException('Language practice session is unavailable.', 503);
    }
  }

  @Post('sessions/:sessionId/report')
  @HttpCode(200)
  async getReport(
    @Param('sessionId') sessionId: string,
    @Req() request: VerifiedRequest,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (!UUID_PATTERN.test(sessionId)) throw new HttpException('Invalid session identifier.', 400);
    if (!request.verifiedIdentity || typeof request.verifiedIdentity.ownerId !== 'string') {
      throw new HttpException('Authentication service unavailable.', 503);
    }
    try {
      return await this.reports.getOrCreate(request.verifiedIdentity.ownerId, sessionId);
    } catch (error) {
      if (error instanceof LanguagePracticeReportAdmissionError) {
        if (error.reason === 'not_found') throw new HttpException('Not found.', 404);
        if (error.reason === 'not_closed') throw new HttpException('Session is not closed.', 409);
      }
      throw new HttpException('Language practice report is unavailable.', 503);
    }
  }

  @Post('sessions')
  async createSession(@Body() body: unknown, @Req() request: VerifiedRequest) {
    if (!request.verifiedIdentity || typeof request.verifiedIdentity.ownerId !== 'string') {
      throw new HttpException('Authentication service unavailable.', 503);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid session setup.');
    const setup = body as Record<string, unknown>;
    if (!(LANGUAGE_PRACTICE_LEVELS as readonly unknown[]).includes(setup.level) ||
        !(LANGUAGE_PRACTICE_TOPICS as readonly unknown[]).includes(setup.topic) ||
        !(LANGUAGE_PRACTICE_DURATIONS_MINUTES as readonly unknown[]).includes(setup.durationMinutes) ||
        Object.keys(setup).some((key) => !['level', 'topic', 'durationMinutes'].includes(key))) {
      throw new BadRequestException('Invalid session setup.');
    }
    let session;
    try {
      session = await this.sessions.createSession(request.verifiedIdentity.ownerId, setup as unknown as LanguagePracticeSetup);
    } catch {
      throw new HttpException('Language practice session is unavailable.', 503);
    }
    return { ...session, turns: [] };
  }

  @Get('sessions/:sessionId')
  async getSession(@Param('sessionId') sessionId: string, @Req() request: VerifiedRequest) {
    if (!UUID_PATTERN.test(sessionId)) throw new HttpException('Invalid session identifier.', 400);
    if (!request.verifiedIdentity || typeof request.verifiedIdentity.ownerId !== 'string') {
      throw new HttpException('Authentication service unavailable.', 503);
    }
    let session;
    try {
      session = await this.sessions.getSession(request.verifiedIdentity.ownerId, sessionId);
    } catch {
      throw new HttpException('Language practice session is unavailable.', 503);
    }
    if (!session) throw new HttpException('Not found.', 404);
    let turns;
    try {
      turns = await this.turns.listCompletedTurns(request.verifiedIdentity.ownerId, sessionId);
    } catch {
      throw new HttpException('Language practice session is unavailable.', 503);
    }
    return { ...session, turns };
  }
}

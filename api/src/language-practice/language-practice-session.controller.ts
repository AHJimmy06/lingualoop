import { Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfiguredVerifiedRequestGuard } from '../auth/google-auth.providers';
import {
  LANGUAGE_PRACTICE_DURATIONS_MINUTES,
  LANGUAGE_PRACTICE_LEVELS,
  LANGUAGE_PRACTICE_TOPICS,
  LanguagePracticeSessionStore,
} from './language-practice-session-store';
import {
  LANGUAGE_PRACTICE_REPORT_STORE,
  LANGUAGE_PRACTICE_SESSION_STORE,
  LANGUAGE_PRACTICE_TURN_STORE,
} from './language-practice-session.providers';
import { LanguagePracticeReportAdmissionError, LanguagePracticeReportStore } from './language-practice-report-store';
import { LanguagePracticeTurnStore } from './language-practice-turn-store';

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

type SessionStore = Pick<LanguagePracticeSessionStore, 'getSession'>;
type TurnStore = Pick<LanguagePracticeTurnStore, 'listCompletedTurns'>;
type ReportStore = Pick<LanguagePracticeReportStore, 'getOrCreate'>;

@Controller('language-practice')
@UseGuards(ConfiguredVerifiedRequestGuard)
export class LanguagePracticeSessionController {
  constructor(
    @Inject(LANGUAGE_PRACTICE_SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(LANGUAGE_PRACTICE_TURN_STORE) private readonly turns: TurnStore,
    @Inject(LANGUAGE_PRACTICE_REPORT_STORE) private readonly reports: ReportStore,
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

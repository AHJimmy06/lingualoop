import { Controller, Get, HttpException, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { ConfiguredVerifiedRequestGuard } from '../auth/google-auth.providers';
import {
  LANGUAGE_PRACTICE_DURATIONS_MINUTES,
  LANGUAGE_PRACTICE_LEVELS,
  LANGUAGE_PRACTICE_TOPICS,
  LanguagePracticeSessionStore,
} from './language-practice-session-store';
import { LANGUAGE_PRACTICE_SESSION_STORE } from './language-practice-session.providers';

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

@Controller('language-practice')
@UseGuards(ConfiguredVerifiedRequestGuard)
export class LanguagePracticeSessionController {
  constructor(
    @Inject(LANGUAGE_PRACTICE_SESSION_STORE) private readonly sessions: SessionStore,
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
    return { ...session, turns: [] };
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
const { memoryStorage } = require('multer') as { memoryStorage: () => unknown };
import { ConfiguredVerifiedRequestGuard } from '../auth/google-auth.providers';
import {
  LANGUAGE_PRACTICE_DURATIONS_MINUTES,
  LANGUAGE_PRACTICE_LEVELS,
  LANGUAGE_PRACTICE_TOPICS,
  type LanguagePracticeSetup,
  LanguagePracticeSessionStore,
} from './language-practice-session-store';
import { LANGUAGE_PRACTICE_SESSION_STORE, LANGUAGE_PRACTICE_TURN_STORE } from './language-practice-session.providers';
import { LanguagePracticeTurnStore, LanguagePracticeTurnAdmissionError } from './language-practice-turn-store';
import {
  LANGUAGE_PRACTICE_ACCEPTED_MIME_TYPES,
  LANGUAGE_PRACTICE_MAX_FILE_SIZE_BYTES,
  LanguagePracticeTurnService,
  PracticeTurnUnavailableError,
} from './language-practice-turn.service';
import { LANGUAGE_PRACTICE_TURN_SERVICE } from './language-practice-turn.providers';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type VerifiedRequest = { verifiedIdentity?: { ownerId: string } };
type UploadedAudio = { buffer: Buffer; mimetype: string };
type SessionStore = Pick<LanguagePracticeSessionStore, 'createSession' | 'getSession'>;
type TurnStore = Pick<LanguagePracticeTurnStore, 'listCompletedTurns'>;

@Controller('language-practice')
@UseGuards(ConfiguredVerifiedRequestGuard)
export class LanguagePracticeTurnController {
  constructor(
    @Inject(LANGUAGE_PRACTICE_SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(LANGUAGE_PRACTICE_TURN_STORE) private readonly turns: TurnStore,
    @Inject(LANGUAGE_PRACTICE_TURN_SERVICE) private readonly turnService: LanguagePracticeTurnService,
  ) {}

  @Post('sessions')
  async createSession(@Body() body: unknown, @Req() request: VerifiedRequest) {
    const ownerId = this.ownerId(request);
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
      session = await this.sessions.createSession(ownerId, setup as unknown as LanguagePracticeSetup);
    } catch {
      throw new HttpException('Language practice session is unavailable.', 503);
    }
    return { ...session, turns: [] };
  }

  @Post('sessions/:sessionId/turns')
  @UseInterceptors(FileInterceptor('audio', {
    storage: memoryStorage(),
    limits: { fileSize: LANGUAGE_PRACTICE_MAX_FILE_SIZE_BYTES, files: 1, fields: 1, parts: 3, fieldNameSize: 32, fieldSize: 64 },
  }))
  async createTurn(
    @Param('sessionId') sessionId: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file: UploadedAudio | undefined,
    @Req() request: VerifiedRequest,
  ) {
    try {
      const ownerId = this.ownerId(request);
      if (!UUID_PATTERN.test(sessionId) || !body || Object.keys(body).length !== 1 ||
          typeof body.clientTurnId !== 'string' || !UUID_PATTERN.test(body.clientTurnId)) {
        throw new BadRequestException('Invalid practice turn request.');
      }
      if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0 ||
          file.buffer.length > LANGUAGE_PRACTICE_MAX_FILE_SIZE_BYTES ||
          !(LANGUAGE_PRACTICE_ACCEPTED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
        throw new BadRequestException('Invalid practice audio.');
      }
      const result = await this.turnService.processTurn(ownerId, sessionId, body.clientTurnId, {
        buffer: file.buffer,
        mimeType: file.mimetype,
      });
      const session = await this.getFreshSession(ownerId, sessionId);
      const audioBase64 = result.audioWav ? result.audioWav.toString('base64') : null;
      return {
        id: result.turn.id,
        clientTurnId: result.turn.clientTurnId,
        sequence: result.turn.sequence,
        status: result.turn.status,
        transcript: result.turn.transcript,
        assistantResponse: result.turn.assistantResponse,
        completedAt: result.turn.completedAt,
        audioBase64,
        audioMimeType: audioBase64 === null ? null : 'audio/wav',
        session,
      };
    } catch (error) {
      if (error instanceof LanguagePracticeTurnAdmissionError) {
        if (error.reason === 'not_found') throw new HttpException('Not found.', 404);
        throw new HttpException('Language practice turn is unavailable.', 409);
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof PracticeTurnUnavailableError) throw new HttpException('Language practice turn is unavailable.', 503);
      throw new HttpException('Language practice turn is unavailable.', 503);
    } finally {
      if (Buffer.isBuffer(file?.buffer)) file.buffer.fill(0);
    }
  }

  private ownerId(request: VerifiedRequest): string {
    if (typeof request.verifiedIdentity?.ownerId !== 'string') {
      throw new HttpException('Authentication service unavailable.', 503);
    }
    return request.verifiedIdentity.ownerId;
  }

  private async getFreshSession(ownerId: string, sessionId: string) {
    const session = await this.sessions.getSession(ownerId, sessionId);
    if (!session) throw new Error('Session detail unavailable.');
    const turns = await this.turns.listCompletedTurns(ownerId, sessionId);
    return { ...session, turns };
  }
}

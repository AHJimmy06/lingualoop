import { BadRequestException, Body, Controller, Get, HttpException, Inject, Param, Post, Req, Res, UseGuards, Header, UseInterceptors, UploadedFile, Injectable, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
const { memoryStorage } = require('multer') as { memoryStorage: () => unknown };
import { GOOGLE_BROWSER_POLICY, createGoogleBrowserPolicy } from '../auth/google-browser-policy';
import { MAX_PRACTICE_IMAGE_BYTES, normalizePracticeImage, PracticeImageBusyError } from './practice-image';
import { ConfiguredVerifiedRequestGuard } from '../auth/google-auth.providers';
import { RoleGuard, Roles } from '../auth/role.guard';
import type { AuthenticatedIdentity } from '../auth/verified-request.guard';
import { PRACTICE_CATALOGUE_STORE, PRACTICE_UUID, PracticeCatalogueStore, validatePracticeInput, exactObject } from './practice-catalogue';

import { LANGUAGE_PRACTICE_REPORT_STORE } from './language-practice-session.providers';
import { LanguagePracticeReportStore } from './language-practice-report-store';

type Upload = { buffer: Buffer; mimetype: string };
type Request = { verifiedIdentity?: AuthenticatedIdentity; headers?: { 'content-type'?: string; origin?: string }; file?: Upload };
type ImageResponse = { setHeader(name: string, value: string): void; end(bytes: Buffer): void };

/** Reuse the configured browser Origin policy before Multer allocates an upload. */
@Injectable()
class PracticeCreateOriginGuard implements CanActivate {
  constructor(@Optional() @Inject(GOOGLE_BROWSER_POLICY) private readonly policy?: ReturnType<typeof createGoogleBrowserPolicy>) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!this.policy?.isAllowedRefreshOrLogoutOrigin(request.headers?.origin)) throw new HttpException('Forbidden.', 403);
    return true;
  }
}
@Controller('language-practice/practices')
@UseGuards(ConfiguredVerifiedRequestGuard, RoleGuard)
@Roles('teacher', 'student')
export class PracticeCatalogueController {
  constructor(@Inject(PRACTICE_CATALOGUE_STORE) private readonly store: PracticeCatalogueStore,
    @Inject(LANGUAGE_PRACTICE_REPORT_STORE) private readonly reports: LanguagePracticeReportStore) {}
  private identity(request: Request) {
    const identity = request.verifiedIdentity;
    if (!identity || (identity.role !== 'teacher' && identity.role !== 'student')) throw new HttpException('Forbidden.', 403);
    return identity as AuthenticatedIdentity & { role: 'student' | 'teacher' };
  }
  @Post()
  @Roles('teacher')
  @UseGuards(PracticeCreateOriginGuard)
  @UseInterceptors(FileInterceptor('image', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_PRACTICE_IMAGE_BYTES, files: 1, fields: 1, parts: 3, fieldNameSize: 32, fieldSize: 64 * 1024, headerPairs: 32 },
  }))
  async create(@Body() body: unknown, @Req() request: Request, @UploadedFile() file?: Upload) {
    const identity = this.identity(request);
    try {
      let input;
      let image;
      try {
        const contentType = request.headers?.['content-type'] ?? '';
        if (/^multipart\/form-data(?:;|$)/i.test(contentType)) {
          const fields = exactObject(body, ['metadata']);
          if (typeof fields.metadata !== 'string') throw new TypeError();
          input = validatePracticeInput(JSON.parse(fields.metadata));
          if (file) image = await normalizePracticeImage(file.buffer, file.mimetype);
        } else {
          if (!/^application\/json(?:;|$)/i.test(contentType) || file) throw new TypeError();
          input = validatePracticeInput(body);
        }
      } catch (error) {
        if (error instanceof PracticeImageBusyError) throw new HttpException('Practice image processing busy.', 429);
        throw new BadRequestException('Invalid practice input.');
      }
      try { return await this.store.create(identity.ownerId, input, image); }
      catch { throw new HttpException('Practice catalogue unavailable.', 503); }
    } finally {
      // No original filenames, raw input buffers or base64 enter persistence/logs.
      file?.buffer.fill(0);
      delete request.file;
    }
  }
  @Get()
  async list(@Req() request: Request) {
    const identity = this.identity(request);
    try { return { practices: await this.store.list(identity.ownerId, identity.role) }; } catch { throw new HttpException('Practice catalogue unavailable.', 503); }
  }
  @Get(':id/submissions')
  @Roles('teacher')
  @Header('Cache-Control', 'private, no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  async submissions(@Param('id') id: string, @Req() request: Request) {
    const identity = this.identity(request);
    if (!PRACTICE_UUID.test(id)) throw new HttpException('Not found.', 404);
    let result;
    try { result = await this.store.submissions(identity.ownerId, id); }
    catch { throw new HttpException('Submissions unavailable.', 503); }
    if (result === null) throw new HttpException('Not found.', 404);
    return { submissions: result };
  }
  @Get(':id/submissions/:sessionId/report')
  @Roles('teacher')
  @Header('Cache-Control', 'private, no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  async submissionReport(@Param('id') id: string, @Param('sessionId') sessionId: string, @Req() request: Request) {
    const identity = this.identity(request);
    if (!PRACTICE_UUID.test(id) || !PRACTICE_UUID.test(sessionId)) throw new HttpException('Not found.', 404);
    let result;
    try { result = await this.reports.findTeacherReport(identity.ownerId, id, sessionId); }
    catch { throw new HttpException('Report unavailable.', 503); }
    if (!result) throw new HttpException('Not found.', 404);
    return result;
  }
  @Get(':id/image')
  @Header('Cache-Control', 'private, no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('X-Content-Type-Options', 'nosniff')
  async image(@Param('id') id: string, @Req() request: Request, @Res() response: ImageResponse) {
    const identity = this.identity(request);
    if (!PRACTICE_UUID.test(id)) throw new HttpException('Not found.', 404);
    let result;
    try { result = await this.store.image(identity.ownerId, identity.role, id); }
    catch { throw new HttpException('Practice catalogue unavailable.', 503); }
    if (!result) throw new HttpException('Not found.', 404);
    response.setHeader('Content-Type', 'image/jpeg');
    response.setHeader('Content-Length', String(result.bytes.length));
    response.end(result.bytes);
  }
  @Get(':id')
  async detail(@Param('id') id: string, @Req() request: Request) {
    const identity = this.identity(request);
    if (!PRACTICE_UUID.test(id)) throw new HttpException('Not found.', 404);
    let result;
    try { result = await this.store.detail(identity.ownerId, identity.role, id); } catch { throw new HttpException('Practice catalogue unavailable.', 503); }
    if (!result) throw new HttpException('Not found.', 404);
    return result;
  }
}

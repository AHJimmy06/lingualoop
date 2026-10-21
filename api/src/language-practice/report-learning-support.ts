import type { CompletedOwnedTurnProjection } from './language-practice-report-fallback';

export interface ReportLearningSupport {
  corrections: { sequence: number; suggestedEnglish: string; translationEs: string; explanationEn: string; explanationEs: string }[];
  strengths: { textEn: string; textEs: string; evidenceSequences: number[] }[];
  recommendations: { textEn: string; textEs: string; evidenceSequences: number[] }[];
}

export interface ReportLearningSupportSource {
  summary: string;
  corrections: { sequence: number; original: string; correctedPhrase: string; explanation: string }[];
  strengths: string[];
  recommendations: string[];
}

export interface ReportLearningSupportInput {
  report: ReportLearningSupportSource;
  turns: readonly CompletedOwnedTurnProjection[];
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid learning support.');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object, key))) throw new TypeError('Invalid learning support.');
  return object;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ||
      Buffer.from(value, 'utf8').toString('utf8') !== value) throw new TypeError('Invalid learning support.');
  return value;
}

/** Keep bilingual presentation additive: the original saved report is never replaced. */
export function parseReportLearningSupport(value: unknown, input: ReportLearningSupportInput): ReportLearningSupport {
  const root = exact(value, ['corrections', 'strengths', 'recommendations']);
  const sequences = new Set(input.turns.map(turn => turn.sequence));
  if (!Array.isArray(root.corrections) || root.corrections.length > 20 || root.corrections.length !== input.report.corrections.length ||
      !Array.isArray(root.strengths) || root.strengths.length > 3 || root.strengths.length !== input.report.strengths.length ||
      !Array.isArray(root.recommendations) || root.recommendations.length > 3 || root.recommendations.length !== input.report.recommendations.length) {
    throw new TypeError('Invalid learning support.');
  }
  const corrections = root.corrections.map((value, index) => {
    const row = exact(value, ['sequence', 'suggestedEnglish', 'translationEs', 'explanationEn', 'explanationEs']);
    if (!Number.isSafeInteger(row.sequence) || row.sequence !== input.report.corrections[index].sequence || !sequences.has(row.sequence as number)) {
      throw new TypeError('Invalid learning support.');
    }
    return { sequence: row.sequence as number, suggestedEnglish: text(row.suggestedEnglish), translationEs: text(row.translationEs),
      explanationEn: text(row.explanationEn), explanationEs: text(row.explanationEs) };
  });
  const observations = (items: unknown[]) => items.map(value => {
    const row = exact(value, ['textEn', 'textEs', 'evidenceSequences']);
    const evidence = row.evidenceSequences;
    if (!Array.isArray(evidence) || evidence.length > 256 || new Set(evidence).size !== evidence.length ||
        evidence.some(sequence => !Number.isSafeInteger(sequence) || !sequences.has(sequence))) throw new TypeError('Invalid learning support.');
    return { textEn: text(row.textEn), textEs: text(row.textEs), evidenceSequences: [...evidence] as number[] };
  });
  return { corrections, strengths: observations(root.strengths), recommendations: observations(root.recommendations) };
}

const boundedText = { type: 'string', minLength: 1, maxLength: 500 } as const;
const observationSchema = {
  type: 'array', maxItems: 3, items: {
    type: 'object', additionalProperties: false,
    properties: { textEn: boundedText, textEs: boundedText, evidenceSequences: { type: 'array', maxItems: 256, items: { type: 'integer' } } },
    required: ['textEn', 'textEs', 'evidenceSequences'],
  },
} as const;

export const reportLearningSupportSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    corrections: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      properties: { sequence: { type: 'integer' }, suggestedEnglish: boundedText, translationEs: boundedText, explanationEn: boundedText, explanationEs: boundedText },
      required: ['sequence', 'suggestedEnglish', 'translationEs', 'explanationEn', 'explanationEs'],
    } },
    strengths: observationSchema, recommendations: observationSchema,
  },
  required: ['corrections', 'strengths', 'recommendations'],
} as const;

import { exactObject, parsePracticeParameters, validatePracticeText, type PracticeParameter } from './practice-catalogue';

export interface ParameterCoverage {
  parameterId: string;
  requirement: string;
  status: 'met' | 'partial' | 'not-met' | 'unassessed';
  evidenceSequences: number[];
  explanation: string;
}
export function unassessedCoverage(parameters: readonly PracticeParameter[]): ParameterCoverage[] {
  return parameters.map(({ id, requirement }) => ({ parameterId: id, requirement, status: 'unassessed', evidenceSequences: [], explanation: 'There is no assessed evidence for this requirement.' }));
}
/** Validate identity, order and student-only linkage, never infer semantic matches from keywords. */
export function validateParameterCoverage(value: unknown, parameters: readonly PracticeParameter[], studentSequences?: ReadonlySet<number>): ParameterCoverage[] {
  parsePracticeParameters(parameters);
  if (!Array.isArray(value) || value.length !== parameters.length) throw new TypeError('Invalid parameter coverage.');
  return value.map((item, index) => {
    const row = exactObject(item, ['parameterId', 'requirement', 'status', 'evidenceSequences', 'explanation']);
    const parameter = parameters[index];
    validatePracticeText(row.explanation, 500);
    if (row.parameterId !== parameter.id || row.requirement !== parameter.requirement ||
        !['met', 'partial', 'not-met', 'unassessed'].includes(row.status as string) ||
        !Array.isArray(row.evidenceSequences) || row.evidenceSequences.length > 256 ||
        new Set(row.evidenceSequences).size !== row.evidenceSequences.length ||
        row.evidenceSequences.some(sequence => !Number.isSafeInteger(sequence) || sequence < 1 || (studentSequences && !studentSequences.has(sequence))) ||
        ((row.status === 'met' || row.status === 'partial') && row.evidenceSequences.length === 0) ||
        (row.status === 'unassessed' && row.evidenceSequences.length !== 0)) throw new TypeError('Invalid parameter coverage.');
    return { parameterId: parameter.id, requirement: parameter.requirement, status: row.status as ParameterCoverage['status'], evidenceSequences: [...row.evidenceSequences], explanation: row.explanation };
  });
}
export const parameterCoverageSchema = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      parameterId: { type: 'string' }, requirement: { type: 'string' },
      status: { type: 'string', enum: ['met', 'partial', 'not-met', 'unassessed'] },
      evidenceSequences: { type: 'array', items: { type: 'integer' } }, explanation: { type: 'string' },
    },
    required: ['parameterId', 'requirement', 'status', 'evidenceSequences', 'explanation'],
  },
} as const;

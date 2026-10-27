export interface CompletedOwnedTurnProjection {
  sequence: number;
  transcript: string;
  spanishCorrectionEvidence: string | null;
}

export interface LanguagePracticeReportCorrection {
  sequence: number;
  original: string;
  correctedPhrase: string;
  explanation: string;
}

export interface LanguagePracticeReportFallback {
  summary: string;
  corrections: LanguagePracticeReportCorrection[];
  strengths: string[];
  recommendations: string[];
}

const MAX_TURNS = 256;
const MAX_CORRECTIONS = 20;
const MAX_SUMMARY_LENGTH = 400;
const MAX_ORIGINAL_LENGTH = 500;
const MAX_CORRECTED_PHRASE_LENGTH = 300;
const MAX_EXPLANATION_LENGTH = 280;

/** Builds a deterministic English report from completed, owner-scoped turn projections. */
export function buildLanguagePracticeReportFallback(
  completedOwnedTurns: readonly CompletedOwnedTurnProjection[],
): LanguagePracticeReportFallback {
  const turns = completedOwnedTurns.slice(0, MAX_TURNS);
  const corrections = turns
    .flatMap((turn) => {
      const correction = parseCorrection(turn);
      return correction ? [correction] : [];
    })
    .slice(0, MAX_CORRECTIONS);

  if (turns.length === 0) {
    return {
      summary:
        'The session ended without completed responses. There is not enough evidence to assess performance.',
      corrections: [],
      strengths: [],
      recommendations: [
        'Start a new practice and complete at least one response to receive evidence-based feedback.',
      ],
    };
  }

  const summary = `Completed responses: ${turns.length}. Evidence-linked corrections: ${corrections.length}.`;
  return {
    summary: summary.slice(0, MAX_SUMMARY_LENGTH),
    corrections,
    strengths: [],
    recommendations: corrections.length
      ? [
          'Practise the corrected phrases using your own examples before your next session.',
        ]
      : [
          'Try another session on this topic and develop your ideas with examples.',
        ],
  };
}

function parseCorrection(
  turn: CompletedOwnedTurnProjection,
): LanguagePracticeReportCorrection | null {
  if (typeof turn.spanishCorrectionEvidence !== 'string' || !turn.spanishCorrectionEvidence) {
    return null;
  }

  try {
    const evidence: unknown = JSON.parse(turn.spanishCorrectionEvidence);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
    const fields = evidence as Record<string, unknown>;
    if (
      typeof fields.correctedPhrase !== 'string' ||
      typeof fields.feedback !== 'string' ||
      !fields.correctedPhrase.trim() ||
      !fields.feedback.trim() ||
      typeof turn.transcript !== 'string' ||
      !turn.transcript.trim()
    ) {
      return null;
    }

    return {
      sequence: turn.sequence,
      original: turn.transcript.trim().slice(0, MAX_ORIGINAL_LENGTH),
      correctedPhrase: fields.correctedPhrase.trim().slice(0, MAX_CORRECTED_PHRASE_LENGTH),
      explanation: fields.feedback.trim().slice(0, MAX_EXPLANATION_LENGTH),
    };
  } catch {
    return null;
  }
}

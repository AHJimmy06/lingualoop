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

/** Builds a deterministic Spanish report from completed, owner-scoped turn projections. */
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
        'La sesión finalizó sin turnos completados, por lo que todavía no hay evidencia suficiente para evaluar el desempeño.',
      corrections: [],
      strengths: [],
      recommendations: [
        'Realice una nueva práctica y complete al menos una intervención para obtener observaciones pedagógicas específicas.',
      ],
    };
  }

  const summary = `Se completaron ${turns.length} ${turns.length === 1 ? 'intervención' : 'intervenciones'} en inglés. El informe conserva ${corrections.length} ${corrections.length === 1 ? 'corrección concreta respaldada' : 'correcciones concretas respaldadas'} por la sesión.`;
  return {
    summary: summary.slice(0, MAX_SUMMARY_LENGTH),
    corrections,
    strengths: [
      `Sostuvo ${turns.length} ${turns.length === 1 ? 'intercambio completo' : 'intercambios completos'} en inglés durante la práctica.`,
    ],
    recommendations: corrections.length
      ? [
          'Practique nuevamente las frases corregidas y úselas en ejemplos propios antes de la próxima sesión.',
        ]
      : [
          'Realice otra sesión sobre el mismo tema para ampliar la evidencia y consolidar la fluidez conversacional.',
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

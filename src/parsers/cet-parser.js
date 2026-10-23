import { firstValue, toNumber } from './grade-parser.js';

export function detectCetLevel(row) {
  const text = [
    row?.languageLevel,
    row?.cetLevel,
    row?.level,
    row?.writtenExaminationSubject,
    row?.subject
  ].filter(Boolean).join(' ');
  if (/cet[-_\s]*6|六级/i.test(text)) return 6;
  if (/cet[-_\s]*4|四级/i.test(text)) return 4;
  return null;
}

export function parseCetRows(rows, { level } = {}) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === 'object')
    .filter((row) => !level || detectCetLevel(row) === level)
    .map((row) => {
      const detected = detectCetLevel(row);
      const oral = firstValue(row, ['oralExamAchievement', 'oralScore']);
      return {
        level: detected ? `CET${detected}` : firstValue(row, ['languageLevel', 'cetLevel', 'level']),
        examYear: firstValue(row, ['examYear', 'year']),
        halfYear: firstValue(row, ['thePastOrNextHalfYearName', 'thePastOrNextHalfYear', 'halfYear']),
        subject: firstValue(row, ['writtenExaminationSubject', 'subject']),
        totalScore: toNumber(firstValue(row, ['writtenExaminationTotalScore', 'totalScore', 'score'])),
        listeningScore: toNumber(firstValue(row, ['hearingScore', 'listeningScore'])),
        readingScore: toNumber(firstValue(row, ['readingScore'])),
        writingScore: toNumber(firstValue(row, ['writingScore'])),
        oralScore: oral && oral !== '--' ? oral : null,
        ticketNumber: firstValue(row, ['writtenExaminationNumber', 'examNumber', 'ticketNumber']),
        certificateNumber: firstValue(row, ['achievementListNumber']),
        campus: firstValue(row, ['writtenExaminationApplyCampus', 'applyCampus', 'campus']),
        missingTest: toBoolCn(firstValue(row, ['whetherMissingTest', 'missingTest'])),
        violation: toBoolCn(firstValue(row, ['whetherViolation', 'violation']))
      };
    });
}

function toBoolCn(value) {
  if (!value) return null;
  if (value === '是' || /^true$/i.test(value)) return true;
  if (value === '否' || /^false$/i.test(value)) return false;
  return null;
}

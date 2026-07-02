export function nextReviewerAssessmentId(goalId: string, _existingResult: unknown): string {
  const escapedGoal = goalId.replace(/[^A-Za-z0-9_.:-]/g, '-');
  return `assessment-${escapedGoal}-1`;
}

export function reviewerSessionId(goalId: string, assessmentId: string): string {
  return `reviewer:${goalId}:${assessmentId}`;
}

import { z } from 'zod'

const id = z.string().trim().min(1).max(200)
const finite = z.number().finite()
const text = z.string().trim().min(1).max(4000)
const hypotheses = z.object({ h0: text, h1: text, scope: z.enum(['per-bias-direction', 'per-member']) }).strict()
const testFamily = z.object({ id, declaration: text, source: id, alpha: finite.gt(0).lt(1), correction: z.enum(['not-applied', 'bonferroni', 'holm']) }).strict()

/**
 * A paper-level declaration that travels with a statistical trial.  This is
 * evidence that the caller stated the intended test, not evidence that the
 * stochastic model or the engineering decision was verified.
 */
export const SurveyStatisticalDeclarationV1 = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-evaluated'), hypotheses, targetPower: z.null(), modelVersion: id,
    covarianceModelVersion: id.nullable(), testFamily,
    humanReview: z.object({ status: z.literal('not-evaluated'), declaration: text }).strict() }).strict(),
  z.object({ status: z.literal('declared'), hypotheses, targetPower: finite.gt(0).lt(1), modelVersion: id,
    covarianceModelVersion: id, testFamily,
    humanReview: z.object({ status: z.enum(['not-recorded', 'pending', 'confirmed']), declaration: text,
      reviewer: id.optional(), recordedAt: z.string().trim().min(1).max(128).optional() }).strict()
  }).strict().superRefine((value, context) => {
    if (value.humanReview.status === 'confirmed' && (!value.humanReview.reviewer || !value.humanReview.recordedAt)) {
      context.addIssue({ code: 'custom', message: 'confirmed human review requires reviewer and recordedAt' })
    }
  })
])
export type SurveyStatisticalDeclarationV1 = z.infer<typeof SurveyStatisticalDeclarationV1>

export function unverifiedSurveyStatisticalDeclarationV1(input: {
  scope: 'per-bias-direction' | 'per-member'; modelVersion: string; covarianceModelVersion?: string | null
  testFamily: { id: string; declaration: string; source: string; alpha: number; correction: 'not-applied' | 'bonferroni' | 'holm' }
}): SurveyStatisticalDeclarationV1 {
  return SurveyStatisticalDeclarationV1.parse({ status: 'not-evaluated', hypotheses: {
    h0: input.scope === 'per-bias-direction' ? 'H0: each declared bias component is zero under the supplied stochastic model.' : 'H0: each declared member statistic is consistent with its supplied null distribution.',
    h1: input.scope === 'per-bias-direction' ? 'H1: at least one declared bias component is non-zero under the supplied stochastic model.' : 'H1: at least one declared member statistic is inconsistent with its supplied null distribution.', scope: input.scope
  }, targetPower: null, modelVersion: input.modelVersion, covarianceModelVersion: input.covarianceModelVersion ?? null,
  testFamily: input.testFamily, humanReview: { status: 'not-evaluated', declaration: 'No human engineering review or professional sign-off is recorded by this trial.' } })
}

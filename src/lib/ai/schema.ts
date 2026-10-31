import { z } from "zod";

export const MoneySchema = z.object({
  currency_code: z.string().length(3),
  value: z.string().regex(/^\d+(\.\d{1,2})?$/),
});

export const RenewalProposalSchema = z.object({
  subscriptionId: z.string().min(1),
  action: z.enum([
    "capture_outstanding",
    "revise_cheaper",
    "retry_later",
    "escalate",
  ]),
  rationale: z.string().min(8).max(600),
  proposedPlanId: z.string().optional(),
  proposedPrice: MoneySchema.optional(),
  impact: MoneySchema.optional(),
  fixtureLabeled: z.boolean().optional(),
});

export type RenewalProposalParsed = z.infer<typeof RenewalProposalSchema>;

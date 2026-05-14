import { z } from "zod";

export const NetworkSchema = z.custom<`${string}:${string}`>(
  (value) => typeof value === "string" && value.includes(":"),
  "network must be a CAIP-2 identifier",
);

export const PaymentRequirementsSchema = z
  .object({
    scheme: z.string(),
    network: NetworkSchema,
    asset: z.string(),
    amount: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number(),
    extra: z.record(z.string(), z.unknown()).default({}),
  })
  .catchall(z.unknown());

export const PaymentRequiredSchema = z.object({
  x402Version: z.number(),
  accepts: z.array(PaymentRequirementsSchema),
});

export const PaymentPayloadSchema = z
  .object({
    x402Version: z.number(),
    resource: z
      .object({
        url: z.string(),
        method: z.string(),
      })
      .optional(),
    accepted: PaymentRequirementsSchema,
    payload: z.record(z.string(), z.unknown()),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());

export type ParsedPaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;
export type ParsedPaymentRequired = z.infer<typeof PaymentRequiredSchema>;
export type ParsedPaymentPayload = z.infer<typeof PaymentPayloadSchema>;

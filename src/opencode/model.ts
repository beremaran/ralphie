import { z } from "zod";

export type OpenCodeModel = {
  readonly providerID: string;
  readonly modelID: string;
};

export type OpenCodeSelection = {
  readonly model?: OpenCodeModel;
  readonly variant?: string;
};

export const openCodeModelSchema = z
  .string()
  .trim()
  .regex(
    /^[^/\s]+\/[^\s]+$/,
    "Model must use OpenCode's provider/model format.",
  )
  .transform((value): OpenCodeModel => {
    const separator = value.indexOf("/");
    return {
      providerID: value.slice(0, separator),
      modelID: value.slice(separator + 1),
    };
  });

export const openCodeModelVariantSchema = z.string().trim().min(1);

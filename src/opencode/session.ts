export type OpenCodeSessionPurpose = "plan" | "implement";

export type OpenCodeSessionStage = {
  readonly kind: "opencode-session";
  readonly purpose: OpenCodeSessionPurpose;
};

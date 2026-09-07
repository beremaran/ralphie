/**
 * Canonical maintenance snapshot seam.
 *
 * A single typed snapshot vocabulary with one name per concept and one
 * construction function per value. The legacy compatibility surface in
 * `src/maintain-issues-snapshot.ts` remains supported and delegates to the
 * same values; this module is the preferred seam for new callers.
 *
 * Canonical concepts covered here:
 * - repository (`MaintenanceRepository`)
 * - issue (`MaintenanceIssue`)
 * - comment thread (`MaintenanceCommentThread`, `MaintenanceComment`)
 * - availability (`MaintenanceAvailability`, `MaintenanceSkip`)
 * - unknown provider evidence (`MaintenanceUnknown`)
 *
 * Supporting actor, label, milestone, and marker values use the same single
 * names. There are no duplicate aliases in this module: each concept has
 * exactly one type name and one construction function.
 */

import {
    cloneMaintainableComment,
    cloneMaintainableIssue,
    cloneMaintainableThread,
    createMaintainableComment,
    createMaintainableIssue,
    createMaintainableThread,
    createUnknownValue,
    isMaintainableUnknownValue,
    maintainableLabelNames,
    maintainMarker,
    normalizeMaintainableActor,
    normalizeMaintainableAuthorAssociation,
    normalizeMaintainableAvailability,
    normalizeMaintainableIssueState,
    normalizeMaintainableLabel,
    normalizeMaintainableMilestone,
    normalizeMaintainableSkip,
    normalizeMaintainableSkipReason,
    parseAllRalphieMarkers,
    parseRalphieMarker,
    isRalphieManaged,
    isMaintainableIssueOpen,
    type MaintainableActor,
    type MaintainableActorInput,
    type MaintainableAuthorAssociation,
    type MaintainableAvailability,
    type MaintainableAvailabilityInput,
    type MaintainableComment,
    type MaintainableCommentInput,
    type MaintainableIssue,
    type MaintainableIssueInput,
    type MaintainableLabel,
    type MaintainableLabelInput,
    type MaintainableMilestone,
    type MaintainableMilestoneInput,
    type MaintainableSelectedThread,
    type MaintainableSelectedThreadInput,
    type MaintainableSkip,
    type MaintainableSkipInput,
    type MaintainableUnknownValue,
    type RalphieMarker,
} from "../maintain-issues-snapshot.ts";
import { mapMaintainRepositoryIdentity } from "./github-reader/lists.ts";
import type { MaintainRepositoryIdentity } from "./github-reader/lists.ts";

export type MaintenanceUnknown = MaintainableUnknownValue;
export type MaintenanceIssueState = MaintainableIssue["state"];
export type MaintenanceActor = MaintainableActor;
export type MaintenanceActorInput = MaintainableActorInput;
export type MaintenanceAuthorAssociation = MaintainableAuthorAssociation;
export type MaintenanceLabel = MaintainableLabel;
export type MaintenanceLabelInput = MaintainableLabelInput;
export type MaintenanceMilestone = MaintainableMilestone;
export type MaintenanceMilestoneInput = MaintainableMilestoneInput;
export type MaintenanceMarker = RalphieMarker;
export type MaintenanceAvailability = MaintainableAvailability;
export type MaintenanceAvailabilityInput = MaintainableAvailabilityInput;
export type MaintenanceSkip = MaintainableSkip;
export type MaintenanceSkipInput = MaintainableSkipInput;
export type MaintenanceComment = MaintainableComment;
export type MaintenanceCommentInput = MaintainableCommentInput;
export type MaintenanceCommentThread = MaintainableSelectedThread;
export type MaintenanceCommentThreadInput = MaintainableSelectedThreadInput;
export type MaintenanceIssue = MaintainableIssue;
export type MaintenanceIssueInput = MaintainableIssueInput;
export type MaintenanceRepository = MaintainRepositoryIdentity;
export type MaintenanceRepositoryInput = {
    readonly fullName?: unknown;
    readonly full_name?: unknown;
    readonly defaultBranch?: unknown;
    readonly default_branch?: unknown;
    readonly htmlUrl?: unknown;
    readonly html_url?: unknown;
};

export const isMaintenanceUnknown = isMaintainableUnknownValue;

export const createMaintenanceUnknown = createUnknownValue;

export const normalizeMaintenanceIssueState = normalizeMaintainableIssueState;

export const isMaintenanceIssueOpen = isMaintainableIssueOpen;

export const normalizeMaintenanceActor = normalizeMaintainableActor;

export const normalizeMaintenanceAuthorAssociation =
    normalizeMaintainableAuthorAssociation;

export const normalizeMaintenanceLabel = normalizeMaintainableLabel;

export const maintenanceLabelNames = maintainableLabelNames;

export const normalizeMaintenanceMilestone = normalizeMaintainableMilestone;

export const renderMaintenanceMarker = maintainMarker;

export const parseMaintenanceMarker = parseRalphieMarker;

export const parseAllMaintenanceMarkers = parseAllRalphieMarkers;

export const isMaintenanceManaged = isRalphieManaged;

export const normalizeMaintenanceSkipReason = normalizeMaintainableSkipReason;

export const normalizeMaintenanceAvailability =
    normalizeMaintainableAvailability;

export const normalizeMaintenanceSkip = normalizeMaintainableSkip;

export const createMaintenanceComment = createMaintainableComment;

export const cloneMaintenanceComment = cloneMaintainableComment;

export const createMaintenanceCommentThread = createMaintainableThread;

export const cloneMaintenanceCommentThread = cloneMaintainableThread;

export const createMaintenanceIssue = createMaintainableIssue;

export const cloneMaintenanceIssue = cloneMaintainableIssue;

export const createMaintenanceRepository = (
    value: unknown,
    repository = "",
): MaintenanceRepository => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return mapMaintainRepositoryIdentity(value, repository);
    }
    return mapMaintainRepositoryIdentity(
        {
            full_name: repository,
            default_branch: "",
            html_url: "",
        },
        repository,
    );
};
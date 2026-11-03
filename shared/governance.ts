// Types shared by the governance / USDM API and the client.

export const ROLES = ['ADMIN', 'DATA_STEWARD', 'PROTOCOL_AUTHOR', 'REVIEWER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  DATA_STEWARD: 'Data Steward',
  PROTOCOL_AUTHOR: 'Protocol Author',
  REVIEWER: 'Reviewer',
  VIEWER: 'Viewer',
};

export const PERMISSIONS = {
  'study.read': 'View studies, protocols, mappings and validation reports',
  'protocol.create': 'Create protocols (Builder and Digitisation)',
  'protocol.edit': 'Edit draft protocol sections and study elements',
  'protocol.delete': 'Delete protocols without approved versions',
  'protocol.submit': 'Submit protocols for review',
  'protocol.approve': 'Approve protocols (mark Final) and protocol versions',
  'element.review': 'Approve or reject study elements',
  'change.propose': 'Propose changes to protocols under change control',
  'change.approve': 'Approve or reject change requests',
  'governance.validate': 'Run data quality validation',
  'issue.create': 'Raise governance issues',
  'issue.manage': 'Assign and resolve governance issues',
  'exception.approve': 'Approve governance exceptions',
  'rules.manage': 'Configure governance rules',
  'owners.manage': 'Assign data owners and stewards',
  'dictionary.manage': 'Manage the data dictionary',
  'usdm.map': 'Run USDM mapping and validation',
  'usdm.mapping.manage': 'Create, edit and deactivate USDM mapping rules',
  'usdm.mapping.review': 'Review USDM mappings, terminology and mapping runs',
  'usdm.terminology.manage': 'Manage controlled terminology mappings',
  'usdm.release.manage': 'Manage USDM releases',
  'usdm.export': 'Export USDM JSON',
  'audit.read': 'View the audit trail',
  'users.manage': 'Manage users and roles',
  'system.backup': 'Download database backups',
} as const;
export type Permission = keyof typeof PERMISSIONS;

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: Object.keys(PERMISSIONS) as Permission[],
  DATA_STEWARD: [
    'study.read',
    'element.review',
    'change.propose',
    'change.approve',
    'governance.validate',
    'issue.create',
    'issue.manage',
    'owners.manage',
    'usdm.map',
    'usdm.mapping.review',
    'usdm.terminology.manage',
    'usdm.export',
  ],
  PROTOCOL_AUTHOR: ['study.read', 'protocol.create', 'protocol.edit', 'protocol.submit', 'change.propose', 'governance.validate', 'issue.create', 'usdm.map'],
  REVIEWER: ['study.read', 'protocol.approve', 'element.review', 'change.approve', 'governance.validate', 'issue.create', 'usdm.map', 'usdm.mapping.review', 'usdm.export', 'audit.read'],
  VIEWER: ['study.read'],
};

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  roles: Role[];
  permissions: Permission[];
  isDemo: boolean;
}

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Informational';
export const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low', 'Informational'];
export type RuleCategory = 'completeness' | 'consistency' | 'validity' | 'traceability';
export const RULE_CATEGORIES: RuleCategory[] = ['completeness', 'consistency', 'validity', 'traceability'];
export type IssueStatus = 'Open' | 'Assigned' | 'In Progress' | 'Resolved' | 'Accepted Exception';
export const ISSUE_STATUSES: IssueStatus[] = ['Open', 'Assigned', 'In Progress', 'Resolved', 'Accepted Exception'];
export type ReviewStatus = 'Pending' | 'Approved' | 'Rejected';

export type MappingStatus = 'Not Mapped' | 'Mapped' | 'Requires Review' | 'Validated' | 'Rejected';
export const MAPPING_STATUSES: MappingStatus[] = ['Not Mapped', 'Mapped', 'Requires Review', 'Validated', 'Rejected'];
export type TransformationType = 'direct' | 'value' | 'terminology' | 'relationship' | 'manual' | 'unsupported';
export const TRANSFORMATION_TYPES: TransformationType[] = ['direct', 'value', 'terminology', 'relationship', 'manual', 'unsupported'];
export const TRANSFORMATION_LABELS: Record<TransformationType, string> = {
  direct: 'Direct mapping',
  value: 'Value transformation',
  terminology: 'Controlled terminology mapping',
  relationship: 'Relationship mapping',
  manual: 'Manual mapping',
  unsupported: 'Unsupported mapping',
};

export interface GovernanceRule {
  id: string;
  name: string;
  description: string;
  category: RuleCategory;
  severity: Severity;
  entityType: string;
  checkType: string;
  config: Record<string, unknown>;
  active: boolean;
  builtin: boolean;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface GovernanceIssue {
  id: string;
  origin: 'rule' | 'manual';
  studyId: string;
  studyTitle?: string;
  protocolNumber?: string;
  protocolId: string | null;
  elementId: string | null;
  elementType: string | null;
  elementLabel?: string | null;
  ruleId: string | null;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  detectedValue: string | null;
  expectedCondition: string | null;
  status: IssueStatus;
  assignedTo: string | null;
  assignedToName?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastDetectedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  exceptionReason: string | null;
  exceptionApprovedBy: string | null;
  exceptionApprovedAt: string | null;
}

export interface QualityFinding {
  ruleId: string;
  elementId: string | null;
  elementType: string | null;
  elementLabel?: string;
  detailKey?: string;
  description: string;
  detectedValue: string;
  expectedCondition: string;
}

export interface LineageRecord {
  elementId: string;
  elementType: string;
  studyId: string;
  protocolId: string;
  label: string;
  sourceType: 'builder' | 'digitisation' | 'ocr' | 'system';
  sourceDocumentId: string | null;
  sourceDocumentName?: string | null;
  sourcePage: number | null;
  sourceSection: string | null;
  sourceText: string | null;
  extractionMethod: string;
  internalEntityType: string;
  usdmMappingId: string | null;
  usdmEntity: string | null;
  usdmRunId: string | null;
  createdBy: string;
  modifiedBy: string;
  createdAt: string;
  modifiedAt: string;
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  deletedAt: string | null;
}

export interface AuditEntry {
  seq: number;
  id: string;
  userId: string | null;
  username: string;
  action: string;
  entityType: string;
  entityId: string | null;
  studyId: string | null;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  ip: string | null;
  createdAt: string;
  hash: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type ChangeRequestStatus = 'Draft' | 'Pending Review' | 'Approved' | 'Rejected' | 'Withdrawn';

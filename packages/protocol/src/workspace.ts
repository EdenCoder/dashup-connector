// =============================================================================
// Workspace: Git state and checks observed on the paired computer
// =============================================================================

export type WorkspaceTarget =
  { kind: 'new'; branch: string; base: string } | { kind: 'existing'; path: string };

export type WorkspaceCheck = {
  command    : string;
  exitCode   : number | null;
  output     : string;
  startedAt  : string;
  finishedAt : string;
  revision   : string;
  stale      : boolean;
  timedOut?  : boolean;
};

export type Workspace = {
  branch    : string | null;
  head      : string;
  baseline  : string;
  branches  : string[];
  worktrees : { path: string; branch: string | null }[];
  files     : { path: string; added: number; deleted: number; binary?: boolean }[];
  diff      : string;
  truncated : boolean;
  checkedAt : string;
  checks    : WorkspaceCheck[];
};

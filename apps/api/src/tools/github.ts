/**
 * GitHub tools — search repos, read files, list issues/PRs, manage repos.
 *
 * Uses GitHub REST API v3. Gated on GITHUB_TOKEN env var.
 * Token needs: repo, read:org scopes for full access.
 */

import type { BrainTool } from '@boss/brain';

export const githubSearchReposTool: BrainTool = {
  name: 'boss_github_search_repos',
  description: 'Search GitHub repositories by keyword. Returns repo names, descriptions, stars, language.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (e.g., "n8n automation" or "org:starrpartners")' },
      max_results: { type: 'number', description: 'Max results (1-20, default 5)' },
    },
    required: ['query'],
  },
};

export const githubSearchCodeTool: BrainTool = {
  name: 'boss_github_search_code',
  description: 'Search code across GitHub repositories. Find specific functions, patterns, or implementations.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Code search query (e.g., "oauth token refresh language:typescript")' },
      max_results: { type: 'number', description: 'Max results (1-20, default 5)' },
    },
    required: ['query'],
  },
};

export const githubReadFileTool: BrainTool = {
  name: 'boss_github_read_file',
  description: 'Read a file from a GitHub repository. Returns the file contents.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (e.g., "starrpartners")' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File path (e.g., "src/index.ts" or "README.md")' },
      ref: { type: 'string', description: 'Branch or commit (default: main)' },
    },
    required: ['owner', 'repo', 'path'],
  },
};

export const githubListReposTool: BrainTool = {
  name: 'boss_github_list_repos',
  description: 'List repositories for the authenticated user or an organization.',
  parameters: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'Organization name. Omit to list your own repos.' },
      sort: { type: 'string', enum: ['updated', 'created', 'pushed', 'name'], description: 'Sort order (default: updated)' },
      max_results: { type: 'number', description: 'Max results (1-50, default 10)' },
    },
    required: [],
  },
};

export const githubListIssuesTool: BrainTool = {
  name: 'boss_github_list_issues',
  description: 'List issues or pull requests for a repository.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default: open)' },
      max_results: { type: 'number', description: 'Max results (1-50, default 10)' },
    },
    required: ['owner', 'repo'],
  },
};

export const githubRepoTreeTool: BrainTool = {
  name: 'boss_github_repo_tree',
  description: 'Get the file/directory tree of a repository. Shows the structure without reading file contents.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'Subdirectory path (default: root)' },
      ref: { type: 'string', description: 'Branch (default: main)' },
    },
    required: ['owner', 'repo'],
  },
};

// ── vS.0.2 — CI/PR introspection ────────────────────────────────────────────

export const githubWorkflowRunsTool: BrainTool = {
  name: 'boss_github_workflow_runs',
  description:
    'List recent GitHub Actions workflow runs for a repository. Shows run name, status, ' +
    'conclusion, branch, and URL. Defaults to TCntryPrd/boss-dev.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      max_results: { type: 'number', description: 'Max results (1-20, default 10)' },
      status: { type: 'string', enum: ['completed', 'in_progress', 'queued'], description: 'Filter by status' },
    },
    required: [],
  },
};

export const githubWorkflowRunLogsTool: BrainTool = {
  name: 'boss_github_workflow_run_logs',
  description:
    'Fetch the log output for a specific GitHub Actions workflow run. Useful for diagnosing ' +
    'failed CI runs. Returns the log text (truncated to 10K chars).',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      run_id: { type: 'number', description: 'Workflow run ID (from boss_github_workflow_runs)' },
    },
    required: ['run_id'],
  },
};

export const githubPrCommentsTool: BrainTool = {
  name: 'boss_github_pr_comments',
  description:
    'List review comments on a pull request. Shows comment body, author, file path, ' +
    'and line number. Useful for reading PR review feedback.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      pr_number: { type: 'number', description: 'Pull request number' },
    },
    required: ['pr_number'],
  },
};

export const githubPrStatusTool: BrainTool = {
  name: 'boss_github_pr_status',
  description:
    'Get aggregated status of a pull request: mergeable state, CI check results, ' +
    'review decisions (approved/changes_requested), and labels.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      pr_number: { type: 'number', description: 'Pull request number' },
    },
    required: ['pr_number'],
  },
};

export const githubOpenIssueTool: BrainTool = {
  name: 'boss_github_open_issue',
  description:
    'Open a new issue on a GitHub repository. Use for bug reports, feature requests, ' +
    'or self-reporting problems BOS discovers.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body (markdown)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
    },
    required: ['title'],
  },
};

// ── vS.0.3 — BOS opens her own PRs ───────────────────────────────────────

export const githubOpenPrTool: BrainTool = {
  name: 'boss_github_open_pr',
  description:
    'Open a pull request on a GitHub repository. Branch must already exist and be pushed. ' +
    'BOS uses this to propose code changes for Kevin to review.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR body (markdown)' },
      head: { type: 'string', description: 'Source branch name (e.g., boss/fix-xyz)' },
      base: { type: 'string', description: 'Target branch (default: master)' },
    },
    required: ['title', 'head'],
  },
};

export const githubRequestReviewTool: BrainTool = {
  name: 'boss_github_request_review',
  description:
    'Request a review on a pull request. Adds specified GitHub users as reviewers.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      pr_number: { type: 'number', description: 'Pull request number' },
      reviewers: { type: 'array', items: { type: 'string' }, description: 'GitHub usernames to request review from (default: ["TCntryPrd"])' },
    },
    required: ['pr_number'],
  },
};

export const githubPrCommentTool: BrainTool = {
  name: 'boss_github_pr_comment',
  description:
    'Post a comment on a pull request. Use to respond to review feedback, explain changes, ' +
    'or provide status updates.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      pr_number: { type: 'number', description: 'Pull request number' },
      body: { type: 'string', description: 'Comment body (markdown)' },
    },
    required: ['pr_number', 'body'],
  },
};

// ── vS.0.5 — Self-deploy ────────────────────────────────────────────────────

export const githubPushTagTool: BrainTool = {
  name: 'boss_github_push_tag',
  description:
    'Push an annotated git tag and trigger CI deploy. RESTRICTED to vS.* and vD.* ' +
    'tag patterns — v1.* and v2.* tags are Kevin-only. The tag must already exist ' +
    'locally (created via boss_self_git or boss_bash).',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      tag: { type: 'string', description: 'Tag name (must match vS.* or vD.* pattern)' },
      sha: { type: 'string', description: 'Commit SHA to tag (default: HEAD of master)' },
      message: { type: 'string', description: 'Tag annotation message' },
    },
    required: ['tag', 'message'],
  },
};

export const githubReleaseNotesTool: BrainTool = {
  name: 'boss_release_notes',
  description:
    'Generate structured release notes from commits since the last tag. Returns a ' +
    'markdown summary of changes grouped by type (feat/fix/docs/chore).',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: TCntryPrd)' },
      repo: { type: 'string', description: 'Repository name (default: boss-dev)' },
      since_tag: { type: 'string', description: 'Previous tag to compare from (auto-detected if omitted)' },
      to_ref: { type: 'string', description: 'End ref (default: master HEAD)' },
    },
    required: [],
  },
};

export const ALL_GITHUB_TOOLS: BrainTool[] = [
  githubSearchReposTool,
  githubSearchCodeTool,
  githubReadFileTool,
  githubListReposTool,
  githubListIssuesTool,
  githubRepoTreeTool,
  // vS.0.2 — CI/PR introspection
  githubWorkflowRunsTool,
  githubWorkflowRunLogsTool,
  githubPrCommentsTool,
  githubPrStatusTool,
  githubOpenIssueTool,
  // vS.0.3 — BOS opens her own PRs
  githubOpenPrTool,
  githubRequestReviewTool,
  githubPrCommentTool,
  // vS.0.5 — Self-deploy
  githubPushTagTool,
  githubReleaseNotesTool,
];

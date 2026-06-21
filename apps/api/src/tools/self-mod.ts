/**
 * Self-modification & engineering tool definitions.
 *
 * These give BOS the same capabilities as Claude Code: read, search,
 * edit, build, test, and version code. All require admin trust tier.
 *
 * Tool quality philosophy: descriptions teach the model WHEN to use,
 * WHEN NOT to use, WHAT to do first, and COMMON MISTAKES to avoid.
 * Vague descriptions produce vague tool use.
 */

import type { BrainTool } from '@boss/brain';

export const bashTool: BrainTool = {
  name: 'boss_bash',
  description:
    'Execute a shell command on the host system. Returns stdout/stderr with exit code.\n\n' +
    'IMPORTANT: Do NOT use bash when a dedicated tool exists:\n' +
    '- To read files → use boss_fs_read (not cat/head/tail)\n' +
    '- To edit files → use boss_self_patch (not sed/awk)\n' +
    '- To search code → use boss_self_grep (not grep/rg)\n' +
    '- To write files → use boss_fs_write (not echo/cat heredoc)\n' +
    '- To run git → use boss_self_git (not git directly)\n\n' +
    'USE bash for: npm/node commands, docker operations, system status checks (df, free, uptime), ' +
    'curl/wget for API testing, process management (ps, kill), package installation.\n\n' +
    'Safety: blocks rm -rf /, sudo, shutdown, reboot, mkfs, dd. ' +
    'Default cwd is /home/boss/boss-dev. Max timeout 5 minutes.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute. Use && to chain dependent commands. Use ; for independent commands.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Default: /home/boss/boss-dev. Use absolute paths.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms. Default: 60000 (1 min). Max: 300000 (5 min). Use higher for builds.',
      },
    },
    required: ['command'],
  },
};

export const selfPatchTool: BrainTool = {
  name: 'boss_self_patch',
  description:
    'Perform exact string replacement in a file. This is your primary editing tool.\n\n' +
    'CRITICAL RULES:\n' +
    '1. You MUST read the file with boss_fs_read BEFORE editing. Never edit a file you have not read.\n' +
    '2. old_string must match the file content EXACTLY — including indentation (spaces/tabs), newlines, and whitespace.\n' +
    '3. If old_string appears multiple times, the edit FAILS unless replace_all=true. ' +
    'Provide more surrounding context to make it unique.\n' +
    '4. Prefer editing existing files over creating new ones.\n' +
    '5. Do not add comments, docstrings, or type annotations to code you did not change.\n\n' +
    'Path resolution: relative paths resolve from /home/boss/boss-dev/. ' +
    'Absolute paths starting with /home/boss/ also work.\n\n' +
    'Common mistake: copying text from a previous read that has been modified since. Always re-read if unsure.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path. Relative to boss-dev (e.g., "apps/api/src/tools/executor.ts") or absolute.',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find. Must match file content precisely, including all whitespace and indentation.',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text. Must be different from old_string.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace ALL occurrences. Default false. Use for renaming variables/functions across a file.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
};

export const selfGrepTool: BrainTool = {
  name: 'boss_self_grep',
  description:
    'Search for a regex pattern across the codebase using ripgrep. Returns matching lines with file:line format.\n\n' +
    'Use this to:\n' +
    '- Find function/class definitions: "async function handleGmail"\n' +
    '- Find imports: "from.*executor"\n' +
    '- Find tool registrations: "boss_gmail_"\n' +
    '- Find string literals: "Error: message_id"\n' +
    '- Find patterns across files: "TODO|FIXME|HACK"\n\n' +
    'Supports full regex syntax (ripgrep). Use glob to filter file types.\n' +
    'Automatically excludes node_modules/ and dist/ directories.\n\n' +
    'For simple file finding by name, use boss_fs_search instead.\n' +
    'For reading a specific file, use boss_fs_read — do not grep then read.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern. Examples: "function\\s+handle", "import.*from", "boss_gmail_".',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search. Default: entire boss-dev codebase.',
      },
      glob: {
        type: 'string',
        description: 'File glob filter. Examples: "*.ts" (TypeScript only), "*.tsx" (React), "*.{ts,tsx}" (both).',
      },
      max_results: {
        type: 'number',
        description: 'Max matches. Default: 50. Use higher (up to 200) for broad searches.',
      },
    },
    required: ['pattern'],
  },
};

export const selfBuildTool: BrainTool = {
  name: 'boss_self_build',
  description:
    'Compile TypeScript and rebuild Docker containers. This deploys your changes to production.\n\n' +
    'WORKFLOW — always follow this order:\n' +
    '1. Make your code changes (boss_self_patch)\n' +
    '2. Run tests (boss_self_test) — fix any failures\n' +
    '3. Build (this tool) — compiles TS and rebuilds containers\n' +
    '4. Verify (check logs with boss_bash: "docker compose logs api --tail 20")\n' +
    '5. Commit (boss_self_git action=commit)\n\n' +
    'NEVER build without testing first. NEVER skip step 4 — a successful build does not mean a successful deploy.\n\n' +
    'The host-native agent (port 8010) does NOT restart via Docker — it runs as a systemd service. ' +
    'To restart it: boss_bash command="systemctl --user restart boss-agent".\n\n' +
    'Build time: ~30-60s for API, ~15-30s for web. Total with restart: ~90s.',
  parameters: {
    type: 'object',
    properties: {
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Services to build. Options: api, web, worker, gateway, stt. Default: ["api"]. Most changes only need "api".',
      },
    },
    required: [],
  },
};

export const selfTestTool: BrainTool = {
  name: 'boss_self_test',
  description:
    'Run the test suite (vitest). Returns pass/fail with detailed output.\n\n' +
    'Run this BEFORE boss_self_build. If tests fail, fix the code first.\n' +
    'Specify a file to run only those tests (faster iteration).\n\n' +
    'Test files are colocated with source: foo.ts → foo.test.ts.\n' +
    'If you add new functionality, add a test. If you fix a bug, add a regression test.',
  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Specific test file path. Example: "apps/api/src/middleware/auth.test.ts". Omit to run all tests.',
      },
    },
    required: [],
  },
};

export const selfGitTool: BrainTool = {
  name: 'boss_self_git',
  description:
    'Git version control operations on the BOS codebase.\n\n' +
    'RULES:\n' +
    '- Commits ALWAYS go to a boss/* branch, NEVER to master. Kevin approves merges.\n' +
    '- Write clear commit messages that explain WHY, not just WHAT.\n' +
    '- Check status before committing to see what changed.\n' +
    '- Never force-push. Never rewrite history.\n\n' +
    'Actions:\n' +
    '- status: show changed/untracked files\n' +
    '- diff: summary of all changes (files + line counts)\n' +
    '- diff_file: detailed diff for a specific file (requires "file" param)\n' +
    '- log: last 20 commits (one-line format)\n' +
    '- commit: stage all + commit to boss/* branch (requires "message" param)\n' +
    '- branch: list all branches\n' +
    '- checkout: switch branch (requires "branch" param, must be master or boss/*)',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Git action: status, diff, diff_file, log, commit, branch, checkout.',
      },
      message: {
        type: 'string',
        description: 'Commit message. Required for commit action. Be specific about what changed and why.',
      },
      file: {
        type: 'string',
        description: 'File path for diff_file action.',
      },
      branch: {
        type: 'string',
        description: 'Branch name for checkout. Only master, main, or boss/* branches allowed.',
      },
    },
    required: ['action'],
  },
};

export const selfIntrospectTool: BrainTool = {
  name: 'boss_self_introspect',
  description:
    'Examine your own system state. Use this FIRST when starting work — understand before acting.\n\n' +
    'Targets:\n' +
    '- overview: codebase line count, recent commits, running containers\n' +
    '- tools: count of registered tools in executor\n' +
    '- errors: recent error/warning log entries from the API container\n\n' +
    'For deeper investigation, use boss_self_grep to search code or boss_bash to check system state.',
  parameters: {
    type: 'object',
    properties: {
      what: {
        type: 'string',
        description: 'What to inspect: overview, tools, errors.',
      },
    },
    required: ['what'],
  },
};

export const ALL_SELF_MOD_TOOLS: BrainTool[] = [
  bashTool,
  selfPatchTool,
  selfGrepTool,
  selfBuildTool,
  selfTestTool,
  selfGitTool,
  selfIntrospectTool,
];

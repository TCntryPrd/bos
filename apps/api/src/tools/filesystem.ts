/**
 * Filesystem tools — give BOS full read/write access to the home directory.
 *
 * Mounted at /data/home → /home/boss/
 * Includes: sp-hub/, .openclaw/, .claude/, boss-dev/, n8n/, and everything else.
 */

import type { BrainTool } from '@boss/brain';

export const fsReadFileTool: BrainTool = {
  name: 'boss_fs_read',
  description:
    'Read a file from the local filesystem. Full access to all project files, configs, OpenClaw data, ' +
    'Claude config, notes, scripts. Path starts with /data/home/ (maps to /home/boss/).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path (e.g., /data/home/sp-hub/CLAUDE.md or /data/home/.openclaw/config.json)' },
      max_lines: { type: 'number', description: 'Max lines to read (default: 500). Use for large files.' },
    },
    required: ['path'],
  },
};

export const fsWriteFileTool: BrainTool = {
  name: 'boss_fs_write',
  description:
    'Write or overwrite a file on the local filesystem. Use for creating notes, reports, configs, or any file ' +
    'in the sp-hub directory. Only writes to /data/sp-hub/ are allowed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path (must start with /data/sp-hub/)' },
      content: { type: 'string', description: 'File content to write' },
    },
    required: ['path', 'content'],
  },
};

export const fsListTool: BrainTool = {
  name: 'boss_fs_list',
  description:
    'List files and directories at a path. Returns names, types (file/dir), and sizes. ' +
    'Use to explore the sp-hub directory structure.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (e.g., /data/sp-hub/)' },
      recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      max_depth: { type: 'number', description: 'Max depth for recursive listing (default: 2)' },
    },
    required: ['path'],
  },
};

export const fsSearchTool: BrainTool = {
  name: 'boss_fs_search',
  description:
    'Search for files by name pattern or search within file contents. ' +
    'Use to find specific files, configs, or content across the project.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to search in (e.g., /data/sp-hub/)' },
      pattern: { type: 'string', description: 'Filename pattern (glob) or text to search for in content' },
      content_search: { type: 'boolean', description: 'If true, search inside file contents. Default: false (filename only).' },
    },
    required: ['path', 'pattern'],
  },
};

export const fsAppendTool: BrainTool = {
  name: 'boss_fs_append',
  description:
    'Append text to an existing file. Use for adding entries to logs, notes, or lists without overwriting.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path (must start with /data/sp-hub/)' },
      content: { type: 'string', description: 'Content to append' },
    },
    required: ['path', 'content'],
  },
};

export const ALL_FS_TOOLS: BrainTool[] = [
  fsReadFileTool,
  fsWriteFileTool,
  fsListTool,
  fsSearchTool,
  fsAppendTool,
];

/**
 * Git Backup Destination — pushes encrypted backup files to a private Git repo.
 * Layer 1 auth: SSH key for repo access.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface BackupDestination {
  readonly name: string;
  deliver(filePaths: string[]): Promise<void>;
}

export interface GitDestinationConfig {
  /** Git remote URL (SSH format). */
  remoteUrl: string;
  /** Local clone path. Default '/tmp/boss-backup-repo'. */
  localPath?: string;
  /** Branch to push to. Default 'main'. */
  branch?: string;
  /** SSH key path for authentication. */
  sshKeyPath?: string;
}

// ── Destination ─────────────────────────────────────────────────────

export class GitBackupDestination implements BackupDestination {
  readonly name = 'git';
  private config: Required<GitDestinationConfig>;

  constructor(config: GitDestinationConfig) {
    this.config = {
      remoteUrl: config.remoteUrl,
      localPath: config.localPath ?? '/tmp/boss-backup-repo',
      branch: config.branch ?? 'main',
      sshKeyPath: config.sshKeyPath ?? '~/.ssh/id_ed25519',
    };
  }

  /**
   * Deliver encrypted backup files to the Git repo.
   *
   * Flow:
   * 1. Ensure repo is cloned and up to date
   * 2. Copy encrypted files into repo
   * 3. Commit with timestamp
   * 4. Push to remote
   */
  async deliver(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;

    // Ensure repo exists and is current
    await this.ensureRepo();

    // Copy files into repo
    for (const filePath of filePaths) {
      await this.copyToRepo(filePath);
    }

    // Stage, commit, push
    const timestamp = new Date().toISOString();
    await this.gitAdd();
    await this.gitCommit(`backup: ${timestamp} (${filePaths.length} files)`);
    await this.gitPush();
  }

  // ── Internal: Git operations (stubs for child_process) ────────────

  /**
   * Ensure the backup repo is cloned and on the correct branch.
   */
  private async ensureRepo(): Promise<void> {
    const exists = await this.directoryExists(this.config.localPath);
    if (!exists) {
      await this.exec('git', [
        'clone',
        '--branch', this.config.branch,
        '--single-branch',
        this.config.remoteUrl,
        this.config.localPath,
      ]);
    } else {
      await this.exec('git', ['-C', this.config.localPath, 'pull', '--ff-only']);
    }
  }

  private async copyToRepo(filePath: string): Promise<void> {
    const filename = filePath.split('/').pop() ?? filePath;
    // TODO: wire to fs.copyFile(filePath, `${this.config.localPath}/${filename}`)
  }

  private async gitAdd(): Promise<void> {
    await this.exec('git', ['-C', this.config.localPath, 'add', '.']);
  }

  private async gitCommit(message: string): Promise<void> {
    await this.exec('git', ['-C', this.config.localPath, 'commit', '-m', message]);
  }

  private async gitPush(): Promise<void> {
    const env: Record<string, string> = this.config.sshKeyPath
      ? { GIT_SSH_COMMAND: `ssh -i ${this.config.sshKeyPath} -o StrictHostKeyChecking=no` }
      : {};
    await this.exec('git', ['-C', this.config.localPath, 'push'], env);
  }

  // ── Execution stubs ───────────────────────────────────────────────

  private async exec(
    _cmd: string,
    _args: string[],
    _env?: Record<string, string>,
  ): Promise<void> {
    // TODO: wire to child_process.execFile
  }

  private async directoryExists(_path: string): Promise<boolean> {
    // TODO: wire to fs.stat
    return false;
  }
}

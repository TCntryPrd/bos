/**
 * Postgres Dump — runs pg_dump for a tenant's schema and produces
 * an unencrypted SQL file ready for encryption.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface PostgresDumpConfig {
  /** Postgres connection URL. */
  connectionUrl: string;
  /** Output directory for dump files. Default '/tmp/boss-backups'. */
  outputDir?: string;
  /** pg_dump binary path. Default 'pg_dump'. */
  pgDumpPath?: string;
  /** Additional pg_dump flags. */
  extraFlags?: string[];
}

export interface DumpResult {
  /** Path to the dump file. */
  path: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Duration of the dump in ms. */
  durationMs: number;
  /** Tenant schema dumped. */
  schema: string;
  createdAt: Date;
}

// ── Dumper ───────────────────────────────────────────────────────────

export class PostgresDumper {
  private config: Required<PostgresDumpConfig>;

  constructor(config: PostgresDumpConfig) {
    this.config = {
      connectionUrl: config.connectionUrl,
      outputDir: config.outputDir ?? '/tmp/boss-backups',
      pgDumpPath: config.pgDumpPath ?? 'pg_dump',
      extraFlags: config.extraFlags ?? [],
    };
  }

  /**
   * Dump a tenant's schema to a SQL file.
   *
   * In multi-tenant mode, dumps only the tenant's schema.
   * In single-tenant mode, dumps the full database.
   */
  async dump(tenantId: string): Promise<DumpResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const schema = `tenant_${tenantId}`;
    const filename = `pg-${tenantId}-${timestamp}.sql`;
    const outputPath = `${this.config.outputDir}/${filename}`;

    // Ensure output directory exists
    await this.ensureDir(this.config.outputDir);

    // Build pg_dump command
    const args = [
      this.config.connectionUrl,
      '--schema', schema,
      '--file', outputPath,
      '--no-owner',
      '--no-privileges',
      '--format', 'plain',
      ...this.config.extraFlags,
    ];

    await this.execPgDump(args);

    const sizeBytes = await this.getFileSize(outputPath);

    return {
      path: outputPath,
      sizeBytes,
      durationMs: Date.now() - startTime,
      schema,
      createdAt: new Date(),
    };
  }

  /**
   * Dump the full database (single-tenant mode).
   */
  async dumpFull(): Promise<DumpResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `pg-full-${timestamp}.sql`;
    const outputPath = `${this.config.outputDir}/${filename}`;

    await this.ensureDir(this.config.outputDir);

    const args = [
      this.config.connectionUrl,
      '--file', outputPath,
      '--no-owner',
      '--no-privileges',
      '--format', 'plain',
      ...this.config.extraFlags,
    ];

    await this.execPgDump(args);

    const sizeBytes = await this.getFileSize(outputPath);

    return {
      path: outputPath,
      sizeBytes,
      durationMs: Date.now() - startTime,
      schema: 'public',
      createdAt: new Date(),
    };
  }

  // ── Internal (stubs for child_process / fs) ───────────────────────

  /**
   * Execute pg_dump with the given arguments.
   * Placeholder — will use child_process.execFile.
   */
  private async execPgDump(_args: string[]): Promise<void> {
    // TODO: wire to child_process.execFile(this.config.pgDumpPath, args)
    // Throw on non-zero exit code with stderr content
  }

  /**
   * Get file size in bytes.
   * Placeholder — will use fs.stat.
   */
  private async getFileSize(_path: string): Promise<number> {
    // TODO: wire to fs.stat
    return 0;
  }

  /**
   * Ensure a directory exists.
   * Placeholder — will use fs.mkdir with recursive.
   */
  private async ensureDir(_dir: string): Promise<void> {
    // TODO: wire to fs.mkdir(dir, { recursive: true })
  }
}

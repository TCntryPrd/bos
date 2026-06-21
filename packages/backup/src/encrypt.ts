/**
 * Backup Encryption — AES-256-GCM encryption per file (Layer 2 auth).
 *
 * Each backup file is encrypted with a separate key derived from a master key.
 * Key rotation happens weekly via a new key version.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface EncryptorConfig {
  /** Master encryption key (hex-encoded, 64 hex chars = 32 bytes). */
  key: string;
  /** Key rotation interval in days. Default 7. */
  rotationIntervalDays?: number;
}

export interface EncryptionMetadata {
  /** Algorithm used. */
  algorithm: 'aes-256-gcm';
  /** Key version (incremented on rotation). */
  keyVersion: number;
  /** Initialization vector (hex-encoded). */
  iv: string;
  /** Authentication tag (hex-encoded). */
  authTag: string;
  /** When the file was encrypted. */
  encryptedAt: string;
  /** Original file size before encryption. */
  originalSizeBytes: number;
}

export interface KeyInfo {
  version: number;
  createdAt: Date;
  expiresAt: Date;
  active: boolean;
}

// ── Encryptor ───────────────────────────────────────────────────────

export class BackupEncryptor {
  private masterKey: string;
  private rotationIntervalDays: number;
  private currentKeyVersion: number;
  private keyCreatedAt: Date;

  constructor(config: EncryptorConfig) {
    if (config.key.length !== 64) {
      throw new Error('Encryption key must be 64 hex characters (32 bytes for AES-256)');
    }
    this.masterKey = config.key;
    this.rotationIntervalDays = config.rotationIntervalDays ?? 7;
    this.currentKeyVersion = 1;
    this.keyCreatedAt = new Date();
  }

  /**
   * Encrypt a file and write the encrypted version alongside it.
   * Returns the path to the encrypted file.
   *
   * Encrypted file format:
   *   [16 bytes metadata length][JSON metadata][encrypted payload]
   */
  async encryptFile(inputPath: string): Promise<string> {
    const outputPath = `${inputPath}.enc`;

    // Check if key rotation is needed
    await this.checkRotation();

    // Derive per-file key from master key + file-specific salt
    const salt = this.generateSalt();
    const derivedKey = await this.deriveKey(this.masterKey, salt);

    // Generate IV
    const iv = this.generateIV();

    // Read input file
    const plaintext = await this.readFile(inputPath);
    const originalSize = plaintext.length;

    // Encrypt with AES-256-GCM
    const { ciphertext, authTag } = await this.aes256gcmEncrypt(plaintext, derivedKey, iv);

    // Build metadata
    const metadata: EncryptionMetadata = {
      algorithm: 'aes-256-gcm',
      keyVersion: this.currentKeyVersion,
      iv: this.bufferToHex(iv),
      authTag: this.bufferToHex(authTag),
      encryptedAt: new Date().toISOString(),
      originalSizeBytes: originalSize,
    };

    // Write encrypted file with metadata header
    await this.writeEncryptedFile(outputPath, metadata, salt, ciphertext);

    // Remove unencrypted file
    await this.deleteFile(inputPath);

    return outputPath;
  }

  /**
   * Decrypt a file.
   * Returns the path to the decrypted file.
   */
  async decryptFile(encryptedPath: string): Promise<string> {
    const outputPath = encryptedPath.replace(/\.enc$/, '');

    // Read encrypted file and parse metadata
    const { metadata, salt, ciphertext } = await this.readEncryptedFile(encryptedPath);

    // Derive the key used for encryption
    const derivedKey = await this.deriveKey(this.masterKey, salt);
    const iv = this.hexToBuffer(metadata.iv);
    const authTag = this.hexToBuffer(metadata.authTag);

    // Decrypt
    const plaintext = await this.aes256gcmDecrypt(ciphertext, derivedKey, iv, authTag);

    // Write decrypted file
    await this.writeFile(outputPath, plaintext);

    return outputPath;
  }

  /**
   * Rotate the encryption key. New backups use the new version.
   * Old backups remain readable with stored key versions.
   */
  async rotateKey(newKey: string): Promise<KeyInfo> {
    if (newKey.length !== 64) {
      throw new Error('New encryption key must be 64 hex characters');
    }

    this.currentKeyVersion++;
    this.masterKey = newKey;
    this.keyCreatedAt = new Date();

    const keyInfo: KeyInfo = {
      version: this.currentKeyVersion,
      createdAt: this.keyCreatedAt,
      expiresAt: new Date(this.keyCreatedAt.getTime() + this.rotationIntervalDays * 24 * 60 * 60 * 1000),
      active: true,
    };

    // Persist key version mapping
    await this.persistKeyVersion(keyInfo);

    return keyInfo;
  }

  /**
   * Get current key info.
   */
  getKeyInfo(): KeyInfo {
    return {
      version: this.currentKeyVersion,
      createdAt: this.keyCreatedAt,
      expiresAt: new Date(this.keyCreatedAt.getTime() + this.rotationIntervalDays * 24 * 60 * 60 * 1000),
      active: true,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async checkRotation(): Promise<void> {
    const ageMs = Date.now() - this.keyCreatedAt.getTime();
    const rotationMs = this.rotationIntervalDays * 24 * 60 * 60 * 1000;
    if (ageMs >= rotationMs) {
      // TODO: trigger key rotation via external key management
      // For now, log a warning
    }
  }

  /**
   * Derive a per-file key from master key + salt using HKDF.
   * Placeholder — will use Node.js crypto.hkdf.
   */
  private async deriveKey(_masterKey: string, _salt: Uint8Array): Promise<Uint8Array> {
    // TODO: wire to crypto.hkdfSync('sha256', masterKey, salt, 'boss-backup', 32)
    return new Uint8Array(32);
  }

  /**
   * AES-256-GCM encryption.
   * Placeholder — will use Node.js crypto.createCipheriv.
   */
  private async aes256gcmEncrypt(
    _plaintext: Uint8Array,
    _key: Uint8Array,
    _iv: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; authTag: Uint8Array }> {
    // TODO: wire to crypto.createCipheriv('aes-256-gcm', key, iv)
    return { ciphertext: new Uint8Array(0), authTag: new Uint8Array(16) };
  }

  /**
   * AES-256-GCM decryption.
   * Placeholder — will use Node.js crypto.createDecipheriv.
   */
  private async aes256gcmDecrypt(
    _ciphertext: Uint8Array,
    _key: Uint8Array,
    _iv: Uint8Array,
    _authTag: Uint8Array,
  ): Promise<Uint8Array> {
    // TODO: wire to crypto.createDecipheriv('aes-256-gcm', key, iv)
    return new Uint8Array(0);
  }

  private generateSalt(): Uint8Array {
    // TODO: wire to crypto.randomBytes(16)
    return new Uint8Array(16);
  }

  private generateIV(): Uint8Array {
    // TODO: wire to crypto.randomBytes(12) — 96-bit IV for GCM
    return new Uint8Array(12);
  }

  private bufferToHex(buf: Uint8Array): string {
    return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private hexToBuffer(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // ── Filesystem stubs ──────────────────────────────────────────────

  private async readFile(_path: string): Promise<Uint8Array> {
    // TODO: wire to fs.readFile
    return new Uint8Array(0);
  }

  private async writeFile(_path: string, _data: Uint8Array): Promise<void> {
    // TODO: wire to fs.writeFile
  }

  private async deleteFile(_path: string): Promise<void> {
    // TODO: wire to fs.unlink
  }

  private async writeEncryptedFile(
    _path: string,
    _metadata: EncryptionMetadata,
    _salt: Uint8Array,
    _ciphertext: Uint8Array,
  ): Promise<void> {
    // TODO: wire to fs — write metadata header + salt + ciphertext
  }

  private async readEncryptedFile(
    _path: string,
  ): Promise<{ metadata: EncryptionMetadata; salt: Uint8Array; ciphertext: Uint8Array }> {
    // TODO: wire to fs — read and parse encrypted file format
    return {
      metadata: {
        algorithm: 'aes-256-gcm',
        keyVersion: 1,
        iv: '',
        authTag: '',
        encryptedAt: '',
        originalSizeBytes: 0,
      },
      salt: new Uint8Array(16),
      ciphertext: new Uint8Array(0),
    };
  }

  private async persistKeyVersion(_keyInfo: KeyInfo): Promise<void> {
    // TODO: wire to Postgres — store key version metadata
  }
}

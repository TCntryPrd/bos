/**
 * Behavioral Embeddings — store and query behavioral embeddings in Weaviate.
 *
 * Converts user patterns and interactions into vector embeddings for
 * semantic search and pattern matching.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface BehavioralEmbedding {
  id: string;
  tenantId: string;
  userId: string;
  /** The category of behavior this embedding represents. */
  category: string;
  /** Human-readable description of the embedded behavior. */
  description: string;
  /** The raw text that was embedded. */
  sourceText: string;
  /** Embedding vector. Populated by Weaviate on insert. */
  vector?: number[];
  /** Additional metadata for filtering. */
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmbeddingQuery {
  tenantId: string;
  userId: string;
  /** Natural language query to search against. */
  query: string;
  /** Optional category filter. */
  category?: string;
  /** Max results. Default 10. */
  limit?: number;
  /** Minimum similarity threshold (0-1). Default 0.7. */
  minSimilarity?: number;
}

export interface EmbeddingSearchResult {
  embedding: BehavioralEmbedding;
  similarity: number;
}

export interface EmbeddingStoreConfig {
  /** Weaviate collection name. Default 'BehavioralEmbeddings'. */
  collectionName?: string;
  /** Vectorizer module. Default 'text2vec-transformers'. */
  vectorizer?: string;
}

// ── Store ───────────────────────────────────────────────────────────

export class EmbeddingStore {
  private config: Required<EmbeddingStoreConfig>;

  constructor(config: EmbeddingStoreConfig = {}) {
    this.config = {
      collectionName: config.collectionName ?? 'BehavioralEmbeddings',
      vectorizer: config.vectorizer ?? 'text2vec-transformers',
    };
  }

  /**
   * Ensure the Weaviate collection exists with the correct schema.
   */
  async initialize(): Promise<void> {
    // TODO: wire to Weaviate client
    // Create collection with properties:
    //   - tenantId (string, filterable)
    //   - userId (string, filterable)
    //   - category (string, filterable)
    //   - description (text)
    //   - sourceText (text, vectorized)
    //   - metadata (object)
    //   - createdAt (date)
    //   - updatedAt (date)
  }

  /**
   * Store a behavioral embedding.
   */
  async store(embedding: BehavioralEmbedding): Promise<string> {
    // TODO: wire to Weaviate client
    // Insert into collection, Weaviate handles vectorization of sourceText
    return embedding.id;
  }

  /**
   * Store multiple embeddings in batch.
   */
  async storeBatch(embeddings: BehavioralEmbedding[]): Promise<number> {
    // TODO: wire to Weaviate client batch import
    let stored = 0;
    for (const embedding of embeddings) {
      await this.store(embedding);
      stored++;
    }
    return stored;
  }

  /**
   * Semantic search for similar behavioral patterns.
   */
  async search(query: EmbeddingQuery): Promise<EmbeddingSearchResult[]> {
    const limit = query.limit ?? 10;
    const minSimilarity = query.minSimilarity ?? 0.7;

    // TODO: wire to Weaviate nearText query
    // Filter by tenantId + userId
    // Optional category filter
    // nearText: query.query
    // limit: limit
    // Return results above minSimilarity threshold

    return [];
  }

  /**
   * Delete all embeddings for a user (privacy support).
   */
  async deleteForUser(tenantId: string, userId: string): Promise<number> {
    // TODO: wire to Weaviate batch delete
    // Filter: tenantId + userId
    return 0;
  }

  /**
   * Delete embeddings by category.
   */
  async deleteByCategory(
    tenantId: string,
    userId: string,
    category: string,
  ): Promise<number> {
    // TODO: wire to Weaviate batch delete
    return 0;
  }

  /**
   * Count embeddings for a user.
   */
  async count(tenantId: string, userId: string): Promise<number> {
    // TODO: wire to Weaviate aggregate query
    return 0;
  }

  /**
   * Create an embedding record from a pattern description.
   * Helper for converting IngestPatterns to embeddings.
   */
  createFromPattern(
    tenantId: string,
    userId: string,
    category: string,
    description: string,
    evidence: string[],
    metadata: Record<string, unknown> = {},
  ): BehavioralEmbedding {
    const sourceText = [description, ...evidence].join('. ');
    return {
      id: `emb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      userId,
      category,
      description,
      sourceText,
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
}

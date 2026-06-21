/**
 * Communication Style Model — builds and maintains a model of the user's
 * communication style for tone matching and response generation.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface StyleProfile {
  tenantId: string;
  userId: string;
  /** Formality level 0 (very casual) to 1 (very formal). */
  formality: number;
  /** Verbosity level 0 (terse) to 1 (verbose). */
  verbosity: number;
  /** How often emoji/emoticons are used 0-1. */
  emojiUsage: number;
  /** Preferred greeting style. */
  greetingStyle: 'none' | 'casual' | 'formal';
  /** Preferred sign-off style. */
  signoffStyle: 'none' | 'casual' | 'formal';
  /** Common phrases and vocabulary. */
  vocabulary: StyleVocabulary;
  /** Samples used to build the profile. */
  sampleCount: number;
  updatedAt: Date;
}

export interface StyleVocabulary {
  /** Frequently used greetings. */
  greetings: string[];
  /** Frequently used sign-offs. */
  signoffs: string[];
  /** Common filler phrases. */
  fillers: string[];
  /** Preferred contractions vs full forms. */
  usesContractions: boolean;
  /** Typical sentence structure length. */
  avgSentenceWords: number;
}

export interface StyleAnalysisInput {
  text: string;
  context: 'email' | 'chat' | 'voice' | 'general';
}

// ── Model ───────────────────────────────────────────────────────────

export class StyleModel {
  private profiles: Map<string, StyleProfile> = new Map();

  /**
   * Analyze a text sample and update the user's style profile.
   */
  async analyze(
    tenantId: string,
    userId: string,
    input: StyleAnalysisInput,
  ): Promise<StyleProfile> {
    const key = `${tenantId}:${userId}`;
    const existing = this.profiles.get(key) ?? this.defaultProfile(tenantId, userId);

    const analysis = this.analyzeText(input.text);

    // Weighted moving average with existing profile
    const weight = 1 / (existing.sampleCount + 1);
    existing.formality = this.blend(existing.formality, analysis.formality, weight);
    existing.verbosity = this.blend(existing.verbosity, analysis.verbosity, weight);
    existing.emojiUsage = this.blend(existing.emojiUsage, analysis.emojiUsage, weight);
    existing.sampleCount++;
    existing.updatedAt = new Date();

    // Update vocabulary
    this.updateVocabulary(existing.vocabulary, analysis);

    // Update greeting/signoff style based on majority
    if (analysis.hasGreeting) {
      existing.greetingStyle = analysis.formalGreeting ? 'formal' : 'casual';
    }
    if (analysis.hasSignoff) {
      existing.signoffStyle = analysis.formalSignoff ? 'formal' : 'casual';
    }

    this.profiles.set(key, existing);
    await this.persist(existing);

    return existing;
  }

  /**
   * Get the current style profile.
   */
  async getProfile(tenantId: string, userId: string): Promise<StyleProfile | undefined> {
    const key = `${tenantId}:${userId}`;
    return this.profiles.get(key);
  }

  /**
   * Generate a style instruction prompt for the brain.
   * Used by brain middleware to match user's communication style.
   */
  async getStylePrompt(tenantId: string, userId: string): Promise<string> {
    const profile = await this.getProfile(tenantId, userId);
    if (!profile || profile.sampleCount < 3) {
      return ''; // Not enough data for reliable style matching
    }

    const parts: string[] = [];

    // Formality
    if (profile.formality < 0.3) {
      parts.push('Use a casual, conversational tone.');
    } else if (profile.formality > 0.7) {
      parts.push('Use a professional, formal tone.');
    } else {
      parts.push('Use a balanced, semi-formal tone.');
    }

    // Verbosity
    if (profile.verbosity < 0.3) {
      parts.push('Keep responses brief and to the point.');
    } else if (profile.verbosity > 0.7) {
      parts.push('Provide detailed explanations.');
    }

    // Contractions
    if (profile.vocabulary.usesContractions) {
      parts.push('Use contractions naturally.');
    } else {
      parts.push('Avoid contractions; use full forms.');
    }

    // Emoji
    if (profile.emojiUsage > 0.3) {
      parts.push('Light emoji usage is appropriate.');
    }

    return parts.join(' ');
  }

  // ── Internal ──────────────────────────────────────────────────────

  private analyzeText(text: string): TextAnalysis {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u;

    // Formality indicators
    const formalWords = ['regards', 'sincerely', 'dear', 'kindly', 'hereby', 'pursuant', 'accordingly'];
    const casualWords = ['hey', 'hi', 'thanks', 'yeah', 'cool', 'awesome', 'gonna', 'wanna'];
    const formalCount = words.filter((w) => formalWords.includes(w.toLowerCase())).length;
    const casualCount = words.filter((w) => casualWords.includes(w.toLowerCase())).length;
    const totalIndicators = formalCount + casualCount;
    const formality = totalIndicators > 0 ? formalCount / totalIndicators : 0.5;

    // Verbosity: words per sentence
    const avgSentenceLen = sentences.length > 0 ? words.length / sentences.length : 10;
    const verbosity = Math.min(1, avgSentenceLen / 30); // normalize: 30+ words = max verbosity

    // Emoji usage
    const emojiCount = (text.match(new RegExp(emojiPattern, 'gu')) ?? []).length;
    const emojiUsage = words.length > 0 ? Math.min(1, emojiCount / words.length * 10) : 0;

    // Contractions
    const contractionPattern = /\w+'\w+/g;
    const contractions = text.match(contractionPattern) ?? [];
    const usesContractions = contractions.length > 0;

    // Greeting detection
    const firstLine = text.split('\n')[0].toLowerCase().trim();
    const hasGreeting = /^(hi|hey|hello|dear|good morning|good afternoon|good evening)/i.test(firstLine);
    const formalGreeting = /^(dear|good morning|good afternoon|good evening)/i.test(firstLine);

    // Signoff detection
    const lastLines = text.split('\n').slice(-3).join(' ').toLowerCase().trim();
    const hasSignoff = /(regards|sincerely|best|thanks|cheers|yours)/i.test(lastLines);
    const formalSignoff = /(regards|sincerely|yours truly|respectfully)/i.test(lastLines);

    return {
      formality,
      verbosity,
      emojiUsage,
      usesContractions,
      avgSentenceWords: avgSentenceLen,
      hasGreeting,
      formalGreeting,
      hasSignoff,
      formalSignoff,
    };
  }

  private blend(current: number, newValue: number, weight: number): number {
    return current * (1 - weight) + newValue * weight;
  }

  private updateVocabulary(vocab: StyleVocabulary, analysis: TextAnalysis): void {
    vocab.usesContractions = analysis.usesContractions;
    vocab.avgSentenceWords = analysis.avgSentenceWords;
  }

  private defaultProfile(tenantId: string, userId: string): StyleProfile {
    return {
      tenantId,
      userId,
      formality: 0.5,
      verbosity: 0.5,
      emojiUsage: 0,
      greetingStyle: 'none',
      signoffStyle: 'none',
      vocabulary: {
        greetings: [],
        signoffs: [],
        fillers: [],
        usesContractions: true,
        avgSentenceWords: 15,
      },
      sampleCount: 0,
      updatedAt: new Date(),
    };
  }

  private async persist(_profile: StyleProfile): Promise<void> {
    // TODO: wire to Postgres data layer
  }
}

// ── Internal Types ──────────────────────────────────────────────────

interface TextAnalysis {
  formality: number;
  verbosity: number;
  emojiUsage: number;
  usesContractions: boolean;
  avgSentenceWords: number;
  hasGreeting: boolean;
  formalGreeting: boolean;
  hasSignoff: boolean;
  formalSignoff: boolean;
}

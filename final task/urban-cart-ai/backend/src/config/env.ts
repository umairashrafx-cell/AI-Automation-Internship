/**
 * Environment configuration.
 *
 * Rules enforced here:
 *   1. No secret ever appears in source. Everything arrives via process.env.
 *   2. Missing credentials are NOT a crash. Each integration reports its own
 *      readiness, and the system degrades to a clearly-labelled DRY-RUN mode.
 *   3. Production has stricter requirements than development, and we fail fast
 *      at boot rather than half-way through a customer conversation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root (…/urban-cart-ai). */
export const PROJECT_ROOT = resolve(HERE, '..', '..', '..');

/* -------------------------------------------------------------------------- */
/* .env loading                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal .env loader. We deliberately do not depend on a library at boot so
 * that configuration errors surface with our own diagnostics.
 * Existing process.env values always win (12-factor: the platform overrides).
 */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  const raw = readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      // Quoted: take it literally, including any '#'.
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment starts at the first '#' preceded by
      // whitespace. Without this, `LOG_LEVEL=info   # debug|info` would be
      // read as the whole string and fail validation.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(join(PROJECT_ROOT, '.env'));

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

const configProblems: string[] = [];

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    configProblems.push(`${key} must be an integer, received "${raw}"`);
    return fallback;
  }
  return n;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    configProblems.push(`${key} must be a number, received "${raw}"`);
    return fallback;
  }
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = str(key, fallback);
  if (!(allowed as readonly string[]).includes(raw)) {
    configProblems.push(`${key} must be one of ${allowed.join(' | ')}, received "${raw}"`);
    return fallback;
  }
  return raw as T;
}

function list(key: string, fallback: string[] = []): string[] {
  const raw = str(key);
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* Typed configuration                                                        */
/* -------------------------------------------------------------------------- */

export type DbDriver = 'pglite' | 'postgres';
export type VectorStoreKind = 'auto' | 'supabase' | 'pgvector';
export type EmbeddingProvider = 'openai' | 'local';
export type LlmProvider = 'anthropic' | 'openai' | 'extractive';

const nodeEnv = oneOf('NODE_ENV', ['development', 'test', 'production'] as const, 'development');

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int('PORT', 3000),
  logLevel: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
  appBaseUrl: str('APP_BASE_URL', 'http://localhost:3000'),

  security: {
    internalApiKey: str('INTERNAL_API_KEY'),
    webhookSigningSecret: str('WEBHOOK_SIGNING_SECRET'),
    corsAllowedOrigins: list('CORS_ALLOWED_ORIGINS', ['http://localhost:3000']),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60),
  },

  db: {
    driver: oneOf('DB_DRIVER', ['pglite', 'postgres'] as const, 'pglite') as DbDriver,
    url: str('DATABASE_URL'),
    pgliteDataDir: resolve(PROJECT_ROOT, str('PGLITE_DATA_DIR', './data/pglite')),
    ssl: bool('PGSSL', false),
    poolMax: int('PG_POOL_MAX', 10),
  },

  supabase: {
    url: str('SUPABASE_URL'),
    serviceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: str('SUPABASE_ANON_KEY'),
  },

  rag: {
    vectorStore: oneOf('VECTOR_STORE', ['auto', 'supabase', 'pgvector'] as const, 'auto') as VectorStoreKind,
    embeddingProvider: oneOf('EMBEDDING_PROVIDER', ['openai', 'local'] as const, 'local') as EmbeddingProvider,
    embeddingModel: str('EMBEDDING_MODEL', 'text-embedding-3-small'),
    embeddingDimensions: int('EMBEDDING_DIMENSIONS', 1536),
    topK: int('RAG_TOP_K', 5),
    chunkSize: int('RAG_CHUNK_SIZE', 900),
    chunkOverlap: int('RAG_CHUNK_OVERLAP', 150),
    minSimilarity: num('RAG_MIN_SIMILARITY', 0.25),
    confidenceThreshold: num('RAG_CONFIDENCE_THRESHOLD', 0.35),
    knowledgeBaseDir: resolve(PROJECT_ROOT, str('KNOWLEDGE_BASE_DIR', './knowledge-base')),
  },

  llm: {
    provider: oneOf('LLM_PROVIDER', ['anthropic', 'openai', 'extractive'] as const, 'extractive') as LlmProvider,
    anthropicApiKey: str('ANTHROPIC_API_KEY'),
    anthropicModel: str('ANTHROPIC_MODEL', 'claude-opus-5'),
    openaiApiKey: str('OPENAI_API_KEY'),
    maxTokens: int('LLM_MAX_TOKENS', 700),
    effort: oneOf('LLM_EFFORT', ['low', 'medium', 'high', 'xhigh', 'max'] as const, 'low'),
    /** OpenAI path only - sampling params are rejected by Claude Opus 5. */
    temperature: num('LLM_TEMPERATURE', 0.2),
  },

  business: {
    highValueLeadBudgetPkr: int('HIGH_VALUE_LEAD_BUDGET_PKR', 150_000),
    highValueLeadScore: int('HIGH_VALUE_LEAD_SCORE', 70),
    duplicateLeadWindowHours: int('DUPLICATE_LEAD_WINDOW_HOURS', 24),
  },

  slack: {
    botToken: str('SLACK_BOT_TOKEN'),
    webhookUrl: str('SLACK_WEBHOOK_URL'),
    channels: {
      sales: str('SLACK_CHANNEL_SALES', '#urbancart-sales'),
      support: str('SLACK_CHANNEL_SUPPORT', '#urbancart-support'),
      alerts: str('SLACK_CHANNEL_ALERTS', '#urbancart-alerts'),
    },
  },

  airtable: {
    apiKey: str('AIRTABLE_API_KEY'),
    baseId: str('AIRTABLE_BASE_ID'),
    tables: {
      leads: str('AIRTABLE_TABLE_LEADS', 'Leads'),
      support: str('AIRTABLE_TABLE_SUPPORT', 'Support Issues'),
      orders: str('AIRTABLE_TABLE_ORDERS', 'Orders'),
    },
  },

  notion: {
    apiKey: str('NOTION_API_KEY'),
    version: str('NOTION_VERSION', '2022-06-28'),
    parentPageId: str('NOTION_PARENT_PAGE_ID'),
  },

  googleDrive: {
    serviceAccountKeyFile: str('GOOGLE_SERVICE_ACCOUNT_KEY_FILE'),
    folderId: str('GOOGLE_DRIVE_FOLDER_ID'),
    pollMinutes: int('GOOGLE_DRIVE_POLL_MINUTES', 15),
  },

  zapier: {
    catchHookUrl: str('ZAPIER_CATCH_HOOK_URL'),
    sharedSecret: str('ZAPIER_SHARED_SECRET'),
  },

  n8n: {
    baseUrl: str('N8N_BASE_URL', 'http://localhost:5678'),
    webhookPrefix: str('N8N_WEBHOOK_PREFIX', '/webhook'),
    sharedSecret: str('N8N_SHARED_SECRET'),
  },

  vapi: {
    apiKey: str('VAPI_API_KEY'),
    assistantId: str('VAPI_ASSISTANT_ID'),
    phoneNumberId: str('VAPI_PHONE_NUMBER_ID'),
    webhookSecret: str('VAPI_WEBHOOK_SECRET'),
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Integration readiness                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether each external integration has the credentials it needs.
 * A `false` here means the connector runs in DRY-RUN: it builds the real
 * request and records it to data/outbox/<service>.jsonl instead of sending.
 */
export const integrationReadiness = {
  slack: Boolean(env.slack.botToken || env.slack.webhookUrl),
  airtable: Boolean(env.airtable.apiKey && env.airtable.baseId),
  notion: Boolean(env.notion.apiKey),
  googleDrive: Boolean(env.googleDrive.serviceAccountKeyFile && env.googleDrive.folderId),
  zapier: Boolean(env.zapier.catchHookUrl),
  supabase: Boolean(env.supabase.url && env.supabase.serviceRoleKey),
  vapi: Boolean(env.vapi.apiKey),
  openaiEmbeddings: Boolean(env.llm.openaiApiKey),
  anthropic: Boolean(env.llm.anthropicApiKey),
} as const;

export type IntegrationName = keyof typeof integrationReadiness;

/** Effective vector store after resolving `auto`. */
export function resolvedVectorStore(): 'supabase' | 'pgvector' {
  if (env.rag.vectorStore === 'supabase') return 'supabase';
  if (env.rag.vectorStore === 'pgvector') return 'pgvector';
  return integrationReadiness.supabase ? 'supabase' : 'pgvector';
}

/** Effective embedding provider: falls back to local when OpenAI has no key. */
export function resolvedEmbeddingProvider(): EmbeddingProvider {
  if (env.rag.embeddingProvider === 'openai' && !integrationReadiness.openaiEmbeddings) {
    return 'local';
  }
  return env.rag.embeddingProvider;
}

/**
 * Similarity thresholds are PROVIDER-SPECIFIC and must not be shared.
 *
 * Cosine similarity is not comparable across embedding models. A trained model
 * like text-embedding-3-small puts a good match around 0.4-0.7, whereas the
 * local hashed bag-of-words puts the same match around 0.15-0.30, because a
 * short query and a long chunk share only a handful of hashed features. Using
 * one threshold for both would either reject every correct local answer or
 * accept every irrelevant OpenAI one.
 *
 * An explicitly-set environment variable always wins; these are only defaults.
 */
const THRESHOLD_DEFAULTS: Record<EmbeddingProvider, { minSimilarity: number; confidence: number }> = {
  openai: { minSimilarity: 0.25, confidence: 0.35 },
  local: { minSimilarity: 0.08, confidence: 0.22 },
};

function wasSet(key: string): boolean {
  const v = process.env[key];
  return v !== undefined && v !== '';
}

export function ragThresholds(): { minSimilarity: number; confidenceThreshold: number } {
  const defaults = THRESHOLD_DEFAULTS[resolvedEmbeddingProvider()];
  return {
    minSimilarity: wasSet('RAG_MIN_SIMILARITY') ? env.rag.minSimilarity : defaults.minSimilarity,
    confidenceThreshold: wasSet('RAG_CONFIDENCE_THRESHOLD')
      ? env.rag.confidenceThreshold
      : defaults.confidence,
  };
}

/** Effective LLM provider: falls back to extractive when the key is missing. */
export function resolvedLlmProvider(): LlmProvider {
  if (env.llm.provider === 'anthropic' && !integrationReadiness.anthropic) return 'extractive';
  if (env.llm.provider === 'openai' && !env.llm.openaiApiKey) return 'extractive';
  return env.llm.provider;
}

/* -------------------------------------------------------------------------- */
/* Boot-time validation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Returns fatal configuration errors. Development tolerates almost everything
 * so the demo always runs; production insists on real secrets and real stores.
 */
export function validateEnvironment(): { errors: string[]; warnings: string[] } {
  const errors = [...configProblems];
  const warnings: string[] = [];

  if (env.db.driver === 'postgres' && !env.db.url) {
    errors.push('DB_DRIVER=postgres requires DATABASE_URL to be set.');
  }
  if (env.rag.vectorStore === 'supabase' && !integrationReadiness.supabase) {
    errors.push('VECTOR_STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  if (env.rag.chunkOverlap >= env.rag.chunkSize) {
    errors.push('RAG_CHUNK_OVERLAP must be smaller than RAG_CHUNK_SIZE.');
  }
  if (env.rag.confidenceThreshold < env.rag.minSimilarity) {
    warnings.push(
      'RAG_CONFIDENCE_THRESHOLD is below RAG_MIN_SIMILARITY; the confidence gate will never fire.',
    );
  }

  if (env.isProduction) {
    if (!env.security.internalApiKey) {
      errors.push('INTERNAL_API_KEY is required in production (protects /api/tools/*).');
    }
    if (!env.security.webhookSigningSecret) {
      errors.push('WEBHOOK_SIGNING_SECRET is required in production (verifies inbound webhooks).');
    }
    if (env.db.driver === 'pglite') {
      errors.push('DB_DRIVER=pglite is a single-process embedded database and is not supported in production. Use DB_DRIVER=postgres.');
    }
    if (resolvedEmbeddingProvider() === 'local') {
      errors.push('EMBEDDING_PROVIDER=local is demo-quality only. Configure OPENAI_API_KEY in production.');
    }
    if (resolvedLlmProvider() === 'extractive') {
      warnings.push('No LLM key configured: answers will be extractive quotes from documents.');
    }
    if (!integrationReadiness.slack) {
      warnings.push('Slack has no credentials: escalations will be written to the outbox, not delivered.');
    }
  } else {
    if (resolvedEmbeddingProvider() === 'local') {
      warnings.push('Embeddings: LOCAL deterministic provider (demo quality, not a trained model).');
    }
    if (resolvedLlmProvider() === 'extractive') {
      warnings.push('Answer generation: EXTRACTIVE mode (verbatim document quotes, no LLM call).');
    }
    for (const [name, ready] of Object.entries(integrationReadiness)) {
      if (!ready && ['slack', 'airtable', 'notion', 'zapier'].includes(name)) {
        warnings.push(`${name}: no credentials -> DRY-RUN (payloads recorded to data/outbox/${name}.jsonl).`);
      }
    }
  }

  return { errors, warnings };
}

/**
 * Test environment flags.
 *
 * This module exists solely so the environment is set BEFORE any application
 * module is evaluated. ES modules hoist imports: assignments in a module body
 * run only after all of that module's own imports have been evaluated, so
 * setting `process.env.NODE_ENV` at the top of a file that also imports the
 * config would set it too late — the config would already have been read, and
 * the tests would silently run against the developer's persistent database.
 *
 * Every test file must import this FIRST, before anything from backend/.
 */

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'error';

// Force a private in-memory PostgreSQL for every test process.
process.env['DB_DRIVER'] = 'pglite';
process.env['PGLITE_DATA_DIR'] = ':memory:';

// Fixed test secrets, so the auth middleware is actually ENFORCED during tests
// rather than falling back to its development "no key configured" behaviour.
// Set here, not in the test file body, for the same hoisting reason as above.
process.env['INTERNAL_API_KEY'] = 'test-internal-key-do-not-use-in-production';
process.env['WEBHOOK_SIGNING_SECRET'] = 'test-webhook-secret';
process.env['VAPI_WEBHOOK_SECRET'] = 'test-vapi-secret';

// Use the provider-appropriate defaults rather than whatever .env happens to say.
process.env['RAG_MIN_SIMILARITY'] = '';
process.env['RAG_CONFIDENCE_THRESHOLD'] = '';

// Never let a test reach a real third-party API, even if .env has credentials.
for (const key of [
  'SLACK_BOT_TOKEN',
  'SLACK_WEBHOOK_URL',
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
  'NOTION_API_KEY',
  'ZAPIER_CATCH_HOOK_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
  'GOOGLE_DRIVE_FOLDER_ID',
]) {
  process.env[key] = '';
}

export const TEST_ENV_READY = true;

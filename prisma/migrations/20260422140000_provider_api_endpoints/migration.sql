-- Align Provider.apiEndpoint / modelsEndpoint with application defaults
-- (src/services/ai-executor.ts + src/services/sync-models.ts).

UPDATE "Provider" SET "apiEndpoint" = '/v1/sonar', "modelsEndpoint" = '', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'perplexity';

UPDATE "Provider" SET "apiEndpoint" = '/v1/responses', "modelsEndpoint" = '/v1/models', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'openai';

UPDATE "Provider" SET "apiEndpoint" = '/v1/messages', "modelsEndpoint" = '/v1/models', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'anthropic';

UPDATE "Provider" SET "apiEndpoint" = '', "modelsEndpoint" = '/v1beta/models', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'google';

UPDATE "Provider" SET "apiEndpoint" = '/v1/chat/completions', "modelsEndpoint" = '/v1/models', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'xai';

UPDATE "Provider" SET "apiEndpoint" = '/chat/completions', "modelsEndpoint" = '/models', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'deepseek';

UPDATE "Provider" SET "apiEndpoint" = '/v1/chat/completions', "modelsEndpoint" = '/v1/models', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" IN ('mistral', 'meta', 'moonshot');

UPDATE "Provider" SET "apiEndpoint" = '/compatible-mode/v1/chat/completions', "modelsEndpoint" = '', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'qwen';

UPDATE "Provider" SET "apiEndpoint" = '/v2/chat', "modelsEndpoint" = '/v1/models', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'cohere';

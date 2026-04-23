-- Perplexity: use OpenAI-SDK-compatible path /chat/completions (documented alias of /v1/sonar).

UPDATE "Provider" SET "apiEndpoint" = '/chat/completions', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'perplexity' AND ("apiEndpoint" = '/v1/sonar' OR "apiEndpoint" = '');

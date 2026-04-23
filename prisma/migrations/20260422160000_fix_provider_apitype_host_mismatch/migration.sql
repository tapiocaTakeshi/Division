-- Fix rows where apiType was left as "openai" but apiBaseUrl targets another vendor (caused /v1/responses on wrong host).

UPDATE "Provider" SET "apiType" = 'anthropic', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'openai' AND LOWER("apiBaseUrl") LIKE '%anthropic%';

UPDATE "Provider" SET "apiType" = 'perplexity', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'openai' AND LOWER("apiBaseUrl") LIKE '%perplexity%';

UPDATE "Provider" SET "apiType" = 'google', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'openai' AND LOWER("apiBaseUrl") LIKE '%generativelanguage.googleapis.com%';

UPDATE "Provider" SET "apiType" = 'xai', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'openai' AND LOWER("apiBaseUrl") LIKE '%api.x.ai%';

UPDATE "Provider" SET "apiType" = 'deepseek', "updatedAt" = CURRENT_TIMESTAMP
WHERE "apiType" = 'openai' AND LOWER("apiBaseUrl") LIKE '%deepseek%';

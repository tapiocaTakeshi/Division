-- Add TypeSafe AI's Jev provider without embedding any API key.
INSERT INTO "Provider" (
  "id", "name", "displayName", "apiBaseUrl", "apiType",
  "apiEndpoint", "modelsEndpoint", "modelId", "description",
  "isEnabled", "createdAt", "updatedAt"
)
VALUES (
  gen_random_uuid(),
  'jev',
  'Jev (TypeSafe AI)',
  'https://api.typesafe.ai',
  'typesafe',
  '/v1/systemone',
  '',
  'jev-latest',
  'Typed decision model for fast, structured orchestration decisions',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "apiBaseUrl" = EXCLUDED."apiBaseUrl",
  "apiType" = EXCLUDED."apiType",
  "apiEndpoint" = EXCLUDED."apiEndpoint",
  "modelsEndpoint" = EXCLUDED."modelsEndpoint",
  "modelId" = EXCLUDED."modelId",
  "description" = EXCLUDED."description",
  "isEnabled" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

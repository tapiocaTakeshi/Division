import { Redis } from "@upstash/redis";

/**
 * Upstash Redis client for KV storage.
 *
 * Requires KV_REST_API_URL and KV_REST_API_TOKEN environment variables.
 * Optionally uses KV_REST_API_READ_ONLY_TOKEN for a read-only client.
 */

let _redis: Redis | null = null;
let _redisReadOnly: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Missing KV_REST_API_URL or KV_REST_API_TOKEN environment variables"
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

export function getRedisReadOnly(): Redis {
  if (!_redisReadOnly) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_READ_ONLY_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Missing KV_REST_API_URL or KV_REST_API_READ_ONLY_TOKEN environment variables"
      );
    }
    _redisReadOnly = new Redis({ url, token, readOnly: true });
  }
  return _redisReadOnly;
}

/** Convenience singleton – full read/write access */
export const kv = {
  get redis() {
    return getRedis();
  },
  get readOnlyRedis() {
    return getRedisReadOnly();
  },
};

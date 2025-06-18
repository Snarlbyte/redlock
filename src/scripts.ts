import {RedisArgument, RedisClientType as IORedisClient} from 'redis';

import {AugmentedClient} from './index';

// Define script constants.
const DB_SELECT_SCRIPT = `
  -- Protected call to execute SELECT command if supported
  redis.pcall("SELECT", tonumber(ARGV[1]))
`;

const ACQUIRE_SCRIPT = `
  ${DB_SELECT_SCRIPT}

  -- Return 0 if an entry already exists.
  for i, key in ipairs(KEYS) do
    if redis.call("exists", key) == 1 then
      return 0
    end
  end

  -- Create an entry for each provided key.
  for i, key in ipairs(KEYS) do
    redis.call("set", key, ARGV[2], "PX", ARGV[3])
  end

  -- Return the number of entries added.
  return #KEYS
`;

const EXTEND_SCRIPT = `
  ${DB_SELECT_SCRIPT}

  -- Return 0 if an entry exists with a *different* lock value.
  for i, key in ipairs(KEYS) do
    if redis.call("get", key) ~= ARGV[2] then
      return 0
    end
  end

  -- Update the entry for each provided key.
  for i, key in ipairs(KEYS) do
    redis.call("set", key, ARGV[2], "PX", ARGV[3])
  end

  -- Return the number of entries updated.
  return #KEYS
`;

const RELEASE_SCRIPT = `
  ${DB_SELECT_SCRIPT}

  local count = 0
  for i, key in ipairs(KEYS) do
    -- Only remove entries for *this* lock value.
    if redis.call("get", key) == ARGV[2] then
      redis.pcall("del", key)
      count = count + 1
    end
  end

  -- Return the number of entries removed.
  return count
`;

declare module 'redis' {
  interface RedisCommander {
    acquireLock(keys: number, ...args: (string | number)[]): Promise<number>;
    extendLock(keys: number, ...args: (string | number)[]): Promise<number>;
    releaseLock(keys: number, ...args: (string | number)[]): Promise<number>;
  }
}

let acquireScriptSha: string;
let extendScriptSha: string;
let releaseScriptSha: string;

export async function ensureCommands(client: IORedisClient): Promise<AugmentedClient | null> {
  const augmentedClient = client as AugmentedClient;

  // Check if commands are already loaded
  if (typeof augmentedClient.acquireLock === 'function') {
    return augmentedClient;
  }

  try {
    // Test client connection first
    await client.ping();

    // Load scripts if not already loaded
    if (!acquireScriptSha) {
      acquireScriptSha = await client.scriptLoad(ACQUIRE_SCRIPT);
    }
    if (!extendScriptSha) {
      extendScriptSha = await client.scriptLoad(EXTEND_SCRIPT);
    }
    if (!releaseScriptSha) {
      releaseScriptSha = await client.scriptLoad(RELEASE_SCRIPT);
    }

    // Add the custom methods to the client
    augmentedClient.acquireLock = async function(keys: RedisArgument[], ...args: (string)[]): Promise<number> {
      try {
        const result = await client.evalSha(acquireScriptSha, { keys, arguments: args });
        if (typeof result !== 'number') {
          throw new Error(`Expected number result from acquireLock script, got ${typeof result}`);
        }
        return result;
      } catch (error) {
        // If script not found, reload and retry
        if (error && typeof error === 'object' && 'message' in error &&
          (error as any).message.includes('NOSCRIPT')) {
          acquireScriptSha = await client.scriptLoad(ACQUIRE_SCRIPT);
          const result = await client.evalSha(acquireScriptSha, { keys, arguments: args });
          if (typeof result !== 'number') {
            throw new Error(`Expected number result from acquireLock script, got ${typeof result}`);
          }
          return result;
        }
        throw error;
      }
    };

    augmentedClient.extendLock = async function(keys: RedisArgument[], ...args: (string)[]): Promise<number> {
      try {
        const result = await client.evalSha(extendScriptSha, { keys, arguments: args });
        if (typeof result !== 'number') {
          throw new Error(`Expected number result from extendLock script, got ${typeof result}`);
        }
        return result;
      } catch (error) {
        if (error && typeof error === 'object' && 'message' in error &&
          (error as any).message.includes('NOSCRIPT')) {
          extendScriptSha = await client.scriptLoad(EXTEND_SCRIPT);
          const result = await client.evalSha(extendScriptSha, { keys, arguments: args });
          if (typeof result !== 'number') {
            throw new Error(`Expected number result from extendLock script, got ${typeof result}`);
          }
          return result;
        }
        throw error;
      }
    };

    augmentedClient.releaseLock = async function(keys: RedisArgument[], ...args: (string)[]): Promise<number> {
      try {
        const result = await client.evalSha(releaseScriptSha, { keys, arguments: args });
        if (typeof result !== 'number') {
          throw new Error(`Expected number result from releaseLock script, got ${typeof result}`);
        }
        return result;
      } catch (error) {
        if (error && typeof error === 'object' && 'message' in error &&
          (error as any).message.includes('NOSCRIPT')) {
          releaseScriptSha = await client.scriptLoad(RELEASE_SCRIPT);
          const result = await client.evalSha(releaseScriptSha, { keys, arguments: args });
          if (typeof result !== 'number') {
            throw new Error(`Expected number result from releaseLock script, got ${typeof result}`);
          }
          return result;
        }
        throw error;
      }
    };

    return augmentedClient;
  } catch (error) {
    console.error('Failed to ensure commands on Redis client:', error);
    return null;
  }
}

"""Token bucket shared by all workers, stored in Redis.

The arithmetic is the same as ``relay.domain.rate_limit.take``. It runs as a Lua
script because Redis executes a script atomically: two workers asking at the same
instant can never both take the last token. Time comes from the Redis server, so
workers with slightly different clocks still agree.
"""

from typing import cast

from redis.asyncio import Redis

from relay.domain.rate_limit import BucketState, RateDecision

_TAKE = """
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) + tonumber(time[2]) / 1000000

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1])
if tokens == nil then
  tokens = capacity
else
  local elapsed = math.max(0, now - tonumber(bucket[2]))
  tokens = math.min(capacity, tokens + elapsed * rate)
end

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after = (1 - tokens) / rate
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
-- An idle bucket refills completely, so it can be forgotten after that long.
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / rate) + 60)
return {allowed, tostring(tokens), tostring(now), tostring(retry_after)}
"""


class RedisRateLimiter:
    def __init__(self, redis: Redis) -> None:
        self._script = redis.register_script(_TAKE)

    async def acquire(self, key: str, *, rate: float, capacity: float) -> RateDecision:
        allowed, tokens, now, retry_after = cast(
            tuple[int, str, str, str],
            await self._script(keys=[f"ratelimit:{key}"], args=[rate, capacity]),
        )
        return RateDecision(
            bool(int(allowed)), BucketState(float(tokens), float(now)), float(retry_after)
        )

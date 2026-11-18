/**
 * Redis Cache-Aside Helper với khả năng fallback an toàn về DB khi Redis gặp sự cố.
 */
const { getRedisClient, delByPrefix } = require('../config/redis');

const metrics = {
    hits: 0,
    misses: 0,
    errors: 0,
};

const shouldUseCache = (options = {}) => {
    if (options.bypassCache) return false;
    if (options.forceCache) return true;
    const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
    if (isTestEnv && process.env.USE_CACHE_IN_TEST !== 'true') {
        return false;
    }
    return true;
};

/**
 * Đọc cache trước; nếu miss hoặc Redis lỗi thì gọi fetcher và lưu lại với TTL (giây).
 */
exports.getOrSet = async (key, ttlSeconds, fetcher, options = {}) => {
    if (!shouldUseCache(options)) {
        return fetcher();
    }

    const client = getRedisClient();
    try {
        const cached = await client.get(key);
        if (cached !== null && cached !== undefined) {
            metrics.hits++;
            return JSON.parse(cached);
        }
    } catch {
        metrics.errors++;
    }

    metrics.misses++;
    const fresh = await fetcher();

    if (fresh !== undefined && fresh !== null) {
        try {
            const serialized = JSON.stringify(fresh);
            const ttl = Math.max(1, Number(ttlSeconds) || 60);
            await client.set(key, serialized, 'EX', ttl);
        } catch {
            metrics.errors++;
        }
    }

    return fresh;
};

exports.del = async (key) => {
    try {
        const client = getRedisClient();
        return await client.del(key);
    } catch {
        metrics.errors++;
        return 0;
    }
};

exports.delByPrefix = async (prefix) => {
    try {
        return await delByPrefix(prefix);
    } catch {
        metrics.errors++;
        return 0;
    }
};

exports.getMetrics = () => {
    const total = metrics.hits + metrics.misses;
    const hitRate = total > 0 ? Math.round((metrics.hits / total) * 100) : 0;
    return {
        hits: metrics.hits,
        misses: metrics.misses,
        errors: metrics.errors,
        hitRate,
    };
};

exports.resetMetrics = () => {
    metrics.hits = 0;
    metrics.misses = 0;
    metrics.errors = 0;
};

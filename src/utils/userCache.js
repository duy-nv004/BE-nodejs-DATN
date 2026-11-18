/**
 * Redis-backed TTL Cache cho User Profile tại Auth Middleware (fallback MemoryRedisStore khi offline).
 * Khóa cache: `auth:user:${userId}:${tokenVersion}`
 * Khi đổi mật khẩu, đăng xuất mọi thiết bị hoặc Admin khóa tài khoản:
 * tokenVersion tăng lên => tokenVersion cũ không khớp cache => Tự động miss & thu hồi ngay lập tức.
 */
const { getRedisClient, delByPrefix } = require('../config/redis');

const DEFAULT_TTL_MS = 60 * 1000; // 60 giây mặc định
const KEY_PREFIX = 'auth:user:';

const serializeUser = (user) => {
    if (!user || typeof user !== 'object') return user;
    const plain = typeof user.toJSON === 'function' ? user.toJSON() : { ...user };
    // Không cache password hash nếu lỡ có trên instance
    if ('password' in plain) delete plain.password;
    return plain;
};

exports.set = async (userId, tokenVersion, user, ttlMs = DEFAULT_TTL_MS) => {
    if (!userId && userId !== 0) return false;
    const tv = Number(tokenVersion) || 0;
    const key = `${KEY_PREFIX}${userId}:${tv}`;
    const px = ttlMs > 0 ? Math.max(1, Math.round(ttlMs)) : DEFAULT_TTL_MS;
    try {
        const client = getRedisClient();
        await client.set(key, JSON.stringify(serializeUser(user)), 'PX', px);
        return true;
    } catch {
        return false;
    }
};

exports.get = async (userId, tokenVersion) => {
    if (!userId && userId !== 0) return null;
    const tv = Number(tokenVersion) || 0;
    const key = `${KEY_PREFIX}${userId}:${tv}`;
    try {
        const client = getRedisClient();
        const raw = await client.get(key);
        if (raw === null || raw === undefined) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

exports.del = async (userId) => {
    if (!userId && userId !== 0) return 0;
    try {
        return await delByPrefix(`${KEY_PREFIX}${userId}:`);
    } catch {
        return 0;
    }
};

exports.clear = async () => {
    try {
        return await delByPrefix(KEY_PREFIX);
    } catch {
        return 0;
    }
};

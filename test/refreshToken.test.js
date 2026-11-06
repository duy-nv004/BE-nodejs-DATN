/**
 * Unit tests for Refresh Token & Single-Device Session Management (TDD RED -> GREEN)
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const User = require('../src/models/User');
const RefreshToken = require('../src/models/RefreshToken');
const { signAccessToken, signToken } = require('../src/middleware/authMiddleware');
const authService = require('../src/services/authService');
const authController = require('../src/controllers/authController');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const makeRes = () => ({
    statusCode: 200,
    headers: {},
    cookies: {},
    clearedCookies: [],
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    cookie(name, val, options) {
        this.cookies[name] = { val, options };
        return this;
    },
    clearCookie(name, options) {
        this.clearedCookies.push({ name, options });
        return this;
    }
});

describe('Token generation (signAccessToken & backward compatible signToken)', () => {
    test('signAccessToken tạo token có hạn 30 phút và chứa id + tokenVersion', () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const user = { id: 101, tokenVersion: 3 };
        const token = signAccessToken(user);
        assert.ok(token);

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        assert.equal(decoded.id, 101);
        assert.equal(decoded.tokenVersion, 3);
        // Hạn 30m = 1800 giây
        const durationSeconds = decoded.exp - decoded.iat;
        assert.equal(durationSeconds, 30 * 60);
    });

    test('signToken giữ nguyên hành vi tương thích ngược cho 419 unit tests cũ', () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const user = { id: 102, tokenVersion: 1 };
        const token = signToken(user);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        assert.equal(decoded.id, 102);
        assert.equal(decoded.tokenVersion, 1);
    });
});

describe('Single-Device Session & Refresh Token Lifecycle', () => {
    test('loginUser thu hồi mọi Refresh Token cũ với lý do new_login và tạo token mới 7 ngày', async () => {
        const user = {
            id: 200,
            password: 'hashedpassword',
            status: 'active',
            tokenVersion: 0,
            plan: 'free',
            roleData: { name: 'landlord' },
            comparePassword: async () => true
        };
        stub(User, 'findOne', async () => user);

        let updateCalls = [];
        stub(RefreshToken, 'update', async (data, where) => {
            updateCalls.push({ data, where });
            return [1];
        });

        let createdTokenRecord = null;
        stub(RefreshToken, 'create', async (data) => {
            createdTokenRecord = data;
            return { id: 1, ...data };
        });

        const result = await authService.loginUser({
            identity: 'landlord@test.com',
            password: 'password123',
            ip: '127.0.0.1',
            userAgent: 'Mozilla/5.0 Test'
        });

        // 1. Kiểm tra payload trả về
        assert.ok(result.token, 'Phải có token cho tương thích ngược');
        assert.ok(result.accessToken, 'Phải có accessToken');
        assert.ok(result.refreshToken, 'Phải có refreshToken');

        // 2. Kiểm tra thu hồi phiên cũ (Single-device policy)
        assert.equal(updateCalls.length, 1);
        assert.equal(updateCalls[0].data.isRevoked, true);
        assert.equal(updateCalls[0].data.revokedReason, 'new_login');
        assert.equal(updateCalls[0].where.where.userId, 200);
        assert.equal(updateCalls[0].where.where.isRevoked, false);

        // 3. Kiểm tra lưu hash token mới
        assert.ok(createdTokenRecord);
        assert.equal(createdTokenRecord.userId, 200);
        assert.equal(createdTokenRecord.isRevoked, false);
        // Hạn 7 ngày (+/- 10s)
        const diffDays = (createdTokenRecord.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        assert.ok(diffDays >= 6.9 && diffDays <= 7.1, `Hạn phải xấp xỉ 7 ngày, hiện tại: ${diffDays}`);
    });

    test('refreshSession xoay vòng token khi token hợp lệ', async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const rawToken = 'sample_raw_refresh_token_12345';
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        const mockRecord = {
            id: 10,
            userId: 300,
            tokenHash,
            expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // còn 5 ngày
            isRevoked: false,
            revokedReason: null,
            async save() { this.saved = true; }
        };

        stub(RefreshToken, 'findOne', async ({ where }) => {
            if (where.tokenHash === tokenHash) return mockRecord;
            return null;
        });

        stub(User, 'findByPk', async (id) => ({
            id,
            status: 'active',
            tokenVersion: 2,
            roleData: { name: 'tenant' }
        }));

        let newCreated = null;
        stub(RefreshToken, 'create', async (data) => {
            newCreated = data;
            return { id: 11, ...data };
        });

        const refreshed = await authService.refreshSession(rawToken, '127.0.0.1', 'Chrome');

        // Token cũ phải bị thu hồi với reason 'token_rotated'
        assert.equal(mockRecord.isRevoked, true);
        assert.equal(mockRecord.revokedReason, 'token_rotated');
        assert.equal(mockRecord.saved, true);

        // Cấp Access Token mới và Refresh Token mới
        assert.ok(refreshed.accessToken);
        assert.ok(refreshed.refreshToken);
        assert.notEqual(refreshed.refreshToken, rawToken, 'Refresh token mới phải khác token cũ');
        assert.ok(newCreated);
        assert.equal(newCreated.userId, 300);
    });

    test('refreshSession từ chối với 401 khi token đã bị đá bởi thiết bị khác (new_login)', async () => {
        const rawToken = 'stale_token_kicked_out';
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        stub(RefreshToken, 'findOne', async () => ({
            id: 20,
            userId: 400,
            tokenHash,
            isRevoked: true,
            revokedReason: 'new_login',
            expiresAt: new Date(Date.now() + 100000)
        }));

        await assert.rejects(
            authService.refreshSession(rawToken, '127.0.0.1', 'Mobile Safari'),
            (err) => {
                assert.equal(err.statusCode || err.status, 401);
                assert.match(err.message, /thiết bị khác/i);
                return true;
            }
        );
    });

    test('refreshSession từ chối với 401 khi token hết hạn hoặc không tìm thấy', async () => {
        stub(RefreshToken, 'findOne', async () => null);

        await assert.rejects(
            authService.refreshSession('non_existent_token', '127.0.0.1', 'Postman'),
            (err) => err.statusCode === 401 || err.status === 401
        );
    });

    test('logoutUser thu hồi token với lý do logout', async () => {
        const rawToken = 'token_to_logout';
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        let updatedData = null;
        stub(RefreshToken, 'update', async (data, where) => {
            updatedData = { data, where };
            return [1];
        });

        const res = await authService.logoutUser(rawToken);
        assert.ok(res.success);
        assert.equal(updatedData.data.isRevoked, true);
        assert.equal(updatedData.data.revokedReason, 'logout');
        assert.equal(updatedData.where.where.tokenHash, tokenHash);
    });
});

describe('Auth Controller Endpoints (Cookie handling & CORS)', () => {
    test('POST /auth/refresh-token đọc cookie refreshToken và set cookie mới', async () => {
        const req = {
            cookies: { refreshToken: 'cookie_refresh_123' },
            body: {},
            ip: '127.0.0.1',
            headers: { 'user-agent': 'Browser' }
        };
        const res = makeRes();

        stub(authService, 'refreshSession', async () => ({
            accessToken: 'new_access_token_abc',
            refreshToken: 'new_refresh_token_xyz'
        }));

        await authController.refreshToken(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.accessToken, 'new_access_token_abc');
        assert.ok(res.cookies.refreshToken);
        assert.equal(res.cookies.refreshToken.val, 'new_refresh_token_xyz');
        assert.equal(res.cookies.refreshToken.options.httpOnly, true);
        assert.equal(res.cookies.refreshToken.options.path, '/api/auth');
    });

    test('POST /auth/logout xóa cookie refreshToken', async () => {
        const req = {
            cookies: { refreshToken: 'cookie_logout_123' },
            body: {}
        };
        const res = makeRes();

        stub(authService, 'logoutUser', async () => ({ success: true }));

        await authController.logout(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.clearedCookies.length, 1);
        assert.equal(res.clearedCookies[0].name, 'refreshToken');
        assert.equal(res.clearedCookies[0].options.path, '/api/auth');
    });
});


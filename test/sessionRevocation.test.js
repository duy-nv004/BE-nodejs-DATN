/**
 * Đợt 1: thu hồi phiên khi đổi mật khẩu + không ghi cứng mật khẩu admin.
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const { protect, signToken } = require('../src/middleware/authMiddleware');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const makeRes = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
});

describe('tokenVersion', () => {
    test('token cấp trước khi đổi mật khẩu bị từ chối 401', async () => {
        const user = { id: 5, status: 'active', tokenVersion: 3 };
        stub(User, 'findByPk', async () => user);
        // Token không mang tokenVersion (cấp trước khi có tính năng) -> phải coi là phiên cũ
        const oldToken = jwt.sign({ id: 5 }, process.env.JWT_SECRET);
        const res = makeRes();
        let nextCalled = false;
        await protect({ headers: { authorization: `Bearer ${oldToken}` } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 401);
    });

    test('token có đúng tokenVersion hiện tại đi qua', async () => {
        stub(User, 'findByPk', async () => ({ id: 5, status: 'active', tokenVersion: 2, roleData: { name: 'landlord' } }));
        stub(require('../src/services/planService'), 'syncExpiredPlan', async () => ({ expired: false }));
        const token = jwt.sign({ id: 5, tokenVersion: 2 }, process.env.JWT_SECRET);
        const res = makeRes();
        let nextCalled = false;
        await protect({ headers: { authorization: `Bearer ${token}` } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        assert.equal(res.statusCode, 200);
    });

    test('tokenVersion cũ hơn DB bị từ chối 401', async () => {
        stub(User, 'findByPk', async () => ({ id: 5, status: 'active', tokenVersion: 4 }));
        const token = jwt.sign({ id: 5, tokenVersion: 3 }, process.env.JWT_SECRET);
        const res = makeRes();
        await protect({ headers: { authorization: `Bearer ${token}` } }, res, () => {});
        assert.equal(res.statusCode, 401);
    });

    test('signToken gắn tokenVersion của user vào payload', () => {
        const token = signToken({ id: 5, tokenVersion: 7 });
        assert.equal(jwt.verify(token, process.env.JWT_SECRET).tokenVersion, 7);
    });
});

describe('đổi mật khẩu tăng tokenVersion', () => {
    test('changePassword lưu tokenVersion + 1', async () => {
        const authService = require('../src/services/authService');
        const hash = await bcrypt.hash('oldpass', 4);
        const user = { id: 5, password: hash, tokenVersion: 0, async comparePassword(p) { return bcrypt.compare(p, this.password); }, async save() { this.saved = true; } };
        stub(User, 'findByPk', async () => user);
        await authService.changePassword(5, { currentPassword: 'oldpass', newPassword: 'newpass1' });
        assert.equal(user.tokenVersion, 1);
        assert.equal(user.saved, true);
    });
});

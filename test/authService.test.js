/**
 * Unit test đổi mật khẩu (src/services/authService.js) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const service = require('../src/services/authService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

describe('changePassword', () => {
    test('từ chối mật khẩu mới dưới 6 ký tự với 400', async () => {
        let saved = false;
        stub(User, 'findByPk', async () => ({ comparePassword: async () => true, save: async () => { saved = true; } }));
        await assert.rejects(
            service.changePassword(1, { currentPassword: 'admin', newPassword: '123' }),
            (e) => e.statusCode === 400 || e.status === 400
        );
        assert.equal(saved, false);
    });

    test('mật khẩu mới đủ 6 ký tự thì lưu', async () => {
        let saved = false;
        stub(User, 'findByPk', async () => ({ comparePassword: async () => true, save: async () => { saved = true; } }));
        const res = await service.changePassword(1, { currentPassword: 'admin', newPassword: '123456' });
        assert.equal(saved, true);
        assert.match(res.message, /thành công/);
    });

    test('T1.15: changePassword xóa telegramLinkToken và telegramLinkTokenExpiresAt', async () => {
        const user = {
            id: 1,
            tokenVersion: 2,
            telegramLinkToken: 'abc123token',
            telegramLinkTokenExpiresAt: new Date(),
            comparePassword: async () => true,
            async save() { this.saved = true; }
        };
        stub(User, 'findByPk', async () => user);
        await service.changePassword(1, { currentPassword: 'admin', newPassword: '123456' });
        assert.equal(user.tokenVersion, 3);
        assert.equal(user.telegramLinkToken, null);
        assert.equal(user.telegramLinkTokenExpiresAt, null);
        assert.equal(user.saved, true);
    });

    test('User model hook beforeUpdate và beforeCreate hash mật khẩu và chống double-hash', async () => {
        assert.ok(User.options?.hooks?.beforeCreate, 'Phải có hook beforeCreate');
        assert.ok(User.options?.hooks?.beforeUpdate, 'Phải có hook beforeUpdate');

        const mockUserNew = { password: 'plainPassword123' };
        await User.runHooks('beforeCreate', mockUserNew);
        assert.ok(mockUserNew.password.startsWith('$2'), 'beforeCreate phải hash mật khẩu thường');

        const alreadyHashed = mockUserNew.password;
        await User.runHooks('beforeCreate', mockUserNew);
        assert.equal(mockUserNew.password, alreadyHashed, 'beforeCreate không được băm lại mật khẩu đã là bcrypt hash');

        const mockUserUpdate = {
            password: 'updatedPassword456',
            changed: (field) => field === 'password'
        };
        await User.runHooks('beforeUpdate', mockUserUpdate);
        assert.ok(mockUserUpdate.password.startsWith('$2'), 'beforeUpdate phải hash mật khẩu khi đổi');

        const alreadyHashedUpdate = mockUserUpdate.password;
        await User.runHooks('beforeUpdate', mockUserUpdate);
        assert.equal(mockUserUpdate.password, alreadyHashedUpdate, 'beforeUpdate không được băm lại mật khẩu đã là bcrypt hash');
    });
});

describe('updateProfile: không còn tài khoản nhận tiền riêng của chủ nhà & validate email/phone (T2.20)', () => {
    test('bỏ qua bankId/bankAccount/bankAccountName gửi lên', async () => {
        const u = { id: 1, name: 'A', async save() { this.saved = true; } };
        stub(User, 'findByPk', async () => u);
        const res = await service.updateProfile(1, { name: 'B', bankId: 'VCB', bankAccount: '0123456789', bankAccountName: 'X' });
        assert.equal(u.saved, true);
        assert.equal(u.name, 'B');
        assert.equal(u.bankAccount, undefined);
        assert.equal(res.bankAccount, undefined);
    });

    test('T2.20: từ chối email hoặc số điện thoại sai định dạng với 400', async () => {
        const u = { id: 1, name: 'A', email: 'old@x.com', phone: '0912345678', async save() { this.saved = true; } };
        stub(User, 'findByPk', async () => u);
        await assert.rejects(
            service.updateProfile(1, { email: 'invalid-email' }),
            (e) => e.statusCode === 400
        );
        await assert.rejects(
            service.updateProfile(1, { phone: '12345' }),
            (e) => e.statusCode === 400
        );
        assert.equal(u.saved, undefined);
    });
});

describe('T2.12/T3.7: cancelUpgradeRequest trong authController', () => {
    const PlanUpgradeRequest = require('../src/models/PlanUpgradeRequest');
    const authController = require('../src/controllers/authController');

    test('hủy yêu cầu pending của chính chủ nhà -> status cancelled (200)', async () => {
        const reqRecord = {
            id: 15,
            landlordId: 3,
            status: 'pending',
            async save() { this.saved = true; }
        };
        stub(PlanUpgradeRequest, 'findOne', async () => reqRecord);
        const res = {
            statusCode: 200,
            body: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; }
        };
        await authController.cancelUpgradeRequest({ user: { id: 3 }, params: { id: '15' } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(reqRecord.status, 'cancelled');
        assert.equal(reqRecord.saved, true);
    });

    test('không tìm thấy yêu cầu pending -> 404', async () => {
        stub(PlanUpgradeRequest, 'findOne', async () => null);
        const res = {
            statusCode: 200,
            body: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; }
        };
        await authController.cancelUpgradeRequest({ user: { id: 3 }, params: { id: '99' } }, res);
        assert.equal(res.statusCode, 404);
    });
});

describe('E3: registerLandlord trả cùng dạng payload với loginUser', () => {
    test('có token, role landlord và thông tin user', async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        const Role = require('../src/models/Role');
        stub(User, 'findOne', async () => null);
        stub(Role, 'findOne', async () => ({ id: 2, name: 'landlord' }));
        stub(User, 'create', async (d) => ({ id: 11, phone: null, plan: 'free', planExpiresAt: null, cccd: null, dob: null, hometown: null, ...d }));
        const res = await service.registerLandlord({ email: 'n@x.com', password: '123456', name: 'Chủ Mới' });
        assert.ok(res.token);
        assert.deepEqual(
            Object.keys(res).filter(k => k !== 'message').sort(),
            ['cccd', 'dob', 'email', 'hometown', 'id', 'name', 'phone', 'plan', 'planExpiresAt', 'role', 'token']
        );
        assert.equal(res.role, 'landlord');
        assert.equal(res.id, 11);
        assert.equal(res.email, 'n@x.com');
        assert.equal(res.name, 'Chủ Mới');
        assert.equal(res.plan, 'free');
    });
});

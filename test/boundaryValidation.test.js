/**
 * T2.20: validate ở biên cho register/createTenant/updateTenant/appeal + map lỗi Sequelize ở controller.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const authService = require('../src/services/authService');
const buildingService = require('../src/services/buildingService');
const adminService = require('../src/services/adminService');
const buildingController = require('../src/controllers/buildingController');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const is400 = (e) => e.statusCode === 400;

describe('registerLandlord validate biên', () => {
    test('email sai định dạng -> 400, không chạm DB', async () => {
        let queried = false;
        stub(User, 'findOne', async () => { queried = true; return null; });
        await assert.rejects(authService.registerLandlord({ email: 'abc', password: '123456' }), is400);
        assert.equal(queried, false);
    });

    test('mật khẩu dưới 6 ký tự -> 400', async () => {
        stub(User, 'findOne', async () => null);
        await assert.rejects(authService.registerLandlord({ email: 'a@x.com', password: '123' }), is400);
    });
});

describe('createTenant validate biên', () => {
    test('SĐT có khoảng trắng được chuẩn hóa trước khi kiểm trùng và lưu', async () => {
        let checkedPhone = null; let createdPhone = null;
        stub(User, 'findOne', async (o) => { checkedPhone = o.where.phone; return null; });
        stub(Role, 'findOne', async () => ({ id: 3 }));
        stub(User, 'create', async (d) => { createdPhone = d.phone; return { id: 9 }; });
        await authService.createTenant(1, { phone: '0912 345 678', password: '123456', name: 'An' });
        assert.equal(checkedPhone, '0912345678');
        assert.equal(createdPhone, '0912345678');
    });

    test('SĐT sai định dạng -> 400', async () => {
        stub(User, 'findOne', async () => null);
        await assert.rejects(authService.createTenant(1, { phone: '12345', password: '123456', name: 'An' }), is400);
    });

    test('mật khẩu dưới 6 ký tự -> 400', async () => {
        stub(User, 'findOne', async () => null);
        await assert.rejects(authService.createTenant(1, { phone: '0912345678', password: '1', name: 'An' }), is400);
    });
});

describe('updateTenant validate biên', () => {
    const tenant = () => ({ id: 7, phone: '0900000000', email: null, saved: 0, async save() { this.saved++; } });

    test('SĐT sai định dạng -> 400, không lưu', async () => {
        const t = tenant();
        stub(User, 'findOne', async (o) => (o.where.ownerId ? t : null));
        await assert.rejects(buildingService.updateTenant(1, 7, { phone: 'abc' }), is400);
        assert.equal(t.saved, 0);
    });

    test('email sai định dạng -> 400', async () => {
        const t = tenant();
        stub(User, 'findOne', async (o) => (o.where.ownerId ? t : null));
        await assert.rejects(buildingService.updateTenant(1, 7, { email: 'x@' }), is400);
    });

    test('SĐT +84 được chuẩn hóa khi lưu', async () => {
        const t = tenant();
        stub(User, 'findOne', async (o) => (o.where.ownerId ? t : null));
        await buildingService.updateTenant(1, 7, { phone: '+84912345678' });
        assert.equal(t.phone, '0912345678');
    });
});

describe('createLandlordTicket validate biên', () => {
    test('email sai định dạng -> 400', async () => {
        await assert.rejects(adminService.createLandlordTicket('khong-phai-email', 'T', 'N'), is400);
    });
});

describe('controller dùng sendError', () => {
    test('updateTenant gặp SequelizeUniqueConstraintError -> 400 tiếng Việt', async () => {
        stub(buildingService, 'updateTenant', async () => {
            const e = new Error('Validation error'); e.name = 'SequelizeUniqueConstraintError'; throw e;
        });
        const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        await buildingController.updateTenant({ user: { id: 1 }, params: { id: '7' }, body: {} }, res);
        assert.equal(res.code, 400);
        assert.notEqual(res.body.message, 'Validation error');
    });
});

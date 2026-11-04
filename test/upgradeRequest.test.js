/**
 * Unit test vòng đời yêu cầu nâng cấp gói cước (T1.16 & T2.12)
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const PlanUpgradeRequest = require('../src/models/PlanUpgradeRequest');
const User = require('../src/models/User');
const AdminLog = require('../src/models/AdminLog');
const sequelize = require('../src/config/db');
const planService = require('../src/services/planService');
const adminService = require('../src/services/adminService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

describe('Vòng đời PlanUpgradeRequest (T1.16 & T2.12)', () => {
    test('createOrReuseUpgradeRequest: hủy pending khác gói/chu kỳ và tái sử dụng pending còn hạn (< 48h)', async () => {
        const now = new Date('2026-05-10T10:00:00.000Z');
        const updates = [];
        const existing = {
            id: 15,
            landlordId: 5,
            planName: 'pro',
            billingCycle: 'annual',
            amount: 1920000,
            transferCode: 'PLAN 5 PRO YEAR',
            status: 'pending',
            createdAt: new Date(now.getTime() - 2 * 3600 * 1000), // mới tạo 2 giờ trước
        };

        stub(PlanUpgradeRequest, 'update', async (values, opts) => {
            updates.push({ values, opts });
            return [1];
        });
        stub(PlanUpgradeRequest, 'findOne', async () => existing);

        const req = await planService.createOrReuseUpgradeRequest({
            landlordId: 5,
            plan: { name: 'pro', price: 200000, annualPrice: 1920000 },
            billingCycle: 'annual',
            now,
        });

        assert.equal(req.id, 15);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].values.status, 'cancelled');
    });

    test('createOrReuseUpgradeRequest: nếu pending cũ đã quá 48h thì chuyển sang expired và tạo mới', async () => {
        const now = new Date('2026-05-10T10:00:00.000Z');
        const stale = {
            id: 11,
            landlordId: 5,
            planName: 'pro',
            billingCycle: 'monthly',
            amount: 200000,
            transferCode: 'PLAN 5 PRO',
            status: 'pending',
            createdAt: new Date(now.getTime() - 50 * 3600 * 1000), // 50 giờ trước (> 48h)
            async save() { this.saved = true; }
        };

        stub(PlanUpgradeRequest, 'update', async () => [0]);
        stub(PlanUpgradeRequest, 'findOne', async () => stale);
        stub(PlanUpgradeRequest, 'create', async (data) => ({ id: 99, ...data }));

        const fresh = await planService.createOrReuseUpgradeRequest({
            landlordId: 5,
            plan: { name: 'pro', price: 200000, annualPrice: 1920000 },
            billingCycle: 'monthly',
            now,
        });

        assert.equal(stale.status, 'expired');
        assert.equal(fresh.id, 99);
        assert.equal(fresh.status, 'pending');
    });

    test('cancelUpgradeRequest: chủ nhà hủy yêu cầu pending của chính mình -> chuyển sang cancelled', async () => {
        const req = {
            id: 21,
            landlordId: 5,
            planName: 'basic',
            status: 'pending',
            async save() { this.saved = true; }
        };
        stub(PlanUpgradeRequest, 'findByPk', async () => req);

        const res = await planService.cancelUpgradeRequest(21, 5);
        assert.equal(res.status, 'cancelled');
        assert.equal(req.saved, true);
    });

    test('cancelUpgradeRequest: chặn hủy nếu yêu cầu của chủ nhà khác hoặc không còn pending', async () => {
        stub(PlanUpgradeRequest, 'findByPk', async () => ({ id: 21, landlordId: 8, status: 'pending' }));
        await assert.rejects(planService.cancelUpgradeRequest(21, 5), (err) => err.statusCode === 404 || err.statusCode === 403);

        stub(PlanUpgradeRequest, 'findByPk', async () => ({ id: 21, landlordId: 5, status: 'paid' }));
        await assert.rejects(planService.cancelUpgradeRequest(21, 5), (err) => err.statusCode === 400);
    });

    test('updateLandlordPlan của Admin tự động hủy mọi PlanUpgradeRequest pending trong cùng transaction', async () => {
        const tx = { LOCK: { UPDATE: 'UPDATE' } };
        let cancelledWhere = null;
        let cancelledTx = null;
        const landlord = {
            id: 5,
            name: 'Chủ A',
            email: 'a@x.com',
            plan: 'free',
            planExpiresAt: null,
            roleData: { name: 'landlord' },
            async save() {}
        };

        stub(sequelize, 'transaction', async (fn) => fn(tx));
        stub(User, 'findByPk', async () => landlord);
        stub(PlanUpgradeRequest, 'update', async (values, opts) => {
            if (values.status === 'cancelled') {
                cancelledWhere = opts.where;
                cancelledTx = opts.transaction;
            }
            return [2];
        });
        const logs = [];
        stub(AdminLog, 'create', async (d) => { logs.push(d); return d; });

        await adminService.updateLandlordPlan(5, 'pro', 99, 'annual');

        assert.deepEqual(cancelledWhere, { landlordId: 5, status: 'pending' });
        assert.equal(cancelledTx, tx);
        assert.equal(landlord.billingCycle, 'annual');
        assert.equal(landlord.planSource, 'admin');
        assert.equal(logs.length, 1);
    });
});

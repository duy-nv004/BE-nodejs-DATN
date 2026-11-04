/**
 * Unit test cho planService.js (T1.17 & T2.12) — kiểm thử múi giờ Việt Nam (Asia/Ho_Chi_Minh),
 * đồng bộ hạn gói, quét hạ gói quá hạn và hết hạn yêu cầu nâng cấp sau 48 giờ.
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const PlanUpgradeRequest = require('../src/models/PlanUpgradeRequest');
const notificationService = require('../src/services/notificationService');
const { todayVN, isExpiredVN, daysRemainingVN, addPlanDaysVN } = require('../src/utils/dateVN');
const planService = require('../src/services/planService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

describe('dateVN helper (Asia/Ho_Chi_Minh)', () => {
    test('todayVN lấy đúng ngày theo giờ Việt Nam khi UTC đang ở ngày hôm trước (18:30 UTC = 01:30+1 VN)', () => {
        const ref = new Date('2026-05-10T18:30:00.000Z'); // 01:30 sáng 11/05/2026 giờ VN
        assert.equal(todayVN(ref), '2026-05-11');
        assert.equal(isExpiredVN('2026-05-10', ref), true);
        assert.equal(isExpiredVN('2026-05-11', ref), false);
        assert.equal(isExpiredVN('2026-05-12', ref), false);
        assert.equal(daysRemainingVN('2026-05-11', ref), 0);
        assert.equal(daysRemainingVN('2026-05-21', ref), 10);
        assert.equal(addPlanDaysVN('2026-05-11', 30, ref), '2026-06-10');
    });
});

describe('syncExpiredPlan (T1.17)', () => {
    const refNow = new Date('2026-05-10T18:30:00.000Z'); // todayVN = '2026-05-11'

    test('hết hạn hôm qua (2026-05-10) theo giờ VN -> hạ về free, xóa planExpiresAt và billingCycle', async () => {
        let saved = 0;
        const user = {
            id: 10,
            plan: 'pro',
            planExpiresAt: '2026-05-10',
            billingCycle: 'annual',
            planSource: 'sepay',
            async save() { saved++; }
        };

        const res = await planService.syncExpiredPlan(user, refNow);
        assert.deepEqual(res, { expired: true, oldPlan: 'pro' });
        assert.equal(user.plan, 'free');
        assert.equal(user.planExpiresAt, null);
        assert.equal(user.billingCycle, null);
        assert.equal(user.planSource, null);
        assert.equal(saved, 1);
    });

    test('hết hạn hôm nay (2026-05-11) theo giờ VN -> vẫn còn hiệu lực hết ngày hôm nay', async () => {
        let saved = 0;
        const user = {
            id: 10,
            plan: 'basic',
            planExpiresAt: '2026-05-11',
            billingCycle: 'monthly',
            async save() { saved++; }
        };

        const res = await planService.syncExpiredPlan(user, refNow);
        assert.deepEqual(res, { expired: false });
        assert.equal(user.plan, 'basic');
        assert.equal(saved, 0);
    });

    test('hết hạn ngày mai (2026-05-12) theo giờ VN -> không hạ gói', async () => {
        let saved = 0;
        const user = {
            id: 10,
            plan: 'pro',
            planExpiresAt: '2026-05-12',
            async save() { saved++; }
        };

        const res = await planService.syncExpiredPlan(user, refNow);
        assert.deepEqual(res, { expired: false });
        assert.equal(user.plan, 'pro');
        assert.equal(saved, 0);
    });
});

describe('expireAllOverduePlans (T1.17)', () => {
    test('tìm user quá hạn theo todayVN, hạ về free, xóa billingCycle và gửi thông báo cho từng user', async () => {
        const refNow = new Date('2026-05-10T18:30:00.000Z'); // todayVN = '2026-05-11'
        const overdueUsers = [
            { id: 1, name: 'Chủ A', email: 'a@x.com', plan: 'basic', planExpiresAt: '2026-05-10' },
            { id: 2, name: 'Chủ B', email: 'b@x.com', plan: 'pro', planExpiresAt: '2026-05-09' }
        ];
        let updateArgs = null;
        const notifications = [];

        stub(User, 'findAll', async () => overdueUsers);
        stub(User, 'update', async (values, options) => {
            updateArgs = { values, options };
            return [overdueUsers.length];
        });
        stub(notificationService, 'createNotification', async (...args) => {
            notifications.push(args);
        });

        const res = await planService.expireAllOverduePlans(refNow);

        assert.equal(res.updatedCount, 2);
        assert.equal(res.expiredUsers.length, 2);
        assert.ok(res > 0);
        assert.equal(updateArgs.values.plan, 'free');
        assert.equal(updateArgs.values.planExpiresAt, null);
        assert.equal(updateArgs.values.billingCycle, null);
        assert.equal(notifications.length, 2);
        assert.equal(notifications[0][0], 1);
        assert.equal(notifications[1][0], 2);
    });
});

describe('expirePendingUpgradeRequests (T2.12)', () => {
    test('chuyển các yêu cầu pending quá 48 giờ sang expired', async () => {
        const refNow = new Date('2026-05-10T12:00:00.000Z');
        let captured = null;
        stub(PlanUpgradeRequest, 'update', async (values, options) => {
            captured = { values, options };
            return [3];
        });

        const count = await planService.expirePendingUpgradeRequests(refNow);
        assert.equal(count, 3);
        assert.equal(captured.values.status, 'expired');
        assert.equal(captured.options.where.status, 'pending');
        const { Op } = require('sequelize');
        const cutoff = captured.options.where.createdAt[Op.lt];
        assert.ok(cutoff instanceof Date);
        assert.equal(refNow.getTime() - cutoff.getTime(), 48 * 60 * 60 * 1000);
    });
});

/**
 * Unit test giới hạn gói & hạn mức AI (src/middleware/checkLimit.js & src/routes/aiRoutes.js)
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Building = require('../src/models/Building');
const Room = require('../src/models/Room');
const Plan = require('../src/models/Plan');
const User = require('../src/models/User');
const {
    assertBuildingLimit,
    assertRoomLimit,
    checkAILimit,
    consumeAILimit
} = require('../src/middleware/checkLimit');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const makeRes = () => ({
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
});

describe('assertBuildingLimit & assertRoomLimit (T1.9)', () => {
    test('chưa đạt giới hạn tòa nhà/phòng -> cho phép và truyền transaction', async () => {
        const fakeTx = { id: 'tx-1' };
        let bCountOpts = null;
        let rCountOpts = null;
        stub(Plan, 'findOne', async () => ({ name: 'basic', maxBuildings: 2, maxRoomsPerBuilding: 10 }));
        stub(Building, 'count', async (opts) => { bCountOpts = opts; return 1; });
        stub(Room, 'count', async (opts) => { rCountOpts = opts; return 5; });

        await assertBuildingLimit({ id: 1, plan: 'basic' }, { transaction: fakeTx });
        await assertRoomLimit({ id: 1, plan: 'basic' }, 10, { transaction: fakeTx });

        assert.equal(bCountOpts.transaction, fakeTx);
        assert.equal(rCountOpts.transaction, fakeTx);
    });

    test('đạt giới hạn tòa nhà/phòng -> ném 403', async () => {
        stub(Plan, 'findOne', async () => ({ name: 'free', maxBuildings: 1, maxRoomsPerBuilding: 5 }));
        stub(Building, 'count', async () => 1);
        stub(Room, 'count', async () => 5);

        await assert.rejects(
            () => assertBuildingLimit({ id: 1, plan: 'free' }),
            (e) => e.statusCode === 403
        );
        await assert.rejects(
            () => assertRoomLimit({ id: 1, plan: 'free' }, 10),
            (e) => e.statusCode === 403
        );
    });

    test('gói không giới hạn (-1) -> luôn cho phép tạo tòa nhà và phòng', async () => {
        stub(Plan, 'findOne', async () => ({ name: 'pro', maxBuildings: -1, maxRoomsPerBuilding: -1 }));
        stub(Building, 'count', async () => 999);
        stub(Room, 'count', async () => 999);

        await assert.doesNotReject(() => assertBuildingLimit({ id: 1, plan: 'pro' }));
        await assert.doesNotReject(() => assertRoomLimit({ id: 1, plan: 'pro' }, 10));
    });
});

describe('checkAILimit & consumeAILimit (T1.13)', () => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    test('gói không có AI (maxAICallsPerMonth = 0) -> chặn 403', async () => {
        stub(Plan, 'findOne', async () => ({ name: 'free', maxAICallsPerMonth: 0 }));
        const res = makeRes();
        let nexted = false;
        await checkAILimit({ user: { id: 1, plan: 'free' } }, res, () => { nexted = true; });
        assert.equal(nexted, false);
        assert.equal(res.statusCode, 403);
    });

    test('gói không giới hạn AI (maxAICallsPerMonth = -1) -> cho qua', async () => {
        stub(Plan, 'findOne', async () => ({ name: 'pro', maxAICallsPerMonth: -1 }));
        const res = makeRes();
        let nexted = false;
        await checkAILimit({ user: { id: 1, plan: 'pro', aiUseCountThisMonth: 500, lastAiUseMonth: currentMonth } }, res, () => { nexted = true; });
        assert.equal(nexted, true);
    });

    test('sang tháng mới tự coi số lượt đã dùng là 0 và reset về 1 khi consume', async () => {
        stub(Plan, 'findOne', async () => ({ name: 'basic', maxAICallsPerMonth: 20 }));
        const userObj = {
            id: 1,
            plan: 'basic',
            aiUseCountThisMonth: 20,
            lastAiUseMonth: '2020-01',
            async save() { this.saved = true; }
        };
        const res = makeRes();
        let nexted = false;
        await checkAILimit({ user: userObj }, res, () => { nexted = true; });
        assert.equal(nexted, true);

        stub(User, 'findByPk', async () => userObj);
        stub(User, 'update', async (vals) => {
            if (vals.lastAiUseMonth) userObj.lastAiUseMonth = vals.lastAiUseMonth;
            if (typeof vals.aiUseCountThisMonth === 'number') userObj.aiUseCountThisMonth = vals.aiUseCountThisMonth;
            return [1];
        });
        await consumeAILimit(1);
        assert.equal(userObj.lastAiUseMonth, currentMonth);
        assert.equal(userObj.aiUseCountThisMonth, 1);
    });

    test('gọi song song Promise.all không vượt hạn mức và tăng nguyên tử', async () => {
        const maxCalls = 3;
        const state = {
            id: 1,
            plan: 'basic',
            aiUseCountThisMonth: 0,
            lastAiUseMonth: currentMonth
        };
        stub(Plan, 'findOne', async () => ({ name: 'basic', maxAICallsPerMonth: maxCalls }));
        stub(User, 'findByPk', async () => ({
            ...state,
            async save() {
                state.aiUseCountThisMonth = this.aiUseCountThisMonth;
                state.lastAiUseMonth = this.lastAiUseMonth;
            }
        }));
        stub(User, 'update', async (vals) => {
            if (state.lastAiUseMonth !== currentMonth) {
                state.lastAiUseMonth = currentMonth;
                state.aiUseCountThisMonth = 1;
                return [1];
            }
            if (state.aiUseCountThisMonth >= maxCalls) {
                return [0];
            }
            state.aiUseCountThisMonth += 1;
            return [1];
        });

        await Promise.all([
            consumeAILimit(1),
            consumeAILimit(1),
            consumeAILimit(1),
            consumeAILimit(1),
            consumeAILimit(1)
        ]);
        assert.equal(state.aiUseCountThisMonth, maxCalls);
    });

    test('aiRoutes có áp dụng express-rate-limit', () => {
        const src = fs.readFileSync(path.join(__dirname, '../src/routes/aiRoutes.js'), 'utf8');
        assert.match(src, /rateLimit/);
    });
});

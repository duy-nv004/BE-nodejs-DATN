/**
 * Unit test dịch vụ admin (src/services/adminService.js) — stub model, không cần DB.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Plan = require('../src/models/Plan');
const AdminLog = require('../src/models/AdminLog');
const service = require('../src/services/adminService');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const makePlan = (over = {}) => ({
    id: 2, name: 'basic', price: '725000.00', annualPrice: '7250000.00',
    maxBuildings: 5, maxRoomsPerBuilding: 20, maxAICallsPerMonth: 30,
    saved: 0, async save() { this.saved++; }, ...over
});

const setup = (plan) => {
    const logs = [];
    stub(Plan, 'findByPk', async () => plan);
    stub(AdminLog, 'create', async (data) => { logs.push(data); return data; });
    return logs;
};

const rejects400 = (p) => assert.rejects(p, (err) => err.statusCode === 400);

describe('updatePlan', () => {
    test('gói Free đặt giá > 0 bị chặn 400', async () => {
        const plan = makePlan({ id: 1, name: 'free', price: '0.00', annualPrice: '0.00' });
        setup(plan);
        await rejects400(service.updatePlan(1, { price: 1000 }, 9));
        assert.equal(plan.saved, 0);
    });

    test('maxBuildings = 0 bị chặn 400', async () => {
        setup(makePlan());
        await rejects400(service.updatePlan(2, { maxBuildings: 0 }, 9));
    });

    test('maxAICallsPerMonth = -2 bị chặn 400', async () => {
        setup(makePlan());
        await rejects400(service.updatePlan(2, { maxAICallsPerMonth: -2 }, 9));
    });

    test('giá âm, số lẻ hoặc không phải số bị chặn 400', async () => {
        setup(makePlan());
        await rejects400(service.updatePlan(2, { price: -1 }, 9));
        await rejects400(service.updatePlan(2, { annualPrice: 1.5 }, 9));
        await rejects400(service.updatePlan(2, { price: 'abc' }, 9));
    });

    test('gói trả phí đặt giá tháng 0đ bị chặn 400', async () => {
        setup(makePlan());
        await rejects400(service.updatePlan(2, { price: 0 }, 9));
    });

    test('cập nhật hợp lệ ghi AdminLog đúng một lần, có giá cũ→mới', async () => {
        const plan = makePlan();
        const logs = setup(plan);
        await service.updatePlan(2, { price: 799000, annualPrice: 7250000, maxBuildings: 6 }, 9);
        assert.equal(plan.saved, 1);
        assert.equal(plan.price, 799000);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].action, 'UPDATE_PLAN_CONFIG');
        assert.equal(logs[0].adminId, 9);
        assert.equal(logs[0].targetUserId, null);
        assert.match(logs[0].description, /725000→799000/);
        assert.match(logs[0].description, /maxBuildings 5→6/);
        assert.doesNotMatch(logs[0].description, /annualPrice/);
    });

    test('dữ liệu không đổi thì không ghi log', async () => {
        const logs = setup(makePlan());
        await service.updatePlan(2, { price: 725000, annualPrice: '7250000', maxBuildings: 5 }, 9);
        assert.equal(logs.length, 0);
    });
});

// ─── A2 + A7: khóa / mở khóa chủ nhà ────────────────────────────────────────────
const User = require('../src/models/User');
const Contract = require('../src/models/Contract');
const emailService = require('../src/services/emailService');
const notificationService = require('../src/services/notificationService');

const makeLandlord = (over = {}) => ({
    id: 3, name: 'Chủ A', email: 'a@x.com', status: 'active', password: 'old-hash', lockReason: null,
    roleData: { name: 'landlord' }, saved: 0, async save() { this.saved++; }, ...over
});

const setupStatus = (landlord, { contracts = [], emailOk = true, notifyFn } = {}) => {
    const logs = [], emails = [], notes = [];
    stub(User, 'findByPk', async () => landlord);
    stub(AdminLog, 'create', async (data) => { logs.push(data); return data; });
    stub(emailService, 'sendNewPasswordEmail', async (...args) => { emails.push(args); return emailOk; });
    stub(Contract, 'findAll', async () => contracts);
    stub(notificationService, 'createNotification', notifyFn || (async (...args) => { notes.push(args); }));
    return { logs, emails, notes };
};

describe('updateLandlordStatus', () => {
    test('khóa không có lý do (hoặc < 5 ký tự) bị chặn 400', async () => {
        const l = makeLandlord();
        setupStatus(l);
        await rejects400(service.updateLandlordStatus(3, 'locked', 9));
        await rejects400(service.updateLandlordStatus(3, 'locked', 9, { reason: '  ab ' }));
        assert.equal(l.saved, 0);
    });

    test('khóa có lý do thì gán lockReason, tăng tokenVersion, xóa telegramLinkToken và log chứa lý do', async () => {
        const l = makeLandlord({ tokenVersion: 2, telegramLinkToken: 'tok-123', telegramLinkTokenExpiresAt: new Date() });
        const { logs } = setupStatus(l);
        await service.updateLandlordStatus(3, 'locked', 9, { reason: '  Vi phạm điều khoản ' });
        assert.equal(l.status, 'locked');
        assert.equal(l.lockReason, 'Vi phạm điều khoản');
        assert.equal(l.tokenVersion, 3);
        assert.equal(l.telegramLinkToken, null);
        assert.equal(l.telegramLinkTokenExpiresAt, null);
        assert.match(logs[0].description, /Vi phạm điều khoản/);
    });

    test('mở khóa mặc định không gửi email, không đổi mật khẩu, xóa lockReason', async () => {
        const l = makeLandlord({ status: 'locked', lockReason: 'x lý do' });
        const { emails } = setupStatus(l);
        const res = await service.updateLandlordStatus(3, 'active', 9);
        assert.equal(emails.length, 0);
        assert.equal(l.password, 'old-hash');
        assert.equal(l.lockReason, null);
        assert.equal(l.status, 'active');
        assert.doesNotMatch(res.message, /đã được gửi/);
    });

    test('mở khóa + resetPassword mà email lỗi thì 502, không save', async () => {
        const l = makeLandlord({ status: 'locked' });
        setupStatus(l, { emailOk: false });
        await assert.rejects(service.updateLandlordStatus(3, 'active', 9, { resetPassword: true }),
            (err) => err.statusCode === 502);
        assert.equal(l.saved, 0);
        assert.equal(l.password, 'old-hash');
    });

    test('mở khóa + resetPassword mà email ok thì đổi mật khẩu, xóa telegramLinkToken, message "đã được gửi"', async () => {
        const l = makeLandlord({ status: 'locked', tokenVersion: 1, telegramLinkToken: 'tok-abc', telegramLinkTokenExpiresAt: new Date() });
        const { emails } = setupStatus(l);
        const res = await service.updateLandlordStatus(3, 'active', 9, { resetPassword: true });
        assert.equal(emails.length, 1);
        assert.equal(emails[0][2].length, 10);
        assert.notEqual(l.password, 'old-hash');
        assert.equal(l.tokenVersion, 2);
        assert.equal(l.telegramLinkToken, null);
        assert.equal(l.telegramLinkTokenExpiresAt, null);
        assert.equal(l.saved, 1);
        assert.match(res.message, /đã được gửi/);
    });

    test('A7: khóa thì báo cho từng khách thuê (bỏ trùng)', async () => {
        const l = makeLandlord();
        const { notes } = setupStatus(l, { contracts: [{ tenantId: 5 }, { tenantId: 5 }, { tenantId: 6 }] });
        await service.updateLandlordStatus(3, 'locked', 9, { reason: 'Vi phạm điều khoản' });
        assert.deepEqual(notes.map(n => n[0]).sort(), [5, 6]);
        assert.equal(notes[0][3], 'landlord_status');
        assert.equal(notes[0][4], 3);
    });

    test('A7: gửi thông báo lỗi thì thao tác khóa vẫn thành công', async () => {
        const l = makeLandlord();
        setupStatus(l, { contracts: [{ tenantId: 5 }], notifyFn: async () => { throw new Error('boom'); } });
        await service.updateLandlordStatus(3, 'locked', 9, { reason: 'Vi phạm điều khoản' });
        assert.equal(l.saved, 1);
    });
});

// ─── A1 + T1.16 + T1.17 + T2.10: đổi gói chủ nhà & thống kê MRR ────────────────
const PlanUpgradeRequest = require('../src/models/PlanUpgradeRequest');
const Role = require('../src/models/Role');
const SePayEvent = require('../src/models/SePayEvent');
const sequelize = require('../src/config/db');
const { addPlanDaysVN, todayVN } = require('../src/utils/dateVN');

describe('updateLandlordPlan', () => {
    const isoIn = (days) => addPlanDaysVN(todayVN(), days);
    const setupPlan = (over) => {
        const l = makeLandlord(over);
        stub(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
        stub(User, 'findByPk', async () => l);
        stub(PlanUpgradeRequest, 'update', async () => [0]);
        stub(Plan, 'findAll', async () => [
            { name: 'basic', price: 100000, annualPrice: 960000 },
            { name: 'pro', price: 200000, annualPrice: 1920000 },
        ]);
        stub(AdminLog, 'create', async (d) => d);
        return l;
    };

    test('free -> free bị chặn 400', async () => {
        const l = setupPlan({ plan: 'free', planExpiresAt: null });
        await rejects400(service.updateLandlordPlan(3, 'free', 9));
        assert.equal(l.saved, 0);
    });

    test('E4: basic (còn 10 ngày) -> basic: gia hạn nối tiếp = 10 + 30 ngày', async () => {
        const l = setupPlan({ plan: 'basic', planExpiresAt: isoIn(10) });
        await service.updateLandlordPlan(3, 'basic', 9);
        assert.equal(l.saved, 1);
        assert.equal(l.planExpiresAt, isoIn(40));
        assert.equal(l.billingCycle, 'monthly');
        assert.equal(l.planSource, 'admin');
    });

    test('E4: basic (đã hết hạn) -> basic: hạn = hôm nay + 30', async () => {
        const l = setupPlan({ plan: 'basic', planExpiresAt: isoIn(-3) });
        await service.updateLandlordPlan(3, 'basic', 9);
        assert.equal(l.planExpiresAt, isoIn(30));
    });

    test('E4 + T1.16: basic (còn 10 ngày) -> pro: quy đổi 10 ngày basic (100k) sang 5 ngày pro (200k) + 30 ngày = 35 ngày', async () => {
        const l = setupPlan({ plan: 'basic', planExpiresAt: isoIn(10) });
        await service.updateLandlordPlan(3, 'pro', 9);
        assert.equal(l.plan, 'pro');
        assert.equal(l.planExpiresAt, isoIn(35));
    });

    test('T1.16: pro (còn 10 ngày) -> basic: quy đổi 10 ngày pro (200k) sang 20 ngày basic (100k) + 30 ngày = 50 ngày', async () => {
        const l = setupPlan({ plan: 'pro', planExpiresAt: isoIn(10) });
        await service.updateLandlordPlan(3, 'basic', 9);
        assert.equal(l.plan, 'basic');
        assert.equal(l.planExpiresAt, isoIn(50));
    });

    test('free -> basic: hạn = hôm nay + 30', async () => {
        const l = setupPlan({ plan: 'free', planExpiresAt: null });
        await service.updateLandlordPlan(3, 'basic', 9);
        assert.equal(l.planExpiresAt, isoIn(30));
    });

    test('free -> basic annual: hạn = hôm nay + 365, billingCycle = annual', async () => {
        const l = setupPlan({ plan: 'free', planExpiresAt: null });
        await service.updateLandlordPlan(3, 'basic', 9, 'annual');
        assert.equal(l.planExpiresAt, isoIn(365));
        assert.equal(l.billingCycle, 'annual');
        assert.equal(l.planSource, 'admin');
    });

    test('pro -> free: hạn null, billingCycle null, planSource null', async () => {
        const l = setupPlan({ plan: 'pro', planExpiresAt: isoIn(5), billingCycle: 'monthly', planSource: 'sepay' });
        await service.updateLandlordPlan(3, 'free', 9);
        assert.equal(l.planExpiresAt, null);
        assert.equal(l.billingCycle, null);
        assert.equal(l.planSource, null);
    });
});

describe('getSystemStats & getLandlordsList & getSePayEvents (T2.10, T3.4, T1.3)', () => {
    const isoIn = (days) => addPlanDaysVN(todayVN(), days);

    test('T2.10: tính MRR theo billingCycle và loại trừ gói do admin cấp tay khỏi totalRevenue thực thu', async () => {
        stub(Role, 'findOne', async () => ({ id: 2, name: 'landlord' }));
        stub(User, 'count', async () => 3);
        stub(Plan, 'findAll', async () => [
            { name: 'basic', price: 100000, annualPrice: 1200000 },
            { name: 'pro', price: 300000, annualPrice: 2400000 },
        ]);
        stub(AdminLog, 'findAll', async () => []);
        stub(User, 'findAll', async () => [
            // Chủ 1: trả qua SePay theo năm, dù chỉ còn 15 ngày vẫn tính giá năm / 12 = 200k
            { plan: 'pro', planExpiresAt: isoIn(15), billingCycle: 'annual', planSource: 'sepay' },
            // Chủ 2: trả qua SePay theo tháng, cộng dồn còn 75 ngày vẫn tính giá tháng = 100k
            { plan: 'basic', planExpiresAt: isoIn(75), billingCycle: 'monthly', planSource: 'sepay' },
            // Chủ 3: Admin cấp tay gói Pro -> không cộng vào totalRevenue thực thu, chỉ tính trong estimatedMrr
            { plan: 'pro', planExpiresAt: isoIn(30), billingCycle: 'monthly', planSource: 'admin' },
        ]);

        const res = await service.getSystemStats();
        assert.equal(res.stats.totalRevenue, 300000);
        assert.equal(res.stats.estimatedMrr, 600000);
    });

    test('T3.4: getLandlordsList trả thêm planExpiresAt, billingCycle, planSource', async () => {
        stub(Role, 'findOne', async () => ({ id: 2, name: 'landlord' }));
        stub(User, 'findAll', async () => [{
            id: 1, name: 'Chủ A', email: 'a@x.com', phone: '0901234567',
            plan: 'pro', planExpiresAt: '2026-12-31', billingCycle: 'annual', planSource: 'sepay',
            status: 'active', lockReason: null, createdAt: new Date('2026-01-01'),
            buildings: [{ id: 1, rooms: [{ id: 10 }, { id: 11 }] }],
        }]);

        const list = await service.getLandlordsList();
        assert.equal(list.length, 1);
        assert.equal(list[0].planExpiresAt, '2026-12-31');
        assert.equal(list[0].billingCycle, 'annual');
        assert.equal(list[0].planSource, 'sepay');
    });

    test('T1.3: getSePayEvents trả danh sách sự kiện SePay có phân trang và lọc status', async () => {
        let queryOpts = null;
        stub(SePayEvent, 'findAndCountAll', async (opts) => {
            queryOpts = opts;
            return { rows: [{ id: 1, status: 'REJECTED' }], count: 1 };
        });

        const res = await service.getSePayEvents({ page: 1, pageSize: 10, status: 'REJECTED' });
        assert.equal(res.total, 1);
        assert.equal(res.items.length, 1);
        assert.equal(queryOpts.where.status, 'REJECTED');
    });
});

// ─── A6: nhật ký admin phân trang + lọc ─────────────────────────────────────────
describe('getAdminLogs', () => {
    test('giới hạn pageSize 100, tính offset, lọc action, trả total', async () => {
        let opts;
        stub(AdminLog, 'findAndCountAll', async (o) => { opts = o; return { rows: [{ id: 1 }], count: 250 }; });
        const res = await service.getAdminLogs({ page: '2', pageSize: '500', action: 'LOCK_USER' });
        assert.equal(opts.limit, 100);
        assert.equal(opts.offset, 100);
        assert.equal(opts.where.action, 'LOCK_USER');
        assert.deepEqual(res, { items: [{ id: 1 }], total: 250, page: 2, pageSize: 100 });
    });

    test('mặc định trang 1, 20 dòng; lọc ngày và từ khóa', async () => {
        let opts;
        stub(AdminLog, 'findAndCountAll', async (o) => { opts = o; return { rows: [], count: 0 }; });
        const { Op } = require('sequelize');
        await service.getAdminLogs({ from: '2026-01-01', to: '2026-01-31', q: 'BASIC' });
        assert.equal(opts.limit, 20);
        assert.equal(opts.offset, 0);
        assert.ok(opts.where.createdAt[Op.gte] instanceof Date);
        assert.equal(opts.where.createdAt[Op.lte].getDate(), 31);
        assert.equal(opts.where.description[Op.like], '%BASIC%');
        await rejects400(service.getAdminLogs({ from: 'abc' }));
    });
});

// ─── E1 + E5: ticket khiếu nại ─────────────────────────────────────────────────
const LandlordTicket = require('../src/models/LandlordTicket');

describe('resolveLandlordTicket', () => {
    const makeTicket = (over = {}) => ({ id: 7, landlordId: 3, email: 'a@x.com', status: 'pending', ...over });
    // t là bản ghi trong "DB". findByPk trả bản sao; update giả lập UPDATE ... WHERE id AND status = old
    const setupTicket = (t) => {
        const updates = [];
        stub(LandlordTicket, 'findByPk', async () => ({ ...t }));
        stub(LandlordTicket, 'update', async (data, { where }) => {
            updates.push({ data, where });
            if (Number(where.id) !== t.id || where.status !== t.status) return [0];
            Object.assign(t, data);
            return [1];
        });
        return updates;
    };
    const stubRejectEmail = (ok = true) => {
        const sent = [];
        stub(emailService, 'sendTicketRejectedEmail', async (...args) => { sent.push(args); return ok; });
        return sent;
    };

    test('E1: duyệt mà gửi email lỗi thì 502, ticket trả về pending để thử lại', async () => {
        const t = makeTicket();
        setupTicket(t);
        const l = makeLandlord({ status: 'locked' });
        setupStatus(l, { emailOk: false });
        await assert.rejects(service.resolveLandlordTicket(7, 'resolved', 9), (err) => err.statusCode === 502);
        assert.equal(t.status, 'pending');
        assert.equal(l.status, 'locked');
    });

    test('E1: duyệt thành công thì mở khóa và đánh dấu resolved', async () => {
        const t = makeTicket();
        setupTicket(t);
        const l = makeLandlord({ status: 'locked' });
        const { emails } = setupStatus(l);
        await service.resolveLandlordTicket('7', 'resolved', 9);
        assert.equal(l.status, 'active');
        assert.equal(t.status, 'resolved');
        assert.equal(emails.length, 1);
    });

    test('T2.17: chủ nhà đã active thì duyệt không ghi đè mật khẩu', async () => {
        const t = makeTicket();
        setupTicket(t);
        const l = makeLandlord({ status: 'active' });
        const { emails } = setupStatus(l);
        await service.resolveLandlordTicket(7, 'resolved', 9);
        assert.equal(t.status, 'resolved');
        assert.equal(emails.length, 0);
        assert.equal(l.password, 'old-hash');
        assert.equal(l.saved, 0);
    });

    test('T2.17: hai admin duyệt cùng lúc thì chỉ một mật khẩu được gửi', async () => {
        const t = makeTicket();
        setupTicket(t);
        const l = makeLandlord({ status: 'locked' });
        const { emails } = setupStatus(l);
        const results = await Promise.allSettled([
            service.resolveLandlordTicket(7, 'resolved', 9),
            service.resolveLandlordTicket(7, 'resolved', 10),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
        assert.equal(results.find((r) => r.status === 'rejected').reason.statusCode, 400);
        assert.equal(emails.length, 1);
    });

    test('T2.17: từ chối không có lý do (hoặc < 5 ký tự) bị 400, ticket giữ pending', async () => {
        const t = makeTicket();
        const updates = setupTicket(t);
        const sent = stubRejectEmail();
        await rejects400(service.resolveLandlordTicket(7, 'rejected', 9));
        await rejects400(service.resolveLandlordTicket(7, 'rejected', 9, { reason: ' ab ' }));
        assert.equal(t.status, 'pending');
        assert.equal(updates.length, 0);
        assert.equal(sent.length, 0);
    });

    test('T2.17: từ chối có lý do thì lưu lý do, ghi log và gửi email cho chủ nhà', async () => {
        const t = makeTicket();
        setupTicket(t);
        const sent = stubRejectEmail();
        const logs = [];
        stub(AdminLog, 'create', async (d) => { logs.push(d); return d; });
        await service.resolveLandlordTicket(7, 'rejected', 9, { reason: '  Chưa đủ bằng chứng ' });
        assert.equal(t.status, 'rejected');
        assert.equal(t.rejectReason, 'Chưa đủ bằng chứng');
        assert.equal(logs[0].action, 'TICKET_REJECTED');
        assert.match(logs[0].description, /Chưa đủ bằng chứng/);
        assert.deepEqual(sent, [['a@x.com', 'Chưa đủ bằng chứng']]);
    });

    test('T2.17: từ chối mà email lỗi thì ticket vẫn rejected, message báo gửi email thất bại', async () => {
        const t = makeTicket();
        setupTicket(t);
        stubRejectEmail(false);
        stub(AdminLog, 'create', async (d) => d);
        const res = await service.resolveLandlordTicket(7, 'rejected', 9, { reason: 'Chưa đủ bằng chứng' });
        assert.equal(t.status, 'rejected');
        assert.match(res.message, /email/i);
    });
});

describe('createLandlordTicket (khiếu nại công khai)', () => {
    const setupAppeal = (user, pending = null) => {
        const created = [];
        stub(User, 'findOne', async () => user);
        stub(LandlordTicket, 'findOne', async () => pending);
        stub(LandlordTicket, 'create', async (d) => { created.push(d); return d; });
        return created;
    };

    test('E5: thiếu trường vẫn 400', async () => {
        await rejects400(service.createLandlordTicket('a@x.com', '', 'nd'));
    });

    test('E5: email không tồn tại / không bị khóa / đã có ticket chờ -> cùng 1 thông điệp, không tạo ticket', async () => {
        const msgs = [];
        const cases = [
            [null, null],
            [makeLandlord({ status: 'active' }), null],
            [makeLandlord({ status: 'locked' }), { id: 1, status: 'pending' }],
        ];
        for (const [user, pending] of cases) {
            const created = setupAppeal(user, pending);
            const res = await service.createLandlordTicket('a@x.com', 'Tiêu đề', 'Nội dung');
            assert.equal(created.length, 0);
            assert.equal(res.ticket, undefined);
            msgs.push(res.message);
            while (restores.length) restores.pop()();
        }
        assert.ok(msgs[0]);
        assert.ok(msgs.every(m => m === msgs[0]));
    });

    test('E5: chủ nhà bị khóa, chưa có ticket chờ -> tạo ticket, cùng thông điệp chung', async () => {
        const created = setupAppeal(makeLandlord({ status: 'locked' }));
        const res = await service.createLandlordTicket('a@x.com', 'Tiêu đề', 'Nội dung');
        assert.equal(created.length, 1);
        assert.equal(created[0].landlordId, 3);
        assert.equal(created[0].status, 'pending');
        assert.equal(res.ticket, undefined);
        assert.ok(res.message);
    });
});

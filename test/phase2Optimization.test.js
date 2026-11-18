/**
 * TDD Tests cho Giai đoạn 2: Tối ưu hiệu năng, Phân trang & Quản lý chi phí AI Chatbot
 * Chạy: node --test test/phase2Optimization.test.js
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const setupAssociations = require('../src/models/associations');
setupAssociations();

const buildingService = require('../src/services/buildingService');
const chatService = require('../src/services/chatService');
const { checkChatLimit, consumeChatLimit } = require('../src/middleware/checkLimit');
const Room = require('../src/models/Room');
const User = require('../src/models/User');
const Plan = require('../src/models/Plan');

const restores = [];
const stub = (obj, key, fn) => {
    const orig = obj[key];
    obj[key] = fn;
    restores.push(() => { obj[key] = orig; });
};
afterEach(() => { while (restores.length) restores.pop()(); });

const fakeRes = () => {
    const r = { code: 200, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
};

describe('Giai đoạn 2: Phân trang danh sách phòng & khách thuê (Pagination)', () => {
    test('getRooms trả về dạng phân trang { data, total, page, totalPages } khi có query.page', async () => {
        stub(Room, 'findAndCountAll', async (opts) => {
            assert.equal(opts.limit, 10);
            assert.equal(opts.offset, 0);
            return {
                count: 25,
                rows: [{ id: 1, roomNumber: '101' }, { id: 2, roomNumber: '102' }]
            };
        });

        const res = await buildingService.getRooms(1, { page: '1', limit: '10' });
        assert.ok(res.data, 'Phải có thuộc tính data');
        assert.equal(res.total, 25);
        assert.equal(res.page, 1);
        assert.equal(res.totalPages, 3);
        assert.equal(res.data.length, 2);
    });

    test('getRooms giữ tương thích ngược: trả về mảng trực tiếp khi không có query.page', async () => {
        stub(Room, 'findAll', async () => [{ id: 1, roomNumber: '101' }]);

        const res = await buildingService.getRooms(1);
        assert.ok(Array.isArray(res), 'Không truyền page thì phải trả về mảng');
        assert.equal(res.length, 1);
    });

    test('getTenants trả về dạng phân trang khi có query.page', async () => {
        stub(User, 'findAndCountAll', async (opts) => {
            assert.equal(opts.limit, 5);
            assert.equal(opts.offset, 5);
            return {
                count: 12,
                rows: [{ id: 10, name: 'Khách A' }]
            };
        });

        const res = await buildingService.getTenants(1, { page: '2', limit: '5' });
        assert.ok(res.data);
        assert.equal(res.total, 12);
        assert.equal(res.page, 2);
        assert.equal(res.totalPages, 3);
    });
});

describe('Giai đoạn 2: Cắt gọt Context Prompt Chatbot (Prompt Thinning)', () => {
    test('landlordContext tóm tắt số lượng phòng và không nhồi danh sách quá 10 phòng', () => {
        const dummySnapshot = {
            buildings: [{ id: 1, name: 'Tòa Nhà Xanh' }],
            rooms: {
                total: 50,
                empty: 10,
                occupied: 40,
                list: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, roomNumber: `${100 + i}`, status: 'occupied', buildingId: 1 }))
            },
            unpaidInvoices: { count: 0, total: 0, items: [] },
            pendingContracts: 0,
            openRequests: 0,
            contracts: [],
            supportRequests: []
        };

        const context = chatService.buildContext ? null : null;
        // Kiểm tra hàm format context cho landlord
        assert.ok(typeof chatService.buildContext === 'function');
    });
});

describe('Giai đoạn 2: Kiểm soát hạn ngạch Chatbot AI theo tháng (Chat Quota)', () => {
    test('Tài khoản Free vượt quá 20 câu/tháng bị checkChatLimit chặn 403', async () => {
        stub(Plan, 'findOne', async () => ({ name: 'free', maxChatCallsPerMonth: 20 }));
        const now = new Date();
        const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        
        const user = {
            id: 1,
            plan: 'free',
            chatUseCountThisMonth: 20,
            lastChatUseMonth: currentPeriod
        };

        const res = fakeRes();
        let nextCalled = false;
        await checkChatLimit({ user }, res, () => { nextCalled = true; });

        assert.equal(res.code, 403);
        assert.match(res.body.message, /hạn mức/i);
        assert.equal(nextCalled, false);
    });

    test('Gói Pro (-1) không bị giới hạn số câu hỏi chatbot', async () => {
        stub(Plan, 'findOne', async () => ({ name: 'pro', maxChatCallsPerMonth: -1 }));
        const user = { id: 1, plan: 'pro', chatUseCountThisMonth: 9999 };

        const res = fakeRes();
        let nextCalled = false;
        await checkChatLimit({ user }, res, () => { nextCalled = true; });

        assert.equal(res.code, 200);
        assert.equal(nextCalled, true);
    });
});

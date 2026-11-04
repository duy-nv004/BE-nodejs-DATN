/**
 * Test endpoint POST /api/chat/execute — thực thi tool sau xác nhận của người dùng.
 * Không cần DB.
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const chatTools = require('../src/services/chatTools');
const chatController = require('../src/controllers/chatController');

const originalExecute = chatTools.executeTool;
afterEach(() => { chatTools.executeTool = originalExecute; });

const fakeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

describe('chatController.execute', () => {
    test('thiếu tool -> 400', async () => {
        const res = fakeRes();
        await chatController.execute({ user: { id: 3 }, body: {} }, res);
        assert.equal(res.statusCode, 400);
    });

    test('gọi executeTool(user, tool, params) và trả kết quả 200', async () => {
        const user = { id: 3, roleData: { name: 'landlord' } };
        const params = { roomNumber: '101', price: 3500000, buildingId: 1 };
        let args;
        chatTools.executeTool = async (u, t, p) => { args = [u, t, p]; return { message: 'Đã tạo phòng 101 thành công.', room: { id: 9 } }; };

        const res = fakeRes();
        await chatController.execute({ user, body: { tool: 'create_room', params } }, res);

        assert.deepEqual(args, [user, 'create_room', params]);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.message, 'Đã tạo phòng 101 thành công.');
        assert.equal(res.body.room.id, 9);
    });

    test('lỗi 403/404 từ service trả đúng mã', async () => {
        chatTools.executeTool = async () => { const e = new Error('Bạn không có quyền'); e.statusCode = 403; throw e; };
        const res = fakeRes();
        await chatController.execute({ user: { id: 7 }, body: { tool: 'create_room', params: {} } }, res);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.message, 'Bạn không có quyền');
    });

    test('lỗi không rõ -> 500 chung, không lộ chi tiết', async () => {
        chatTools.executeTool = async () => { throw new Error('ECONNREFUSED 10.0.0.5'); };
        const res = fakeRes();
        await chatController.execute({ user: { id: 3 }, body: { tool: 'create_room', params: {} } }, res);
        assert.equal(res.statusCode, 500);
        assert.doesNotMatch(res.body.message, /ECONNREFUSED/);
    });

    test('T2.16: chặn 409 khi gửi lại cùng actionId trong vòng 15 phút', async () => {
        let count = 0;
        chatTools.executeTool = async () => { count++; return { message: 'OK' }; };
        const user = { id: 3, roleData: { name: 'landlord' } };
        const body = { actionId: 'uuid-test-1234', tool: 'create_room', params: { roomNumber: '101', price: 1000, buildingId: 1 } };

        const res1 = fakeRes();
        await chatController.execute({ user, body }, res1);
        assert.equal(res1.statusCode, 200);

        const res2 = fakeRes();
        await chatController.execute({ user, body }, res2);
        assert.equal(res2.statusCode, 409);
        assert.equal(res2.body.message, 'Thao tác này đã được thực hiện trước đó.');
        assert.equal(count, 1);
    });
});

describe('chatRoutes: execute endpoint', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/chatRoutes.js'), 'utf8');

    test('POST /execute được định nghĩa, có protect và rate limit', () => {
        assert.match(src, /router\.post\(\s*['"]\/execute['"]\s*,\s*protect[\s\S]*?chatController\.execute/);
        assert.match(src, /executeLimiter|rateLimit/);
    });
});

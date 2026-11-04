/**
 * Test controller + route của chatbot — không cần DB.
 * Chạy: npm test
 */
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const chatService = require('../src/services/chatService');
const chatController = require('../src/controllers/chatController');

const originalChat = chatService.chat;
afterEach(() => { chatService.chat = originalChat; });

const fakeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

describe('chatController.chat', () => {
    test('chuyển req.user, messages và toolsForUser cho service, trả 200 full result', async () => {
        let args;
        chatService.chat = async (user, messages, deps) => { args = [user, messages, deps]; return { reply: 'Xin chào' }; };
        const user = { id: 7, roleData: { name: 'tenant' } };
        const messages = [{ role: 'user', content: 'hi' }];
        const res = fakeRes();

        await chatController.chat({ user, body: { messages } }, res);

        assert.equal(args[0], user);
        assert.equal(args[1], messages);
        assert.equal(typeof args[2].toolsForUser, 'function');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { reply: 'Xin chào' });
    });

    test('service trả string thuần -> được bọc thành { reply }', async () => {
        chatService.chat = async () => 'Xin chào';
        const res = fakeRes();
        await chatController.chat({ user: { id: 7, roleData: { name: 'tenant' } }, body: { messages: [{ role: 'user', content: 'hi' }] } }, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { reply: 'Xin chào' });
    });

    test('pendingAction từ service được trả nguyên vẹn cho client', async () => {
        chatService.chat = async () => ({ reply: 'Xác nhận?', pendingAction: { tool: 'create_room', params: { roomNumber: '101' } } });
        const res = fakeRes();
        await chatController.chat({ user: { id: 3, roleData: { name: 'landlord' } }, body: { messages: [{ role: 'user', content: 'tạo phòng' }] } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.pendingAction.tool, 'create_room');
    });

    test('lỗi có statusCode được trả đúng mã và thông báo', async () => {
        chatService.chat = async () => { const e = new Error('Vui lòng nhập câu hỏi'); e.statusCode = 400; throw e; };
        const res = fakeRes();
        await chatController.chat({ user: { id: 1 }, body: {} }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.message, 'Vui lòng nhập câu hỏi');
    });

    test('lỗi không rõ -> 500 với thông báo chung, không lộ chi tiết nội bộ', async () => {
        chatService.chat = async () => { throw new Error('ECONNREFUSED 10.0.0.5:3306'); };
        const res = fakeRes();
        await chatController.chat({ user: { id: 1 }, body: {} }, res);
        assert.equal(res.statusCode, 500);
        assert.doesNotMatch(res.body.message, /ECONNREFUSED/);
    });
});

describe('chatRoutes', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/chatRoutes.js'), 'utf8');
    const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

    test('POST / bắt buộc đăng nhập (protect) và có giới hạn tần suất', () => {
        assert.match(src, /router\.post\(\s*['"]\/['"]\s*,\s*protect\s*,\s*chatLimiter\s*,\s*chatController\.chat/);
    });

    test('được gắn vào /api/chat trong index.js', () => {
        assert.match(indexSrc, /app\.use\(\s*["']\/api\/chat["']\s*,\s*chatRoutes\s*\)/);
    });
});

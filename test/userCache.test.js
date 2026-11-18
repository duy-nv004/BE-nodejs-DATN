const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const userCache = require('../src/utils/userCache');

describe('userCache (TDD Redis / Memory TTL Cache)', () => {
    beforeEach(async () => {
        await userCache.clear();
    });

    test('lưu và lấy user hợp lệ khi tokenVersion khớp', async () => {
        const dummyUser = { id: 10, name: 'Nguyễn Văn A', tokenVersion: 0 };
        await userCache.set(10, 0, dummyUser, 5000);

        const cached = await userCache.get(10, 0);
        assert.ok(cached);
        assert.equal(cached.id, 10);
        assert.equal(cached.name, 'Nguyễn Văn A');
    });

    test('trả về null nếu tokenVersion không khớp (phiên đã bị thu hồi/đổi pass)', async () => {
        const dummyUser = { id: 10, name: 'Nguyễn Văn A', tokenVersion: 0 };
        await userCache.set(10, 0, dummyUser, 5000);

        // JWT gửi lên tokenVersion = 1 nhưng cache lưu tokenVersion = 0
        const cached = await userCache.get(10, 1);
        assert.equal(cached, null);
    });

    test('trả về null khi cache đã hết hạn TTL', async () => {
        const dummyUser = { id: 10, name: 'Nguyễn Văn A', tokenVersion: 0 };
        // TTL ngắn: 20ms
        await userCache.set(10, 0, dummyUser, 20);

        assert.ok(await userCache.get(10, 0));
        await new Promise((r) => setTimeout(r, 35));
        assert.equal(await userCache.get(10, 0), null);
    });

    test('del(userId) xóa thành công người dùng khỏi cache', async () => {
        const dummyUser = { id: 10, name: 'Nguyễn Văn A', tokenVersion: 0 };
        await userCache.set(10, 0, dummyUser, 5000);
        assert.ok(await userCache.get(10, 0));

        await userCache.del(10);
        assert.equal(await userCache.get(10, 0), null);
    });

    test('xử lý an toàn khi userId hoặc tokenVersion không hợp lệ', async () => {
        assert.equal(await userCache.get(null, 0), null);
        assert.equal(await userCache.get(undefined, 0), null);
        assert.equal(await userCache.set(null, 0, {}), false);
    });
});

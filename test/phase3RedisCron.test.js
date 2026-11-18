const test = require('node:test');
const assert = require('node:assert');
const { getRedisClient, acquireLock, releaseLock, withDistributedLock } = require('../src/config/redis');
const sseService = require('../src/services/sseService');
const cronWorker = require('../src/jobs/cronWorker');

test('Phase 3 - Redis Client & Distributed Lock (In-Memory Fallback)', async (t) => {
    await t.test('getRedisClient trả về client có đủ các hàm cơ bản (get, set, del, publish, subscribe)', async () => {
        const client = getRedisClient();
        assert.ok(typeof client.get === 'function');
        assert.ok(typeof client.set === 'function');
        assert.ok(typeof client.del === 'function');
        assert.ok(typeof client.publish === 'function');
        assert.ok(typeof client.subscribe === 'function');
    });

    await t.test('set và get dữ liệu có TTL hoạt động chính xác trong fallback mode', async () => {
        const client = getRedisClient();
        await client.set('test_key', 'hello_datn', 'EX', 2);
        const val = await client.get('test_key');
        assert.strictEqual(val, 'hello_datn');

        await client.del('test_key');
        const afterDel = await client.get('test_key');
        assert.strictEqual(afterDel, null);
    });

    await t.test('acquireLock và releaseLock đảm bảo loại trừ lẫn nhau (Mutual Exclusion)', async () => {
        const lockKey = 'test_resource_lock';
        const lockId1 = await acquireLock(lockKey, 1000);
        assert.ok(lockId1, 'Lock 1 phải lấy được lock');

        // Thử lấy cùng lock lần 2 với retry thấp -> phải thất bại (null)
        const lockId2 = await acquireLock(lockKey, 1000, 2, 20);
        assert.strictEqual(lockId2, null, 'Lock 2 phải thất bại khi Lock 1 đang nắm giữ');

        // Giải phóng lock 1
        const released = await releaseLock(lockKey, lockId1);
        assert.strictEqual(released, true);

        // Sau khi release, lock 3 có thể lấy được
        const lockId3 = await acquireLock(lockKey, 1000, 2, 20);
        assert.ok(lockId3, 'Lock 3 phải lấy được lock sau khi lock 1 giải phóng');
        await releaseLock(lockKey, lockId3);
    });

    await t.test('withDistributedLock thực thi hàm an toàn và tự động giải phóng lock', async () => {
        let counter = 0;
        const job = () => withDistributedLock('test_counter_lock', async () => {
            const current = counter;
            await new Promise(r => setTimeout(r, 20));
            counter = current + 1;
        });

        await Promise.all([job(), job(), job()]);
        assert.strictEqual(counter, 3, 'Counter phải là 3 do distributed lock chống race condition');
    });
});

test('Phase 3 - SSE Service Pub/Sub Integration', async (t) => {
    await t.test('SSE Service broadcast và sendToUser kích hoạt qua pub/sub client', async () => {
        let receivedEvent = null;
        const mockRes = {
            write: (str) => {
                receivedEvent = str;
            }
        };

        sseService.addClient(999, {}, mockRes);
        assert.ok(mockRes);

        // Gửi qua sendToUser
        const sent = sseService.sendToUser(999, 'invoice_paid', { invoiceId: 101 });
        assert.strictEqual(sent, true);
        assert.ok(receivedEvent.includes('invoice_paid'));
        assert.ok(receivedEvent.includes('101'));
    });
});

test('Phase 3 - Cron Worker Decoupling & Distributed Lock Protection', async (t) => {
    await t.test('cronWorker.runJobWithLock chỉ cho phép 1 instance chạy một lúc', async () => {
        let executionCount = 0;
        const task = async () => {
            executionCount++;
            await new Promise(r => setTimeout(r, 50));
        };

        // Chạy 2 cron đồng thời với cùng tên job
        const [res1, res2] = await Promise.all([
            cronWorker.runJobWithLock('test_cron_task', task, 1000),
            cronWorker.runJobWithLock('test_cron_task', task, 1000)
        ]);

        // 1 job chạy thành công (executed = true), 1 job bị skip do instance khác đang chạy (executed = false)
        const executedJobs = [res1, res2].filter(r => r.executed);
        const skippedJobs = [res1, res2].filter(r => r.skipped);

        assert.strictEqual(executedJobs.length, 1, 'Chỉ 1 instance được thực thi');
        assert.strictEqual(skippedJobs.length, 1, 'Instance còn lại bị skip');
        assert.strictEqual(executionCount, 1, 'Task chỉ chạy 1 lần duy nhất');
    });
});


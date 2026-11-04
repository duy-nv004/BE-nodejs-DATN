/**
 * Test rate limit POST /auth/appeal (T2.20): dựng app Express thật, stub service, không cần DB.
 * Chạy: node --test test/authRoutes.test.js
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const adminService = require('../src/services/adminService');
const authRoutes = require('../src/routes/authRoutes');

describe('rate limit /auth/appeal (T2.20)', () => {
    let server;
    let baseUrl;
    let origCreate;
    let calls = 0;

    before(async () => {
        origCreate = adminService.createLandlordTicket;
        adminService.createLandlordTicket = async () => { calls += 1; return { message: 'ok' }; };
        const app = express();
        app.use(express.json());
        app.use('/auth', authRoutes);
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        adminService.createLandlordTicket = origCreate;
        await new Promise((resolve) => server.close(resolve));
    });

    const appeal = () => fetch(`${baseUrl}/auth/appeal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', title: 't', message: 'm' })
    });

    test('quá 5 lần/15 phút từ cùng IP thì 429 tiếng Việt và không gọi service', async () => {
        for (let i = 0; i < 5; i += 1) {
            const res = await appeal();
            assert.equal(res.status, 201);
        }
        const blocked = await appeal();
        assert.equal(blocked.status, 429);
        const body = await blocked.json();
        assert.match(body.message, /thử lại/);
        assert.equal(calls, 5);
    });
});

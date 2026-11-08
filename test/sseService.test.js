const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sseService = require('../src/services/sseService');

describe('sseService', () => {
    test('addClient, sendToUser và removeClient', () => {
        const messages = [];
        const fakeRes = {
            write(msg) { messages.push(msg); },
            writeHead() {},
            flushHeaders() {}
        };
        const fakeReq = {
            on(evt, cb) { this.closeCb = cb; }
        };

        sseService.addClient(10, fakeReq, fakeRes);
        assert.ok(messages.length >= 1);
        assert.ok(messages[0].includes('connected'));

        sseService.sendToUser(10, 'payment_success', { invoiceId: 5, amount: 2000000 });
        assert.equal(messages.length, 2);
        assert.ok(messages[1].includes('payment_success'));
        assert.ok(messages[1].includes('2000000'));

        fakeReq.closeCb();
        sseService.sendToUser(10, 'test', {});
        assert.equal(messages.length, 2);
    });
});


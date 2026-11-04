/**
 * Unit test giá gói cước VND (src/utils/planPricing.js) — không cần DB.
 * Chạy: npm test
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../src/utils/planPricing');

describe('planPriceVnd', () => {
    test('giá đã lưu VND, không nhân tỷ giá', () => {
        const plan = { price: '725000.00', annualPrice: '7250000.00' };
        assert.equal(pricing.planPriceVnd(plan, 'monthly'), 725000);
        assert.equal(pricing.planPriceVnd(plan, 'annual'), 7250000);
    });

    test('không còn export VND_PER_USD', () => {
        assert.equal(pricing.VND_PER_USD, undefined);
    });
});

describe('migrateUsdPlanPrices', () => {
    const makePlan = (name, price, annualPrice) => ({
        name, price, annualPrice, saved: 0,
        async save() { this.saved++; }
    });

    test('đổi gói USD sang VND (x25000, làm tròn 1000đ), bỏ qua free và gói đã là VND', async () => {
        const plans = [
            makePlan('free', '0.00', '0.00'),
            makePlan('basic', '29.00', '290.00'),
            makePlan('pro', '99.99', '990.00'),
            makePlan('vip', '725000.00', '7250000.00'),
        ];
        const Plan = { findAll: async () => plans };
        const converted = await pricing.migrateUsdPlanPrices(Plan);

        assert.deepEqual(converted, ['basic', 'pro']);
        assert.equal(plans[1].price, 725000);
        assert.equal(plans[1].annualPrice, 7250000);
        assert.equal(plans[2].price, 2500000); // 99.99*25000 = 2499750 -> 2500000
        assert.equal(plans[0].saved + plans[3].saved, 0);
    });

    test('chạy lại lần hai không đổi gì (idempotent)', async () => {
        const plans = [makePlan('basic', '29.00', '290.00')];
        const Plan = { findAll: async () => plans };
        await pricing.migrateUsdPlanPrices(Plan);
        assert.deepEqual(await pricing.migrateUsdPlanPrices(Plan), []);
        assert.equal(plans[0].price, 725000);
        assert.equal(plans[0].saved, 1);
    });
});

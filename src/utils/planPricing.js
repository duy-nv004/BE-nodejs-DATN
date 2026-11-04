/**
 * Tiện ích giá gói cước. Bảng Plans lưu giá bằng VND.
 */

const ANNUAL_TOKENS = ['annual', 'year', 'yearly', 'nam'];

/** Chu kỳ thanh toán có phải theo năm hay không */
const isAnnualCycle = (billingCycle) =>
    ANNUAL_TOKENS.includes(String(billingCycle || '').trim().toLowerCase());

/** Chu kỳ đã chuẩn hoá để lưu xuống DB */
const normalizeCycle = (billingCycle) => (isAnnualCycle(billingCycle) ? 'annual' : 'monthly');

/** Số ngày cộng thêm vào hạn sử dụng của gói theo chu kỳ */
const cycleDays = (billingCycle) => (isAnnualCycle(billingCycle) ? 365 : 30);

/**
 * Số tiền phải thu (VND) của một gói cước theo chu kỳ thanh toán.
 * @param {{price: number|string, annualPrice: number|string}} plan
 * @param {string} billingCycle
 */
const planPriceVnd = (plan, billingCycle) => {
    const price = isAnnualCycle(billingCycle) ? plan.annualPrice : plan.price;
    return Math.round(parseFloat(price || 0));
};

/**
 * Chuyển một lần giá gói cũ lưu USD sang VND (x25000, làm tròn 1000đ).
 * Chỉ đổi khi 0 < price < 1000 nên chạy lại nhiều lần vẫn an toàn.
 * @param {object} Plan - model Plan
 * @returns {Promise<string[]>} tên các gói đã chuyển
 */
const migrateUsdPlanPrices = async (Plan) => {
    const toVnd = (usd) => Math.round(parseFloat(usd || 0) * 25) * 1000;
    const converted = [];
    for (const p of await Plan.findAll()) {
        const price = parseFloat(p.price);
        if (p.name === 'free' || !(price > 0 && price < 1000)) continue;
        p.price = toVnd(p.price);
        p.annualPrice = toVnd(p.annualPrice);
        await p.save();
        converted.push(p.name);
    }
    return converted;
};

/**
 * Nội dung chuyển khoản mà SePay sẽ gửi lại trong webhook.
 * Cú pháp: `PLAN <LANDLORD_ID> <PLAN_NAME> [YEAR]`
 */
const buildTransferCode = (landlordId, planName, billingCycle) =>
    `PLAN ${landlordId} ${String(planName).toUpperCase()}${isAnnualCycle(billingCycle) ? ' YEAR' : ''}`;

module.exports = {
    isAnnualCycle,
    normalizeCycle,
    cycleDays,
    planPriceVnd,
    buildTransferCode,
    migrateUsdPlanPrices
};

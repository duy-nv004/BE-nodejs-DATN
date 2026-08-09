const sequelize = require('../src/config/db');
const setupAssociations = require('../src/models/associations');
const invoiceService = require('../src/services/invoiceService');

async function test() {
    try {
        setupAssociations();
        await sequelize.authenticate();
        console.log("Database connected successfully!");
        
        // Thử chạy thống kê theo tháng
        const resultMonth = await invoiceService.getRevenueStats(1, { month: '7', year: '2026' });
        console.log("MONTH STATS:", resultMonth);
        
        // Thử chạy thống kê theo năm
        const resultYear = await invoiceService.getRevenueStats(1, { month: 'all', year: '2026' });
        console.log("YEAR STATS:", resultYear);
    } catch (err) {
        console.error("SEQUELIZE ERROR:", err.message);
        console.error(err);
    } finally {
        process.exit();
    }
}
test();

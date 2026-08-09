const sequelize = require('../src/config/db');
const setupAssociations = require('../src/models/associations');
const contractService = require('../src/services/contractService');

async function test() {
    try {
        setupAssociations();
        await sequelize.authenticate();
        console.log("Database connected successfully!");
        
        // Giả lập landlordId = 1 hoặc thử tìm một landlord thực tế
        const result = await contractService.getContracts(1);
        console.log("QUERY SUCCESS, contracts count:", result.length);
    } catch (err) {
        console.error("SEQUELIZE ERROR:", err.message);
        console.error(err);
    } finally {
        process.exit();
    }
}
test();

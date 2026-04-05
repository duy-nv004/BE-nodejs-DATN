const Contract = require('../models/Contract');
const Room = require('../models/Room');
const User = require('../models/User');
const MeterReading = require('../models/MeterReading');
const Building = require('../models/Building');
const Service = require('../models/Service');
const sequelize = require('../config/db');
const dayjs = require('dayjs');

exports.createContract = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { 
            roomId, tenantPhone, startDate, durationMonths, deposit,
            initialElectricity, initialWater,
            customElectricity, customWater, customInternet, customCleaning 
        } = req.body;

        const tenant = await User.findOne({ where: { phone: tenantPhone } });
        if (!tenant) throw new Error("Số điện thoại người thuê chưa có tài khoản.");

        const room = await Room.findByPk(roomId, {
            include: [{ 
                model: Building, 
                as: 'building', 
                include: [{ model: Service, as: 'service' }] 
            }]
        });
        if (!room) throw new Error("Không tìm thấy phòng.");
        
        const defaultSvc = room.building.service || {};

        const finalPrices = {
            electricity: customElectricity || defaultSvc.electricityPrice || 3500,
            water: customWater || defaultSvc.waterPrice || 30000,
            internet: customInternet || defaultSvc.internetPrice || 100000,
            cleaning: customCleaning || defaultSvc.cleaningPrice || 50000
        };

        const endDate = dayjs(startDate).add(durationMonths, 'month').format('YYYY-MM-DD');

        const contract = await Contract.create({
            roomId, tenantId: tenant.id, startDate, endDate, deposit,
            electricityPrice: finalPrices.electricity,
            waterPrice: finalPrices.water,
            internetPrice: finalPrices.internet,
            cleaningPrice: finalPrices.cleaning
        }, { transaction });

        await MeterReading.bulkCreate([
            { type: 'electricity', readingValue: initialElectricity, isInitial: true, roomId, readingDate: startDate },
            { type: 'water', readingValue: initialWater, isInitial: true, roomId, readingDate: startDate }
        ], { transaction });

        await Room.update({ status: 'occupied' }, { where: { id: roomId }, transaction });

        await transaction.commit();
        res.status(201).json({ message: "Hợp đồng & Chỉ số đầu kỳ đã được lưu!", contract });
    } catch (err) {
        await transaction.rollback();
        res.status(400).json({ message: err.message });
    }
};
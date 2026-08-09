const User = require('../models/User');
const Role = require('../models/Role');
const Building = require('../models/Building');
const Room = require('../models/Room');
const Invoice = require('../models/Invoice');
const Plan = require('../models/Plan');
const { createError } = require('../utils/errors');

exports.getSystemStats = async () => {
    const landlordRole = await Role.findOne({ where: { name: 'landlord' } });
    if (!landlordRole) {
        throw createError(500, "Không tìm thấy quyền Landlord trong hệ thống");
    }

    const totalRevenue = await Invoice.sum('totalAmount') || 0;
    const landlordCount = await User.count({ where: { roleId: landlordRole.id } });
    const userCount = await User.count();

    const freeCount = await User.count({ where: { roleId: landlordRole.id, plan: 'free' } });
    const basicCount = await User.count({ where: { roleId: landlordRole.id, plan: 'basic' } });
    const proCount = await User.count({ where: { roleId: landlordRole.id, plan: 'pro' } });

    const buildings = await Building.findAll({
        include: [
            { model: User, as: 'landlord', attributes: ['id', 'name', 'email'] },
            { model: Room, as: 'rooms', attributes: ['id', 'status'] }
        ]
    });

    const flagshipAssets = buildings.map(b => {
        const rooms = b.rooms || [];
        const totalRooms = rooms.length;
        const occupiedRooms = rooms.filter(r => r.status === 'occupied').length;
        const occupancyRate = totalRooms > 0 ? ((occupiedRooms / totalRooms) * 100).toFixed(1) + '%' : '0%';
        return {
            id: b.id,
            name: b.name,
            address: b.address,
            owner: b.landlord ? (b.landlord.name || b.landlord.email) : 'Chưa xác định',
            units: `${totalRooms} Phòng`,
            yield: occupancyRate,
            status: totalRooms > 0 ? 'OPERATIONAL' : 'INACTIVE'
        };
    });

    const recentInvoices = await Invoice.findAll({
        limit: 4,
        order: [['createdAt', 'DESC']],
        include: [{
            model: Room,
            as: 'roomDetails',
            attributes: ['roomNumber'],
            include: [{ model: Building, as: 'building', attributes: ['name'] }]
        }]
    });

    const recentActivity = recentInvoices.map(inv => {
        const bName = inv.roomDetails?.building?.name || 'Tòa nhà';
        const rNum = inv.roomDetails?.roomNumber || 'Phòng';
        return {
            label: `Đã xuất hóa đơn phòng ${rNum}`,
            sub: `${bName} - Hóa đơn tháng ${inv.month}/${inv.year}`,
            time: `Tổng: ${Number(inv.totalAmount).toLocaleString('vi-VN')} VNĐ`,
            isPaid: inv.isPaid
        };
    });

    return {
        stats: {
            totalRevenue: parseFloat(totalRevenue),
            landlordCount,
            userCount
        },
        packages: {
            free: freeCount,
            basic: basicCount,
            pro: proCount,
            total: freeCount + basicCount + proCount
        },
        flagshipAssets: flagshipAssets.slice(0, 5),
        recentActivity
    };
};

exports.getLandlordsList = async () => {
    const landlordRole = await Role.findOne({ where: { name: 'landlord' } });
    if (!landlordRole) {
        throw createError(500, "Không tìm thấy quyền Landlord trong hệ thống");
    }

    const landlords = await User.findAll({
        where: { roleId: landlordRole.id },
        attributes: ['id', 'name', 'email', 'phone', 'plan', 'createdAt'],
        include: [
            {
                model: Building,
                as: 'buildings',
                attributes: ['id'],
                include: [{ model: Room, as: 'rooms', attributes: ['id'] }]
            }
        ]
    });

    const result = landlords.map(l => {
        let totalRooms = 0;
        const buildings = l.buildings || [];
        buildings.forEach(b => {
            totalRooms += b.rooms ? b.rooms.length : 0;
        });

        return {
            id: l.id,
            name: l.name || 'Chủ nhà mới',
            email: l.email,
            phone: l.phone || 'Chưa cung cấp',
            plan: l.plan.toUpperCase(),
            portfolio: `${buildings.length} Tòa nhà / ${totalRooms} Phòng`,
            date: new Date(l.createdAt).toLocaleDateString('vi-VN'),
            status: 'ACTIVE'
        };
    });

    return result;
};

exports.updateLandlordPlan = async (id, plan) => {
    if (!['free', 'basic', 'pro'].includes(plan?.toLowerCase())) {
        throw createError(400, "Gói cước không hợp lệ. Chỉ chấp nhận: free, basic, pro");
    }

    const landlord = await User.findByPk(id, {
        include: [{ model: Role, as: 'roleData' }]
    });

    if (!landlord || landlord.roleData.name !== 'landlord') {
        throw createError(404, "Không tìm thấy tài khoản chủ nhà");
    }

    landlord.plan = plan.toLowerCase();
    await landlord.save();

    return {
        message: `Đã cập nhật gói cước của chủ nhà ${landlord.name || landlord.email} thành ${plan.toUpperCase()}`,
        landlord: {
            id: landlord.id,
            email: landlord.email,
            plan: landlord.plan.toUpperCase()
        }
    };
};

exports.getPlans = async () => {
    const plans = await Plan.findAll({ order: [['id', 'ASC']] });
    return plans;
};

exports.updatePlan = async (planId, { price, annualPrice, maxBuildings, maxRoomsPerBuilding, maxAICallsPerMonth }) => {
    const plan = await Plan.findByPk(planId);
    if (!plan) {
        throw createError(404, "Không tìm thấy gói cước để cập nhật");
    }

    if (price !== undefined) plan.price = price;
    if (annualPrice !== undefined) plan.annualPrice = annualPrice;
    if (maxBuildings !== undefined) plan.maxBuildings = maxBuildings;
    if (maxRoomsPerBuilding !== undefined) plan.maxRoomsPerBuilding = maxRoomsPerBuilding;
    if (maxAICallsPerMonth !== undefined) plan.maxAICallsPerMonth = maxAICallsPerMonth;

    await plan.save();
    return plan;
};

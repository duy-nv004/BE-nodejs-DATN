const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const bcrypt = require('bcryptjs');
const Role = require('./Role');

const User = sequelize.define('User', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { 
        type: DataTypes.STRING, 
        allowNull: true, 
        unique: true,
        validate: { isEmail: true } 
    },
    phone: { 
        type: DataTypes.STRING, 
        allowNull: true, 
        unique: true 
    },
    password: { type: DataTypes.STRING, allowNull: false },
    roleId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: Role, key: 'id' }
    },
    plan: { type: DataTypes.ENUM('free', 'basic', 'pro'), defaultValue: 'free' },
    ownerId: { type: DataTypes.INTEGER, allowNull: true }, // Lưu ID của Landlord tạo ra Tenant này
    telegramChatId: {
    type: DataTypes.STRING,
    allowNull: true,
}
}, {
    tableName: 'Users',
    hooks: {
        beforeCreate: async (user) => {
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(user.password, salt);
        }
    }
});

User.prototype.comparePassword = async function(password) {
    return await bcrypt.compare(password, this.password);
};

module.exports = User;
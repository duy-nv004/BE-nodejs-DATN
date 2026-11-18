const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bookingService = require('../services/bookingService');
const { sendError } = require('../utils/errors');

const tryExtractUserId = (req) => {
    const authHeader = req.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        return decoded?.id || null;
    } catch {
        return null;
    }
};

exports.getPublicRooms = async (req, res) => {
    try {
        const result = await bookingService.getPublicRooms(req.query);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
};

exports.getPublicLocations = async (req, res) => {
    try {
        const result = await bookingService.getPublicLocations();
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
};

exports.getPublicRoomDetail = async (req, res) => {
    try {
        const result = await bookingService.getPublicRoomDetail(req.params.id);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
};

exports.getRoomImage = async (req, res) => {
    try {
        const filename = path.basename(String(req.params.filename || ''));
        if (!filename) {
            return res.status(400).json({ message: 'Tên ảnh không hợp lệ' });
        }
        const safePath = path.resolve(__dirname, '../../uploads/rooms', filename);
        const roomsDir = path.resolve(__dirname, '../../uploads/rooms');
        if (!safePath.startsWith(roomsDir) || !fs.existsSync(safePath)) {
            return res.status(404).json({ message: 'Không tìm thấy ảnh phòng' });
        }
        res.sendFile(safePath);
    } catch (err) {
        sendError(res, err);
    }
};

exports.createPublicBooking = async (req, res) => {
    try {
        const authenticatedUserId = tryExtractUserId(req);
        const result = await bookingService.createPublicBooking(req.body, { authenticatedUserId });
        res.status(201).json(result);
    } catch (err) {
        sendError(res, err);
    }
};

exports.getPublicBookingStatus = async (req, res) => {
    try {
        const lookupToken = req.query?.token || req.headers?.['x-booking-token'];
        const result = await bookingService.getPublicBookingStatus(req.params.id, lookupToken);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
};

exports.markBookingTransferred = async (req, res) => {
    try {
        const lookupToken = req.body?.lookupToken || req.body?.token || req.query?.token || req.headers?.['x-booking-token'];
        const result = await bookingService.markBookingTransferred(req.params.id, lookupToken);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
};

// Chủ nhà xem & xử lý danh sách đặt phòng / đặt cọc
exports.getLandlordBookings = async (req, res) => {
    try {
        const result = await bookingService.getLandlordBookings(req.user.id, req.query);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
};

exports.updateBookingStatus = async (req, res) => {
    try {
        const result = await bookingService.updateBookingStatus(req.user.id, req.params.id, req.body);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
};

// Người thuê xem danh sách yêu cầu đặt phòng / đặt cọc của mình
exports.getTenantBookings = async (req, res) => {
    try {
        const result = await bookingService.getTenantBookings(req.user.id);
        res.json(result);
    } catch (err) {
        sendError(res, err);
    }
};

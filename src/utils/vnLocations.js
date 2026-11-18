/**
 * Danh mục hành chính Việt Nam đầy đủ (63 Tỉnh/Thành phố, toàn bộ Quận/Huyện/Thị xã/TP,
 * và Phường/Xã/Thị trấn theo từng Quận/Huyện) cùng hàm chuẩn hóa/suy luận vị trí từ địa chỉ.
 */

const normalizeText = (str) => String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsToken = (haystack, needle) => {
    if (!haystack || !needle) return false;
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`);
    return re.test(haystack);
};

const canonicalCityName = (str) => {
    const cleaned = normalizeText(str)
        .replace(/[.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(thanh pho|tp|tinh)\s+/, '');
    if (!cleaned) return '';
    if (['hcm', 'tphcm', 'tp hcm', 'ho chi minh', 'sai gon'].includes(cleaned)) {
        return 'ho chi minh';
    }
    if (['hn', 'ha noi'].includes(cleaned)) {
        return 'ha noi';
    }
    if (['hue', 'thua thien hue'].includes(cleaned)) {
        return 'thua thien hue';
    }
    return cleaned;
};

const PRIORITY_VN_CITIES = [
    'Hà Nội',
    'TP.HCM',
    'Đà Nẵng',
    'Hải Phòng',
    'Cần Thơ',
    'Bình Dương',
    'Đồng Nai'
];

const VN_DISTRICTS_BY_CITY = {
    'Hà Nội': [
        'Ba Đình', 'Bắc Từ Liêm', 'Cầu Giấy', 'Đống Đa', 'Hà Đông', 'Hai Bà Trưng',
        'Hoàn Kiếm', 'Hoàng Mai', 'Long Biên', 'Nam Từ Liêm', 'Tây Hồ', 'Thanh Xuân',
        'Thị xã Sơn Tây', 'Ba Vì', 'Chương Mỹ', 'Đan Phượng', 'Đông Anh', 'Gia Lâm',
        'Hoài Đức', 'Mê Linh', 'Mỹ Đức', 'Phú Xuyên', 'Phúc Thọ', 'Quốc Oai',
        'Sóc Sơn', 'Thạch Thất', 'Thanh Oai', 'Thanh Trì', 'Thường Tín', 'Ứng Hòa'
    ],
    'TP.HCM': [
        'TP. Thủ Đức', 'Quận 1', 'Quận 3', 'Quận 4', 'Quận 5', 'Quận 6', 'Quận 7',
        'Quận 8', 'Quận 10', 'Quận 11', 'Quận 12', 'Bình Tân', 'Bình Thạnh', 'Gò Vấp',
        'Phú Nhuận', 'Tân Bình', 'Tân Phú', 'Bình Chánh', 'Cần Giờ', 'Củ Chi', 'Hóc Môn', 'Nhà Bè'
    ],
    'Đà Nẵng': [
        'Cẩm Lệ', 'Hải Châu', 'Hòa Vang', 'Hoàng Sa', 'Liên Chiểu', 'Ngũ Hành Sơn', 'Sơn Trà', 'Thanh Khê'
    ],
    'Hải Phòng': [
        'Đồ Sơn', 'Dương Kinh', 'Hải An', 'Hồng Bàng', 'Kiến An', 'Lê Chân', 'Ngô Quyền',
        'An Dương', 'An Lão', 'Bạch Long Vĩ', 'Cát Hải', 'Kiến Thụy', 'Thủy Nguyên', 'Tiên Lãng', 'Vĩnh Bảo'
    ],
    'Cần Thơ': [
        'Bình Thủy', 'Cái Răng', 'Ninh Kiều', 'Ô Môn', 'Thốt Nốt', 'Cờ Đỏ', 'Phong Điền', 'Thới Lai', 'Vĩnh Thạnh'
    ],
    'Bình Dương': [
        'Thủ Dầu Một', 'Dĩ An', 'Thuận An', 'Tân Uyên', 'Bến Cát', 'Bắc Tân Uyên', 'Bàu Bàng', 'Dầu Tiếng', 'Phú Giáo'
    ],
    'Đồng Nai': [
        'Biên Hòa', 'Long Khánh', 'Cẩm Mỹ', 'Định Quán', 'Long Thành', 'Nhơn Trạch',
        'Tân Phú', 'Thống Nhất', 'Trảng Bom', 'Vĩnh Cửu', 'Xuân Lộc'
    ],
    'An Giang': [
        'TP. Long Xuyên', 'TP. Châu Đốc', 'Thị xã Tân Châu', 'Thị xã Tịnh Biên',
        'An Phú', 'Châu Phú', 'Châu Thành', 'Chợ Mới', 'Phú Tân', 'Thoại Sơn', 'Tri Tôn'
    ],
    'Bà Rịa - Vũng Tàu': [
        'TP. Vũng Tàu', 'TP. Bà Rịa', 'Thị xã Phú Mỹ', 'Châu Đức', 'Côn Đảo', 'Đất Đỏ', 'Long Điền', 'Xuyên Mộc'
    ],
    'Bắc Giang': [
        'TP. Bắc Giang', 'Thị xã Việt Yên', 'Thị xã Chũ', 'Hiệp Hòa', 'Lạng Giang',
        'Lục Nam', 'Lục Ngạn', 'Sơn Động', 'Tân Yên', 'Yên Thế'
    ],
    'Bắc Kạn': [
        'TP. Bắc Kạn', 'Ba Bể', 'Bạch Thông', 'Chợ Đồn', 'Chợ Mới', 'Na Rì', 'Ngân Sơn', 'Pác Nặm'
    ],
    'Bạc Liêu': [
        'TP. Bạc Liêu', 'Thị xã Giá Rai', 'Đông Hải', 'Hòa Bình', 'Hồng Dân', 'Phước Long', 'Vĩnh Lợi'
    ],
    'Bắc Ninh': [
        'TP. Bắc Ninh', 'Từ Sơn', 'Quế Võ', 'Thị xã Thuận Thành', 'Gia Bình', 'Lương Tài', 'Tiên Du', 'Yên Phong'
    ],
    'Bến Tre': [
        'TP. Bến Tre', 'Ba Tri', 'Bình Đại', 'Châu Thành', 'Chợ Lách', 'Giồng Trôm', 'Mỏ Cày Bắc', 'Mỏ Cày Nam', 'Thạnh Phú'
    ],
    'Bình Định': [
        'TP. Quy Nhơn', 'Thị xã An Nhơn', 'Thị xã Hoài Nhơn', 'An Lão', 'Hoài Ân',
        'Phù Cát', 'Phù Mỹ', 'Tây Sơn', 'Tuy Phước', 'Vân Canh', 'Vĩnh Thạnh'
    ],
    'Bình Phước': [
        'TP. Đồng Xoài', 'Thị xã Bình Long', 'Thị xã Chơn Thành', 'Thị xã Phước Long',
        'Bù Đăng', 'Bù Đốp', 'Bù Gia Mập', 'Đồng Phú', 'Hớn Quản', 'Lộc Ninh', 'Phú Riềng'
    ],
    'Bình Thuận': [
        'TP. Phan Thiết', 'Thị xã La Gi', 'Bắc Bình', 'Đức Linh', 'Hàm Tân',
        'Hàm Thuận Bắc', 'Hàm Thuận Nam', 'Phú Quý', 'Tánh Linh', 'Tuy Phong'
    ],
    'Cà Mau': [
        'TP. Cà Mau', 'Cái Nước', 'Đầm Dơi', 'Năm Căn', 'Ngọc Hiển', 'Phú Tân', 'Thới Bình', 'Trần Văn Thời', 'U Minh'
    ],
    'Cao Bằng': [
        'TP. Cao Bằng', 'Bảo Lạc', 'Bảo Lâm', 'Hạ Lang', 'Hà Quảng', 'Hòa An', 'Nguyên Bình', 'Quảng Hòa', 'Thạch An', 'Trùng Khánh'
    ],
    'Đắk Lắk': [
        'TP. Buôn Ma Thuột', 'Thị xã Buôn Hồ', 'Buôn Đôn', 'Cư Kuin', "Cư M'gar",
        "Ea H'leo", 'Ea Kar', 'Ea Súp', 'Krông Ana', 'Krông Bông', 'Krông Búk',
        'Krông Năng', 'Krông Pắc', 'Lắk', "M'Đrắk"
    ],
    'Đắk Nông': [
        'TP. Gia Nghĩa', 'Cư Jút', 'Đắk Glong', 'Đắk Mil', "Đắk R'lấp", 'Đắk Song', 'Krông Nô', 'Tuy Đức'
    ],
    'Điện Biên': [
        'TP. Điện Biên Phủ', 'Thị xã Mường Lay', 'Điện Biên', 'Điện Biên Đông',
        'Mường Ảng', 'Mường Chà', 'Mường Nhé', 'Nậm Pồ', 'Tủa Chùa', 'Tuần Giáo'
    ],
    'Đồng Tháp': [
        'TP. Cao Lãnh', 'TP. Sa Đéc', 'TP. Hồng Ngự', 'Huyện Cao Lãnh', 'Châu Thành',
        'Huyện Hồng Ngự', 'Lai Vung', 'Lấp Vò', 'Tam Nông', 'Tân Hồng', 'Thanh Bình', 'Tháp Mười'
    ],
    'Gia Lai': [
        'TP. Pleiku', 'Thị xã An Khê', 'Thị xã Ayun Pa', 'Chư Păh', 'Chư Prông', 'Chư Pưh',
        'Chư Sê', 'Đăk Đoa', 'Đăk Pơ', 'Đức Cơ', 'Ia Grai', 'Ia Pa', 'Kbang', 'Kông Chro',
        'Krông Pa', 'Mang Yang', 'Phú Thiện'
    ],
    'Hà Giang': [
        'TP. Hà Giang', 'Bắc Mê', 'Bắc Quang', 'Đồng Văn', 'Hoàng Su Phì', 'Mèo Vạc',
        'Quản Bạ', 'Quang Bình', 'Vị Xuyên', 'Xín Mần', 'Yên Minh'
    ],
    'Hà Nam': [
        'TP. Phủ Lý', 'Thị xã Duy Tiên', 'Thị xã Kim Bảng', 'Bình Lục', 'Lý Nhân', 'Thanh Liêm'
    ],
    'Hà Tĩnh': [
        'TP. Hà Tĩnh', 'Thị xã Hồng Lĩnh', 'Thị xã Kỳ Anh', 'Cẩm Xuyên', 'Can Lộc', 'Đức Thọ',
        'Hương Khê', 'Hương Sơn', 'Huyện Kỳ Anh', 'Lộc Hà', 'Nghi Xuân', 'Thạch Hà', 'Vũ Quang'
    ],
    'Hải Dương': [
        'TP. Hải Dương', 'TP. Chí Linh', 'Thị xã Kinh Môn', 'Bình Giang', 'Cẩm Giàng',
        'Gia Lộc', 'Kim Thành', 'Nam Sách', 'Ninh Giang', 'Thanh Hà', 'Thanh Miện', 'Tứ Kỳ'
    ],
    'Hậu Giang': [
        'TP. Vị Thanh', 'TP. Ngã Bảy', 'Thị xã Long Mỹ', 'Châu Thành', 'Châu Thành A', 'Huyện Long Mỹ', 'Phụng Hiệp', 'Vị Thủy'
    ],
    'Hòa Bình': [
        'TP. Hòa Bình', 'Cao Phong', 'Đà Bắc', 'Kim Bôi', 'Lạc Sơn', 'Lạc Thủy', 'Lương Sơn', 'Mai Châu', 'Tân Lạc', 'Yên Thủy'
    ],
    'Hưng Yên': [
        'TP. Hưng Yên', 'Mỹ Hào', 'Ân Thi', 'Khoái Châu', 'Kim Động', 'Phù Cừ', 'Tiên Lữ', 'Văn Giang', 'Văn Lâm', 'Yên Mỹ'
    ],
    'Khánh Hòa': [
        'Nha Trang', 'Cam Ranh', 'Ninh Hòa', 'Cam Lâm', 'Diên Khánh', 'Khánh Sơn', 'Khánh Vĩnh', 'Trường Sa', 'Vạn Ninh'
    ],
    'Kiên Giang': [
        'TP. Rạch Giá', 'TP. Hà Tiên', 'TP. Phú Quốc', 'An Biên', 'An Minh', 'Châu Thành',
        'Giang Thành', 'Giồng Riềng', 'Gò Quao', 'Hòn Đất', 'Kiên Hải', 'Kiên Lương',
        'Tân Hiệp', 'U Minh Thượng', 'Vĩnh Thuận'
    ],
    'Kon Tum': [
        'TP. Kon Tum', 'Đăk Glei', 'Đăk Hà', 'Đăk Tô', "Ia H'Drai", 'Kon Plông', 'Kon Rẫy', 'Ngọc Hồi', 'Sa Thầy', 'Tu Mơ Rông'
    ],
    'Lai Châu': [
        'TP. Lai Châu', 'Mường Tè', 'Nậm Nhùn', 'Phong Thổ', 'Sìn Hồ', 'Tam Đường', 'Tân Uyên', 'Than Uyên'
    ],
    'Lâm Đồng': [
        'Đà Lạt', 'Bảo Lộc', 'Bảo Lâm', 'Cát Tiên', 'Đạ Huoai', 'Đạ Tẻh', 'Đam Rông',
        'Di Linh', 'Đơn Dương', 'Đức Trọng', 'Lạc Dương', 'Lâm Hà'
    ],
    'Lạng Sơn': [
        'TP. Lạng Sơn', 'Bắc Sơn', 'Bình Gia', 'Cao Lộc', 'Chi Lăng', 'Đình Lập',
        'Hữu Lũng', 'Lộc Bình', 'Tràng Định', 'Văn Lãng', 'Văn Quan'
    ],
    'Lào Cai': [
        'TP. Lào Cai', 'Thị xã Sa Pa', 'Bắc Hà', 'Bảo Thắng', 'Bảo Yên', 'Bát Xát', 'Mường Khương', 'Si Ma Cai', 'Văn Bàn'
    ],
    'Long An': [
        'TP. Tân An', 'Thị xã Kiến Tường', 'Bến Lức', 'Cần Đước', 'Cần Giuộc', 'Châu Thành',
        'Đức Hòa', 'Đức Huệ', 'Mộc Hóa', 'Tân Hưng', 'Tân Thạnh', 'Tân Trụ', 'Thạnh Hóa', 'Thủ Thừa', 'Vĩnh Hưng'
    ],
    'Nam Định': [
        'TP. Nam Định', 'Giao Thủy', 'Hải Hậu', 'Nam Trực', 'Nghĩa Hưng', 'Trực Ninh', 'Vụ Bản', 'Xuân Trường', 'Ý Yên'
    ],
    'Nghệ An': [
        'TP. Vinh', 'Cửa Lò', 'Thị xã Hoàng Mai', 'Thị xã Thái Hòa', 'Anh Sơn', 'Con Cuông',
        'Diễn Châu', 'Đô Lương', 'Hưng Nguyên', 'Kỳ Sơn', 'Nam Đàn', 'Nghi Lộc', 'Nghĩa Đàn',
        'Quế Phong', 'Quỳ Châu', 'Quỳ Hợp', 'Quỳnh Lưu', 'Tân Kỳ', 'Thanh Chương', 'Tương Dương', 'Yên Thành'
    ],
    'Ninh Bình': [
        'TP. Ninh Bình', 'TP. Tam Điệp', 'Gia Viễn', 'Hoa Lư', 'Kim Sơn', 'Nho Quan', 'Yên Khánh', 'Yên Mô'
    ],
    'Ninh Thuận': [
        'TP. Phan Rang - Tháp Chàm', 'Bác Ái', 'Ninh Hải', 'Ninh Phước', 'Ninh Sơn', 'Thuận Bắc', 'Thuận Nam'
    ],
    'Phú Thọ': [
        'TP. Việt Trì', 'Thị xã Phú Thọ', 'Cẩm Khê', 'Đoan Hùng', 'Hạ Hòa', 'Lâm Thao',
        'Phù Ninh', 'Tam Nông', 'Tân Sơn', 'Thanh Ba', 'Thanh Sơn', 'Thanh Thủy', 'Yên Lập'
    ],
    'Phú Yên': [
        'TP. Tuy Hòa', 'Thị xã Đông Hòa', 'Thị xã Sông Cầu', 'Đồng Xuân', 'Phú Hòa', 'Sơn Hòa', 'Sông Hinh', 'Tây Hòa', 'Tuy An'
    ],
    'Quảng Bình': [
        'TP. Đồng Hới', 'Thị xã Ba Đồn', 'Bố Trạch', 'Lệ Thủy', 'Minh Hóa', 'Quảng Ninh', 'Quảng Trạch', 'Tuyên Hóa'
    ],
    'Quảng Nam': [
        'TP. Tam Kỳ', 'TP. Hội An', 'Thị xã Điện Bàn', 'Bắc Trà My', 'Đại Lộc', 'Đông Giang',
        'Duy Xuyên', 'Hiệp Đức', 'Nam Giang', 'Nam Trà My', 'Nông Sơn', 'Núi Thành', 'Phú Ninh',
        'Phước Sơn', 'Quế Sơn', 'Tây Giang', 'Thăng Bình', 'Tiên Phước'
    ],
    'Quảng Ngãi': [
        'TP. Quảng Ngãi', 'Thị xã Đức Phổ', 'Ba Tơ', 'Bình Sơn', 'Lý Sơn', 'Minh Long',
        'Mộ Đức', 'Nghĩa Hành', 'Sơn Hà', 'Sơn Tây', 'Sơn Tịnh', 'Trà Bồng', 'Tư Nghĩa'
    ],
    'Quảng Ninh': [
        'Hạ Long', 'Cẩm Phả', 'Móng Cái', 'Uông Bí', 'TP. Đông Triều', 'Thị xã Quảng Yên',
        'Ba Chẽ', 'Bình Liêu', 'Cô Tô', 'Đầm Hà', 'Hải Hà', 'Tiên Yên', 'Vân Đồn'
    ],
    'Quảng Trị': [
        'TP. Đông Hà', 'Thị xã Quảng Trị', 'Cam Lộ', 'Cồn Cỏ', 'Đa Krông', 'Gio Linh', 'Hải Lăng', 'Hướng Hóa', 'Triệu Phong', 'Vĩnh Linh'
    ],
    'Sóc Trăng': [
        'TP. Sóc Trăng', 'Thị xã Ngã Năm', 'Thị xã Vĩnh Châu', 'Châu Thành', 'Cù Lao Dung',
        'Kế Sách', 'Long Phú', 'Mỹ Tú', 'Mỹ Xuyên', 'Thạnh Trị', 'Trần Đề'
    ],
    'Sơn La': [
        'TP. Sơn La', 'Thị xã Mộc Châu', 'Bắc Yên', 'Mai Sơn', 'Mường La', 'Phù Yên',
        'Quỳnh Nhai', 'Sông Mã', 'Sốp Cộp', 'Thuận Châu', 'Vân Hồ', 'Yên Châu'
    ],
    'Tây Ninh': [
        'TP. Tây Ninh', 'Thị xã Hòa Thành', 'Thị xã Trảng Bàng', 'Bến Cầu', 'Châu Thành',
        'Dương Minh Châu', 'Gò Dầu', 'Tân Biên', 'Tân Châu'
    ],
    'Thái Bình': [
        'TP. Thái Bình', 'Đông Hưng', 'Hưng Hà', 'Kiến Xương', 'Quỳnh Phụ', 'Thái Thụy', 'Tiền Hải', 'Vũ Thư'
    ],
    'Thái Nguyên': [
        'TP. Thái Nguyên', 'Sông Công', 'Phổ Yên', 'Đại Từ', 'Định Hóa', 'Đồng Hỷ', 'Phú Bình', 'Phú Lương', 'Võ Nhai'
    ],
    'Thanh Hóa': [
        'TP. Thanh Hóa', 'Sầm Sơn', 'Bỉm Sơn', 'Thị xã Nghi Sơn', 'Bá Thước', 'Cẩm Thủy',
        'Đông Sơn', 'Hà Trung', 'Hậu Lộc', 'Hoằng Hóa', 'Lang Chánh', 'Mường Lát', 'Nga Sơn',
        'Ngọc Lặc', 'Như Thanh', 'Như Xuân', 'Nông Cống', 'Quan Hóa', 'Quan Sơn', 'Quảng Xương',
        'Thạch Thành', 'Thiệu Hóa', 'Thọ Xuân', 'Thường Xuân', 'Triệu Sơn', 'Vĩnh Lộc', 'Yên Định'
    ],
    'Thừa Thiên Huế': [
        'TP. Huế', 'Hương Thủy', 'Hương Trà', 'A Lưới', 'Nam Đông', 'Phong Điền', 'Phú Lộc', 'Phú Vang', 'Quảng Điền'
    ],
    'Tiền Giang': [
        'TP. Mỹ Tho', 'TP. Gò Công', 'Thị xã Cai Lậy', 'Cái Bè', 'Huyện Cai Lậy', 'Châu Thành',
        'Chợ Gạo', 'Gò Công Đông', 'Gò Công Tây', 'Tân Phú Đông', 'Tân Phước'
    ],
    'Trà Vinh': [
        'TP. Trà Vinh', 'Thị xã Duyên Hải', 'Càng Long', 'Cầu Kè', 'Cầu Ngang', 'Châu Thành',
        'Huyện Duyên Hải', 'Tiểu Cần', 'Trà Cú'
    ],
    'Tuyên Quang': [
        'TP. Tuyên Quang', 'Chiêm Hóa', 'Hàm Yên', 'Lâm Bình', 'Na Hang', 'Sơn Dương', 'Yên Sơn'
    ],
    'Vĩnh Long': [
        'TP. Vĩnh Long', 'Thị xã Bình Minh', 'Bình Tân', 'Long Hồ', 'Mang Thít', 'Tam Bình', 'Trà Ôn', 'Vũng Liêm'
    ],
    'Vĩnh Phúc': [
        'TP. Vĩnh Yên', 'TP. Phúc Yên', 'Bình Xuyên', 'Lập Thạch', 'Sông Lô', 'Tam Đảo', 'Tam Dương', 'Vĩnh Tường', 'Yên Lạc'
    ],
    'Yên Bái': [
        'TP. Yên Bái', 'Thị xã Nghĩa Lộ', 'Lục Yên', 'Mù Cang Chải', 'Trạm Tấu', 'Trấn Yên', 'Văn Chấn', 'Văn Yên', 'Yên Bình'
    ]
};

const EXPLICIT_WARDS_BY_DISTRICT = {
    'Hà Nội|Ba Đình': ['Cống Vị', 'Điện Biên', 'Đội Cấn', 'Giảng Võ', 'Kim Mã', 'Liễu Giai', 'Ngọc Hà', 'Ngọc Khánh', 'Nguyễn Trung Trực', 'Phúc Xá', 'Quán Thánh', 'Thành Công', 'Trúc Bạch', 'Vĩnh Phúc'],
    'Hà Nội|Bắc Từ Liêm': ['Cổ Nhuế 1', 'Cổ Nhuế 2', 'Đông Ngạc', 'Đức Thắng', 'Liên Mạc', 'Minh Khai', 'Phú Diễn', 'Phúc Diễn', 'Tây Tựu', 'Thượng Cát', 'Thụy Phương', 'Xuân Đỉnh', 'Xuân Tảo'],
    'Hà Nội|Cầu Giấy': ['Dịch Vọng', 'Dịch Vọng Hậu', 'Mai Dịch', 'Nghĩa Đô', 'Nghĩa Tân', 'Quan Hoa', 'Trung Hòa', 'Yên Hòa'],
    'Hà Nội|Đống Đa': ['Cát Linh', 'Hàng Bột', 'Khâm Thiên', 'Khương Thượng', 'Kim Liên', 'Láng Hạ', 'Láng Thượng', 'Nam Đồng', 'Ngã Tư Sở', 'Ô Chợ Dừa', 'Phương Liên', 'Phương Mai', 'Quang Trung', 'Quốc Tử Giám', 'Thịnh Quang', 'Thổ Quan', 'Trung Liệt', 'Trung Phụng', 'Trung Tự', 'Văn Chương', 'Văn Miếu'],
    'Hà Nội|Hà Đông': ['Biên Giang', 'Đồng Mai', 'Dương Nội', 'Hà Cầu', 'Kiến Hưng', 'La Khê', 'Mộ Lao', 'Nguyễn Trãi', 'Phú La', 'Phú Lãm', 'Phú Lương', 'Phúc La', 'Quang Trung', 'Vạn Phúc', 'Văn Quán', 'Yên Nghĩa', 'Yết Kiêu'],
    'Hà Nội|Hai Bà Trưng': ['Bách Khoa', 'Bạch Đằng', 'Bạch Mai', 'Cầu Dền', 'Đống Mác', 'Đồng Nhân', 'Đồng Tâm', 'Lê Đại Hành', 'Minh Khai', 'Ngô Thì Nhậm', 'Nguyễn Du', 'Phạm Đình Hổ', 'Phố Huế', 'Quỳnh Lôi', 'Quỳnh Mai', 'Thanh Lương', 'Thanh Nhàn', 'Trương Định', 'Vĩnh Tuy'],
    'Hà Nội|Hoàn Kiếm': ['Chương Dương', 'Cửa Đông', 'Cửa Nam', 'Đồng Xuân', 'Hàng Bạc', 'Hàng Bài', 'Hàng Bồ', 'Hàng Bông', 'Hàng Buồm', 'Hàng Đào', 'Hàng Gai', 'Hàng Mã', 'Hàng Trống', 'Lý Thái Tổ', 'Phan Chu Trinh', 'Phúc Tân', 'Trần Hưng Đạo', 'Tràng Tiền'],
    'Hà Nội|Hoàng Mai': ['Đại Kim', 'Định Công', 'Giáp Bát', 'Hoàng Liệt', 'Hoàng Văn Thụ', 'Lĩnh Nam', 'Mai Động', 'Tân Mai', 'Thanh Trì', 'Thịnh Liệt', 'Trần Phú', 'Tương Mai', 'Vĩnh Hưng', 'Yên Sở'],
    'Hà Nội|Long Biên': ['Bồ Đề', 'Cự Khối', 'Đức Giang', 'Gia Thụy', 'Giang Biên', 'Long Biên', 'Ngọc Lâm', 'Ngọc Thụy', 'Phúc Đồng', 'Phúc Lợi', 'Sài Đồng', 'Thạch Bàn', 'Thượng Thanh', 'Việt Hưng'],
    'Hà Nội|Nam Từ Liêm': ['Cầu Diễn', 'Đại Mỗ', 'Mễ Trì', 'Mỹ Đình 1', 'Mỹ Đình 2', 'Phú Đô', 'Phương Canh', 'Tây Mỗ', 'Trung Văn', 'Xuân Phương'],
    'Hà Nội|Tây Hồ': ['Bưởi', 'Nhật Tân', 'Phú Thượng', 'Quảng An', 'Thụy Khuê', 'Tứ Liên', 'Xuân La', 'Yên Phụ'],
    'Hà Nội|Thanh Xuân': ['Hạ Đình', 'Khương Đình', 'Khương Mai', 'Khương Trung', 'Kim Giang', 'Nhân Chính', 'Phương Liệt', 'Thanh Xuân Bắc', 'Thanh Xuân Nam', 'Thanh Xuân Trung', 'Thượng Đình'],
    'Hà Nội|Gia Lâm': ['Thị trấn Trâu Quỳ', 'Thị trấn Yên Viên', 'Đa Tốn', 'Dương Xá', 'Kiêu Kỵ', 'Cổ Bi', 'Đặng Xá'],
    'Hà Nội|Hoài Đức': ['Thị trấn Trạm Trôi', 'An Khánh', 'An Thượng', 'Di Trạch', 'Đức Giang', 'Kim Chung', 'La Phù', 'Lại Yên', 'Vân Canh'],
    'Hà Nội|Đông Anh': ['Thị trấn Đông Anh', 'Cổ Loa', 'Đông Hội', 'Hải Bối', 'Kim Chung', 'Kim Nỗ', 'Tiên Dương', 'Uy Nỗ', 'Vĩnh Ngọc'],
    'TP.HCM|TP. Thủ Đức': ['An Khánh', 'An Phú', 'Bình Chiểu', 'Bình Thọ', 'Cát Lái', 'Hiệp Bình Chánh', 'Hiệp Bình Phước', 'Hiệp Phú', 'Linh Chiểu', 'Linh Đông', 'Linh Tây', 'Linh Trung', 'Linh Xuân', 'Long Bình', 'Long Thạnh Mỹ', 'Phước Bình', 'Phước Long A', 'Phước Long B', 'Tam Bình', 'Tam Phú', 'Tăng Nhơn Phú A', 'Tăng Nhơn Phú B', 'Thảo Điền', 'Trường Thọ'],
    'TP.HCM|Quận 1': ['Bến Nghé', 'Bến Thành', 'Cầu Kho', 'Cầu Ông Lãnh', 'Cô Giang', 'Đa Kao', 'Nguyễn Cư Trinh', 'Nguyễn Thái Bình', 'Phạm Ngũ Lão', 'Tân Định'],
    'TP.HCM|Quận 3': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Võ Thị Sáu', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14'],
    'TP.HCM|Quận 4': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 6', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 16', 'Phường 18'],
    'TP.HCM|Quận 5': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14'],
    'TP.HCM|Quận 6': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14'],
    'TP.HCM|Quận 7': ['Bình Thuận', 'Phú Mỹ', 'Phú Thuận', 'Tân Hưng', 'Tân Kiểng', 'Tân Phong', 'Tân Phú', 'Tân Quy', 'Tân Thuận Đông', 'Tân Thuận Tây'],
    'TP.HCM|Quận 8': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 16'],
    'TP.HCM|Quận 10': ['Phường 1', 'Phường 2', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15'],
    'TP.HCM|Quận 11': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 16'],
    'TP.HCM|Quận 12': ['An Phú Đông', 'Đông Hưng Thuận', 'Hiệp Thành', 'Tân Chánh Hiệp', 'Tân Hưng Thuận', 'Tân Thới Hiệp', 'Tân Thới Nhất', 'Thạnh Lộc', 'Thạnh Xuân', 'Thới An', 'Trung Mỹ Tây'],
    'TP.HCM|Bình Tân': ['An Lạc', 'An Lạc A', 'Bình Hưng Hòa', 'Bình Hưng Hòa A', 'Bình Hưng Hòa B', 'Bình Trị Đông', 'Bình Trị Đông A', 'Bình Trị Đông B', 'Tân Tạo', 'Tân Tạo A'],
    'TP.HCM|Bình Thạnh': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 17', 'Phường 19', 'Phường 21', 'Phường 22', 'Phường 24', 'Phường 25', 'Phường 26', 'Phường 27', 'Phường 28'],
    'TP.HCM|Gò Vấp': ['Phường 1', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 16', 'Phường 17'],
    'TP.HCM|Phú Nhuận': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 13', 'Phường 15', 'Phường 17'],
    'TP.HCM|Tân Bình': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15'],
    'TP.HCM|Tân Phú': ['Hiệp Tân', 'Hòa Thạnh', 'Phú Thạnh', 'Phú Thọ Hòa', 'Phú Trung', 'Sơn Kỳ', 'Tân Quý', 'Tân Sơn Nhì', 'Tân Thành', 'Tân Thới Hòa', 'Tây Thạnh'],
    'Đà Nẵng|Hải Châu': ['Bình Hiên', 'Bình Thuận', 'Hải Châu 1', 'Hải Châu 2', 'Hòa Cường Bắc', 'Hòa Cường Nam', 'Hòa Thuận Đông', 'Hòa Thuận Tây', 'Nam Dương', 'Phước Ninh', 'Thạch Thang', 'Thanh Bình', 'Thuận Phước'],
    'Đà Nẵng|Sơn Trà': ['An Hải Bắc', 'An Hải Đông', 'An Hải Tây', 'Mân Thái', 'Nại Hiên Đông', 'Phước Mỹ', 'Thọ Quang'],
    'Đà Nẵng|Ngũ Hành Sơn': ['Hòa Hải', 'Hòa Quý', 'Khuê Mỹ', 'Mỹ An'],
    'Đà Nẵng|Liên Chiểu': ['Hòa Hiệp Bắc', 'Hòa Hiệp Nam', 'Hòa Khánh Bắc', 'Hòa Khánh Nam', 'Hòa Minh'],
    'Cần Thơ|Ninh Kiều': ['An Bình', 'An Cư', 'An Hòa', 'An Khánh', 'An Nghiệp', 'An Phú', 'Cái Khế', 'Hưng Lợi', 'Tân An', 'Thới Bình', 'Xuân Khánh'],
    'Bình Dương|Dĩ An': ['An Bình', 'Bình An', 'Bình Thắng', 'Dĩ An', 'Đông Hòa', 'Tân Bình', 'Tân Đông Hiệp'],
    'Bình Dương|Thuận An': ['An Phú', 'An Sơn', 'An Thạnh', 'Bình Chuẩn', 'Bình Hòa', 'Bình Nhâm', 'Hưng Định', 'Lái Thiêu', 'Thuận Giao', 'Vĩnh Phú'],
    'Đồng Nai|Biên Hòa': ['An Bình', 'Bình Đa', 'Bửu Hòa', 'Bửu Long', 'Hóa An', 'Hố Nai', 'Long Bình', 'Long Bình Tân', 'Quang Vinh', 'Quyết Thắng', 'Tam Hiệp', 'Tam Hòa', 'Tân Biên', 'Tân Hiệp', 'Tân Hòa', 'Tân Mai', 'Tân Phong', 'Tân Tiến', 'Tân Vạn', 'Thanh Bình', 'Thống Nhất', 'Trảng Dài', 'Trung Dũng']
};

const buildDefaultWardsForDistrict = (district) => {
    const cleanName = district
        .replace(/^(TP\.|Thị xã|Huyện|Quận)\s+/i, '')
        .trim();

    if (/^TP\./i.test(district)) {
        return ['Phường 1', 'Phường 2', 'Phường 3', 'Phường Trung Tâm', `Phường ${cleanName}`];
    }
    if (/^Thị xã/i.test(district)) {
        return [`Phường ${cleanName}`, 'Phường Trung Tâm', 'Phường 1', 'Phường 2'];
    }
    return [`Thị trấn ${cleanName}`, `Xã Trung Tâm (${cleanName})`];
};

const buildCompleteWardsMap = () => {
    const result = {};
    for (const [city, districts] of Object.entries(VN_DISTRICTS_BY_CITY)) {
        for (const district of districts) {
            const key = `${city}|${district}`;
            const explicit = EXPLICIT_WARDS_BY_DISTRICT[key];
            result[key] = explicit && explicit.length > 0 ? explicit : buildDefaultWardsForDistrict(district);
        }
    }
    return result;
};

const VN_CITY_ALIASES = {
    'TP.HCM': ['tp hcm', 'tphcm', 'tp ho chi minh', 'ho chi minh', 'sai gon'],
    'Hà Nội': ['ha noi', 'hanoi'],
    'Thừa Thiên Huế': ['thua thien hue', 'thanh pho hue', 'tp hue'],
    'Khánh Hòa': ['khanh hoa', 'nha trang'],
    'Lâm Đồng': ['lam dong', 'da lat'],
    'Bà Rịa - Vũng Tàu': ['ba ria vung tau', 'vung tau', 'ba ria'],
    'Quảng Ninh': ['quang ninh', 'ha long'],
    'Đắk Lắk': ['dak lak', 'dac lac', 'buon ma thuot'],
    'Bình Định': ['binh dinh', 'quy nhon'],
    'Kiên Giang': ['kien giang', 'rach gia', 'phu quoc'],
    'Bình Thuận': ['binh thuan', 'phan thiet'],
    'Tiền Giang': ['tien giang', 'my tho'],
    'An Giang': ['an giang', 'long xuyen'],
    'Nghệ An': ['nghe an', 'tp vinh']
};

const sortCitiesWithPriority = (cities) =>
    [...cities].sort((a, b) => {
        const idxA = PRIORITY_VN_CITIES.indexOf(a);
        const idxB = PRIORITY_VN_CITIES.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b, 'vi');
    });

const DEFAULT_VN_LOCATIONS = {
    cities: sortCitiesWithPriority(Object.keys(VN_DISTRICTS_BY_CITY)),
    districtsByCity: VN_DISTRICTS_BY_CITY,
    wardsByDistrict: buildCompleteWardsMap()
};

const CITY_ADDRESS_PATTERNS = DEFAULT_VN_LOCATIONS.cities.map((city) => {
    const baseNorm = normalizeText(city).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    const extraAliases = VN_CITY_ALIASES[city] || [];
    const patterns = Array.from(new Set([baseNorm, ...extraAliases]));
    return { city, patterns };
});

const stripAdminPrefix = (name) =>
    normalizeText(name)
        .replace(/[.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(tp|thanh pho|thi xa|tx|huyen)\s+/, '');

const districtMatchesAddress = (normAddr, districtName) => {
    const full = normalizeText(districtName).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (containsToken(normAddr, full)) return true;
    const stripped = stripAdminPrefix(districtName);
    return stripped !== full && stripped.length >= 3 && containsToken(normAddr, stripped);
};

const inferLocationFromAddress = (address) => {
    const raw = String(address || '').trim();
    if (!raw) return { city: '', district: '', ward: '' };

    const normAddr = normalizeText(raw).replace(/[.,-]/g, ' ').replace(/\s+/g, ' ').trim();
    let city = '';
    for (const entry of CITY_ADDRESS_PATTERNS) {
        if (entry.patterns.some((p) => containsToken(normAddr, p))) {
            city = entry.city;
            break;
        }
    }

    let district = '';
    if (city) {
        const candidates = [...(DEFAULT_VN_LOCATIONS.districtsByCity[city] || [])].sort(
            (a, b) => b.length - a.length
        );
        district = candidates.find((d) => districtMatchesAddress(normAddr, d)) || '';
    } else {
        const allCandidates = Object.entries(DEFAULT_VN_LOCATIONS.districtsByCity)
            .flatMap(([c, ds]) => ds.map((d) => ({ c, d })))
            .sort((a, b) => b.d.length - a.d.length);
        const hit = allCandidates.find((item) => districtMatchesAddress(normAddr, item.d));
        if (hit) {
            city = hit.c;
            district = hit.d;
        }
    }

    let ward = '';
    if (city && district) {
        const wards = [...(DEFAULT_VN_LOCATIONS.wardsByDistrict[`${city}|${district}`] || [])].sort(
            (a, b) => b.length - a.length
        );
        ward =
            wards.find((w) => containsToken(normAddr, normalizeText(w).replace(/\s+/g, ' '))) || '';
    }

    if (!city || !district) {
        const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2 && !city) {
            const last = parts[parts.length - 1];
            const lastNorm = normalizeText(last).replace(/[.,-]/g, ' ').replace(/\s+/g, ' ').trim();
            const matched = CITY_ADDRESS_PATTERNS.find((entry) =>
                entry.patterns.some((p) => containsToken(lastNorm, p))
            );
            if (matched) city = matched.city;
            else if (parts.length >= 3) city = last;
        }
        if (parts.length >= 3 && !district) {
            district = parts[parts.length - 2];
        }
        if (parts.length >= 4 && !ward) {
            ward = parts[parts.length - 3];
        }
    }

    return { city, district, ward };
};

module.exports = {
    normalizeText,
    canonicalCityName,
    DEFAULT_VN_LOCATIONS,
    inferLocationFromAddress
};

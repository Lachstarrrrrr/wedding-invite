/* ==========================================================================
   Wedding Invite  script.js (FULL REWRITE  FIX PACK)
   --------------------------------------------------------------------------
   Fixes included (per your notes):
   1) Initial invite card/overlay reliably initializes (works even if script is in <head>)
   2) Envelope red SVG crease overlay aligns to the same CSS vars as the cropping:
      - reads --crease-* vars from the *correct* element (walks up the DOM)
      - forces SVG sizing + preserveAspectRatio so it cannot letterbox
      - updates on resize + layout changes (ResizeObserver)
   3) Film reel keeps moving even when hovered:
      - forcibly sets animation-play-state to running on the animated elements
      - re-applies on pointer events (to defeat CSS :hover pause rules)
   4) Bride/Groom wedding photos swapped back to correct sides (best-effort selector set)
   -------------------------------------------------------------------------- */

(() => {
    "use strict";

    // =========================================================
    // CONFIG (EDIT THESE)
    // =========================================================
    const WEDDING_DATE_ISO = "2026-01-24T10:30:00+07:00";

    const ALBUM_FILM_IMAGES = [
        "./assets/photos/Aus%20Photos/IMG_0380.JPG",
        "./assets/photos/Edited%20Photos/RIC_0001.jpg",
        "./assets/photos/Edited%20Photos/RIC_0138.jpg",
        "./assets/photos/Edited%20Photos/RIC_9354.jpg",
        "./assets/photos/Edited%20Photos/RIC_9806.jpg",
        "./assets/photos/Edited%20Photos/RIC_9287.jpg",
    ];

    const GALLERY_IMAGES = [
        "./assets/photos/Edited%20Photos/RIC_0769.jpg",
        "./assets/photos/Edited%20Photos/RIC_0386.jpg",
        "./assets/photos/Edited%20Photos/RIC_9296.jpg",
        "./assets/photos/Edited%20Photos/RIC_9755.jpg",
        "./assets/photos/Edited%20Photos/RIC_9377.jpg",
        "./assets/photos/Edited%20Photos/RIC_0494.jpg",
        "./assets/photos/Edited%20Photos/RIC_0637.jpg",
        "./assets/photos/Edited%20Photos/RIC_9727.jpg",
        "./assets/photos/Edited%20Photos/RIC_9738.jpg",
        "./assets/photos/Edited%20Photos/RIC_9890.jpg",
    ];

    const DRESS_DOT_COLORS = ["#fbf3e8", "#231713", "#ffffff"];

    const RSVP_ENDPOINT = "https://formspree.io/f/xgovdbzb";
    const RSVP_MAILTO_TO = "";

    // If false, the invite overlay shows on every page load until the seal is clicked.
    const PERSIST_ENTERED = false;

    const LS = {
        entered: "wedding_entered",
        lang: "wedding_lang",
        music: "wedding_music",
    };

    // =========================================================
    // HELPERS
    // =========================================================
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
    const pad2 = (n) => String(Math.max(0, n)).padStart(2, "0");

    const prefersReducedMotion = () =>
        window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const sampleArray = (arr, n) => {
        const copy = arr.slice();
        for (let i = copy.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy.slice(0, Math.min(n, copy.length));
    };

    const getLS = (k, fallback = null) => {
        try {
            const v = localStorage.getItem(k);
            return v === null ? fallback : v;
        } catch {
            return fallback;
        }
    };

    const setLS = (k, v) => {
        try {
            localStorage.setItem(k, v);
        } catch {
            /* ignore */
        }
    };

    const removeLS = (k) => {
        try {
            localStorage.removeItem(k);
        } catch {
            /* ignore */
        }
    };

    const onReady = (fn) => {
        if (document.readyState === "complete" || document.readyState === "interactive") {
            // run next tick so layout is available
            setTimeout(fn, 0);
            return;
        }
        document.addEventListener("DOMContentLoaded", fn, { once: true });
    };

    const firstEl = (selectors, root = document) => {
        for (const sel of selectors) {
            const el = root.querySelector(sel);
            if (el) return el;
        }
        return null;
    };

    // Walk up the DOM looking for a non-empty CSS var value
    const getCssVar = (startEl, varName) => {
        let el = startEl;
        while (el && el !== document.documentElement) {
            const cs = getComputedStyle(el);
            const v = cs.getPropertyValue(varName);
            if (v && String(v).trim() !== "") return { el, value: String(v).trim() };
            el = el.parentElement;
        }
        // fallback to root
        const rootCS = getComputedStyle(document.documentElement);
        const rv = rootCS.getPropertyValue(varName);
        return { el: document.documentElement, value: String(rv || "").trim() };
    };

    const parsePercent = (raw, fallback) => {
        if (raw == null) return fallback;
        const s = String(raw).trim();
        if (!s) return fallback;
        if (s.endsWith("%")) {
            const n = parseFloat(s.slice(0, -1));
            return Number.isFinite(n) ? n : fallback;
        }
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : fallback;
    };

    const parseAttrMap = (s) => {
        // "title:key;aria-label:key2"
        return String(s)
            .split(";")
            .map((chunk) => chunk.trim())
            .filter(Boolean)
            .map((pair) => {
                const idx = pair.indexOf(":");
                if (idx < 0) return null;
                return { attr: pair.slice(0, idx).trim(), key: pair.slice(idx + 1).trim() };
            })
            .filter(Boolean);
    };

    // =========================================================
    // STATE
    // =========================================================
    const state = {
        entered: PERSIST_ENTERED ? getLS(LS.entered, "0") === "1" : false,
        lang: (() => {
            const saved = getLS(LS.lang, "");
            return saved === "en" || saved === "vi" ? saved : "vi";
        })(),
        musicOn: getLS(LS.music, "0") === "1",
        galleryIndex: 0,
    };

    // =========================================================
    // i18n DICTIONARY (UNCHANGED)
    // =========================================================
    const I18N = /* pasted as-is from your file */ {
        vi: {
            "doc.title": "Thùy Phương & Mitchell Lachlan - Thiệp cưới",
            "doc.description": "Thiệp mời cưới của Thùy Phương và Mitchell Lachlan - 24/01/2026",
            "overlay.openInvitation": "Mở thiệp mời",
            "overlay.flipInvitation": "Lật thiệp mời",
            "overlay.save": "SAVE",
            "overlay.the": "the",
            "overlay.date": "DATE",
            "overlay.inviteLine": "Thân mời",
            "overlay.tapToOpen": "Chạm để mở",
            "overlay.breakSeal": "Phá niêm phong",
            "overlay.tapSealToEnter": "Chạm vào con dấu để vào thiệp",
            "audio.unsupported": "Trình duyệt của bạn không hỗ trợ audio.",
            "topbar.titleAria": "Thanh tiêu đề",
            "topbar.musicTitle": "Bật/Tắt nhạc nền",
            "topbar.musicAria": "Bật/Tắt nhạc nền",
            "topbar.langTitle": "Đổi ngôn ngữ",
            "topbar.langAria": "Đổi ngôn ngữ",
            "hero.sectionAria": "Ảnh bìa",
            "hero.gettingMarried": "Chúng mình cưới rồi!",
            "hero.titleAria": "Tên cô dâu chú rể",
            "hero.dateAria": "Ngày cưới",
            "dateBanner.sectionAria": "Đếm ngược",
            "dateBanner.lead": "CHÚNG MÌNH SẼ TRỞ THÀNH<br>VỢ CHỒNG TRONG",
            "dateBanner.timerAria": "Đếm ngược tới ngày cưới",
            "saveDate.sectionAria": "Save the date",
            "saveDate.titleAria": "Save the date",
            "saveDate.save": "SAVE",
            "saveDate.the": "the",
            "saveDate.date": "DATE",
            "childhood.sectionAria": "Ảnh hồi nhỏ",
            "childhood.title": "Khi Chúng Mình Còn Bé",
            "childhood.subtitle": "Một chút hồi ức trước ngày trọng đại.",
            "childhood.stageAria": "Khung ảnh hồi nhỏ",
            "childhood.leftAlt": "Ảnh hồi nhỏ của cô dâu",
            "childhood.rightAlt": "Ảnh hồi nhỏ của chú rể",
            "family.sectionAria": "Thông tin gia đình",
            "family.brideSideHead": "NHÀ GÁI",
            "family.groomSideHead": "NHÀ TRAI",
            "family.brideSideBody": "Ông: Trương Kỳ Phong<br />Bà: Nguyễn Thanh Thảo<br />Địa chỉ: Ấp Bình Phú, xã Nhơn Trạch, Tỉnh Đồng Nai (địa chỉ mới)",
            "family.groomSideBody": "Ông: Cook Lenard Leslie<br />Bà: Cook Amy Michelle<br />Địa chỉ: Melbourne - VIC Australia",
            "family.inviteLine": "Thân mời đến dự lễ thành hôn của chúng tôi!",
            "family.coupleAria": "Tên cô dâu và chú rể",
            "family.andWord": "và",
            "family.whenAria": "Thời gian tổ chức",
            "family.whenLabel": "Được tổ chức vào lúc",
            "family.whenMain": "10:30 - THỨ BẢY",
            "family.address": "1551 Lý Thái Tổ, Long Tân, Nhơn Trạch, Đồng Nai, Vietnam",
            "family.directionsAria": "Đi tới địa điểm",
            "family.directionsBtn": "CHỈ ĐƯỜNG",
            "story.sectionAria": "Câu chuyện",
            "story.titleAria": "Câu chuyện tình yêu",
            "story.titleA": "CÂU CHUYỆN",
            "story.titleOf": "về",
            "story.titleB": "TÌNH YÊU",
            "story.cardsAria": "Thẻ giới thiệu",
            "story.bridePhotoAlt": "Ảnh cô dâu",
            "story.groomPhotoAlt": "Ảnh chú rể",
            "story.brideInfoAria": "Thông tin cô dâu",
            "story.groomInfoAria": "Thông tin chú rể",
            "story.brideRole": "Cô dâu",
            "story.groomRole": "Chú rể",
            "story.timelineAria": "Dòng thời gian câu chuyện",
            "story.y2022.title": "2022 - GẶP GỠ ĐỊNH MỆNH",
            "story.y2022.text":
                "Chúng tôi hai con người, ở hai quốc gia khác nhau, tưởng chừng sẽ không thể hòa hợp. Tình yêu đối với chúng tôi lúc đó không chỉ là sự thấu hiểu giữa hai tính cách nữa, mà còn là sự khác biệt về ngôn ngữ, văn hóa. Đó là rào cản đầu tiên khi chúng tôi bắt đầu tìm hiểu về đối phương. Cả hai mang trong mình những hoài bão khác biệt, một tương lai mà cả hai chưa bao giờ nghĩ sẽ gặp gỡ và đồng hành cùng nhau. Một thành phố nhỏ và bình yên nằm ở phía Bắc nước Úc nơi chúng tôi lần đầu gặp nhau và quyết định nắm tay đi tiếp chặng đường còn lại.",
            "story.y2023.title": "2023 - HẸN HÒ",
            "story.y2023.text":
                "Tình yêu thuở bắt đầu bao giờ cũng ngọt ngào và lãng mạn, cùng nhau xem phim, du lịch, cùng cười, cùng buồn và ty tỷ những thứ lo âu về một mối quan hệ lâu bền, và những kế hoạch cho tương lai.",
            "story.y2024.title": "2024 - LỜI HỨA",
            "story.y2024.text":
                "Càng đi cùng nhau, cả hai điều nhận thấy sự hiện diện của nữa kia trong cuộc sống của mình như một điều không thể thiếu, và được sắp đặt trước. Chúng tôi đã bắt đầu nghiêm túc về mối quan hệ của cả hai... Dưới sự chấp thuận của gia đình hai bên, tình yêu của chúng tôi như được chấp thêm đôi cánh.",
            "story.y2025.title": "2025 - CẦU HÔN",
            "story.y2025.text":
                "Một năm với nhiều điều trắc trở, những vui buồn, những bộn bề cứ lần lượt gõ cửa, nhưng rồi mọi thứ cũng trôi qua và chúng tôi vẫn ở đây cùng nhau, có một nơi gọi là nhà, có một người luôn đợi ta trở về. Chúng tôi đã có một buổi lễ kết hôn thân mật và ấp áp ở thành phố nhỏ Darwin nơi tình yêu của chúng tôi bắt đầu và giờ 2026 đã đến dưới sự mong chờ và chúc phúc của mọi người ở Việt Nam một lễ cưới sẽ được tổ chức ấm áp tại gia đình chúng tôi... và sự có mặt của Bạn, những người thân yêu của chúng tôi vào hôm đấy sẽ là một trong những kỷ niệm đẹp mà chúng tôi sẽ cất giữ mãi trên hành trình này. Cũng như việc hôm nay ngồi lại, viết về hành trình yêu thương của chúng tôi và chia sẽ cùng Bạn. Thương Mến",
            "album.sectionAria": "Album",
            "album.filmstripAria": "Dải phim",
            "album.collageAria": "Bố cục album",
            "album.titleAria": "Tiêu đề album",
            "album.subAria": "Phụ đề album",
            "album.the": "The",
            "album.album": "ALBUM",
            "album.of": "OF",
            "album.love": "LOVE",
            "album.photoAlt": "Ảnh cưới",
            "gallery.sectionAria": "Thư viện ảnh",
            "gallery.stageAria": "Trình xem ảnh",
            "gallery.selectedAria": "Ảnh đang chọn",
            "gallery.mainAlt": "Ảnh chính",
            "gallery.prevAria": "Ảnh trước",
            "gallery.nextAria": "Ảnh sau",
            "gallery.thumbsAria": "Ảnh thu nhỏ",
            "dress.sectionAria": "Trang phục",
            "dress.title": "DRESS CODE",
            "dress.dotsAria": "Màu dress code",
            "timeline.sectionAria": "Lịch trình",
            "timeline.railAria": "Lịch trình sự kiện",
            "timeline.title": "LỊCH TRÌNH",
            "timeline.node1": "ĐÓN TIẾP<br>KHÁCH MỜI",
            "timeline.node2": "BẮT ĐẦU<br>LỄ THÀNH HÔN",
            "timeline.node3": "CHUNG VUI<br>KHAI TIỆC",
            "timeline.node4": "KARAOKE<br>VÀ KHIÊU VŨ",
            "location.sectionAria": "Địa điểm",
            "location.title": "ĐỊA ĐIỂM",
            "location.venue": "BÚN RIÊU A-TÈO",
            "location.mapAria": "Bản đồ",
            "location.iframeTitle": "Google Maps",
            "location.addressLabel": "ĐỊA CHỈ",
            "location.copyBtn": "SAO CHÉP",
            "location.directionsBtn": "CHỈ ĐƯỜNG",
            "location.actionsAria": "Hành động địa điểm",
            "rsvp.sectionAria": "RSVP",
            "rsvp.intro":
                "Hãy xác nhận sự có mặt của bạn trước ngày 12.01.2026 để chúng mình chuẩn bị đón tiếp một cách chu đáo nhất.<br />Trân trọng!",
            "rsvp.namePh": "Tên của bạn",
            "rsvp.nameAria": "Nhập tên của bạn",
            "rsvp.messagePh": "Lời nhắn (tuỳ chọn)",
            "rsvp.messageAria": "Nhập lời nhắn",
            "rsvp.attendAria": "Bạn sẽ đến chứ?",
            "rsvp.attendPlaceholder": "Bạn sẽ đến chứ?",
            "rsvp.attendYes": "Có, mình sẽ đến",
            "rsvp.attendNo": "Xin lỗi, mình không đến được",
            "rsvp.guestsPh": "Số người đi cùng (tuỳ chọn)",
            "rsvp.guestsAria": "Nhập số người đi cùng",
            "rsvp.invitedByPh": "Bạn được mời bởi ai? (tuỳ chọn)",
            "rsvp.invitedByAria": "Nhập tên người mời",
            "rsvp.submitAria": "Gửi RSVP",
            "footer.sectionAria": "Cuối trang",
            "footer.withLove": "With love",
            "status.copied": "Đã sao chép!",
            "status.copyFailed": "Không sao chép được.",
            "status.musicOn": "Nhạc: Bật",
            "status.musicOff": "Nhạc: Tắt",
            "status.langVI": "Ngôn ngữ: VI",
            "status.langEN": "Language: EN",
            "status.entered": "Đã mở thiệp mời.",
            "status.flipped": "Đã lật thiệp mời.",
            "status.rsvpSending": "Đang gửi...",
            "status.rsvpSent": "Cảm ơn bạn! Đã ghi nhận.",
            "status.rsvpNotConfigured": "RSVP chưa được cấu hình nơi nhận.",
            "status.rsvpFailed": "Gửi thất bại. Vui lòng thử lại.",
        },
        en: {
            "doc.title": "Thy Phuong & Mitchell Lachlan  Wedding Invitation",
            "doc.description": "Wedding invitation for Thy Phuong and Mitchell Lachlan  24/01/2026",
            "overlay.openInvitation": "Open invitation",
            "overlay.flipInvitation": "Flip invitation",
            "overlay.save": "SAVE",
            "overlay.the": "the",
            "overlay.date": "DATE",
            "overlay.inviteLine": "You are invited",
            "overlay.tapToOpen": "Tap to open",
            "overlay.breakSeal": "Break the seal",
            "overlay.tapSealToEnter": "Tap the seal to enter",
            "audio.unsupported": "Your browser does not support the audio element.",
            "topbar.titleAria": "Top bar",
            "topbar.musicTitle": "Toggle background music",
            "topbar.musicAria": "Toggle background music",
            "topbar.langTitle": "Toggle language",
            "topbar.langAria": "Toggle language",
            "hero.sectionAria": "Hero",
            "hero.gettingMarried": "We're getting married!",
            "hero.titleAria": "Couple names",
            "hero.dateAria": "Wedding date",
            "dateBanner.sectionAria": "Countdown",
            "dateBanner.lead": "WE WILL BECOME<br>HUSBAND AND WIFE IN",
            "dateBanner.timerAria": "Countdown to wedding day",
            "saveDate.sectionAria": "Save the date",
            "saveDate.titleAria": "Save the date",
            "saveDate.save": "SAVE",
            "saveDate.the": "the",
            "saveDate.date": "DATE",
            "childhood.sectionAria": "Childhood photos",
            "childhood.title": "When We Were Little",
            "childhood.subtitle": "A tiny throwback before the big day.",
            "childhood.stageAria": "Childhood photo frames",
            "childhood.leftAlt": "Bride childhood photo",
            "childhood.rightAlt": "Groom childhood photo",
            "family.sectionAria": "Family details",
            "family.brideSideHead": "BRIDE'S FAMILY",
            "family.groomSideHead": "GROOM'S FAMILY",
            "family.brideSideBody": "Mr: Trương Kỳ Phong<br />Mrs: Nguyễn Thanh Thảo<br />Address: Ấp Bình Phú, xã Nhơn Trạch, Tỉnh Đồng Nai (địa chỉ mới)",
            "family.groomSideBody": "Mr: Cook Lenard Leslie<br />Mrs: Cook Amy Michelle<br />Address: Melbourne - VIC Australia",
            "family.inviteLine": "You are warmly invited to our wedding ceremony!",
            "family.coupleAria": "Couple names",
            "family.andWord": "and",
            "family.whenAria": "When",
            "family.whenLabel": "Will be held at",
            "family.whenMain": "10:30AM SATURDAY",
            "family.address": "1551 Ly Thai To, Long Tan, Nhon Trach, Dong Nai, Vietnam",
            "family.directionsAria": "Go to location",
            "family.directionsBtn": "DIRECTIONS",
            "story.sectionAria": "Our story",
            "story.titleAria": "The story of love",
            "story.titleA": "THE STORY",
            "story.titleOf": "of",
            "story.titleB": "LOVE",
            "story.cardsAria": "Intro cards",
            "story.bridePhotoAlt": "Bride photo",
            "story.groomPhotoAlt": "Groom photo",
            "story.brideInfoAria": "Bride info",
            "story.groomInfoAria": "Groom info",
            "story.brideRole": "Bride",
            "story.groomRole": "Groom",
            "story.timelineAria": "Story timeline",
            "story.y2022.title": "2022 - DESTINED MEETING",
            "story.y2022.text":
                "We were two people from two different countries, and it seemed we could never truly fit together. Our love at that time was not only about understanding two personalities, but also the differences in language and culture. That was the first barrier when we began to learn about each other. We each carried different ambitions and a future we never imagined would meet and walk together. In a small and peaceful city in northern Australia, we first met and decided to hold hands and continue the journey ahead.",
            "story.y2023.title": "2023 - DATING",
            "story.y2023.text":
                "Early love is always sweet and romantic: watching films together, traveling, laughing and crying together, and countless worries about a lasting relationship, along with plans for the future.",
            "story.y2024.title": "2024 - PROMISE",
            "story.y2024.text":
                "The longer we walked together, the more we realized each other's presence in our lives was something essential and destined. We began to take our relationship seriously... With the blessing of both families, our love felt as if it had been given wings.",
            "story.y2025.title": "2025 - PROPOSAL",
            "story.y2025.text":
                "A year full of challenges—joys and sorrows, busyness knocking at our door—but everything passed and we were still there together, with a place called home and someone always waiting for us to return. We had a warm and intimate wedding ceremony in the small city of Darwin where our love began, and now 2026 arrives with the anticipation and blessings of everyone in Vietnam for a heartfelt celebration at our family home... and your presence, our beloved friends and family, that day will be one of the beautiful memories we will carry with us on this journey. Just like today, sitting down to write about our story of love and sharing it with you. With love.",
            "album.sectionAria": "Album",
            "album.filmstripAria": "Film strip",
            "album.collageAria": "Album collage",
            "album.titleAria": "Album title",
            "album.subAria": "Album subtitle",
            "album.the": "The",
            "album.album": "ALBUM",
            "album.of": "OF",
            "album.love": "LOVE",
            "album.photoAlt": "Wedding photo",
            "gallery.sectionAria": "Gallery",
            "gallery.stageAria": "Gallery viewer",
            "gallery.selectedAria": "Selected image",
            "gallery.mainAlt": "Main photo",
            "gallery.prevAria": "Previous photo",
            "gallery.nextAria": "Next photo",
            "gallery.thumbsAria": "Thumbnails",
            "dress.sectionAria": "Dress code",
            "dress.title": "DRESS CODE",
            "dress.dotsAria": "Dress code colors",
            "timeline.sectionAria": "Timeline",
            "timeline.railAria": "Wedding timeline",
            "timeline.title": "TIMELINE",
            "timeline.node1": "WELCOME<br>GUESTS",
            "timeline.node2": "CEREMONY<br>BEGINS",
            "timeline.node3": "BANQUET<br>STARTS",
            "timeline.node4": "KARAOKE<br>& DANCING",
            "location.sectionAria": "Location",
            "location.title": "LOCATION",
            "location.venue": "BÚN RIÊU A-TÈO",
            "location.mapAria": "Map",
            "location.iframeTitle": "Google Maps",
            "location.addressLabel": "ADDRESS",
            "location.copyBtn": "COPY",
            "location.directionsBtn": "DIRECTIONS",
            "location.actionsAria": "Location actions",
            "rsvp.sectionAria": "RSVP",
            "rsvp.intro": "Please confirm your attendance before 12.01.2026 so we can prepare properly.<br />Thank you!",
            "rsvp.namePh": "Your name",
            "rsvp.nameAria": "Enter your name",
            "rsvp.messagePh": "Message (optional)",
            "rsvp.messageAria": "Enter a message",
            "rsvp.attendAria": "Will you attend?",
            "rsvp.attendPlaceholder": "Will you attend?",
            "rsvp.attendYes": "Yes, I will attend",
            "rsvp.attendNo": "Sorry, I cant make it",
            "rsvp.guestsPh": "Number of guests (optional)",
            "rsvp.guestsAria": "Enter number of guests",
            "rsvp.invitedByPh": "Invited by (optional)",
            "rsvp.invitedByAria": "Enter inviter name",
            "rsvp.submitAria": "Submit RSVP",
            "footer.sectionAria": "Footer",
            "footer.withLove": "With love",
            "status.copied": "Copied!",
            "status.copyFailed": "Copy failed.",
            "status.musicOn": "Music: On",
            "status.musicOff": "Music: Off",
            "status.langVI": "Ngn ng?: VI",
            "status.langEN": "Language: EN",
            "status.entered": "Invitation opened.",
            "status.flipped": "Invitation flipped.",
            "status.rsvpSending": "Sending...",
            "status.rsvpSent": "Thank you! Received.",
            "status.rsvpNotConfigured": "RSVP destination is not configured.",
            "status.rsvpFailed": "Send failed. Please try again.",
        },
    };

    const t = (key) => {
        const table = I18N[state.lang] || {};
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
    };

    // =========================================================
    // ELEMENTS (robust selectors)
    // =========================================================
    const els = {
        html: document.documentElement,
        body: document.body,

        // overlay / card
        overlay: firstEl(["#enterOverlay", ".enter-overlay"]),
        overlayStatus: firstEl(["#overlayStatus", ".overlay-status"]),
        inviteCard: firstEl(["#inviteCard", ".invite-card", "[data-invite-card]"]),
        sealBtn: firstEl(["#sealBtn", ".seal-btn", "[data-seal]"]),

        // music/lang
        bgMusic: firstEl(["#bgMusic", "audio[data-bg-music]"]),
        musicToggle: firstEl(["#musicToggle", "[data-music-toggle]"]),
        langToggle: firstEl(["#langToggle", "[data-lang-toggle]"]),

        // countdown
        cdDays: $("#cdDays"),
        cdHours: $("#cdHours"),
        cdMins: $("#cdMins"),
        cdSecs: $("#cdSecs"),

        // reveal targets
        dateBanner: $("#date"),
        saveDateSection: $("#portrait"),
        timelineSection: $("#timeline"),

        // album filmstrip
        albumSection: $("#album"),
        albumStrip: firstEl(["#album .album-filmstrip", ".album-filmstrip", "[data-album-filmstrip]"]),
        albumTrack: firstEl(["#albumTrack", ".album-track", ".album-filmtrack", "[data-album-track]"]),

        // gallery
        gallerySection: $("#gallery"),
        galleryStage: firstEl(["#gallery .gallery-stage", ".gallery-stage", "[data-gallery-stage]"]),
        galleryMainImg: firstEl(["#galleryMainImg", ".gallery-main img", "[data-gallery-main] img"]),
        galleryThumbs: firstEl(["#galleryThumbs", ".gallery-thumbs", "[data-gallery-thumbs]"]),
        galleryPrev: firstEl(["#gallery .gallery-arrow-left", ".gallery-arrow-left", "[data-gallery-prev]"]),
        galleryNext: firstEl(["#gallery .gallery-arrow-right", ".gallery-arrow-right", "[data-gallery-next]"]),

        // dress dots
        dressDots: firstEl(["#dressDots", ".dress-dots", "[data-dress-dots]"]),

        // address copy
        addressText: $("#addressText"),
        copyAddressBtn: $("#copyAddressBtn"),
        copyAddressStatus: $("#copyAddressStatus"),

        // rsvp
        rsvpForm: $("#rsvpForm"),
        rsvpName: $("#rsvpName"),
        rsvpMessage: $("#rsvpMessage"),
        rsvpAttend: $("#rsvpAttend"),
        rsvpGuests: $("#rsvpGuests"),
        rsvpInvitedBy: $("#rsvpInvitedBy"),
        rsvpSubmitBtn: $("#rsvpSubmitBtn"),
        rsvpStatus: $("#rsvpStatus"),

        // envelope / crease svg
        envStage: firstEl([".env-stage", "[data-env-stage]"]),
        creaseSvg: firstEl([".env-stage svg", "#creaseSvg", "svg[data-crease]"]),
        creaseL: $("#creaseL"),
        creaseR: $("#creaseR"),
        creaseFlat: $("#creaseFlat"),
    };

    // =========================================================
    // i18n apply
    // =========================================================
    const updateMusicButtonUI = (announce = false) => {
        if (!els.musicToggle) return;
        const label = state.musicOn ? t("status.musicOn") : t("status.musicOff");
        els.musicToggle.textContent = label || (state.musicOn ? "Music: On" : "Music: Off");
        els.musicToggle.setAttribute("aria-pressed", state.musicOn ? "true" : "false");
        if (announce && els.overlayStatus) els.overlayStatus.textContent = els.musicToggle.textContent;
    };

    const updateLangButtonUI = () => {
        if (!els.langToggle) return;
        const label = state.lang === "vi" ? t("status.langVI") : t("status.langEN");
        els.langToggle.textContent = label || (state.lang === "vi" ? "Ngn ng?: VI" : "Language: EN");
        els.langToggle.setAttribute("aria-pressed", state.lang === "vi" ? "true" : "false");
    };

    const applyLanguage = () => {
        const lang = state.lang;

        if (els.html) {
            els.html.setAttribute("lang", lang);
            els.html.setAttribute("data-lang", lang);
        }

        const title = t("doc.title");
        if (title) document.title = title;

        const desc = t("doc.description");
        if (desc) {
            const meta = document.querySelector('meta[name="description"]');
            if (meta) meta.setAttribute("content", desc);
        }

        $$("[data-i18n]").forEach((el) => {
            const key = el.getAttribute("data-i18n");
            const val = t(key);
            if (val !== null) el.textContent = val;
        });

        $$("[data-i18n-html]").forEach((el) => {
            const key = el.getAttribute("data-i18n-html");
            const val = t(key);
            if (val !== null) el.innerHTML = val;
        });

        $$("[data-i18n-attr]").forEach((el) => {
            const spec = el.getAttribute("data-i18n-attr");
            parseAttrMap(spec).forEach(({ attr, key }) => {
                const val = t(key);
                if (val !== null) el.setAttribute(attr, val);
            });
        });

        updateMusicButtonUI(false);
        updateLangButtonUI();
    };

    // =========================================================
    // MUSIC
    // =========================================================
    const tryPlayMusic = async () => {
        if (!els.bgMusic) return false;
        try {
            await els.bgMusic.play();
            return true;
        } catch {
            return false;
        }
    };

    const stopMusic = () => {
        if (!els.bgMusic) return;
        try {
            els.bgMusic.pause();
            els.bgMusic.currentTime = 0;
        } catch {
            /* ignore */
        }
    };

    const setMusicOn = async (on) => {
        state.musicOn = Boolean(on);
        setLS(LS.music, state.musicOn ? "1" : "0");
        updateMusicButtonUI(true);

        if (!els.bgMusic) return;

        if (state.musicOn) {
            await tryPlayMusic(); // user gesture happens on toggle click
        } else {
            stopMusic();
        }
    };

    // =========================================================
    // OVERLAY FLOW (robust)
    // =========================================================
    const setOverlayStatus = (keyOrText) => {
        if (!els.overlayStatus) return;
        els.overlayStatus.textContent = t(keyOrText) ?? keyOrText ?? "";
    };

    const setInviteFlipped = (flipped) => {
        if (!els.inviteCard) return;

        els.inviteCard.classList.toggle("is-flipped", Boolean(flipped));

        const front = els.inviteCard.querySelector(".invite-front");
        const back = els.inviteCard.querySelector(".invite-back");
        if (front) front.setAttribute("aria-hidden", flipped ? "true" : "false");
        if (back) back.setAttribute("aria-hidden", flipped ? "false" : "true");

        setOverlayStatus("status.flipped");
    };

    const unlockSite = () => {
        if (els.body) {
            els.body.classList.remove("locked");
            els.body.classList.add("reveal");
        }

        if (els.overlay) {
            els.overlay.classList.add("hidden");
            els.overlay.setAttribute("aria-hidden", "true");
        }

        state.entered = true;
        if (PERSIST_ENTERED) {
            setLS(LS.entered, "1");
        } else {
            removeLS(LS.entered);
        }
        setOverlayStatus("status.entered");
    };

    const enterSite = async () => {
        unlockSite();
        await setMusicOn(true);
        if (els.musicToggle) {
            try {
                els.musicToggle.focus({ preventScroll: true });
            } catch {
                /* ignore */
            }
        }
    };

    const initOverlay = () => {
        // If overlay/card structure is missing, never hard-fail the site
        if (!els.overlay || !els.inviteCard || !els.sealBtn) {
            // still unlock scrolling, otherwise site feels broken
            if (els.body) els.body.classList.remove("locked");
            return;
        }

        // Always normalize overlay hidden state:
        // (Fixes the initial card doesnt load symptom when HTML accidentally ships hidden)
        if (!state.entered) {
            els.overlay.classList.remove("hidden");
            els.overlay.setAttribute("aria-hidden", "false");
        }

        if (state.entered) {
            if (els.body) els.body.classList.remove("locked");
            els.overlay.classList.add("hidden");
            els.overlay.setAttribute("aria-hidden", "true");
            updateMusicButtonUI(false);
            return;
        }

        if (els.body) els.body.classList.add("locked");

        // Make card focusable even if markup forgot tabindex
        if (!els.inviteCard.hasAttribute("tabindex")) els.inviteCard.setAttribute("tabindex", "0");
        els.inviteCard.setAttribute("role", els.inviteCard.getAttribute("role") || "button");
        els.inviteCard.setAttribute(
            "aria-label",
            els.inviteCard.getAttribute("aria-label") || t("overlay.flipInvitation") || "Flip invitation"
        );

        const flip = () => {
            const nowFlipped = !els.inviteCard.classList.contains("is-flipped");
            setInviteFlipped(nowFlipped);
        };

        els.inviteCard.addEventListener("click", flip);
        els.inviteCard.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                e.preventDefault();
                flip();
            }
        });

        els.sealBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            await enterSite();
        });

        try {
            els.inviteCard.focus({ preventScroll: true });
        } catch {
            /* ignore */
        }
    };

    // =========================================================
    // COUNTDOWN
    // =========================================================
    const startCountdown = () => {
        if (!els.cdDays || !els.cdHours || !els.cdMins || !els.cdSecs) return;

        const target = new Date(WEDDING_DATE_ISO);
        if (Number.isNaN(target.getTime())) {
            els.cdDays.textContent = "";
            els.cdHours.textContent = "";
            els.cdMins.textContent = "";
            els.cdSecs.textContent = "";
            return;
        }

        const tick = () => {
            const now = Date.now();
            let diff = target.getTime() - now;
            if (diff <= 0) diff = 0;

            const totalSeconds = Math.floor(diff / 1000);
            const days = Math.floor(totalSeconds / (24 * 3600));
            const hours = Math.floor((totalSeconds % (24 * 3600)) / 3600);
            const mins = Math.floor((totalSeconds % 3600) / 60);
            const secs = totalSeconds % 60;

            els.cdDays.textContent = pad2(days);
            els.cdHours.textContent = pad2(hours);
            els.cdMins.textContent = pad2(mins);
            els.cdSecs.textContent = pad2(secs);
        };

        tick();
        window.setInterval(tick, 1000);
    };

    // =========================================================
    // SCROLL REVEAL
    // =========================================================
    const initScrollReveal = () => {
        const targets = new Set();
        $$(".reveal-on-scroll").forEach((el) => targets.add(el));
        if (els.dateBanner) targets.add(els.dateBanner);
        if (els.saveDateSection) targets.add(els.saveDateSection);
        if (els.timelineSection) targets.add(els.timelineSection);

        if (targets.size === 0) return;

        if (prefersReducedMotion()) {
            targets.forEach((el) => el.classList.add("is-visible"));
            return;
        }

        const makeObserver = (rootMargin, threshold) =>
            new IntersectionObserver(
                (entries, observer) => {
                    entries.forEach((entry) => {
                        if (!entry.isIntersecting) return;
                        entry.target.classList.add("is-visible");
                        observer.unobserve(entry.target);
                    });
                },
                { threshold, rootMargin }
            );

        const defaultThreshold = 0.18;
        const defaultRootMargin = "0px 0px -10% 0px";
        const defaultObserver = makeObserver(defaultRootMargin, defaultThreshold);
        const customObservers = new Map();

        const observe = (el) => {
            const rm = el.getAttribute("data-reveal-rootmargin");
            const thRaw = el.getAttribute("data-reveal-threshold");
            if (!rm && thRaw == null) {
                defaultObserver.observe(el);
                return;
            }

            const parsedThreshold = thRaw == null || thRaw === "" ? defaultThreshold : Number.parseFloat(thRaw);
            const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : defaultThreshold;
            const rootMargin = rm && rm.trim() ? rm.trim() : defaultRootMargin;
            const key = `${rootMargin}|${threshold}`;

            let observer = customObservers.get(key);
            if (!observer) {
                observer = makeObserver(rootMargin, threshold);
                customObservers.set(key, observer);
            }
            observer.observe(el);
        };

        targets.forEach((el) => observe(el));
    };

    // =========================================================
    // FIX: BRIDE/GROOM PHOTOS SWAPPED
    // =========================================================
    const fixBrideGroomSwapped = () => {
        // Best-effort selector set. If your HTML uses different IDs/classes,
        // add them here (this wont break anything if not found).
        const root = firstEl(["#story", ".story", "[data-story]"]) || document;

        const brideImg = firstEl(
            [
                "#brideImg",
                "#storyBrideImg",
                "img[data-person='bride']",
                ".story-card.bride img",
                ".bride-card img",
                ".story .bride img",
            ],
            root
        );

        const groomImg = firstEl(
            [
                "#groomImg",
                "#storyGroomImg",
                "img[data-person='groom']",
                ".story-card.groom img",
                ".groom-card img",
                ".story .groom img",
            ],
            root
        );

        if (!brideImg || !groomImg) return;

        const bSrc = brideImg.getAttribute("src") || "";
        const gSrc = groomImg.getAttribute("src") || "";
        if (!bSrc || !gSrc) return;

        // Swap
        brideImg.setAttribute("src", gSrc);
        groomImg.setAttribute("src", bSrc);

        // Re-apply alts from i18n if present
        const bAlt = t("story.bridePhotoAlt");
        const gAlt = t("story.groomPhotoAlt");
        if (bAlt) brideImg.setAttribute("alt", bAlt);
        if (gAlt) groomImg.setAttribute("alt", gAlt);
    };

    // =========================================================
    // ALBUM FILMSTRIP (seamless loop + FORCE RUN on hover)
    // =========================================================
    /* ==========================================================================
       Album filmstrip — helpers
       ========================================================================== */
    const attachFilmstripLoadGuards = (trackEl, stripEl, setAEl) => {
        const update = () => {
            requestAnimationFrame(() => {
                const dist = Math.max(0, setAEl.scrollWidth || 0);
                stripEl.style.setProperty("--film-loop-distance", `${dist}px`);
                stripEl.classList.toggle("is-loop", dist > 0);
            });
        };

        trackEl.querySelectorAll("img").forEach((img) => {
            const onDone = () => update();

            img.addEventListener("load", onDone, { once: true });
            img.addEventListener(
                "error",
                () => {
                    console.warn("Film image failed:", img.src);
                    img.closest(".album-frame")?.remove();
                    update();
                },
                { once: true }
            );

            if (img.complete) update();
        });

        try {
            new ResizeObserver(update).observe(setAEl);
        } catch {
            window.addEventListener("resize", update);
        }

        update();
    };

    const forceFilmstripRunning = () => {
        if (!els.albumStrip) return;

        // If your CSS pauses on :hover, inline style wins.
        // We set on likely animated nodes.
        const nodes = [];

        if (els.albumStrip) nodes.push(els.albumStrip);
        if (els.albumTrack) nodes.push(els.albumTrack);
        $$(".album-track-set", els.albumStrip).forEach((n) => nodes.push(n));

        nodes.forEach((n) => {
            try {
                n.style.animationPlayState = "running";
            } catch {
                /* ignore */
            }
        });
    };

    const initAlbumFilmstrip = () => {
        if (!els.albumTrack || !els.albumStrip) return;

        const images = sampleArray(ALBUM_FILM_IMAGES.slice().filter(Boolean), 10);
        if (images.length === 0) return;

        // If reduced motion, do not animate
        if (prefersReducedMotion()) {
            els.albumStrip.classList.remove("is-loop");
            return;
        }

        const buildSet = (setId) => {
            const set = document.createElement("div");
            set.className = "album-track-set";
            set.setAttribute("data-set", setId);

            images.forEach((src) => {
                const frame = document.createElement("div");
                frame.className = "album-frame";

                const img = document.createElement("img");
                img.loading = "lazy";
                img.decoding = "async";
                img.alt = t("album.photoAlt") || "";
                img.src = src;

                frame.appendChild(img);
                set.appendChild(frame);
            });

            return set;
        };

        els.albumTrack.innerHTML = "";
        const setA = buildSet("a");
        const setB = buildSet("b");
        els.albumTrack.appendChild(setA);
        els.albumTrack.appendChild(setB);

        const sec = clamp(Math.round(images.length * 6.0), 60, 120);
        els.albumStrip.style.setProperty("--film-loop-speed", `${sec}s`);
        attachFilmstripLoadGuards(els.albumTrack, els.albumStrip, setA);
        forceFilmstripRunning();

        // Defeat CSS hover pause (some CSS does: .album-filmstrip:hover { animation-play-state: paused })
        // We re-assert on pointer events.
        els.albumStrip.addEventListener("pointerenter", forceFilmstripRunning);
        els.albumStrip.addEventListener("pointermove", forceFilmstripRunning);
        els.albumStrip.addEventListener("pointerleave", forceFilmstripRunning);

        // Resize handling
        let resizeTimer = null;
        window.addEventListener("resize", () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                attachFilmstripLoadGuards(els.albumTrack, els.albumStrip, setA);
                forceFilmstripRunning();
            }, 120);
        });
    };

    // =========================================================
    // GALLERY VIEWER
    // =========================================================
    const initGallery = () => {
        if (!els.galleryMainImg || !els.galleryThumbs) return;

        const images = (GALLERY_IMAGES && GALLERY_IMAGES.length ? GALLERY_IMAGES : ALBUM_FILM_IMAGES)
            .slice()
            .filter(Boolean);

        if (images.length === 0) return;

        state.galleryIndex = 0;

        const setGalleryIndex = (idx, doScrollThumb) => {
            const n = images.length;
            state.galleryIndex = (idx + n) % n;

            const src = images[state.galleryIndex];
            els.galleryMainImg.src = src;

            const alt = t("gallery.mainAlt") || els.galleryMainImg.getAttribute("alt") || "";
            els.galleryMainImg.setAttribute("alt", alt);

            const thumbs = $$(".gallery-thumb", els.galleryThumbs);
            thumbs.forEach((b) => b.classList.remove("is-active"));

            const active = thumbs[state.galleryIndex];
            if (active) {
                active.classList.add("is-active");
                if (doScrollThumb) {
                    try {
                        active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
                    } catch {
                        /* ignore */
                    }
                }
            }
        };

        const renderThumbs = () => {
            els.galleryThumbs.innerHTML = "";
            images.forEach((src, idx) => {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "gallery-thumb";
                btn.setAttribute("aria-label", `Photo ${idx + 1} / ${images.length}`);
                btn.dataset.index = String(idx);

                const img = document.createElement("img");
                img.loading = "lazy";
                img.decoding = "async";
                img.alt = "";
                img.src = src;

                btn.appendChild(img);
                btn.addEventListener("click", () => setGalleryIndex(idx, true));
                els.galleryThumbs.appendChild(btn);
            });
        };

        renderThumbs();
        setGalleryIndex(state.galleryIndex, false);

        if (els.galleryPrev) els.galleryPrev.addEventListener("click", () => setGalleryIndex(state.galleryIndex - 1, true));
        if (els.galleryNext) els.galleryNext.addEventListener("click", () => setGalleryIndex(state.galleryIndex + 1, true));

        if (els.galleryStage) {
            els.galleryStage.addEventListener("keydown", (e) => {
                if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    setGalleryIndex(state.galleryIndex - 1, true);
                } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    setGalleryIndex(state.galleryIndex + 1, true);
                }
            });
        }
    };

    // =========================================================
    // DRESS CODE DOTS
    // =========================================================
    const initDressDots = () => {
        if (!els.dressDots) return;
        els.dressDots.innerHTML = "";
        DRESS_DOT_COLORS.slice()
            .filter(Boolean)
            .forEach((c) => {
                const dot = document.createElement("span");
                dot.className = "dress-dot";
                dot.style.background = c;
                dot.setAttribute("aria-hidden", "true");
                els.dressDots.appendChild(dot);
            });
    };

    // =========================================================
    // COPY ADDRESS
    // =========================================================
    const copyToClipboard = async (text) => {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch {
            /* fall back */
        }
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "true");
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            ta.style.top = "0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    };

    const initCopyAddress = () => {
        if (!els.copyAddressBtn || !els.addressText || !els.copyAddressStatus) return;

        let timer = null;

        els.copyAddressBtn.addEventListener("click", async () => {
            const text = (els.addressText.textContent || "").trim();
            if (!text) return;

            const ok = await copyToClipboard(text);
            els.copyAddressStatus.textContent = ok ? t("status.copied") || "Copied!" : t("status.copyFailed") || "Copy failed.";

            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                els.copyAddressStatus.textContent = "";
            }, 2400);
        });
    };

    // =========================================================
    // RSVP
    // =========================================================
    const serializeRSVP = () => ({
        name: (els.rsvpName?.value || "").trim(),
        message: (els.rsvpMessage?.value || "").trim(),
        attending: (els.rsvpAttend?.value || "").trim(),
        guests: (els.rsvpGuests?.value || "").trim(),
        invitedBy: (els.rsvpInvitedBy?.value || "").trim(),
        lang: state.lang,
        submittedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
    });

    const setRSVPStatus = (keyOrText) => {
        if (!els.rsvpStatus) return;
        els.rsvpStatus.textContent = t(keyOrText) ?? keyOrText ?? "";
    };

    const setRSVPLoading = (isLoading) => {
        if (els.rsvpSubmitBtn) els.rsvpSubmitBtn.disabled = Boolean(isLoading);
        if (els.rsvpForm) els.rsvpForm.setAttribute("aria-busy", isLoading ? "true" : "false");
    };

    const initRSVP = () => {
        if (!els.rsvpForm) return;

        els.rsvpForm.addEventListener("submit", async (e) => {
            e.preventDefault();

            const payload = serializeRSVP();
            if (!payload.name || !payload.attending) return;

            setRSVPLoading(true);
            setRSVPStatus("status.rsvpSending");

            try {
                if (RSVP_ENDPOINT) {
                    const res = await fetch(RSVP_ENDPOINT, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                    if (!res.ok) throw new Error(`RSVP HTTP ${res.status}`);
                    setRSVPStatus("status.rsvpSent");
                    els.rsvpForm.reset();
                    setRSVPLoading(false);
                    return;
                }

                if (RSVP_MAILTO_TO) {
                    const subject = encodeURIComponent("Wedding RSVP");
                    const body = encodeURIComponent(
                        [
                            `Name: ${payload.name}`,
                            `Attending: ${payload.attending}`,
                            payload.guests ? `Guests: ${payload.guests}` : "",
                            payload.invitedBy ? `Invited by: ${payload.invitedBy}` : "",
                            payload.message ? `Message: ${payload.message}` : "",
                            "",
                            `Submitted: ${payload.submittedAt}`,
                        ]
                            .filter(Boolean)
                            .join("\n")
                    );
                    window.location.href = `mailto:${encodeURIComponent(RSVP_MAILTO_TO)}?subject=${subject}&body=${body}`;
                    setRSVPStatus("status.rsvpSent");
                    els.rsvpForm.reset();
                    setRSVPLoading(false);
                    return;
                }

                setLS("wedding_rsvp_last", JSON.stringify(payload));
                setRSVPStatus("status.rsvpNotConfigured");
                setRSVPLoading(false);
            } catch (err) {
                console.error(err);
                setRSVPStatus("status.rsvpFailed");
                setRSVPLoading(false);
            }
        });
    };

    // =========================================================
    // LANGUAGE TOGGLE
    // =========================================================
    const initLangToggle = () => {
        if (!els.langToggle) return;
        els.langToggle.addEventListener("click", () => {
            state.lang = state.lang === "vi" ? "en" : "vi";
            setLS(LS.lang, state.lang);
            applyLanguage();
            // after language swap, re-check bride/groom alts too
            fixBrideGroomSwapped();
        });
    };

    // =========================================================
    // MUSIC TOGGLE
    // =========================================================
    const initMusicToggle = () => {
        if (!els.musicToggle) return;
        els.musicToggle.addEventListener("click", async () => {
            await setMusicOn(!state.musicOn);
        });
    };

    // =========================================================
    // FIX: Envelope crease SVG alignment
    // =========================================================
    const normalizeCreaseSvgSizing = () => {
        if (!els.creaseSvg) return;
        try {
            // Ensure SVG scales exactly to its box (no letterboxing)
            els.creaseSvg.setAttribute("preserveAspectRatio", "none");
            if (!els.creaseSvg.getAttribute("viewBox")) els.creaseSvg.setAttribute("viewBox", "0 0 100 100");

            // Force it to fill the stage
            els.creaseSvg.style.width = "100%";
            els.creaseSvg.style.height = "100%";
            els.creaseSvg.style.display = "block";
            els.creaseSvg.style.position = els.creaseSvg.style.position || "absolute";
            els.creaseSvg.style.inset = els.creaseSvg.style.inset || "0";
        } catch {
            /* ignore */
        }
    };

    const updateCreaseLines = () => {
        if (!els.envStage || !els.creaseL || !els.creaseR || !els.creaseFlat) return;

        // IMPORTANT FIX:
        // Cropping vars might not be on .env-stage anymore, so we walk the tree to find them.
        const creaseYRaw = getCssVar(els.envStage, "--crease-y").value;
        const creaseLxRaw = getCssVar(els.envStage, "--crease-left-x").value;
        const creaseRxRaw = getCssVar(els.envStage, "--crease-right-x").value;
        const creaseTopYRaw = getCssVar(els.envStage, "--crease-top-y").value;
        const creaseTopLxRaw = getCssVar(els.envStage, "--crease-top-left-x").value;
        const creaseTopRxRaw = getCssVar(els.envStage, "--crease-top-right-x").value;

        const creaseY = parsePercent(creaseYRaw, 60);
        const creaseLx = parsePercent(creaseLxRaw, 44.5);
        const creaseRx = parsePercent(creaseRxRaw, 55.5);
        const creaseTopY = parsePercent(creaseTopYRaw, 40);
        const creaseTopLx = parsePercent(creaseTopLxRaw, 23);
        const creaseTopRx = parsePercent(creaseTopRxRaw, 77.5);

        const setLine = (line, x1, y1, x2, y2) => {
            line.setAttribute("x1", String(x1));
            line.setAttribute("y1", String(y1));
            line.setAttribute("x2", String(x2));
            line.setAttribute("y2", String(y2));
        };

        // SVG coords are 0..100
        // Match the same points used by the clip-path polygon.
        setLine(els.creaseL, creaseTopLx, creaseTopY, creaseLx, creaseY);
        setLine(els.creaseR, creaseRx, creaseY, creaseTopRx, creaseTopY);
        setLine(els.creaseFlat, creaseLx, creaseY, creaseRx, creaseY);
    };

    const initCreaseAlignment = () => {
        normalizeCreaseSvgSizing();
        updateCreaseLines();

        // Keep it aligned when the stage changes size (mobile, font load, orientation, etc.)
        if (els.envStage && "ResizeObserver" in window) {
            const ro = new ResizeObserver(() => {
                normalizeCreaseSvgSizing();
                updateCreaseLines();
            });
            ro.observe(els.envStage);
        }

        window.addEventListener("resize", () => {
            normalizeCreaseSvgSizing();
            updateCreaseLines();
        });

        // One extra pass after layout settles
        requestAnimationFrame(() => {
            normalizeCreaseSvgSizing();
            updateCreaseLines();
        });
    };

    // =========================================================
    // INIT
    // =========================================================
    const init = () => {
        applyLanguage();
        updateMusicButtonUI(false);
        updateLangButtonUI();

        // Overlay/card reliability fix
        initOverlay();

        initMusicToggle();
        initLangToggle();

        startCountdown();
        initScrollReveal();

        // Fix ordering issues before building album/gallery (if your story section uses same assets)
        fixBrideGroomSwapped();

        initAlbumFilmstrip();
        initGallery();
        initDressDots();
        initCopyAddress();
        initRSVP();

        // Envelope crease overlay alignment fix
        initCreaseAlignment();

        // Autoplay rules: if not entered, never play
        if (!state.entered) {
            stopMusic();
        } else {
            // still dont autoplay; keep paused until a user gesture toggles it
            if (els.bgMusic) {
                try {
                    els.bgMusic.pause();
                } catch {
                    /* ignore */
                }
            }
        }
    };

    onReady(init);

    // =========================================================
    // DEV helpers
    // =========================================================
    window.__wedding = {
        resetEnter: () => removeLS(LS.entered),
        setLang: (l) => {
            state.lang = l === "en" ? "en" : "vi";
            setLS(LS.lang, state.lang);
            applyLanguage();
            fixBrideGroomSwapped();
        },
        setMusic: (on) => setMusicOn(Boolean(on)),
        updateCreases: () => {
            normalizeCreaseSvgSizing();
            updateCreaseLines();
        },
        forceFilmRun: forceFilmstripRunning,
    };
})();

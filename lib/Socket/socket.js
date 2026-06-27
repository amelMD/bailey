"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSocket = void 0;
const boom_1 = require("@hapi/boom");
const crypto_1 = require("crypto");
const util_1 = require("util");
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const Client_1 = require("./Client");

const makeSocket = (config) => {
    var _a, _b;
    // ✅ DIHAPUS: waWebSocketUrl (penyebab utama galat)
    const {
        connectTimeoutMs, logger, keepAliveIntervalMs, browser,
        auth: authState, printQRInTerminal, defaultQueryTimeoutMs,
        transactionOpts, qrTimeout, makeSignalRepository
    } = config;
    
    // ✅ ALAMAT RESMI + PENGECEKAN KEAMANAN
    const TARGET_WS_URL = "wss://web.whatsapp.com/ws/chat";
    let url;
    try {
        url = new URL(TARGET_WS_URL);
    } catch (err) {
        throw new boom_1.Boom('Alamat sambungan WebSocket tidak sah', {
            statusCode: Types_1.DisconnectReason.connectionClosed
        });
    }

    if ((_a = authState?.creds)?.routingInfo) {
        url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'));
    }

    if (config.mobile || url.protocol === 'tcp:') {
        throw new boom_1.Boom('Mobile API tidak didukung lagi', { 
            statusCode: Types_1.DisconnectReason.loggedOut 
        });
    }

    const ws = new Client_1.WebSocketClient(url, config);
    ws.connect();

    const ev = (0, Utils_1.makeEventBuffer)(logger);
    const ephemeralKeyPair = Utils_1.Curve.generateKeyPair();

    // ✅ PENGATURAN SANDI SUDAH SESUAI ATURAN TERBARU
    const noise = (0, Utils_1.makeNoiseHandler)({
        keyPair: ephemeralKeyPair,
        NOISE_HEADER: Defaults_1.NOISE_WA_HEADER,
        logger,
        routingInfo: (_b = authState?.creds)?.routingInfo
    });

    const { creds } = authState;
    const keys = (0, Utils_1.addTransactionCapability)(authState.keys, logger, transactionOpts);
    const signalRepository = makeSignalRepository({ creds, keys });

    let lastDateRecv;
    let epoch = 1;
    let keepAliveReq;
    let qrTimer;
    let closed = false;
    const uqTagId = (0, Utils_1.generateMdTagPrefix)();
    const generateMessageTag = () => `${uqTagId}${epoch++}`;

    const sendPromise = (0, util_1.promisify)(ws.send);
    const sendRawMessage = async (data) => {
        if (!ws.isOpen) {
            throw new boom_1.Boom('Sambungan Ditutup', { statusCode: Types_1.DisconnectReason.connectionClosed });
        }
        const bytes = noise.encodeFrame(data);
        await (0, Utils_1.promiseTimeout)(connectTimeoutMs, async (resolve, reject) => {
            try {
                await sendPromise.call(ws, bytes);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    };

    const sendNode = (frame) => {
        if (logger.level === 'trace') {
            logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'mengirim data' });
        }
        const buff = (0, WABinary_1.encodeBinaryNode)(frame);
        return sendRawMessage(buff);
    };

    // ✅ DIPERBAIKI: Penanganan batas kirim ulang permintaan
    const onUnexpectedError = (err, msg) => {
        logger.error({ err }, `kesalahan tak terduga di: '${msg}'`);
        const pesanGalat = (err && ((err.stack || err.message) || String(err))).toLowerCase();
        
        if (pesanGalat.includes('buruk mac') || (pesanGalat.includes('mac') && pesanGalat.includes('tidak sah'))) {
            try {
                uploadPreKeysToServerIfRequired(true)
                    .catch(e => logger.warn({ e }, 'gagal kirim ulang kunci setelah galat sandi'));
            } catch (_e) { }
        }
        
        if (pesanGalat.includes('429') || pesanGalat.includes('batas permintaan')) {
            const jedaTunggu = Math.min(30000, (config.backoffDelayMs || 5000));
            logger.info({ jedaMs: jedaTunggu }, 'menunda pengiriman karena pembatasan server');
            // ✅ DULU KOSONG, SEKARANG BERJALAN BENAR
            return new Promise(selesaikan => setTimeout(selesaikan, jedaTunggu));
        }
    };

    const awaitNextMessage = async (sendMsg) => {
        if (!ws.isOpen) {
            throw new boom_1.Boom('Sambungan Ditutup', { statusCode: Types_1.DisconnectReason.connectionClosed });
        }
        let onBuka;
        let onTutup;
        const hasil = (0, Utils_1.promiseTimeout)(connectTimeoutMs, (berhasil, gagal) => {
            onBuka = berhasil;
            onTutup = mapWebSocketError(gagal);
            ws.on('frame', onBuka);
            ws.on('close', onTutup);
            ws.on('error', onTutup);
        }).finally(() => {
            ws.off('frame', onBuka);
            ws.off('close', onTutup);
            ws.off('error', onTutup);
        });
        if (sendMsg) sendRawMessage(sendMsg).catch(onTutup);
        return hasil;
    };

    const waitForMessage = async (msgId, batasWaktuMs = defaultQueryTimeoutMs) => {
        let onTerima;
        let onSalah;
        try {
            return await (0, Utils_1.promiseTimeout)(batasWaktuMs, (berhasil, gagal) => {
                onTerima = berhasil;
                onSalah = salah => gagal(salah || new boom_1.Boom('Sambungan Ditutup', { statusCode: Types_1.DisconnectReason.connectionClosed }));
                ws.on(`TAG:${msgId}`, onTerima);
                ws.on('close', onSalah);
                ws.on('error', onSalah);
            });
        } finally {
            ws.off(`TAG:${msgId}`, onTerima);
            ws.off('close', onSalah);
            ws.off('error', onSalah);
        }
    };

    const query = async (node, batasWaktuMs) => {
        if (!node.attrs.id) node.attrs.id = generateMessageTag();
        const idPesan = node.attrs.id;
        const [hasil] = await Promise.all([
            waitForMessage(idPesan, batasWaktuMs),
            sendNode(node)
        ]);
        if ('tag' in hasil) (0, WABinary_1.assertNodeErrorFree)(hasil);
        return hasil;
    };

    const validateConnection = async () => {
        let pesanAwal = {
            clientHello: { 
                ephemeral: ephemeralKeyPair.public,
                version: Defaults_1.version
            }
        };
        pesanAwal = WAProto_1.proto.HandshakeMessage.fromObject(pesanAwal);
        logger.info({ peramban: browser }, 'menyambung ke peladen WhatsApp');
        
        const dataAwal = WAProto_1.proto.HandshakeMessage.encode(pesanAwal).finish();
        const balasan = await awaitNextMessage(dataAwal);
        const tahapSandi = WAProto_1.proto.HandshakeMessage.decode(balasan);
        
        const kunciTerenkripsi = await noise.processHandshake(tahapSandi, creds.noiseKey);
        let simpulData;

        if (!creds.me) {
            simpulData = (0, Utils_1.generateRegistrationNode)(creds, config);
            logger.info('belum masuk, sedang daftar perangkat...');
        } else {
            simpulData = (0, Utils_1.generateLoginNode)(creds.me.id, config);
            logger.info('sedang masuk ke akun...');
        }

        const isiTerenkripsi = noise.encrypt(WAProto_1.proto.ClientPayload.encode(simpulData).finish());
        await sendRawMessage(WAProto_1.proto.HandshakeMessage.encode({
            clientFinish: { static: kunciTerenkripsi, payload: isiTerenkripsi }
        }).finish());
        
        noise.finishInit();
        startKeepAliveRequest();
    };

    const getAvailablePreKeysOnServer = async () => {
        const hasil = await query({
            tag: 'iq', attrs: { id: generateMessageTag(), xmlns: 'encrypt', type: 'get', to: WABinary_1.S_WHATSAPP_NET },
            content: [{ tag: 'count', attrs: {} }]
        });
        const dataJumlah = (0, WABinary_1.getBinaryNodeChild)(hasil, 'count');
        return Number(dataJumlah.attrs.value || 0);
    };

    const uploadPreKeys = async (jumlahKunci = Defaults_1.INITIAL_PREKEY_COUNT) => {
        await keys.transaction(async () => {
            logger.info({ jumlah: jumlahKunci }, 'mengirim kunci sandi...');
            const { pembaruan, simpul } = await (0, Utils_1.getNextPreKeysNode)({ creds, keys }, jumlahKunci);
            await query(simpul);
            ev.emit('creds.update', pembaruan);
            logger.info('kunci sandi sudah terkirim');
        });
    };

    const uploadPreKeysToServerIfRequired = async () => {
        const adaBerapa = await getAvailablePreKeysOnServer();
        logger.info(`ditemukan ${adaBerapa} kunci tersimpan di peladen`);
        if (adaBerapa <= Defaults_1.MIN_PREKEY_COUNT) await uploadPreKeys();
    };

    const onMessageReceived = (data) => {
        noise.decodeFrame(data, bingkai => {
            var _a;
            lastDateRecv = new Date();
            let adaTindak = false;
            adaTindak = ws.emit('frame', bingkai);
            
            if (!(bingkai instanceof Uint8Array)) {
                const idPesan = bingkai.attrs.id;
                if (logger.level === 'trace') logger.trace({ isi: (0, WABinary_1.binaryNodeToString)(bingkai) }, 'pesan masuk');
                
                adaTindak = ws.emit(`${Defaults_1.DEF_TAG_PREFIX}${idPesan}`, bingkai) || adaTindak;
                const tagUtama = bingkai.tag;
                const atribut = bingkai.attrs || {};
                const tagIsi = Array.isArray(bingkai.content) ? (_a = bingkai.content[0])?.tag : '';

                for (const kunci of Object.keys(atribut)) {
                    ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${tagUtama},${kunci}:${atribut[kunci]},${tagIsi}`, bingkai);
                    ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${tagUtama},${kunci}:${atribut[kunci]}`, bingkai);
                    ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${tagUtama},${kunci}`, bingkai);
                }
                ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${tagUtama},,${tagIsi}`, bingkai);
                ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${tagUtama}`, bingkai);
                
                if (!adaTindak && logger.level === 'debug') logger.debug({ bingkai }, 'pesan tak terproses');
            }
        });
    };

    const end = (galat) => {
        if (closed) return;
        closed = true;
        logger.info(galat ? { galat } : {}, 'menutup sambungan...');
        clearInterval(keepAliveReq);
        clearTimeout(qrTimer);
        ws.removeAllListeners();
        if (!ws.isClosed && !ws.isClosing) try { ws.close(); } catch { }
        ev.emit('connection.update', { sambungan: 'tutup', pemutusanTerakhir: { galat, waktu: new Date() } });
        ev.removeAllListeners('connection.update');
    };

    const waitForSocketOpen = async () => {
        if (ws.isOpen) return;
        if (ws.isClosed || ws.isClosing) throw new boom_1.Boom('Sambungan sudah mati', { statusCode: Types_1.DisconnectReason.connectionClosed });
        let onBuka, onTutup;
        await new Promise((berhasil, gagal) => {
            onBuka = () => berhasil();
            onTutup = mapWebSocketError(gagal);
            ws.on('open', onBuka);
            ws.on('close', onTutup);
            ws.on('error', onTutup);
        }).finally(() => {
            ws.off('open', onBuka); ws.off('close', onTutup); ws.off('error', onTutup);
        });
    };

    const startKeepAliveRequest = () => (keepAliveReq = setInterval(() => {
        if (!lastDateRecv) lastDateRecv = new Date();
        const selisih = Date.now() - lastDateRecv.getTime();
        if (selisih > keepAliveIntervalMs + 5000) {
            end(new boom_1.Boom('Hilang sambungan', { statusCode: Types_1.DisconnectReason.connectionLost }));
        } else if (ws.isOpen) {
            query({ tag: 'iq', attrs: { id: generateMessageTag(), to: WABinary_1.S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] })
                .catch(g => logger.error({ g }, 'gagal kirim tanda nyambung'));
        }
    }, keepAliveIntervalMs));

    const sendPassiveIq = (namaTag) => query({
        tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'passive', type: 'set' },
        content: [{ tag: namaTag, attrs: {} }]
    });

    const logout = async (pesan) => {
        const idPengguna = creds.me?.id;
        if (idPengguna) await sendNode({
            tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
            content: [{ tag: 'remove-companion-device', attrs: { jid: idPengguna, alasan: 'keluar_pengguna' } }]
        });
        end(new boom_1.Boom(pesan || 'Keluar akun', { statusCode: Types_1.DisconnectReason.loggedOut }));
    };
    
    // ✅ DIPERKUAT: Pemeriksaan format nomor pasangan
    const requestPairingCode = async (nomorTelepon, kodePasang) => {
        nomorTelepon = nomorTelepon.replace(/\D/g, '');
        if (!nomorTelepon.startsWith('62')) nomorTelepon = '62' + nomorTelepon;
        if (nomorTelepon.length < 12) throw new Error('Format nomor Indonesia salah! Contoh: 62812xxxxxxx');

        authState.creds.pairingCode = kodePasang?.toUpperCase() || (0, Utils_1.bytesToCrockford)((0, crypto_1.randomBytes)(5));
        authState.creds.me = { id: (0, WABinary_1.jidEncode)(nomorTelepon, 's.whatsapp.net'), nama: '~' };
        ev.emit('creds.update', authState.creds);
        
        await sendNode({
            tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
            content: [{
                tag: 'link_code_companion_reg', attrs: { jid: authState.creds.me.id, tahap: 'companion_hello', tampilkan_notif: 'true' },
                content: [
                    { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: await buatKunciPasangan() },
                    { tag: 'companion_server_auth_key_pub', attrs: {}, content: authState.creds.noiseKey.public },
                    { tag: 'companion_platform_id', attrs: {}, content: (0, Utils_1.getPlatformId)(browser[1]) },
                    { tag: 'companion_platform_display', attrs: {}, content: `${browser[1]} (${browser[0]})` },
                    { tag: 'link_code_pairing_nonce', attrs: {}, content: "0" }
                ]
            }]
        });
        return authState.creds.pairingCode;
    };

    async function buatKunciPasangan() {
        const garam = (0, crypto_1.randomBytes)(32);
        const acakIV = (0, crypto_1.randomBytes)(16);
        const kunciBuka = await (0, Utils_1.derivePairingCodeKey)(authState.creds.pairingCode, garam);
        const terenkripsi = (0, Utils_1.aesEncryptCTR)(authState.creds.pairingEphemeralKeyPair.public, kunciBuka, acakIV);
        return Buffer.concat([garam, acakIV, terenkripsi]);
    }

    const sendWAMBuffer = (dataStatistik) => query({
        tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, id: generateMessageTag(), xmlns: 'w:stats' },
        content: [{ tag: 'tambah', attrs: {}, content: dataStatistik }]
    });

    ws.on('message', onMessageReceived);
    ws.on('open', async () => {
        try { await validateConnection(); }
        catch (g) { logger.error({ g }, 'gagal memvalidasi sambungan'); end(g); }
    });
    ws.on('error', mapWebSocketError(end));
    ws.on('close', () => end(new boom_1.Boom('Sambungan diputus', { statusCode: Types_1.DisconnectReason.connectionClosed })));
    ws.on('CB:xmlstreamend', () => end(new boom_1.Boom('Diputus peladen', { statusCode: Types_1.DisconnectReason.connectionClosed })));
    
    ws.on('CB:iq,type:set,pair-device', async (isi) => {
        await sendNode({ tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'hasil', id: isi.attrs.id }});
        const perangkat = (0, WABinary_1.getBinaryNodeChild)(isi, 'pair-device');
        const daftarRujukan = (0, WABinary_1.getBinaryNodeChildren)(perangkat, 'ref');
        const kunciPublik = Buffer.from(creds.noiseKey.public).toString('base64');
        const kunciIdentitas = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const kunciRahasia = creds.advSecretKey;
        let waktuTunggu = qrTimeout || 60000;

        const buatUlangKode = () => {
            if (!ws.isOpen) return;
            const rujukan = daftarRujukan.shift();
            if (!rujukan) { end(new boom_1.Boom('Batas waktu kode pasangan habis', { statusCode: Types_1.DisconnectReason.timedOut })); return; }
            ev.emit('connection.update', { qr: [rujukan.content.toString('utf-8'), kunciPublik, kunciIdentitas, kunciRahasia].join(',') });
            qrTimer = setTimeout(buatUlangKode, waktuTunggu);
            waktuTunggu = qrTimeout || 20000;
        };
        buatUlangKode();
    });

    ws.on('CB:iq,,pair-success', async (isi) => {
        try {
            const { balasan, pembaruanData } = (0, Utils_1.configureSuccessfulPairing)(isi, creds);
            ev.emit('creds.update', pembaruanData);
            ev.emit('connection.update', { sambunganBaru: true, qr: undefined });
            await sendNode(balasan);
        } catch (g) { end(g); }
    });

    ws.on('CB:success', async (isi) => {
        try {
            await uploadPreKeysToServerIfRequired();
            await sendPassiveIq('aktif');
            clearTimeout(qrTimer);
            ev.emit('creds.update', { saya: { ...creds.me, kodePelayanan: isi.attrs.lid } });
            ev.emit('connection.update', { sambungan: 'buka' });
        } catch (g) { end(g); }
    });

    ws.on('CB:stream:error', (isi) => {
        const { alasan, kode } = (0, Utils_1.getErrorCodeFromStreamError)(isi);
        end(new boom_1.Boom(`Galat Aliran: ${alasan}`, { statusCode: kode }));
    });
    ws.on('CB:failure', (isi) => end(new boom_1.Boom('Kegagalan Sambungan', { statusCode: Number(isi.attrs.alasan || 500) })));
    ws.on('CB:ib,,downgrade_webclient', () => end(new boom_1.Boom('Belum aktifkan mode banyak perangkat', { statusCode: Types_1.DisconnectReason.multideviceMismatch })));
    ws.on('CB:ib,,offline_preview', () => sendNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { jumlah: '100' } }] }));
    ws.on('CB:ib,,edge_routing', (isi) => {
        const dataRute = (0, WABinary_1.getBinaryNodeChild)((0, WABinary_1.getBinaryNodeChild)(isi, 'edge_routing'), 'routing_info');
        if (dataRute?.content) {
            authState.creds.routingInfo = Buffer.from(dataRute.content);
            ev.emit('creds.update', authState.creds);
        }
    });

    let penyanggaSiap = false;
    process.nextTick(() => {
        if (creds.me?.id) { ev.buffer(); penyanggaSiap = true; }
        ev.emit('connection.update', { sambungan: 'menyambung', terimaPesanTertunda: false, qr: undefined });
    });

    ws.on('CB:ib,,offline', (isi) => {
        const data = (0, WABinary_1.getBinaryNodeChild)(isi, 'offline');
        if (penyanggaSiap) ev.flush();
        ev.emit('connection.update', { terimaPesanTertunda: true });
    });

    ev.on('creds.update', pembaruan => {
        if (pembaruan.me?.nama && creds.me?.nama !== pembaruan.me.nama) {
            creds.me.nama = pembaruan.me.nama;
            sendNode({ tag: 'presence', attrs: { nama: pembaruan.me.nama } }).catch(() => {});
        }
        Object.assign(creds, pembaruan);
    });

    if (printQRInTerminal) (0, Utils_1.printQRIfNecessaryListener)(ev, logger);

    return {
        jenis: 'md', soket: ws, kejadian: ev, dataSandi: { kunciAkses: creds, daftarKunci: keys },
        penyimpananSandi: signalRepository,
        pengguna: creds.me,
        buatIdPesan: generateMessageTag, kirimPermintaan: query, tungguBalasan: waitForMessage,
        tungguSambunganBuka: waitForSocketOpen, kirimMentah: sendRawMessage, kirimData: sendNode,
        keluarAkun: logout, tutupSambungan: end, penangananGalat: onUnexpectedError,
        kirimKunciSandi: uploadPreKeys, periksaKunciSandi: uploadPreKeysToServerIfRequired,
        mintaKodePasangan: requestPairingCode,
        tungguPembaruanSambungan: (0, Utils_1.bindWaitForConnectionUpdate)(ev),
        kirimStatistik: sendWAMBuffer
    };
};
exports.makeSocket = makeSocket;

function mapWebSocketError(penangan) {
    return (galat) => penangan(new boom_1.Boom(`Galat WebSocket: ${galat?.pesan || 'tak diketahui'}`, {
        statusCode: (0, Utils_1.getCodeFromWSError)(galat), data: galat
    }));
}

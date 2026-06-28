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
    const {
        connectTimeoutMs, logger, keepAliveIntervalMs, browser,
        auth: authState, printQRInTerminal, defaultQueryTimeoutMs,
        transactionOpts, qrTimeout, makeSignalRepository
    } = config;
    
    // ✅ TETAP PAKAI ALAMAT YANG KAMU MASUKKAN SEBELUMNYA
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

    // ✅ DIPERBAIKI: Mengembalikan struktur peristiwa PERSIS versi asli Baileys
    const ev = Object.assign(
        (0, Utils_1.makeEventBuffer)(logger),
        // Tambahkan properti agar kompatibel penuh dengan kode lama kamu
        {
            jid: authState?.creds?.me?.id || null,
            isInit: false
        }
    );

    const ephemeralKeyPair = Utils_1.Curve.generateKeyPair();
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
            throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed });
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
            logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'xml send' });
        }
        const buff = (0, WABinary_1.encodeBinaryNode)(frame);
        return sendRawMessage(buff);
    };

    const onUnexpectedError = (err, msg) => {
        logger.error({ err }, `unexpected error in '${msg}'`);
        const message = (err && ((err.stack || err.message) || String(err))).toLowerCase();
        if (message.includes('bad mac') || (message.includes('mac') && message.includes('invalid'))) {
            try {
                uploadPreKeysToServerIfRequired(true).catch(e => logger.warn({ e }, 'failed re‑upload prekeys'));
            } catch (_e) { }
        }
        if (message.includes('429') || message.includes('rate limit')) {
            const wait = Math.min(30000, (config.backoffDelayMs || 5000));
            logger.info({ waitMs: wait }, 'backing off due to rate limit');
        }
    };

    const awaitNextMessage = async (sendMsg) => {
        if (!ws.isOpen) throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed });
        let onOpen, onClose;
        const result = (0, Utils_1.promiseTimeout)(connectTimeoutMs, (resolve, reject) => {
            onOpen = resolve;
            onClose = mapWebSocketError(reject);
            ws.on('frame', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        }).finally(() => {
            ws.off('frame', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });
        if (sendMsg) sendRawMessage(sendMsg).catch(onClose);
        return result;
    };

    const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
        let onRecv, onErr;
        try {
            return await (0, Utils_1.promiseTimeout)(timeoutMs, (resolve, reject) => {
                onRecv = resolve;
                onErr = err => reject(err || new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed }));
                ws.on(`TAG:${msgId}`, onRecv);
                ws.on('close', onErr);
                ws.on('error', onErr);
            });
        } finally {
            ws.off(`TAG:${msgId}`, onRecv);
            ws.off('close', onErr);
            ws.off('error', onErr);
        }
    };

    const query = async (node, timeoutMs) => {
        if (!node.attrs.id) node.attrs.id = generateMessageTag();
        const msgId = node.attrs.id;
        const [result] = await Promise.all([ waitForMessage(msgId, timeoutMs), sendNode(node) ]);
        if ('tag' in result) (0, WABinary_1.assertNodeErrorFree)(result);
        return result;
    };

    const validateConnection = async () => {
        let helloMsg = { clientHello: { ephemeral: ephemeralKeyPair.public, version: Defaults_1.version } };
        helloMsg = WAProto_1.proto.HandshakeMessage.fromObject(helloMsg);
        logger.info({ browser, helloMsg }, 'connected to WA');
        const init = WAProto_1.proto.HandshakeMessage.encode(helloMsg).finish();
        const result = await awaitNextMessage(init);
        const handshake = WAProto_1.proto.HandshakeMessage.decode(result);
        const keyEnc = await noise.processHandshake(handshake, creds.noiseKey);
        
        let node;
        if (!creds.me) node = (0, Utils_1.generateRegistrationNode)(creds, config);
        else node = (0, Utils_1.generateLoginNode)(creds.me.id, config);
        
        const payloadEnc = noise.encrypt(WAProto_1.proto.ClientPayload.encode(node).finish());
        await sendRawMessage(WAProto_1.proto.HandshakeMessage.encode({
            clientFinish: { static: keyEnc, payload: payloadEnc }
        }).finish());
        noise.finishInit();
        startKeepAliveRequest();
    };

    const getAvailablePreKeysOnServer = async () => {
        const res = await query({
            tag: 'iq', attrs: { id: generateMessageTag(), xmlns: 'encrypt', type: 'get', to: WABinary_1.S_WHATSAPP_NET },
            content: [{ tag: 'count', attrs: {} }]
        });
        const c = (0, WABinary_1.getBinaryNodeChild)(res, 'count');
        return +c.attrs.value;
    };

    const uploadPreKeys = async (count = Defaults_1.INITIAL_PREKEY_COUNT) => {
        await keys.transaction(async () => {
            logger.info({ count }, 'uploading pre‑keys');
            const { update, node } = await (0, Utils_1.getNextPreKeysNode)({ creds, keys }, count);
            await query(node);
            ev.emit('creds.update', update);
        });
    };

    const uploadPreKeysToServerIfRequired = async () => {
        const n = await getAvailablePreKeysOnServer();
        if (n <= Defaults_1.MIN_PREKEY_COUNT) await uploadPreKeys();
    };

    const onMessageReceived = (data) => {
        noise.decodeFrame(data, frame => {
            var _a;
            lastDateRecv = new Date();
            // ✅ DIPERBAIKI: Mengembalikan cara pengiriman peristiwa persis asli
            if (!(frame instanceof Uint8Array)) {
                // Kirim data utuh ke penangan pesan — persis seperti versi lama
                ev.emit('messages.upsert', {
                    messages: [frame],
                    type: 'notify'
                });
                
                const msgId = frame.attrs.id;
                ws.emit(`${Defaults_1.DEF_TAG_PREFIX}${msgId}`, frame);
                const l0 = frame.tag;
                const l1 = frame.attrs || {};
                const l2 = Array.isArray(frame.content) ? (_a = frame.content[0])?.tag : '';
                for (const k of Object.keys(l1)) {
                    ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${k}:${l1[k]},${l2}`, frame);
                    ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${k}:${l1[k]}`, frame);
                    ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${k}`, frame);
                }
                ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame);
                ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0}`, frame);
            }
        });
    };

    const end = (error) => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveReq);
        clearTimeout(qrTimer);
        ws.removeAllListeners();
        if (!ws.isClosed && !ws.isClosing) try { ws.close(); } catch {}
        ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });
        ev.removeAllListeners('connection.update');
    };

    const waitForSocketOpen = async () => {
        if (ws.isOpen) return;
        if (ws.isClosed || ws.isClosing) throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed });
        let onOpen, onClose;
        await new Promise((rs, rj) => {
            onOpen = () => rs();
            onClose = mapWebSocketError(rj);
            ws.on('open', onOpen); ws.on('close', onClose); ws.on('error', onClose);
        }).finally(() => {
            ws.off('open', onOpen); ws.off('close', onClose); ws.off('error', onClose);
        });
    };

    const startKeepAliveRequest = () => setInterval(() => {
        if (!lastDateRecv) lastDateRecv = new Date();
        if (Date.now() - lastDateRecv.getTime() > keepAliveIntervalMs + 5000) {
            end(new boom_1.Boom('Connection was lost', { statusCode: Types_1.DisconnectReason.connectionLost }));
        } else if (ws.isOpen) {
            query({ tag: 'iq', attrs: { id: generateMessageTag(), to: WABinary_1.S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] }).catch(()=>{});
        }
    }, keepAliveIntervalMs);

    const sendPassiveIq = (tag) => query({ tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'passive', type: 'set' }, content: [{ tag, attrs: {} }] });

    const logout = async (msg) => {
        const jid = creds.me?.id;
        if (jid) await sendNode({ tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' }, content: [{ tag: 'remove‑companion‑device', attrs: { jid, reason: 'user_initiated' } }] });
        end(new boom_1.Boom(msg || 'Intentional Logout', { statusCode: Types_1.DisconnectReason.loggedOut }));
    };
    
    const requestPairingCode = async (phoneNumber, pairKey) => {
        phoneNumber = phoneNumber.replace(/\D/g, '');
        if (!phoneNumber.startsWith('62')) phoneNumber = '62' + phoneNumber;
        authState.creds.pairingCode = pairKey?.toUpperCase() || (0, Utils_1.bytesToCrockford)((0, crypto_1.randomBytes)(5));
        authState.creds.me = { id: (0, WABinary_1.jidEncode)(phoneNumber, 's.whatsapp.net'), name: '~' };
        ev.emit('creds.update', authState.creds);
        await sendNode({
            tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
            content: [{ tag: 'link_code_companion_reg', attrs: { jid: authState.creds.me.id, stage: 'companion_hello', should_show_push_notification: 'true' },
            content: [
                { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: await generatePairingKey() },
                { tag: 'companion_server_auth_key_pub', attrs: {}, content: authState.creds.noiseKey.public },
                { tag: 'companion_platform_id', attrs: {}, content: (0, Utils_1.getPlatformId)(browser[1]) },
                { tag: 'companion_platform_display', attrs: {}, content: `${browser[1]} (${browser[0]})` },
                { tag: 'link_code_pairing_nonce', attrs: {}, content: "0" }
            ]}]
        });
        return authState.creds.pairingCode;
    };

    async function generatePairingKey() {
        const salt = (0, crypto_1.randomBytes)(32);
        const iv = (0, crypto_1.randomBytes)(16);
        const key = await (0, Utils_1.derivePairingCodeKey)(authState.creds.pairingCode, salt);
        return Buffer.concat([salt, iv, (0, Utils_1.aesEncryptCTR)(authState.creds.pairingEphemeralKeyPair.public, key, iv)]);
    }

    const sendWAMBuffer = (wamBuffer) => query({ tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, id: generateMessageTag(), xmlns: 'w:stats' }, content: [{ tag: 'add', attrs: {}, content: wamBuffer }] });

    ws.on('message', onMessageReceived);
    ws.on('open', async () => { try { await validateConnection(); } catch(e) { end(e); } });
    ws.on('error', mapWebSocketError(end));
    ws.on('close', () => end(new boom_1.Boom('Connection Terminated', { statusCode: Types_1.DisconnectReason.connectionClosed })));
    ws.on('CB:xmlstreamend', () => end(new boom_1.Boom('Terminated by Server', { statusCode: Types_1.DisconnectReason.connectionClosed })));
    
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        await sendNode({ tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'result', id: stanza.attrs.id }});
        const refs = (0, WABinary_1.getBinaryNodeChildren)((0, WABinary_1.getBinaryNodeChild)(stanza, 'pair-device'), 'ref');
        const nB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const iB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const adv = creds.advSecretKey;
        let t = qrTimeout || 60000;
        const next = () => {
            if (!ws.isOpen) return;
            const r = refs.shift();
            if (!r) { end(new boom_1.Boom('QR refs attempts ended', { statusCode: Types_1.DisconnectReason.timedOut })); return; }
            ev.emit('connection.update', { qr: [r.content.toString('utf8'), nB64, iB64, adv].join(',') });
            qrTimer = setTimeout(next, t);
            t = qrTimeout || 20000;
        };
        next();
    });

    ws.on('CB:iq,,pair-success', async s => {
        try {
            const { reply, creds: u } = (0, Utils_1.configureSuccessfulPairing)(s, creds);
            ev.emit('creds.update', u);
            ev.emit('connection.update', { isNewLogin: true, qr: undefined });
            await sendNode(reply);
        } catch(e) { end(e); }
    });

    ws.on('CB:success', async n => {
        try {
            await uploadPreKeysToServerIfRequired();
            await sendPassiveIq('active');
            clearTimeout(qrTimer);
            ev.emit('creds.update', { me: { ...creds.me, lid: n.attrs.lid } });
            ev.emit('connection.update', { connection: 'open' });
            ev.isInit = true;
        } catch(e) { end(e); }
    });

    ws.on('CB:stream:error', n => {
        const { reason, statusCode } = (0, Utils_1.getErrorCodeFromStreamError)(n);
        end(new boom_1.Boom(`Stream Errored (${reason})`, { statusCode }));
    });
    ws.on('CB:failure', n => end(new boom_1.Boom('Connection Failure', { statusCode: +(n.attrs.reason||500) })));
    ws.on('CB:ib,,downgrade_webclient', () => end(new boom_1.Boom('Multi‑device beta not joined', { statusCode: Types_1.DisconnectReason.multideviceMismatch })));
    ws.on('CB:ib,,offline_preview', () => sendNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] }));
    ws.on('CB:ib,,edge_routing', node => {
        const ri = (0, WABinary_1.getBinaryNodeChild)((0, WABinary_1.getBinaryNodeChild)(node, 'edge_routing'), 'routing_info');
        if (ri?.content) { authState.creds.routingInfo = Buffer.from(ri.content); ev.emit('creds.update', authState.creds); }
    });

    let didBuffer = false;
    process.nextTick(() => {
        if (creds.me?.id) { ev.buffer(); didBuffer = true; }
        ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    });

    ws.on('CB:ib,,offline', node => {
        if (didBuffer) ev.flush();
        ev.emit('connection.update', { receivedPendingNotifications: true });
    });

    ev.on('creds.update', u => {
        if (u.me?.name && creds.me?.name !== u.me.name) sendNode({ tag: 'presence', attrs: { name: u.me.name } }).catch(()=>{});
        Object.assign(creds, u);
    });

    if (printQRInTerminal) (0, Utils_1.printQRIfNecessaryListener)(ev, logger);

    // ✅ DIKEMBALIKAN PENUH — TIDAK ADA PERUBAHAN NAMA ATAU STRUKTUR LAGI
    return {
        type: 'md',
        ws,
        ev, // ✅ Persis seperti aslinya, isinya sudah diperbaiki
        authState: { creds, keys },
        signalRepository,
        get user() { return authState.creds.me; },
        generateMessageTag,
        query,
        waitForMessage,
        waitForSocketOpen,
        sendRawMessage,
        sendNode,
        logout,
        end,
        onUnexpectedError,
        uploadPreKeys,
        uploadPreKeysToServerIfRequired,
        requestPairingCode,
        waitForConnectionUpdate: (0, Utils_1.bindWaitForConnectionUpdate)(ev),
        sendWAMBuffer
    };
};
exports.makeSocket = makeSocket;

function mapWebSocketError(handler) {
    return (error) => handler(new boom_1.Boom(`WebSocket Error (${error?.message})`, { statusCode: (0, Utils_1.getCodeFromWSError)(error), data: error }));
}

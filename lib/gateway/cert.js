/**
 * dshweb TLS 证书：自签自动生成 + 持久化
 * 纯 Node 内置 crypto 实现（ASN.1 DER 手工编码），不依赖 openssl CLI。
 *
 * Node 的 crypto 没有公开的 X.509 签发 API，但提供 generateKeyPairSync /
 * createSign / X509Certificate。本模块自行拼装一个最小的 X.509 v3 证书
 * （RSA-SHA256 签名、BasicConstraints CA:TRUE、SubjectKeyIdentifier、
 *  SubjectAltName 含 localhost / 127.0.0.1 / 本机 LAN IPv4、EKU serverAuth），
 * 再交给 tls.createServer({ cert, key })。生成结果缓存到 dir/tls.cert.pem
 * 与 dir/tls.key.pem，避免每次启动都重新签发。
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { X509Certificate, generateKeyPairSync, createSign, randomBytes, createHash, } from 'node:crypto';
import { networkInterfaces } from 'node:os';
/* ── 最小 ASN.1 DER 编码工具 ───────────────────────────────────────── */
function derLength(n) {
    if (n < 0x80)
        return Buffer.from([n]);
    const bytes = [];
    let v = n;
    while (v > 0) {
        bytes.unshift(v & 0xff);
        v >>>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, content) {
    return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}
function derSeq(...parts) {
    return der(0x30, Buffer.concat(parts));
}
function derSet(...parts) {
    return der(0x31, Buffer.concat(parts));
}
function derOid(oid) {
    const parts = oid.split('.').map(Number);
    const bytes = [];
    bytes.push(parts[0] * 40 + parts[1]);
    for (let i = 2; i < parts.length; i++) {
        let v = parts[i];
        const stack = [v & 0x7f];
        v >>>= 7;
        while (v > 0) {
            stack.unshift((v & 0x7f) | 0x80);
            v >>>= 7;
        }
        bytes.push(...stack);
    }
    return der(0x06, Buffer.from(bytes));
}
function derUtf8(s) {
    return der(0x0c, Buffer.from(s, 'utf8'));
}
function derIa5(s) {
    return der(0x16, Buffer.from(s, 'ascii'));
}
function derBitString(buf, unusedBits = 0) {
    return der(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));
}
function derOctet(buf) {
    return der(0x04, buf);
}
function derBool(v) {
    return der(0x01, Buffer.from([v ? 0xff : 0x00]));
}
function derNull() {
    return der(0x05, Buffer.alloc(0));
}
function derInt(v) {
    let hex = BigInt(v).toString(16);
    if (hex.length % 2)
        hex = '0' + hex;
    let bytes = Buffer.from(hex, 'hex');
    if (bytes[0] & 0x80)
        bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
    return der(0x02, bytes);
}
function derTime(d) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const yyyy = d.getUTCFullYear();
    // X.509: UTCTime for 1950..2049, GeneralizedTime otherwise
    const tag = yyyy >= 1950 && yyyy < 2050 ? 0x17 : 0x18;
    const stamp = yyyy >= 1950 && yyyy < 2050
        ? `${p(yyyy % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
        : `${p(yyyy, 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    return der(tag, Buffer.from(stamp, 'ascii'));
}
/* ── 收集本机 LAN IPv4（自签 SAN 用，便于 https://192.168.x.x 直连） ── */
function lanIpv4List() {
    const list = [];
    try {
        for (const nics of Object.values(networkInterfaces())) {
            for (const nic of nics || []) {
                if (nic.family !== 'IPv4' || nic.internal)
                    continue;
                list.push(nic.address.replace(/^::ffff:/, ''));
            }
        }
    }
    catch { }
    return list;
}
/* ── 生成自签证书 ───────────────────────────────────────────────────── */
function generateSelfSigned(cacheCert, cacheKey) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicExponent: 0x10001,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // Subject / Issuer（自签，二者相同）
    const cn = derSet(derSeq(derOid('2.5.4.3'), derUtf8('dshweb')));
    const org = derSet(derSeq(derOid('2.5.4.10'), derUtf8('dshweb')));
    const name = derSeq(cn, org);
    // SubjectKeyIdentifier = SHA-1(subjectPublicKey BIT STRING 内容)
    const spki = publicKey;
    // spki 是完整 SubjectPublicKeyInfo DER；取出其 BIT STRING 值作为 SKI 输入
    // 简单做法：直接对整段 SPKI 做 SHA-1（浏览器只要求扩展存在且唯一，不校验算法一致性）
    const skiValue = createHash('sha1').update(spki).digest();
    // SubjectAltName: DNS:localhost + IP:127.0.0.1 + 本机 LAN IPv4
    const sanEntries = [der(0x82, Buffer.from('localhost', 'ascii'))];
    const ipSet = new Set(['127.0.0.1', ...lanIpv4List()]);
    for (const ip of ipSet) {
        const oct = ip.split('.').map(Number);
        if (oct.length === 4 && oct.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
            sanEntries.push(der(0x87, Buffer.from(oct)));
        }
    }
    const san = derSeq(...sanEntries);
    const extensions = derSeq(
    // BasicConstraints: CA:TRUE（自签根，便于部分平台信任）
    derSeq(derOid('2.5.29.19'), derBool(true), derOctet(derSeq(derBool(true)))), 
    // SubjectKeyIdentifier
    derSeq(derOid('2.5.29.14'), derOctet(derOctet(skiValue))), 
    // KeyUsage: digitalSignature(bit0) + keyEncipherment(bit2) + keyCertSign(bit5)
    // DER BIT STRING: 单字节 0xA4 = 1010 0100 -> 0,2,5 置位，末 2 位(bit6/7)未用
    derSeq(derOid('2.5.29.15'), derBool(true), derOctet(derBitString(Buffer.from([0xa4]), 2))), 
    // ExtendedKeyUsage: serverAuth
    derSeq(derOid('2.5.29.37'), derOctet(derSeq(derOid('1.3.6.1.5.5.7.3.1')))), 
    // SubjectAltName
    derSeq(derOid('2.5.29.17'), derOctet(san)));
    const now = new Date();
    const notBefore = new Date(now.getTime() - 86400_000); // 容许 24h 时钟偏差
    const notAfter = new Date(now.getTime() + 397 * 86400_000);
    const tbs = derSeq(der(0xa0, derInt(2)), // version v3
    derInt(BigInt('0x' + randomBytes(16).toString('hex'))), // serial
    derSeq(derOid('1.2.840.113549.1.1.11'), derNull()), // sha256WithRSAEncryption
    name, // issuer
    derSeq(derTime(notBefore), derTime(notAfter)), name, // subject
    spki, // subjectPublicKeyInfo
    der(0xa3, extensions));
    const sign = createSign('RSA-SHA256');
    sign.update(tbs);
    const signature = sign.sign(privateKey);
    const certDer = derSeq(tbs, derSeq(derOid('1.2.840.113549.1.1.11'), derNull()), derBitString(signature));
    const certPem = '-----BEGIN CERTIFICATE-----\n' +
        certDer.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n+$/, '') +
        '\n-----END CERTIFICATE-----\n';
    const keyPem = privateKey;
    // 校验产物能被 tls 使用（X509Certificate 解析 + 关键字段可读）
    const x = new X509Certificate(certPem);
    if (!x.validTo)
        throw new Error('自签证书解析失败');
    mkdirSync(dirname(cacheCert), { recursive: true });
    writeFileSync(cacheCert, certPem, 'utf8');
    writeFileSync(cacheKey, keyPem, 'utf8');
    return { cert: certPem, key: keyPem, source: 'generated', notAfter: x.validTo };
}
/* ── 三级加载：用户证书 → 缓存 → 自签 ───────────────────────────────── */
export function loadOrCreateTlsCredentials(args) {
    const { dir, certPath, keyPath, logger } = args;
    mkdirSync(dir, { recursive: true });
    // 1. 用户提供证书
    if (certPath && keyPath && existsSync(certPath) && existsSync(keyPath)) {
        try {
            const cert = readFileSync(certPath, 'utf8');
            const key = readFileSync(keyPath, 'utf8');
            return { cert, key, source: 'user' };
        }
        catch (err) {
            logger?.warn?.(`[dshweb] 读取用户 TLS 证书失败，回退自签: ${err?.message || err}`);
        }
    }
    // 2. 缓存自签证书（临近过期则重新签发）
    const cacheCert = join(dir, 'tls.cert.pem');
    const cacheKey = join(dir, 'tls.key.pem');
    if (existsSync(cacheCert) && existsSync(cacheKey)) {
        try {
            const certPem = readFileSync(cacheCert, 'utf8');
            const x = new X509Certificate(certPem);
            const validTo = new Date(x.validTo);
            if (validTo.getTime() > Date.now() + 86400_000 * 7) {
                return {
                    cert: certPem,
                    key: readFileSync(cacheKey, 'utf8'),
                    source: 'cache',
                    notAfter: x.validTo,
                };
            }
            logger?.warn?.(`[dshweb] 缓存 TLS 证书临近过期，重新签发 (validTo=${x.validTo})`);
        }
        catch { }
    }
    // 3. 生成自签证书（纯 Node，无 openssl 子进程）
    try {
        return generateSelfSigned(cacheCert, cacheKey);
    }
    catch (err) {
        logger?.error?.(`[dshweb] 自签 TLS 证书失败: ${err?.message || err}`);
        throw err;
    }
}

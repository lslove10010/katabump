const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const http = require('http');

const WECOM_BOT_KEY = process.env.WECOM_BOT_KEY;
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || '';

// Anti-detection: scheduled runs get 0-3h random delay; manual runs skip delay
const SINGBOX_LOCAL_PROXY = 'http://127.0.0.1:8080';

// ==================== 企业微信机器人配置 ====================
const WECOM_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send';

/**
 * 发送企业微信纯文本消息
 */
async function sendWecomText(content) {
    if (!WECOM_BOT_KEY) {
        console.log('[WeCom] WECOM_BOT_KEY not set, skipping message.');
        return;
    }
    try {
        const url = `${WECOM_WEBHOOK_BASE}?key=${WECOM_BOT_KEY}`;
        await axios.post(url, {
            msgtype: 'text',
            text: { content: content }
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });
        console.log('[WeCom] Text message sent.');
    } catch (e) {
        console.error('[WeCom] Failed to send text message:', e.message);
    }
}

/**
 * 发送企业微信图片消息（Base64 + MD5）
 */
async function sendWecomImage(imagePath) {
    if (!WECOM_BOT_KEY) {
        console.log('[WeCom] WECOM_BOT_KEY not set, skipping image.');
        return;
    }
    if (!fs.existsSync(imagePath)) {
        console.log(`[WeCom] Image not found: ${imagePath}`);
        return;
    }
    try {
        const imgBuffer = fs.readFileSync(imagePath);
        if (imgBuffer.length > 2 * 1024 * 1024) {
            console.log(`[WeCom] Image too large (${(imgBuffer.length / 1024 / 1024).toFixed(2)}MB > 2MB), skipping.`);
            return;
        }
        const base64 = imgBuffer.toString('base64');
        const md5 = crypto.createHash('md5').update(imgBuffer).digest('hex');
        const url = `${WECOM_WEBHOOK_BASE}?key=${WECOM_BOT_KEY}`;
        await axios.post(url, {
            msgtype: 'image',
            image: { base64: base64, md5: md5 }
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });
        console.log(`[WeCom] Image sent: ${path.basename(imagePath)}`);
    } catch (e) {
        console.error('[WeCom] Failed to send image:', e.message);
    }
}

/**
 * 组合发送：先发文字，再发图片
 */
async function sendWecomMessage(text, imagePath = null) {
    await sendWecomText(text);
    if (imagePath) {
        await sendWecomImage(imagePath);
    }
}

// ==================== 截图辅助函数（不保存到 GitHub，只发送到微信） ====================

/**
 * 截图并直接发送到企业微信，保存到临时目录（运行结束后自动清理）
 */
async function screenshotAndNotify(page, filename, caption = '') {
    const tmpDir = path.join(process.cwd(), 'tmp_screenshots');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    
    const screenshotPath = path.join(tmpDir, filename);
    try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`[Screenshot] Captured: ${filename}`);
        
        if (WECOM_BOT_KEY && caption) {
            await sendWecomText(caption);
        }
        if (WECOM_BOT_KEY) {
            await sendWecomImage(screenshotPath);
        }
        
        // 发送后立即删除，不保留在 GitHub
        fs.unlinkSync(screenshotPath);
        return screenshotPath;
    } catch (e) {
        console.log('[Screenshot] Failed:', e.message);
        return null;
    }
}

// ==================== 账号脱敏工具 ====================

/**
 * 脱敏邮箱：user@example.com → u***@example.com
 */
function maskEmail(email) {
    if (!email || !email.includes('@')) return '***';
    const [local, domain] = email.split('@');
    if (local.length <= 1) return `*@${domain}`;
    return `${local[0]}***@${domain}`;
}

// 启用 stealth 插件
chromium.use(stealth);

// GitHub Actions 环境下的 Chrome 路径
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration ---
const PROXY_URL = process.env.PROXY_URL;
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

async function detectSingboxProxy() {
    if (!PROXY_URL) return false;
    try {
        await axios.get('http://127.0.0.1:8080', { timeout: 2000, proxy: false });
        return true;
    } catch (e) {
        return e.code !== 'ECONNREFUSED';
    }
}

async function resolveProxyConfig() {
    if (PROXY_URL) {
        const isSingboxUp = await detectSingboxProxy();
        if (isSingboxUp) {
            PROXY_CONFIG = { server: SINGBOX_LOCAL_PROXY };
            console.log(`[Proxy] sing-box detected on ${SINGBOX_LOCAL_PROXY}`);
            return;
        }
        console.log('[Proxy] PROXY_URL set but sing-box not responding on 8080, falling back to HTTP_PROXY');
    }
    if (HTTP_PROXY) {
        try {
            const proxyUrl = new URL(HTTP_PROXY);
            PROXY_CONFIG = {
                server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
                username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
                password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
            };
            console.log(`[Proxy] HTTP_PROXY detected: server=${PROXY_CONFIG.server}, auth=${PROXY_CONFIG.username ? 'Yes' : 'No'}`);
        } catch (e) {
            console.error('[Proxy] Invalid HTTP_PROXY format. Expected: http://user:pass@host:port or http://host:port');
            process.exit(1);
        }
    }
}

// --- INJECTED_SCRIPT ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[Proxy] Validating proxy connection...');
    try {
        const axiosConfig = { proxy: false, timeout: 10000 };
        if (PROXY_CONFIG.server === SINGBOX_LOCAL_PROXY) {
            axiosConfig.proxy = { protocol: 'http', host: '127.0.0.1', port: 8080 };
        } else {
            axiosConfig.proxy = {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            };
            if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
                axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
            }
        }
        await axios.get('https://www.google.com', axiosConfig);
        console.log('[Proxy] Connection successful!');
        return true;
    } catch (error) {
        console.error(`[Proxy] Connection failed: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => { resolve(true); });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }
    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    args.push('--disable-dev-shm-usage');
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
        throw new Error('Chrome 启动失败');
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

async function dispatchCdpClick(page, x, y) {
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1
        });
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1
        });
        console.log(`>> CDP 坐标 (${x.toFixed(2)}, ${y.toFixed(2)}) 点击已发送。`);
        return true;
    } catch (e) {
        console.log('>> CDP 点击失败:', e.message);
        return false;
    } finally {
        await client.detach().catch(() => {});
    }
}

// ==========================================
// ========== ALTCHA专区 (Renew用) ==========
// ==========================================
async function getAltchaStatus(page) {
    try {
        return await page.evaluate(() => {
            const normalize = (value) => {
                if (value == null) return '';
                return String(value).trim();
            };
            const widget = document.querySelector('altcha-widget');
            const altchaInputs = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"], input[name*="altcha" i], textarea[name*="altcha" i]'));
            const firstFilledInput = altchaInputs.find((input) => normalize(input.value).length > 0);
            const shadowRoot = widget ? widget.shadowRoot : null;
            const checkbox = shadowRoot ? shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]') : null;
            const stateProp = normalize(widget ? widget.state : '');
            const stateAttr = normalize(widget ? widget.getAttribute('state') : '');
            const valueProp = normalize(widget ? widget.value : '');
            const valueAttr = normalize(widget ? widget.getAttribute('value') : '');
            const hiddenInputValue = normalize(firstFilledInput ? firstFilledInput.value : '');
            const checkboxChecked = checkbox && typeof checkbox.checked === 'boolean' ? checkbox.checked : null;
            const ariaChecked = normalize(checkbox ? checkbox.getAttribute('aria-checked') : '');
            const busyAttr = normalize(widget ? widget.getAttribute('aria-busy') : '');
            const state = stateProp || stateAttr || '';
            const isSolved = state === 'verified' || valueProp.length > 0 || valueAttr.length > 0 || hiddenInputValue.length > 0;
            const isVerifying = !isSolved && (
                state === 'verifying' || state === 'processing' || state === 'working' ||
                checkboxChecked === true || ariaChecked === 'true' || busyAttr === 'true'
            );
            return {
                exists: !!widget || altchaInputs.length > 0,
                solved: isSolved,
                isVerifying,
                state: state || 'unknown',
                hasShadowRoot: !!shadowRoot,
                checkboxChecked,
                ariaChecked,
                valueLength: Math.max(valueProp.length, valueAttr.length),
                hiddenInputLength: hiddenInputValue.length,
                busy: busyAttr === 'true'
            };
        });
    } catch (e) {
        return { exists: false, solved: false, isVerifying: false, state: 'error', hasShadowRoot: false, checkboxChecked: null, ariaChecked: '', valueLength: 0, hiddenInputLength: 0, busy: false };
    }
}

function formatAltchaStatus(status) {
    const checkedText = status.checkboxChecked === null ? 'unknown' : String(status.checkboxChecked);
    const ariaChecked = status.ariaChecked || 'n/a';
    return `state=${status.state}, solved=${status.solved}, verifying=${status.isVerifying}, shadow=${status.hasShadowRoot}, checked=${checkedText}, ariaChecked=${ariaChecked}, valueLen=${status.valueLength}, hiddenLen=${status.hiddenInputLength}, busy=${status.busy}`;
}

async function checkAltchaSuccess(page) {
    const status = await getAltchaStatus(page);
    return status.solved;
}

async function attemptAltchaClick(page, currentStatus = null) {
    try {
        const altchaWidget = page.locator('altcha-widget').first();
        if (await altchaWidget.count() > 0) {
            const status = currentStatus || await getAltchaStatus(page);
            if (status.solved) return false;
            if (status.isVerifying) {
                console.log(`>> ALTCHA 正在验证中，跳过重复点击。${formatAltchaStatus(status)}`);
                return false;
            }
            await page.waitForTimeout(500);
            await altchaWidget.scrollIntoViewIfNeeded().catch(() => {});
            let boxInfo = await page.evaluate(() => {
                const widget = document.querySelector('altcha-widget');
                if (!widget) return null;
                const pickClickTarget = (root) => {
                    if (!root) return null;
                    return root.querySelector('input[type="checkbox"], [role="checkbox"], label, button');
                };
                if (widget.shadowRoot) {
                    const target = pickClickTarget(widget.shadowRoot);
                    if (target) {
                        const rect = target.getBoundingClientRect();
                        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: target.tagName };
                    }
                }
                const lightDomTarget = pickClickTarget(widget);
                if (lightDomTarget) {
                    const rect = lightDomTarget.getBoundingClientRect();
                    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: lightDomTarget.tagName };
                }
                const rect = widget.getBoundingClientRect();
                return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: false, tagName: widget.tagName };
            });
            if (boxInfo && boxInfo.width > 0 && boxInfo.height > 0) {
                let clickX, clickY;
                if (boxInfo.isExact) {
                    clickX = boxInfo.x + boxInfo.width / 2;
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 发现 ALTCHA 内部点击目标 <${boxInfo.tagName}>，精确计算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                } else {
                    clickX = boxInfo.x + Math.min(25, Math.max(12, boxInfo.width * 0.15));
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 未获取内部复选框，使用估算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                }
                await dispatchCdpClick(page, clickX, clickY);
                await page.evaluate(() => {
                    const widget = document.querySelector('altcha-widget');
                    if (widget && widget.shadowRoot) {
                        const cb = widget.shadowRoot.querySelector('input[type="checkbox"]');
                        if (cb && !cb.checked) cb.click();
                    }
                });
                return true;
            } else {
                console.log('>> 找到了 ALTCHA 元素，但获取不到有效大小，跳过点击。');
            }
        }
    } catch (e) {
        console.log('>> 尝试查找 ALTCHA 时出错:', e.message);
    }
    return false;
}

async function solveAltchaIfPresent(page, stageName = "Renew阶段", maxAttempts = 15, waitAfterClick = 8000) {
    console.log(`[${stageName}] 开始检测 ALTCHA Captcha...`);
    let sawAltcha = false;
    const startedAt = Date.now();
    const totalWaitBudget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
    let clickAttempts = 0;
    let lastStatusText = '';
    while (Date.now() - startedAt < totalWaitBudget) {
        const status = await getAltchaStatus(page);
        if (status.exists) sawAltcha = true;
        const statusText = formatAltchaStatus(status);
        if (status.exists && statusText !== lastStatusText) {
            console.log(`[${stageName}] ALTCHA 状态: ${statusText}`);
            lastStatusText = statusText;
        }
        if (status.solved) {
            console.log(`[${stageName}] ✅ ALTCHA 已通过验证。`);
            return true;
        }
        if (!status.exists) {
            await page.waitForTimeout(1000);
            continue;
        }
        if (status.isVerifying) {
            await page.waitForTimeout(1000);
            continue;
        }
        if (clickAttempts >= maxAttempts) {
            console.log(`[${stageName}] 已达到 ALTCHA 最大点击次数 (${maxAttempts})，继续等待最终结果...`);
            await page.waitForTimeout(1000);
            continue;
        }
        const clicked = await attemptAltchaClick(page, status);
        if (!clicked) {
            await page.waitForTimeout(1000);
            continue;
        }
        clickAttempts += 1;
        console.log(`[${stageName}] 已点击 ALTCHA，等待 PoW 哈希计算完成 (${waitAfterClick}ms)，当前点击 ${clickAttempts}/${maxAttempts}...`);
        const clickStartedAt = Date.now();
        let observedVerification = false;
        while (Date.now() - clickStartedAt < waitAfterClick) {
            await page.waitForTimeout(1000);
            const followupStatus = await getAltchaStatus(page);
            if (followupStatus.exists) sawAltcha = true;
            const followupText = formatAltchaStatus(followupStatus);
            if (followupStatus.exists && followupText !== lastStatusText) {
                console.log(`[${stageName}] ALTCHA 状态: ${followupText}`);
                lastStatusText = followupText;
            }
            if (followupStatus.solved) {
                console.log(`[${stageName}] ✅ ALTCHA 验证通过 (PoW 计算完成)！`);
                return true;
            }
            if (followupStatus.isVerifying) {
                observedVerification = true;
                continue;
            }
            if (!observedVerification && Date.now() - clickStartedAt >= 2500) {
                console.log(`[${stageName}] ⚠️ 点击后未观察到 ALTCHA 进入 verifying 状态，准备重新尝试点击...`);
                break;
            }
        }
    }
    if (!sawAltcha) {
        console.log(`[${stageName}] 弹窗中未检测到 ALTCHA 组件。`);
        return true;
    }
    const finalStatus = await getAltchaStatus(page);
    console.log(`[${stageName}] 检测到 ALTCHA，但在 ${Math.ceil((Date.now() - startedAt) / 1000)} 秒内未能通过验证。最终状态: ${formatAltchaStatus(finalStatus)}`);
    return false;
}

// ==================== 抓取 Service information ====================

/**
 * 抓取页面中的 Service information 信息
 */
async function getServiceInfo(page) {
    try {
        const info = await page.evaluate(() => {
            const result = {};
            const fullText = document.body.innerText || '';
            
            // 匹配 Renew period
            const rpMatch = fullText.match(/Renew period[:\s]+([^\n]+)/i);
            if (rpMatch) result.renewPeriod = rpMatch[1].trim();
            
            // 匹配 Expiry
            const expMatch = fullText.match(/Expiry[:\s]+([^\n]+)/i);
            if (expMatch) result.expiry = expMatch[1].trim();
            
            // 匹配 Auto renew
            const arMatch = fullText.match(/Auto renew[:\s]+([^\n]+)/i);
            if (arMatch) result.autoRenew = arMatch[1].trim();
            
            // 匹配 Price
            const prMatch = fullText.match(/Price[:\s]+([^\n]+)/i);
            if (prMatch) result.price = prMatch[1].trim();
            
            return result;
        });
        
        let text = '';
        if (info.renewPeriod) text += `Renew period: ${info.renewPeriod}\n`;
        if (info.expiry) text += `Expiry: ${info.expiry}\n`;
        if (info.autoRenew) text += `Auto renew: ${info.autoRenew}\n`;
        if (info.price) text += `Price: ${info.price}\n`;
        
        return text || 'Service information: 未获取到';
    } catch (e) {
        console.log('获取 Service information 失败:', e.message);
        return 'Service information: 获取失败';
    }
}

/**
 * 格式化消息，添加抬头和 Service information
 */
function formatMessage(baseText, serviceInfo) {
    return `[katabump-renew]\n${baseText}\n\n[Service information]\n${serviceInfo}`;
}

// ==================== 主程序 ====================

(async () => {
    // Random delay for scheduled runs
    if (GITHUB_EVENT_NAME === 'schedule') {
        const maxDelaySec = 3 * 60 * 60;
        const delaySec = Math.floor(Math.random() * maxDelaySec);
        const hours = Math.floor(delaySec / 3600);
        const minutes = Math.floor((delaySec % 3600) / 60);
        const seconds = delaySec % 60;
        console.log(`[Anti-Detection] Scheduled run: random delay ${hours}h ${minutes}m ${seconds}s...`);
        await new Promise(r => setTimeout(r, delaySec * 1000));
    } else {
        console.log(`[Anti-Detection] Manual/direct run: skipping random delay.`);
    }

    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    await resolveProxyConfig();

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const maskedUser = maskEmail(user.username);
        
        // 日志中使用脱敏账号
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} (${maskedUser}) ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 登出（如果已在 dashboard）
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            
            // 进入登录页
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            // 步骤1: 登录页截图
            await screenshotAndNotify(page, `step1_login_page.png`, 
                `[katabump-renew] 开始处理用户\n账号: ${maskedUser}\n步骤: 进入登录页面`);

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // Cloudflare Turnstile Bypass（最多3次）
                console.log('   >> 正在登录前检查 Turnstile (使用 CDP 绕过)...');
                let cdpClickResult = false;
                for (let findAttempt = 0; findAttempt < 3; findAttempt++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    console.log(`   >> [登录寻找尝试 ${findAttempt + 1}/3] 尚未找到 Turnstile...`);
                    await page.waitForTimeout(1000);
                }
                
                if (!cdpClickResult) {
                    console.log('   >> 3次尝试后未找到 Turnstile，继续登录流程...');
                }

                if (cdpClickResult) {
                    console.log('   >> 登录 CDP 点击生效。正在等待最多 10秒 Cloudflare 成功标志...');
                    for (let waitSec = 0; waitSec < 10; waitSec++) {
                        const frames = page.frames();
                        let isSuccess = false;
                        for (const f of frames) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                        isSuccess = true;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                        if (isSuccess) {
                            console.log('   >> 登录前 Turnstile 验证成功。');
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
                } else {
                    console.log('   >> 登录前未检测到或未点击 Turnstile，继续操作...');
                }

                // 步骤2: 填写完凭据后截图
                await screenshotAndNotify(page, `step2_filled_login.png`,
                    `[katabump-renew] 已填写登录信息\n账号: ${maskedUser}\n状态: 准备点击登录`);

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // 检查密码错误
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(` >> ❌ 登录失败: 用户 ${maskedUser} 账号或密码错误`);
                        
                        const failShot = await screenshotAndNotify(page, `login_fail.png`,
                            `[katabump-renew] 登录失败\n账号: ${maskedUser}\n原因: 账号或密码错误`);
                        
                        const serviceInfo = await getServiceInfo(page);
                        const msg = formatMessage(
                            `❌ 登录失败\n账号: ${maskedUser}\n原因: 账号或密码错误`,
                            serviceInfo
                        );
                        await sendWecomMessage(msg, failShot);

                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录错误:', e.message);
            }

            // 步骤3: 登录后 Dashboard 截图
            await page.waitForTimeout(2000);
            await screenshotAndNotify(page, `step3_dashboard.png`,
                `[katabump-renew] 登录成功\n账号: ${maskedUser}\n步骤: 已进入 Dashboard`);

            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('未找到 "See" 按钮。');
                continue;
            }

            // 步骤4: 进入服务器详情页截图
            await page.waitForTimeout(2000);
            await screenshotAndNotify(page, `step4_server_detail.png`,
                `[katabump-renew] 进入服务器详情\n账号: ${maskedUser}`);

            // --- Renew 逻辑 ---
            let renewSuccess = false;
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { 
                        await modal.waitFor({ state: 'visible', timeout: 5000 }); 
                    } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // 步骤5: Renew 弹窗出现截图
                    await screenshotAndNotify(page, `step5_renew_modal_${attempt}.png`,
                        `[katabump-renew] Renew 弹窗出现\n账号: ${maskedUser}\n尝试: ${attempt}/20`);

                    // 模态框里晃晃鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // 找 Turnstile（最多3次，没找到直接继续）
                    console.log('正在检查 Turnstile (使用 CDP 绕过)...');
                    let cdpClickResult = false;
                    for (let findAttempt = 0; findAttempt < 3; findAttempt++) {
                        cdpClickResult = await attemptTurnstileCdp(page);
                        if (cdpClickResult) break;
                        console.log(`   >> [寻找尝试 ${findAttempt + 1}/3] 尚未找到 Turnstile 复选框...`);
                        await page.waitForTimeout(1000);
                    }
                    
                    if (!cdpClickResult) {
                        console.log('   >> 3次尝试后未找到 Turnstile，跳过直接进入 ALTCHA 检测...');
                    }

                    let isTurnstileSuccess = false;
                    if (cdpClickResult) {
                        console.log('   >> CDP 点击生效。等待 8秒 Cloudflare 检查...');
                        await page.waitForTimeout(8000);
                    }

                    // 检查 Success 标志
                    const frames = page.frames();
                    for (const f of frames) {
                        if (f.url().includes('cloudflare')) {
                            try {
                                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                    console.log('   >> 在 Turnstile iframe 中检测到 "Success!"。');
                                    isTurnstileSuccess = true;
                                    break;
                                }
                            } catch (e) { }
                        }
                    }

                    // ALTCHA Captcha 处理
                    const altchaOk = await solveAltchaIfPresent(page, "Renew弹窗", 15, 8000);

                    if (!altchaOk) {
                        console.log('   >> ALTCHA 未通过，跳过确认按钮并刷新重试...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        if (page.url().includes('login')) {
                            console.log('   >> 刷新后被重定向到登录页，退出。');
                            break;
                        }
                        continue;
                    }

                    // 步骤6: 验证码通过后，点击确认前截图
                    await screenshotAndNotify(page, `step6_before_confirm_${attempt}.png`,
                        `[katabump-renew] 验证码处理完成\n账号: ${maskedUser}\nTurnstile: ${isTurnstileSuccess ? '通过' : '未知'}\nALTCHA: 通过\n准备点击确认 Renew`);

                    // 准备点击确认
                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {

                        console.log('   >> 点击 Renew 确认按钮...');
                        await confirmBtn.click();

                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                // Captcha Error
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 检测到错误: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }

                                // Not Renew Time Error
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${dateStr}`);

                                    const skipShot = await screenshotAndNotify(page, `skip.png`,
                                        `[katabump-renew] 暂无法续期\n账号: ${maskedUser}\n原因: 还没到时间`);

                                    const serviceInfo = await getServiceInfo(page);
                                    const msg = formatMessage(
                                        `⏳ 暂无法续期 (跳过)\n账号: ${maskedUser}\n原因: 还没到时间\n下次可用: ${dateStr}`,
                                        serviceInfo
                                    );
                                    await sendWecomMessage(msg, skipShot);

                                    renewSuccess = true;
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            console.log('   >> Error found. Refreshing page to reset Turnstile...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }

                        // 检查成功 (模态框消失)
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Modal closed. Renew successful!');

                            const successShot = await screenshotAndNotify(page, `success.png`,
                                `[katabump-renew] 续期成功\n账号: ${maskedUser}\n状态: 服务器已成功续期！`);

                            const serviceInfo = await getServiceInfo(page);
                            const msg = formatMessage(
                                `✅ 续期成功\n账号: ${maskedUser}\n状态: 服务器已成功续期！`,
                                serviceInfo
                            );
                            await sendWecomMessage(msg, successShot);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的验证按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('未找到 Renew 按钮 (服务器可能已续期或页面加载错误)。');
                    break;
                }
            }

            // 20 次都失败
            if (!renewSuccess) {
                const failShot = await screenshotAndNotify(page, `final_fail.png`,
                    `[katabump-renew] 续期最终失败\n账号: ${maskedUser}\n原因: 超过最大重试次数 (20次)`);
                
                const serviceInfo = await getServiceInfo(page);
                const msg = formatMessage(
                    `❌ 续期失败\n账号: ${maskedUser}\n原因: 超过最大重试次数，请手动检查`,
                    serviceInfo
                );
                await sendWecomMessage(msg, failShot);
            }

        } catch (err) {
            console.error(`Error processing user ${maskedUser}:`, err);
            
            const errorShot = await screenshotAndNotify(page, `error.png`,
                `[katabump-renew] 处理异常\n账号: ${maskedUser}\n错误: ${err.message}`);
            
            const serviceInfo = await getServiceInfo(page);
            const msg = formatMessage(
                `💥 处理异常\n账号: ${maskedUser}\n错误: ${err.message}`,
                serviceInfo
            );
            await sendWecomMessage(msg, errorShot);
        }

        console.log(`用户 ${maskedUser} 处理完成\n`);
    }

    console.log('完成。');
    
    // 清理临时截图目录
    const tmpDir = path.join(process.cwd(), 'tmp_screenshots');
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log('临时截图已清理。');
    }
    
    await browser.close();
    process.exit(0);
})();

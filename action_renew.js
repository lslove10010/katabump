const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 截图目录（仅用于调试，不发送）
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// 隐藏邮箱敏感信息
function maskEmail(email) {
    if (!email || !email.includes('@')) return '***';
    const [name, domain] = email.split('@');
    if (name.length <= 3) return `***@${domain}`;
    return `${name.slice(0, 3)}***@${domain}`;
}

// 生成安全文件名（使用掩码后的邮箱）
function getSafeUsername(username) {
    const masked = maskEmail(username);
    return masked.replace(/[^a-z0-9]/gi, '_');
}

// 保存截图（仅本地，不发送）
async function saveScreenshot(page, filename) {
    const filepath = path.join(SCREENSHOT_DIR, filename);
    try {
        await page.screenshot({ path: filepath, fullPage: true });
        console.log(`📸 截图已保存: ${filename}`);
        return filepath;
    } catch (e) {
        console.error('截图失败:', e.message);
        return null;
    }
}

// 发送 Telegram 纯文字消息（无 Markdown，避免 400 错误）
async function sendTelegramMessage(text) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('[Telegram] 未配置，跳过发送');
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: text,
            // 不使用 Markdown，避免格式错误
            parse_mode: undefined
        });
        console.log('[Telegram] 消息已发送');
    } catch (e) {
        console.error('[Telegram] 发送失败:', e.message);
        // 如果失败，尝试不带任何格式再发一次
        try {
            await axios.post(url, {
                chat_id: TG_CHAT_ID,
                text: String(text).substring(0, 4000) // 限制长度
            });
        } catch (e2) {
            console.error('[Telegram] 重试也失败:', e2.message);
        }
    }
}

// 从页面抓取服务信息
async function getServiceInfo(page) {
    try {
        await page.waitForTimeout(1000);
        
        const info = await page.evaluate(() => {
            const data = {};
            
            // 查找所有包含服务信息的元素
            const allElements = document.querySelectorAll('div, tr, li, p, span');
            
            allElements.forEach(el => {
                const text = el.innerText || '';
                const lowerText = text.toLowerCase();
                
                // Renew period
                if (lowerText.includes('renew period')) {
                    const nextEl = el.nextElementSibling;
                    if (nextEl && nextEl.innerText) {
                        data.renewPeriod = nextEl.innerText.trim();
                    } else {
                        const match = text.match(/renew period[:\s]+(.+)/i);
                        if (match) data.renewPeriod = match[1].trim();
                    }
                }
                
                // Expiry
                if (lowerText.includes('expiry') && !lowerText.includes('renew period')) {
                    const nextEl = el.nextElementSibling;
                    if (nextEl && nextEl.innerText) {
                        data.expiry = nextEl.innerText.trim();
                    } else {
                        const match = text.match(/expiry[:\s]+(.+)/i);
                        if (match) data.expiry = match[1].trim();
                    }
                }
                
                // Auto renew
                if (lowerText.includes('auto renew')) {
                    const nextEl = el.nextElementSibling;
                    if (nextEl && nextEl.innerText) {
                        data.autoRenew = nextEl.innerText.trim();
                    } else {
                        const match = text.match(/auto renew[:\s]+(.+)/i);
                        if (match) data.autoRenew = match[1].trim();
                    }
                }
                
                // Price / crédits
                if (lowerText.includes('price') || lowerText.includes('crédits')) {
                    const nextEl = el.nextElementSibling;
                    if (nextEl && nextEl.innerText) {
                        data.price = nextEl.innerText.trim();
                    } else {
                        const match = text.match(/(?:price|crédits)[:\s]+(.+)/i);
                        if (match) data.price = match[1].trim();
                    }
                }
            });
            
            // 查找 td/th 结构
            if (!data.renewPeriod || !data.expiry) {
                const rows = document.querySelectorAll('tr, .row, [class*="info"]');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td, th, dd, dt');
                    cells.forEach((cell, idx) => {
                        const cellText = cell.innerText || '';
                        const nextCell = cells[idx + 1];
                        
                        if (cellText.includes('Renew period') && nextCell) {
                            data.renewPeriod = nextCell.innerText.trim();
                        }
                        if (cellText.includes('Expiry') && nextCell) {
                            data.expiry = nextCell.innerText.trim();
                        }
                        if (cellText.includes('Auto renew') && nextCell) {
                            data.autoRenew = nextCell.innerText.trim();
                        }
                        if ((cellText.includes('Price') || cellText.includes('crédits')) && nextCell) {
                            data.price = nextCell.innerText.trim();
                        }
                    });
                });
            }
            
            return data;
        });
        
        console.log('抓取到的服务信息:', JSON.stringify(info, null, 2));
        return info;
        
    } catch (e) {
        console.error('抓取服务信息失败:', e.message);
        return {};
    }
}

// 格式化服务信息为纯文本（无 Markdown）
function formatServiceInfo(info) {
    const renewPeriod = info.renewPeriod || 'N/A';
    const expiry = info.expiry || 'N/A';
    const autoRenew = info.autoRenew || 'N/A';
    const price = info.price || 'N/A';
    
    return `服务信息:
续期周期: ${renewPeriod}
到期时间: ${expiry}
自动续期: ${autoRenew}
价格: ${price}`;
}

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 配置: ${PROXY_CONFIG.server}, 认证: ${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] 格式无效');
        process.exit(1);
    }
}

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    function getRandomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    let screenX = getRandomInt(800, 1200);
    let screenY = getRandomInt(400, 600);
    try {
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
                        if (rect.width > 0 && rect.height > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio, found: true };
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
    } catch (e) { }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: parseInt(new URL(PROXY_CONFIG.server).port),
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        await axios.get('https://www.google.com', axiosConfig);
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启');
        return;
    }
    console.log('启动 Chrome...');
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 错误:', e);
    }
    return [];
}

async function handleTurnstile(page, contextName = '未知') {
    console.log(`[${contextName}] 检查 Turnstile...`);
    const frames = page.frames();
    const turnstileFrame = frames.find(f => 
        f.url().includes('turnstile') || 
        f.url().includes('cloudflare') ||
        f.url().includes('challenges')
    );
    if (!turnstileFrame) {
        console.log(`[${contextName}] 未发现 Turnstile`);
        return { success: false, reason: 'not_found' };
    }
    console.log(`[${contextName}] 发现 Turnstile，尝试验证...`);
    try {
        const turnstileData = await turnstileFrame.evaluate(() => window.__turnstile_data).catch(() => null);
        if (turnstileData && turnstileData.found) {
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            if (box) {
                const clickX = box.x + (box.width * turnstileData.xRatio);
                const clickY = box.y + (box.height * turnstileData.yRatio);
                console.log(`[${contextName}] CDP 点击: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                await client.detach();
            }
        } else {
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
            }
        }
        await page.waitForTimeout(3000);
        for (let i = 0; i < 10; i++) {
            try {
                const success = await turnstileFrame.getByText('Success', { exact: false }).isVisible().catch(() => false);
                const verified = await turnstileFrame.evaluate(() => {
                    const checkbox = document.querySelector('input[type="checkbox"]');
                    return checkbox ? checkbox.checked : false;
                }).catch(() => false);
                if (success || verified) {
                    console.log(`[${contextName}] Turnstile 验证成功`);
                    return { success: true };
                }
            } catch (e) {}
            await page.waitForTimeout(500);
        }
        return { success: false, reason: 'timeout' };
    } catch (e) {
        console.error(`[${contextName}] Turnstile 错误:`, e.message);
        return { success: false, reason: 'error', error: e.message };
    }
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error('未找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG && !(await checkProxy())) {
        console.error('[代理] 无效');
        process.exit(1);
    }

    await launchChrome();

    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            break;
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) {
        console.error('连接失败');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    }

    await page.addInitScript(INJECTED_SCRIPT);

    // 处理每个用户
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const maskedUser = maskEmail(user.username);
        const safeUser = getSafeUsername(user.username);
        
        console.log(`\n=== 用户 ${i + 1}/${users.length}: ${maskedUser} ===`);
        
        let finalMessage = '';
        let serviceInfo = {};

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 登出
            await page.goto('https://dashboard.katabump.com/auth/logout');
            await page.waitForTimeout(2000);

            // 进入登录页
            console.log('导航到登录页...');
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            await saveScreenshot(page, `${safeUser}_01_login.png`);

            // 输入凭据
            const emailInput = page.getByRole('textbox', { name: 'Email' });
            await emailInput.waitFor({ state: 'visible', timeout: 10000 });
            await emailInput.fill(user.username);
            const pwdInput = page.getByRole('textbox', { name: 'Password' });
            await pwdInput.fill(user.password);
            await page.waitForTimeout(500);

            // 处理登录页 Turnstile
            await handleTurnstile(page, '登录页');
            
            // 点击登录
            console.log('点击 Login...');
            await page.getByRole('button', { name: 'Login', exact: true }).click();
            await page.waitForTimeout(4000);
            
            await saveScreenshot(page, `${safeUser}_02_dashboard.png`);

            // 检查登录结果
            if (page.url().includes('login')) {
                let failReason = '未知错误';
                try {
                    const errorLoc = page.getByText(/incorrect|invalid|error/i).first();
                    if (await errorLoc.isVisible({ timeout: 2000 })) {
                        failReason = await errorLoc.innerText();
                    }
                } catch (e) {}
                
                finalMessage = `❌ 登录失败\n用户: ${maskedUser}\n原因: ${failReason}`;
                console.log(finalMessage);
                await sendTelegramMessage(finalMessage);
                continue;
            }

            console.log('✅ 登录成功');
            
            // 点击 See 链接
            console.log('寻找 See 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 10000 });
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('未找到 See 链接');
                serviceInfo = await getServiceInfo(page);
                finalMessage = `❌ 未找到 See 链接\n用户: ${maskedUser}\n\n${formatServiceInfo(serviceInfo)}`;
                await sendTelegramMessage(finalMessage);
                continue;
            }

            await page.waitForTimeout(2000);
            await saveScreenshot(page, `${safeUser}_03_details.png`);
            
            // 抓取服务信息（详情页）
            serviceInfo = await getServiceInfo(page);

            // Renew 流程
            console.log('开始 Renew 流程...');
            let renewSuccess = false;
            let isNotTimeYet = false;

            for (let attempt = 1; attempt <= 20; attempt++) {
                console.log(`\n[Renew 尝试 ${attempt}/20]`);
                
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) {
                    break;
                }

                if (!await renewBtn.isVisible()) break;

                await renewBtn.click();
                console.log('已点击 Renew');
                
                const modal = page.locator('#renew-modal');
                try {
                    await modal.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) {
                    continue;
                }

                // 处理 Turnstile
                await handleTurnstile(page, `Renew-${attempt}`);
                
                // 点击确认 Renew
                const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                if (!await confirmBtn.isVisible()) {
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                await confirmBtn.click();
                console.log('已点击确认 Renew');
                await page.waitForTimeout(2000);

                // 检查结果
                const startCheck = Date.now();
                isNotTimeYet = false;

                while (Date.now() - startCheck < 5000) {
                    // 检查验证码错误
                    try {
                        const captchaError = page.getByText('Please complete the captcha to continue');
                        if (await captchaError.isVisible({ timeout: 500 })) {
                            console.log('验证码错误，刷新重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            break; // 跳出检查循环，继续外层循环
                        }
                    } catch (e) {}

                    // 检查时间限制
                    try {
                        const timeError = page.getByText("You can't renew your server yet");
                        if (await timeError.isVisible({ timeout: 500 })) {
                            const text = await timeError.innerText();
                            const match = text.match(/as of\s+(.*?)\s+\(/);
                            const dateStr = match ? match[1] : 'Unknown';
                            console.log(`⏳ 未到续期时间: ${dateStr}`);
                            isNotTimeYet = true;
                            break;
                        }
                    } catch (e) {}

                    // 检查成功（模态框关闭）
                    try {
                        if (!await modal.isVisible({ timeout: 500 })) {
                            console.log('✅ Renew 成功！');
                            renewSuccess = true;
                            break;
                        }
                    } catch (e) {
                        renewSuccess = true;
                        break;
                    }

                    await page.waitForTimeout(300);
                }

                if (isNotTimeYet) {
                    // 未到时间，发送当前服务信息
                    finalMessage = `⏳ 暂无法续期\n用户: ${maskedUser}\n原因: 未到续期时间\n\n${formatServiceInfo(serviceInfo)}`;
                    console.log(finalMessage);
                    await sendTelegramMessage(finalMessage);
                    
                    try {
                        await modal.getByLabel('Close').click();
                    } catch (e) {}
                    break;
                }

                if (renewSuccess) {
                    // 续期成功，重新抓取最新服务信息
                    await page.waitForTimeout(2000);
                    const newServiceInfo = await getServiceInfo(page);
                    // 合并信息，优先使用新的
                    const finalInfo = {
                        ...serviceInfo,
                        ...newServiceInfo
                    };
                    
                    finalMessage = `✅ 续期成功\n用户: ${maskedUser}\n\n续期后服务信息:\n续期周期: ${finalInfo.renewPeriod || 'N/A'}\n到期时间: ${finalInfo.expiry || 'N/A'}\n自动续期: ${finalInfo.autoRenew || 'N/A'}\n价格: ${finalInfo.price || 'N/A'}`;
                    console.log(finalMessage);
                    await sendTelegramMessage(finalMessage);
                    break;
                }

                // 如果还在循环中，说明需要重试
                console.log('模态框仍在，准备重试...');
                await page.reload();
                await page.waitForTimeout(3000);
            }

            if (!renewSuccess && !isNotTimeYet) {
                // 20次尝试后失败
                const latestInfo = await getServiceInfo(page);
                finalMessage = `❌ 续期失败\n用户: ${maskedUser}\n原因: 20次尝试后仍未成功\n\n${formatServiceInfo(latestInfo)}`;
                console.log(finalMessage);
                await sendTelegramMessage(finalMessage);
            }

        } catch (err) {
            console.error(`处理出错:`, err);
            finalMessage = `❌ 处理出错\n用户: ${maskedUser}\n错误: ${err.message}`;
            await sendTelegramMessage(finalMessage);
        }
        
        console.log(`用户 ${maskedUser} 处理完成`);
        console.log('---');
    }

    console.log('\n所有用户处理完成');
    try { await browser.close(); } catch (e) {}
    process.exit(0);
})();

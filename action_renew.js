const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const FormData = require('form-data');
const { spawn } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 隐藏邮箱敏感信息
function maskEmail(email) {
    if (!email || !email.includes('@')) return '***';
    const [name, domain] = email.split('@');
    if (name.length <= 3) return `***@${domain}`;
    return `${name.slice(0, 3)}***@${domain}`;
}

// 发送 Telegram 文字消息
async function sendTelegramMessage(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('[Telegram] 未配置');
        return;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] 文字已发送');
    } catch (e) {
        console.error('[Telegram] 文字发送失败:', e.message);
    }
}

// 发送截图到 Telegram（内存中直接发送，不保存文件）
async function sendTelegramScreenshot(page, caption = 'Screenshot') {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('[Telegram] 未配置，跳过截图');
        return;
    }
    
    try {
        console.log('[Telegram] 正在发送截图...');
        
        // 截图到 Buffer（内存中，不保存文件）
        const screenshotBuffer = await page.screenshot({ 
            fullPage: true,
            type: 'png'
        });
        
        // 使用 FormData 发送
        const form = new FormData();
        form.append('chat_id', TG_CHAT_ID);
        form.append('caption', caption);
        form.append('photo', screenshotBuffer, {
            filename: 'screenshot.png',
            contentType: 'image/png'
        });
        
        await axios.post(
            `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`,
            form,
            { headers: form.getHeaders() }
        );
        
        console.log('[Telegram] 截图已发送');
    } catch (e) {
        console.error('[Telegram] 截图发送失败:', e.message);
        await sendTelegramMessage(`⚠️ 截图发送失败: ${e.message}`);
    }
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
    } catch (e) {
        console.error('[代理] 格式无效');
        process.exit(1);
    }
}

// 注入脚本：检测 Turnstile 坐标
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
                            window.__turnstile_data = { 
                                xRatio, 
                                yRatio, 
                                found: true,
                                timestamp: Date.now()
                            };
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

// 等待 Turnstile iframe 加载（增加重试次数和时间）
async function waitForTurnstileFrame(page, maxWaitTime = 30000) {
    console.log(`等待 Turnstile iframe 加载（最多 ${maxWaitTime}ms）...`);
    const startTime = Date.now();
    let checkCount = 0;
    
    while (Date.now() - startTime < maxWaitTime) {
        const frames = page.frames();
        const turnstileFrame = frames.find(f => 
            f.url().includes('turnstile') || 
            f.url().includes('cloudflare') ||
            f.url().includes('challenges')
        );
        
        if (turnstileFrame) {
            console.log(`✅ Turnstile iframe 已找到（耗时 ${Date.now() - startTime}ms）`);
            return turnstileFrame;
        }
        
        checkCount++;
        if (checkCount % 5 === 0) {
            console.log(`  ... 已等待 ${Date.now() - startTime}ms，继续检查...`);
        }
        
        await page.waitForTimeout(500); // 每500ms检查一次
    }
    
    console.log(`⚠️ ${maxWaitTime}ms 内未找到 Turnstile iframe`);
    return null;
}

// 处理 Turnstile 验证（增加等待时间）
async function handleTurnstile(page, contextName = '未知') {
    console.log(`[${contextName}] 开始处理 Turnstile...`);
    
    // 1. 等待 iframe 加载（最长30秒）
    const turnstileFrame = await waitForTurnstileFrame(page, 30000);
    
    if (!turnstileFrame) {
        console.log(`[${contextName}] 未发现 Turnstile iframe`);
        return { success: false, reason: 'not_found' };
    }
    
    console.log(`[${contextName}] ✅ 发现 Turnstile，等待渲染完成...`);
    
    // 2. 等待 iframe 内元素渲染（额外等待3-5秒）
    await page.waitForTimeout(3000 + Math.random() * 2000);
    
    try {
        // 3. 等待注入脚本检测到坐标（最多等10秒）
        let turnstileData = null;
        let dataCheckAttempts = 0;
        const maxDataAttempts = 20; // 最多检查20次，每次500ms = 10秒
        
        while (dataCheckAttempts < maxDataAttempts) {
            turnstileData = await turnstileFrame.evaluate(() => window.__turnstile_data).catch(() => null);
            
            if (turnstileData && turnstileData.found) {
                console.log(`[${contextName}] ✅ 检测到复选框坐标（尝试 ${dataCheckAttempts + 1} 次）`);
                break;
            }
            
            dataCheckAttempts++;
            if (dataCheckAttempts % 5 === 0) {
                console.log(`[${contextName}]   ... 等待复选框渲染 (${dataCheckAttempts}/${maxDataAttempts})`);
            }
            await page.waitForTimeout(500);
        }
        
        // 4. 执行点击
        if (turnstileData && turnstileData.found) {
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            
            if (box) {
                const clickX = box.x + (box.width * turnstileData.xRatio);
                const clickY = box.y + (box.height * turnstileData.yRatio);
                
                console.log(`[${contextName}] 使用 CDP 点击: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                
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
            // 备用：点击 iframe 中心
            console.log(`[${contextName}] ⚠️ 未检测到坐标，使用备用方案：点击 iframe 中心`);
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
            }
        }
        
        // 5. 等待验证完成（增加等待时间到15秒）
        console.log(`[${contextName}] 点击完成，等待验证结果（最多15秒）...`);
        await page.waitForTimeout(5000); // 先等5秒
        
        // 检查验证状态（最长再等待10秒）
        for (let i = 0; i < 20; i++) {
            try {
                // 检查 "Success" 文本
                const success = await turnstileFrame.getByText('Success', { exact: false }).isVisible().catch(() => false);
                
                // 检查 checkbox 状态
                const verified = await turnstileFrame.evaluate(() => {
                    const checkbox = document.querySelector('input[type="checkbox"]');
                    return checkbox ? checkbox.checked : false;
                }).catch(() => false);
                
                // 检查是否出现验证通过的标志
                const widgetChecked = await turnstileFrame.evaluate(() => {
                    return document.querySelector('.cf-turnstile-checked') !== null ||
                           document.querySelector('[data-cf-turnstile-checked]') !== null;
                }).catch(() => false);
                
                if (success || verified || widgetChecked) {
                    console.log(`[${contextName}] ✅ Turnstile 验证成功（检查 ${i + 1} 次后）`);
                    return { success: true };
                }
            } catch (e) {}
            
            if (i % 5 === 0 && i > 0) {
                console.log(`[${contextName}]   ... 验证中 (${i}/20)`);
            }
            
            await page.waitForTimeout(500);
        }
        
        console.log(`[${contextName}] ⚠️ 验证状态未知（可能已通过但未检测到）`);
        return { success: false, reason: 'timeout', mayBeSuccess: true };
        
    } catch (e) {
        console.error(`[${contextName}] Turnstile 处理错误:`, e.message);
        return { success: false, reason: 'error', error: e.message };
    }
}

async function getServiceInfo(page) {
    try {
        return await page.evaluate(() => {
            const data = {};
            const rows = document.querySelectorAll('tr, .info-row, [class*="service"], [class*="detail"]');
            rows.forEach(row => {
                const text = row.innerText || '';
                if (text.includes('Renew period')) {
                    const match = text.match(/Renew period\s*[:：]?\s*(.+)/i);
                    if (match) data.renewPeriod = match[1].trim();
                }
                if (text.includes('Expiry')) {
                    const match = text.match(/Expiry\s*[:：]?\s*(.+)/i);
                    if (match) data.expiry = match[1].trim();
                }
                if (text.includes('Auto renew')) {
                    const match = text.match(/Auto renew\s*[:：]?\s*(.+)/i);
                    if (match) data.autoRenew = match[1].trim();
                }
                if (text.includes('Price') || text.includes('crédits')) {
                    const match = text.match(/(?:Price|Prix)\s*[:：]?\s*(.+)/i);
                    if (match) data.price = match[1].trim();
                }
            });
            // 备用：直接查 td
            if (!data.renewPeriod) {
                const allTd = document.querySelectorAll('td');
                allTd.forEach((td, index) => {
                    const text = td.innerText || '';
                    if (text.includes('Renew period') && allTd[index + 1]) {
                        data.renewPeriod = allTd[index + 1].innerText.trim();
                    }
                    if (text.includes('Expiry') && allTd[index + 1]) {
                        data.expiry = allTd[index + 1].innerText.trim();
                    }
                    if (text.includes('Auto renew') && allTd[index + 1]) {
                        data.autoRenew = allTd[index + 1].innerText.trim();
                    }
                    if ((text.includes('Price') || text.includes('crédits')) && allTd[index + 1]) {
                        data.price = allTd[index + 1].innerText.trim();
                    }
                });
            }
            return data;
        });
    } catch (e) {
        return {};
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

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const maskedUser = maskEmail(user.username);
        
        console.log(`\n=== 用户 ${i + 1}/${users.length}: ${maskedUser} ===`);
        
        let status = 'unknown';
        let message = '';
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
            
            // 等待页面完全加载（增加等待时间）
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(3000); // 额外等待3秒确保 CF 组件加载
            
            // 截图：登录页初始状态 -> Telegram
            await sendTelegramScreenshot(page, `🔄 ${maskedUser} - 登录页初始`);

            // 输入凭据
            const emailInput = page.getByRole('textbox', { name: 'Email' });
            await emailInput.waitFor({ state: 'visible', timeout: 10000 });
            await emailInput.fill(user.username);
            const pwdInput = page.getByRole('textbox', { name: 'Password' });
            await pwdInput.fill(user.password);
            await page.waitForTimeout(500);

            // 截图：填写完表单 -> Telegram
            await sendTelegramScreenshot(page, `📝 ${maskedUser} - 已填写表单`);

            // 4. 处理登录页 Turnstile（增加等待时间）
            console.log('开始处理登录页 Turnstile（可能需要较长时间）...');
            const turnstileResult = await handleTurnstile(page, '登录页');
            
            // 如果验证不确定，多等一会儿
            if (!turnstileResult.success && turnstileResult.mayBeSuccess) {
                console.log('验证状态不确定，额外等待5秒...');
                await page.waitForTimeout(5000);
            }
            
            // 截图：验证后状态 -> Telegram
            await sendTelegramScreenshot(page, `🔐 ${maskedUser} - Turnstile验证后 (${turnstileResult.success ? '成功' : turnstileResult.mayBeSuccess ? '可能成功' : '失败'})`);

            // 点击登录
            console.log('点击 Login...');
            await page.getByRole('button', { name: 'Login', exact: true }).click();
            
            // 等待导航完成（增加超时时间）
            try {
                await page.waitForLoadState('networkidle', { timeout: 30000 });
            } catch (e) {
                console.log('等待 networkidle 超时，继续执行...');
            }
            await page.waitForTimeout(4000);
            
            // 截图：登录后状态 -> Telegram
            await sendTelegramScreenshot(page, `🔑 ${maskedUser} - 登录后 (URL: ${page.url().split('?')[0]})`);

            // 检查登录结果
            if (page.url().includes('login')) {
                let failReason = '未知错误';
                try {
                    const errorLoc = page.getByText(/incorrect|invalid|error/i).first();
                    if (await errorLoc.isVisible({ timeout: 2000 })) {
                        failReason = await errorLoc.innerText();
                    }
                } catch (e) {}
                
                console.error(`❌ 登录失败: ${failReason}`);
                status = 'login_failed';
                message = `❌ *登录失败*\n用户: ${maskedUser}\n原因: ${failReason}`;
                
                await sendTelegramMessage(message);
                continue;
            }

            console.log('✅ 登录成功');
            serviceInfo = await getServiceInfo(page);

            // 寻找 "See" 链接
            console.log('寻找 See 链接...');
            let seeFound = false;
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 10000 });
                await page.getByRole('link', { name: 'See' }).first().click();
                seeFound = true;
            } catch (e) {
                console.log('❌ 未找到 See 链接');
                await sendTelegramScreenshot(page, `❌ ${maskedUser} - 未找到See链接`);
                
                status = 'no_see_link';
                message = `❌ *未找到 See 链接*\n用户: ${maskedUser}`;
                await sendTelegramMessage(message);
                continue;
            }

            await page.waitForTimeout(2000);
            await sendTelegramScreenshot(page, `👁️ ${maskedUser} - 点击See后`);

            // Renew 流程
            console.log('开始 Renew 流程...');
            let renewSuccess = false;
            let hasCaptchaError = false;
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

                // 鼠标移动
                try {
                    const box = await modal.boundingBox();
                    if (box) await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 5 });
                } catch (e) {}

                // 处理模态框 Turnstile（同样增加等待）
                console.log('处理模态框 Turnstile...');
                const modalTurnstile = await handleTurnstile(page, `Renew-${attempt}`);
                
                if (!modalTurnstile.success && modalTurnstile.mayBeSuccess) {
                    console.log('模态框验证状态不确定，额外等待3秒...');
                    await page.waitForTimeout(3000);
                }
                
                await sendTelegramScreenshot(page, `🔄 ${maskedUser} - Renew尝试${attempt}`);

                const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                if (!await confirmBtn.isVisible()) {
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                await confirmBtn.click();
                await page.waitForTimeout(2000);

                // 检查结果
                const startCheck = Date.now();
                hasCaptchaError = false;
                isNotTimeYet = false;

                while (Date.now() - startCheck < 5000) {
                    try {
                        const captchaError = page.getByText('Please complete the captcha to continue');
                        if (await captchaError.isVisible({ timeout: 500 })) {
                            hasCaptchaError = true;
                            break;
                        }
                    } catch (e) {}
                    
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
                    
                    try {
                        if (!await modal.isVisible({ timeout: 500 })) {
                            break;
                        }
                    } catch (e) {
                        break;
                    }
                    await page.waitForTimeout(300);
                }

                await sendTelegramScreenshot(page, `📊 ${maskedUser} - 结果${attempt} (Captcha:${hasCaptchaError}, NotTime:${isNotTimeYet})`);

                if (isNotTimeYet) {
                    status = 'not_time';
                    message = `⏳ *暂无法续期*\n用户: ${maskedUser}\n原因: 未到续期时间`;
                    renewSuccess = true;
                    
                    try {
                        await modal.getByLabel('Close').click();
                    } catch (e) {}
                    
                    await sendTelegramMessage(message);
                    break;
                }

                if (hasCaptchaError) {
                    console.log('验证码错误，刷新重试...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                await page.waitForTimeout(2000);
                if (!await modal.isVisible().catch(() => false)) {
                    console.log('✅ Renew 成功！');
                    status = 'success';
                    
                    await page.waitForTimeout(1000);
                    const newServiceInfo = await getServiceInfo(page);
                    const info = newServiceInfo.expiry ? newServiceInfo : serviceInfo;
                    
                    message = `✅ *续期成功*\n` +
                              `用户: ${maskedUser}\n` +
                              `━━━━━━━━━━━━━━\n` +
                              `*服务信息*\n` +
                              `📅 续期周期: ${info.renewPeriod || 'Every 4 days'}\n` +
                              `⏰ 到期时间: ${info.expiry || 'Unknown'}\n` +
                              `🔄 自动续期: ${info.autoRenew || 'Non'}\n` +
                              `💰 价格: ${info.price || '0 crédits'}`;
                    
                    renewSuccess = true;
                    
                    await sendTelegramScreenshot(page, `✅ ${maskedUser} - 续期成功`);
                    await sendTelegramMessage(message);
                    break;
                } else {
                    console.log('模态框仍在，重试...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                }
            }

            if (!renewSuccess && !isNotTimeYet) {
                status = 'renew_failed';
                message = `❌ *续期失败*\n用户: ${maskedUser}\n原因: 20次尝试后仍未成功`;
                await sendTelegramScreenshot(page, `❌ ${maskedUser} - 最终失败`);
                await sendTelegramMessage(message);
            }

        } catch (err) {
            console.error(`错误:`, err);
            status = 'error';
            message = `❌ *处理出错*\n用户: ${maskedUser}\n错误: ${err.message}`;
            
            try {
                await sendTelegramScreenshot(page, `💥 ${maskedUser} - 异常`);
            } catch (e) {}
            
            await sendTelegramMessage(message);
        }
        
        console.log(`用户 ${maskedUser} 处理完成，状态: ${status}`);
        console.log('---');
    }

    console.log('\n所有用户处理完成');
    try { await browser.close(); } catch (e) {}
    process.exit(0);
})();

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 截图目录
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// 隐藏邮箱敏感信息：nanning@disbox.org -> nan***@disbox.org
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

// 保存截图
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

// 发送 Telegram 消息
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('[Telegram] 未配置，跳过发送');
        return;
    }

    // 1. 发送文字消息
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] 文字消息已发送');
    } catch (e) {
        console.error('[Telegram] 文字消息发送失败:', e.message);
    }

    // 2. 发送图片
    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] 正在发送图片...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}" -F caption="Debug Screenshot"`;
        
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] 图片发送失败:', err.message);
                else console.log('[Telegram] 图片已发送');
                resolve();
            });
        });
    }
}

// 从页面抓取服务信息（优化版）
async function getServiceInfo(page) {
    try {
        // 先等待一下确保页面渲染完成
        await page.waitForTimeout(1000);
        
        const info = await page.evaluate(() => {
            const data = {};
            
            // 方法1: 查找包含 "Service information" 的区块
            const serviceSection = Array.from(document.querySelectorAll('*')).find(el => 
                el.innerText && el.innerText.includes('Service information')
            );
            
            if (serviceSection) {
                // 获取该区块内的所有文本
                const sectionText = serviceSection.innerText;
                console.log('找到 Service information 区块:', sectionText.substring(0, 200));
            }
            
            // 方法2: 查找所有可能包含服务信息的元素
            const allElements = document.querySelectorAll('div, tr, li, p');
            
            allElements.forEach(el => {
                const text = el.innerText || '';
                const lowerText = text.toLowerCase();
                
                // Renew period
                if (lowerText.includes('renew period')) {
                    const nextEl = el.nextElementSibling;
                    if (nextEl && nextEl.innerText) {
                        data.renewPeriod = nextEl.innerText.trim();
                    } else {
                        // 尝试从文本中提取
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
            
            // 方法3: 查找 dt/dd 或 th/td 结构
            if (!data.renewPeriod || !data.expiry) {
                const rows = document.querySelectorAll('tr, .row, [class*="info"]');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td, th, dd, dt, [class*="col"]');
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
        
        console.log('抓取到的服务信息:', info);
        return info;
        
    } catch (e) {
        console.error('抓取服务信息失败:', e.message);
        return {};
    }
}

// 格式化服务信息为字符串
function formatServiceInfo(info, title = '*服务信息*') {
    // 确保有默认值
    const renewPeriod = info.renewPeriod || info.renew_period || 'N/A';
    const expiry = info.expiry || info.expires || 'N/A';
    const autoRenew = info.autoRenew || info.auto_renew || 'N/A';
    const price = info.price || info.credits || 'N/A';
    
    return `${title}\n` +
           `📅 续期周期: ${renewPeriod}\n` +
           `⏰ 到期时间: ${expiry}\n` +
           `🔄 自动续期: ${autoRenew}\n` +
           `💰 价格: ${price}`;
}

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

// Proxy Configuration
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
        console.error('[代理] 格式无效，期望: http://user:pass@host:port');
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
    } catch (e) {
        console.error('[注入] Hook 失败:', e);
    }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 验证连接...');
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
        console.log('[代理] 连接成功');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启');
        return;
    }

    console.log(`正在启动 Chrome: ${CHROME_PATH}`);

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

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        throw new Error('Chrome 启动失败');
    }
    console.log('Chrome 启动成功');
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

// 处理 Turnstile 验证（通用函数）
async function handleTurnstile(page, contextName = '未知') {
    console.log(`[${contextName}] 检查 Turnstile...`);
    
    const frames = page.frames();
    const turnstileFrame = frames.find(f => 
        f.url().includes('turnstile') || 
        f.url().includes('cloudflare') ||
        f.url().includes('challenges')
    );
    
    if (!turnstileFrame) {
        console.log(`[${contextName}] 未发现 Turnstile iframe`);
        return { success: false, reason: 'not_found' };
    }
    
    console.log(`[${contextName}] ✅ 发现 Turnstile，尝试验证...`);
    
    try {
        // 方法1: 使用注入脚本获取精确坐标
        const turnstileData = await turnstileFrame.evaluate(() => window.__turnstile_data).catch(() => null);
        
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
            // 方法2: 点击 iframe 中心
            console.log(`[${contextName}] 使用备用方法：点击中心`);
            const iframeElement = await turnstileFrame.frameElement();
            const box = await iframeElement.boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
            }
        }
        
        // 等待验证结果
        await page.waitForTimeout(3000);
        
        // 检查验证状态
        for (let i = 0; i < 10; i++) {
            try {
                const success = await turnstileFrame.getByText('Success', { exact: false }).isVisible().catch(() => false);
                const verified = await turnstileFrame.evaluate(() => {
                    const checkbox = document.querySelector('input[type="checkbox"]');
                    return checkbox ? checkbox.checked : false;
                }).catch(() => false);
                
                if (success || verified) {
                    console.log(`[${contextName}] ✅ Turnstile 验证成功`);
                    return { success: true };
                }
            } catch (e) {}
            await page.waitForTimeout(500);
        }
        
        console.log(`[${contextName}] ⚠️ Turnstile 状态未知`);
        return { success: false, reason: 'timeout' };
        
    } catch (e) {
        console.error(`[${contextName}] Turnstile 处理错误:`, e.message);
        return { success: false, reason: 'error', error: e.message };
    }
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error('未找到用户配置');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 无效，终止');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log('连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败，重试...`);
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
    console.log('注入脚本已添加');

    // 处理每个用户
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const maskedUser = maskEmail(user.username); // 日志中显示掩码邮箱
        const safeUser = getSafeUsername(user.username); // 文件名使用掩码邮箱
        
        console.log(`\n=== 用户 ${i + 1}/${users.length}: ${maskedUser} ===`);
        
        let status = 'unknown';
        let message = '';
        let finalScreenshot = null;
        let serviceInfo = {}; // 存储服务信息

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 1. 登出（如果已登录）
            await page.goto('https://dashboard.katabump.com/auth/logout');
            await page.waitForTimeout(2000);

            // 2. 进入登录页
            console.log('导航到登录页...');
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            
            // 截图：登录页初始状态
            const loginInitShot = await saveScreenshot(page, `${safeUser}_01_login_init.png`);
            await sendTelegramMessage(`🔄 开始处理用户: ${maskedUser}\n步骤: 进入登录页`, loginInitShot);

            // 3. 输入凭据
            console.log('输入凭据...');
            const emailInput = page.getByRole('textbox', { name: 'Email' });
            await emailInput.waitFor({ state: 'visible', timeout: 10000 });
            await emailInput.fill(user.username);
            
            const pwdInput = page.getByRole('textbox', { name: 'Password' });
            await pwdInput.fill(user.password);
            await page.waitForTimeout(500);

            // 截图：填写完表单
            const loginFilledShot = await saveScreenshot(page, `${safeUser}_02_login_filled.png`);

            // 4. 处理登录页 Turnstile
            const turnstileResult = await handleTurnstile(page, '登录页');
            
            // 截图：验证后状态
            const loginVerifyShot = await saveScreenshot(page, `${safeUser}_03_login_verify.png`);
            
            if (!turnstileResult.success) {
                await sendTelegramMessage(
                    `⚠️ 用户: ${maskedUser}\n登录页 Turnstile 可能未通过\n原因: ${turnstileResult.reason}`, 
                    loginVerifyShot
                );
            }

            // 5. 点击登录
            console.log('点击 Login...');
            await page.getByRole('button', { name: 'Login', exact: true }).click();
            
            // 等待跳转
            await page.waitForTimeout(4000);
            
            // 截图：登录后状态
            const afterLoginShot = await saveScreenshot(page, `${safeUser}_04_after_login.png`);

            // 6. 检查登录结果
            if (page.url().includes('login')) {
                // 登录失败
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
                finalScreenshot = afterLoginShot;
                
                await sendTelegramMessage(message, finalScreenshot);
                continue;
            }

            console.log('✅ 登录成功，当前 URL:', page.url());
            
            // 抓取服务信息（登录后立即抓取）
            serviceInfo = await getServiceInfo(page);
            console.log('抓取到的服务信息:', JSON.stringify(serviceInfo, null, 2));
            
            // 测试：如果抓取失败，尝试点击 See 后再抓取
            if (!serviceInfo.expiry) {
                console.log('首次抓取失败，尝试点击 See 后再抓取...');
            }
            
            await sendTelegramMessage(`✅ 用户 ${maskedUser} 登录成功\nURL: ${page.url()}`, afterLoginShot);

            // 7. 寻找 "See" 链接
            console.log('寻找 See 链接...');
            let seeFound = false;
            
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 10000 });
                await page.getByRole('link', { name: 'See' }).first().click();
                seeFound = true;
                console.log('✅ 找到并点击 See');
            } catch (e) {
                console.log('❌ 未找到 See 链接');
                
                // 截图查看页面结构
                const dashboardShot = await saveScreenshot(page, `${safeUser}_05_dashboard_no_see.png`);
                
                // 列出所有链接帮助调试
                const links = await page.getByRole('link').all();
                let linkTexts = [];
                for (const link of links.slice(0, 10)) {
                    try {
                        const text = await link.innerText();
                        if (text) linkTexts.push(text.trim());
                    } catch (e) {}
                }
                
                status = 'no_see_link';
                message = `❌ *未找到 See 链接*\n用户: ${maskedUser}\n页面链接: ${linkTexts.join(', ') || '无'}\n\n${formatServiceInfo(serviceInfo)}`;
                finalScreenshot = dashboardShot;
                
                await sendTelegramMessage(message, finalScreenshot);
                continue;
            }

            await page.waitForTimeout(2000);
            const afterSeeShot = await saveScreenshot(page, `${safeUser}_06_after_see_click.png`);
            
            // 点击 See 后重新抓取服务信息（更详细的信息通常在详情页）
            const detailedInfo = await getServiceInfo(page);
            if (detailedInfo.expiry) {
                serviceInfo = { ...serviceInfo, ...detailedInfo };
                console.log('详情页服务信息:', JSON.stringify(serviceInfo, null, 2));
            }

            // 8. Renew 流程
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
                    console.log('未找到 Renew 按钮');
                    break;
                }

                if (!await renewBtn.isVisible()) {
                    console.log('Renew 按钮不可见');
                    break;
                }

                await renewBtn.click();
                console.log('已点击 Renew，等待模态框...');
                
                const modal = page.locator('#renew-modal');
                try {
                    await modal.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) {
                    console.log('模态框未出现');
                    continue;
                }

                // 鼠标移动模拟
                try {
                    const box = await modal.boundingBox();
                    if (box) await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 5 });
                } catch (e) {}

                // 处理 Turnstile
                console.log('处理模态框 Turnstile...');
                const modalTurnstile = await handleTurnstile(page, `Renew-${attempt}`);
                
                // 截图：点击 Renew 后，验证前
                const renewModalShot = await saveScreenshot(page, `${safeUser}_07_renew_modal_${attempt}.png`);

                if (!modalTurnstile.success) {
                    console.log('Turnstile 可能未就绪，继续...');
                }

                // 点击确认 Renew
                const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                if (!await confirmBtn.isVisible()) {
                    console.log('未找到确认按钮');
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                await confirmBtn.click();
                console.log('已点击确认 Renew');
                
                await page.waitForTimeout(2000);

                // 检查结果
                const startCheck = Date.now();
                hasCaptchaError = false;
                isNotTimeYet = false;

                while (Date.now() - startCheck < 5000) {
                    // 检查验证码错误
                    try {
                        const captchaError = page.getByText('Please complete the captcha to continue');
                        if (await captchaError.isVisible({ timeout: 500 })) {
                            console.log('⚠️ 检测到验证码错误');
                            hasCaptchaError = true;
                            break;
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

                    // 检查成功
                    try {
                        if (!await modal.isVisible({ timeout: 500 })) {
                            console.log('✅ 模态框关闭，可能成功');
                            break;
                        }
                    } catch (e) {
                        console.log('✅ 模态框已关闭');
                        break;
                    }

                    await page.waitForTimeout(300);
                }

                // 截图：操作结果
                const resultShot = await saveScreenshot(page, `${safeUser}_08_renew_result_${attempt}.png`);

                if (isNotTimeYet) {
                    status = 'not_time';
                    message = `⏳ *暂无法续期*\n用户: ${maskedUser}\n原因: 未到续期时间\n\n${formatServiceInfo(serviceInfo)}`;
                    finalScreenshot = resultShot;
                    renewSuccess = true; // 标记完成，不再重试
                    
                    // 关闭模态框
                    try {
                        await modal.getByLabel('Close').click();
                    } catch (e) {}
                    
                    await sendTelegramMessage(message, finalScreenshot);
                    break;
                }

                if (hasCaptchaError) {
                    console.log('验证码错误，刷新重试...');
                    await sendTelegramMessage(
                        `⚠️ 用户 ${maskedUser} 第 ${attempt} 次尝试\n验证码未通过，准备刷新重试`, 
                        resultShot
                    );
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                // 检查是否真的成功
                await page.waitForTimeout(2000);
                if (!await modal.isVisible().catch(() => false)) {
                    console.log('✅ Renew 成功！');
                    status = 'success';
                    
                    // 重新抓取服务信息（续期后）
                    await page.waitForTimeout(1000);
                    const newServiceInfo = await getServiceInfo(page);
                    console.log('续期后服务信息:', JSON.stringify(newServiceInfo, null, 2));
                    
                    // 使用新信息，如果没有则使用旧的
                    const info = newServiceInfo.expiry ? newServiceInfo : serviceInfo;
                    
                    message = `✅ *续期成功*\n用户: ${maskedUser}\n\n${formatServiceInfo(info, '*续期后服务信息*')}`;
                    finalScreenshot = resultShot;
                    renewSuccess = true;
                    
                    await sendTelegramMessage(message, finalScreenshot);
                    break;
                } else {
                    console.log('模态框仍在，可能失败，准备重试...');
                    await sendTelegramMessage(
                        `⚠️ 用户 ${maskedUser} 第 ${attempt} 次尝试\n模态框未关闭，准备重试`, 
                        resultShot
                    );
                    await page.reload();
                    await page.waitForTimeout(3000);
                }
            }

            if (!renewSuccess && !isNotTimeYet) {
                status = 'renew_failed';
                
                // 重新抓取最新服务信息（失败时）
                await page.waitForTimeout(1000);
                const latestInfo = await getServiceInfo(page);
                const info = latestInfo.expiry ? latestInfo : serviceInfo;
                
                message = `❌ *续期失败*\n用户: ${maskedUser}\n原因: 20次尝试后仍未成功\n\n${formatServiceInfo(info)}`;
                finalScreenshot = await saveScreenshot(page, `${safeUser}_09_final_failed.png`);
                await sendTelegramMessage(message, finalScreenshot);
            }

        } catch (err) {
            console.error(`处理用户时出错:`, err);
            status = 'error';
            
            // 尝试抓取服务信息（即使出错也尝试）
            try {
                const errorInfo = await getServiceInfo(page);
                if (errorInfo.expiry) serviceInfo = errorInfo;
            } catch (e) {}
            
            message = `❌ *处理出错*\n用户: ${maskedUser}\n错误: ${err.message}\n\n${formatServiceInfo(serviceInfo)}`;
            
            try {
                finalScreenshot = await saveScreenshot(page, `${safeUser}_error.png`);
            } catch (e) {}
            
            await sendTelegramMessage(message, finalScreenshot);
        }

        // 最终截图
        try {
            const finalShot = await saveScreenshot(page, `${safeUser}_final_${status}.png`);
            console.log(`用户 ${maskedUser} 处理完成，状态: ${status}`);
        } catch (e) {
            console.log('最终截图失败');
        }
        
        console.log('---');
    }

    console.log('\n所有用户处理完成');
    
    try {
        await browser.close();
    } catch (e) {}
    
    process.exit(0);
})();

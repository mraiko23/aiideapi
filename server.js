// Features:
// - ⚡ ULTRA-FAST Response System with Aggressive Caching & Compression
// - 🚀 Optimized Single-Browser System (512MB RAM Optimized)
// - 💾 Smart Session Recovery with Context Preservation
// - 🔥 Cloudflare Bypass (puppeteer-real-browser)
// - 🤖 Full AI Suite: Chat, Search, Image (Txt2Img/Img2Img), TTS, STT, Video
// - 📦 Persistent Storage for Chats & Tokens
// - 🛡️ Advanced Error Handling & Auto-Recovery
// - ⚡ HTTP Compression, LRU Cache, Parallel Init, Fast Timeouts

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const puppeteerCore = require('puppeteer');
const path = require('path');
const { connect } = require('puppeteer-real-browser');
const fs = require('fs').promises;
const fsSync = require('fs');

// Persistent Storage Manager
class PersistentStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = { chats: [], tokens: [], lastToken: null };
        this.loadSync();
    }

    loadSync() {
        try {
            if (fsSync.existsSync(this.filePath)) {
                this.data = JSON.parse(fsSync.readFileSync(this.filePath, 'utf8'));
            }
        } catch (e) {
            console.warn('[Store] Load failed, using defaults:', e.message);
        }
    }

    async save() {
        try {
            await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error('[Store] Save failed:', e.message);
        }
    }

    getAllChats() { return this.data.chats; }
    
    createChat(title, model) {
        const chat = {
            id: Date.now().toString(),
            title: title || 'New Chat',
            model: model || 'gemini-2.0-flash',
            createdAt: new Date().toISOString(),
            messages: []
        };
        this.data.chats.push(chat);
        this.save();
        return chat;
    }

    getChat(id) {
        return this.data.chats.find(c => c.id === id);
    }

    addMessage(chatId, role, content) {
        const chat = this.getChat(chatId);
        if (chat) {
            chat.messages.push({ role, content, timestamp: new Date().toISOString() });
            this.save();
        }
    }

    saveToken(token, userId = 'default') {
        if (!token) return;
        this.data.lastToken = token;
        const existing = this.data.tokens.find(t => t.userId === userId);
        if (existing) {
            existing.token = token;
            existing.updatedAt = new Date().toISOString();
        } else {
            this.data.tokens.push({ userId, token, createdAt: new Date().toISOString() });
        }
        this.save();
    }

    getLastToken() {
        return this.data.lastToken;
    }
}

const chatStore = new PersistentStore('./chat_store.json');

const app = express();
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ULTRA-FAST Response Cache with LRU (10 min TTL, 500 entries)
const responseCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

function getCacheKey(endpoint, body) {
    // Fast hash instead of full JSON stringify for speed
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    return `${endpoint}:${str.length}:${str.substring(0, 100)}`;
}

function getFromCache(key) {
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        // LRU: Move to end
        responseCache.delete(key);
        responseCache.set(key, cached);
        return cached.data;
    }
    responseCache.delete(key);
    return null;
}

function setCache(key, data) {
    // LRU eviction: Remove oldest if full
    if (responseCache.size >= MAX_CACHE_SIZE) {
        const firstKey = responseCache.keys().next().value;
        responseCache.delete(firstKey);
    }
    responseCache.set(key, { data, timestamp: Date.now() });
}

// ULTRA-FAST Middleware with compression
app.use(compression({ 
    level: 6, // Balance between speed and compression
    threshold: 1024 // Only compress responses > 1KB
}));
app.use(cors({
    origin: true,
    credentials: true,
    maxAge: 86400 // Cache preflight for 24h
}));
app.use(express.json({ 
    limit: '50mb',
    strict: false // Faster parsing
}));
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d', // Cache static files for 1 day
    etag: true,
    lastModified: true
}));

// Speed headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-cache'); // For API responses
    next();
});

// PREVENT CRASHES: Global Error Handlers with Recovery
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
    // Attempt recovery if pool exists
    if (pool && pool.primary && !pool.primary.isReady) {
        console.log('[Recovery] Attempting to restart primary session...');
        pool.forceRotate().catch(e => console.error('[Recovery] Failed:', e));
    }
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection:', reason);
});

// Keep-alive ping (optimized interval)
const PING_INTERVAL = 120 * 1000; // 2 minutes (less frequent)
function startKeepAlive() {
    setInterval(() => {
        try {
            const http = RENDER_URL.startsWith('https') ? require('https') : require('http');
            http.get(`${RENDER_URL}/api/health`, (res) => { 
                res.resume(); // Consume response to free memory
            }).on('error', () => { });
        } catch (e) { }
    }, PING_INTERVAL);
}

// =====================
// Browser Session Class
// =====================

class BrowserSession {
    constructor(id, type = 'standby') {
        this.id = id;
        this.type = type; // 'primary' or 'standby'
        this.browser = null;
        this.page = null;
        this.isReady = false;
        this.status = 'initializing';
        this.createdAt = Date.now();
        this.token = null;
        this.activeRequests = 0; // Reference counting
    }

    async init(existingToken = null) {
        console.log(`[Session #${this.id}] Launching INCOGNITO (${this.type})...`);
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

                // Try multiple paths for Chrome/Chromium on Render and local
                if (!executablePath) {
                    const fsSync = require('fs');
                    const { execSync } = require('child_process');
                    
                    const possiblePaths = [
                        // Render.com cache (with glob)
                        '/opt/render/project/src/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
                        // Local cache (with glob)
                        `${process.cwd()}/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome`,
                        // System Chrome
                        '/usr/bin/google-chrome',
                        '/usr/bin/chromium-browser',
                        '/usr/bin/chromium'
                    ];

                    for (const pathPattern of possiblePaths) {
                        try {
                            if (pathPattern.includes('*')) {
                                // Glob pattern - find actual path
                                const foundPath = execSync(`ls ${pathPattern} 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
                                if (foundPath && fsSync.existsSync(foundPath)) {
                                    executablePath = foundPath;
                                    console.log(`[Session #${this.id}] ✅ Found Chrome at: ${executablePath}`);
                                    break;
                                }
                            } else if (fsSync.existsSync(pathPattern)) {
                                executablePath = pathPattern;
                                console.log(`[Session #${this.id}] ✅ Found Chrome at: ${executablePath}`);
                                break;
                            }
                        } catch (e) {
                            // Continue to next path
                        }
                    }
                    
                    // Last resort: try puppeteer default
                    if (!executablePath) {
                        try {
                            executablePath = puppeteerCore.executablePath();
                            if (executablePath && !path.isAbsolute(executablePath)) {
                                executablePath = path.resolve(process.cwd(), executablePath);
                            }
                            console.log(`[Session #${this.id}] Using Puppeteer default: ${executablePath}`);
                        } catch (e) {
                            console.error(`[Session #${this.id}] ⚠️ Puppeteer default failed: ${e.message}`);
                        }
                    }
                }

                if (!executablePath) {
                    throw new Error('❌ Chrome executable not found! Install Chrome or set PUPPETEER_EXECUTABLE_PATH');
                }

                console.log(`[Session #${this.id}] 🚀 Launching Chrome: ${executablePath}`);

                const launchArgs = [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-first-run',
                    '--incognito',
                    '--disable-blink-features=AutomationControlled',
                    '--window-position=-10000,-10000',
                    // ULTRA-FAST optimizations (stable)
                    '--disable-features=TranslateUI,BlinkGenPropertyTrees',
                    '--disable-renderer-backgrounding',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-client-side-phishing-detection',
                    '--disable-default-apps',
                    '--disable-hang-monitor',
                    '--disable-popup-blocking',
                    '--disable-prompt-on-repost',
                    '--disable-domain-reliability',
                    '--no-default-browser-check',
                    '--no-pings',
                    '--password-store=basic',
                    '--use-mock-keychain'
                    // NOTE: --single-process removed - causes detached frames
                ];

                const response = await connect({
                    headless: 'auto',
                    turnstile: true,
                    customConfig: { 
                        chromePath: executablePath,
                        // Force new profile each time
                        args: launchArgs
                    },
                    connectOption: {
                        defaultViewport: { width: 1280, height: 720 },
                        timeout: 60000
                    },
                    args: launchArgs,
                    fingerprint: true,
                    turnstileOptimization: true
                });

                this.browser = response.browser;
                this.page = response.page;

                console.log(`[Session #${this.id}] ✅ Incognito browser launched!`);

                // ULTRA-FAST timeouts
                this.page.setDefaultNavigationTimeout(30000);
                this.page.setDefaultTimeout(20000);

                // Fastest possible page load
                await this.page.goto('https://puter.com', {
                    waitUntil: 'domcontentloaded', // Don't wait for everything
                    timeout: 30000
                });

                // DON'T inject old token - always get fresh one
                console.log(`[Session #${this.id}] Getting FRESH token (no injection)...`);

                await this.waitForLogin();
                await this.optimizePage();

                return;

            } catch (e) {
                console.error(`[Session #${this.id}] Init Attempt ${attempt}/${maxRetries} Failed: ${e.message}`);

                if (this.browser) await this.browser.close().catch(() => { });
                this.browser = null;
                this.page = null;

                if (attempt === maxRetries) {
                    this.status = 'dead';
                    throw e;
                }

                await new Promise(r => setTimeout(r, attempt * 3000));
            }
        }
    }


    async optimizePage() {
        if (!this.page) return;
        try {
            console.log(`[Session #${this.id}] ULTRA-FAST optimization mode...`);
            
            const client = await this.page.target().createCDPSession();
            
            // Aggressive resource blocking for speed
            await client.send('Network.setBlockedURLs', {
                urls: [
                    '*.woff', '*.woff2', '*.ttf', '*.otf', // Fonts
                    '*analytics*', '*doubleclick*', '*facebook.com/tr*', // Analytics
                    '*ads*', '*tracking*', '*metrics*' // Ads & tracking
                ]
            });
            
            // Enable network caching
            await client.send('Network.setCacheDisabled', { cacheDisabled: false });
            
            // Disable images for non-image tasks (can be toggled per request)
            // await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } });
            
            // Faster page load settings
            await this.page.evaluateOnNewDocument(() => {
                // Disable animations for speed
                const style = document.createElement('style');
                style.textContent = '* { animation-duration: 0s !important; transition-duration: 0s !important; }';
                document.head?.appendChild(style);
            });
            
        } catch (e) {
            console.warn(`[Session #${this.id}] Optimization warning: ${e.message}`);
        }
    }

    async waitForLogin() {
        console.log(`[Session #${this.id}] FAST login detection...`);
        let loggedIn = false;

        for (let i = 0; i < 30; i++) { // 60 seconds max (faster)
            await new Promise(r => setTimeout(r, 2000));

            // Auto-click "Get Started"
            try {
                await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    const startBtn = buttons.find(b => b.innerText.match(/Get Started|Start|Guest|Try/i));
                    if (startBtn) startBtn.click();
                });
            } catch (e) { }

            await this.injectHelpers();

            // Check Status
            const state = await this.getPageStatus();
            
            // Minimal logging for speed
            if (i % 10 === 0) { // Log every 20 seconds
                console.log(`[Session #${this.id}] Check ${i}: API=${state.api}, Token=${state.token ? 'YES' : 'NO'}`);
            }
            
            if (state.api && state.token) {
                // Validate token
                let tokenStr = state.token;
                if (typeof tokenStr === 'object') {
                    console.log(`[Session #${this.id}] ⚠️ Token is object:`, tokenStr);
                    tokenStr = tokenStr.token || tokenStr.value || tokenStr.auth_token || JSON.stringify(tokenStr);
                }
                
                if (typeof tokenStr === 'string' && tokenStr.length > 20 && tokenStr !== '{}' && tokenStr !== 'null') {
                    this.token = tokenStr;
                    chatStore.saveToken(tokenStr);
                    loggedIn = true;
                    break;
                } else {
                    console.log(`[Session #${this.id}] ⚠️ Invalid token format:`, tokenStr);
                }
            }
        }

        if (loggedIn) {
            console.log(`[Session #${this.id}] READY! ✅`);
            console.log(`[Session #${this.id}] Full Token: ${this.token}`);
            this.isReady = true;
            this.status = 'ready';
        } else {
            console.log(`[Session #${this.id}] Login Timeout.`);
            throw new Error('Login Timeout');
        }
    }

    async getPageStatus() {
        if (!this.page) return { api: false, token: null };
        try {
            return await this.page.evaluate(() => {
                let token = null;
                
                // Execute puter.authToken as command and get result
                try {
                    if (typeof puter !== 'undefined') {
                        // Direct property access
                        const authToken = puter.authToken;
                        
                        if (authToken) {
                            // If it's an object, try to extract token string
                            if (typeof authToken === 'object') {
                                token = authToken.token || authToken.value || authToken.auth_token || JSON.stringify(authToken);
                            } else if (typeof authToken === 'string') {
                                token = authToken;
                            }
                            
                            if (token && token.length > 20) {
                                console.log('[Puter] ✅ Token from puter.authToken:', typeof authToken);
                                return {
                                    api: !!puter.ai,
                                    token: token
                                };
                            }
                        }
                        
                        // Try alternative paths
                        if (puter.auth && puter.auth.token) {
                            const authObj = puter.auth.token;
                            if (typeof authObj === 'string') {
                                token = authObj;
                            } else if (typeof authObj === 'object') {
                                token = authObj.token || authObj.value || JSON.stringify(authObj);
                            }
                            
                            if (token && token.length > 20) {
                                console.log('[Puter] ✅ Token from puter.auth.token');
                                return {
                                    api: !!puter.ai,
                                    token: token
                                };
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Puter] Error accessing puter.authToken:', e);
                }
                
                // Fallback: LocalStorage
                const storageKeys = [
                    'puter.auth.token',
                    'puter.authToken', 
                    'auth.token',
                    'authToken',
                    'token',
                    'auth_token'
                ];
                
                for (const key of storageKeys) {
                    try {
                        const val = localStorage.getItem(key);
                        if (val && val.length > 20 && val !== 'undefined' && val !== 'null') {
                            // Try to parse if it's JSON
                            try {
                                const parsed = JSON.parse(val);
                                if (typeof parsed === 'object') {
                                    token = parsed.token || parsed.value || parsed.auth_token || val;
                                } else {
                                    token = val;
                                }
                            } catch (e) {
                                token = val;
                            }
                            
                            if (token && token.length > 20) {
                                console.log(`[Puter] ✅ Token from localStorage.${key}`);
                                return {
                                    api: typeof puter !== 'undefined' && !!puter.ai,
                                    token: token
                                };
                            }
                        }
                    } catch (e) {}
                }

                return {
                    api: typeof puter !== 'undefined' && !!puter.ai,
                    token: null
                };
            });
        } catch (e) { 
            console.error('[getPageStatus] Error:', e);
            return { api: false, token: null }; 
        }
    }

    async injectHelpers() {
        if (!this.page) return;
        await this.page.evaluate(() => {
            window.puterReady = true;

            // Chat Wrapper (with streaming support)
            window.doChat = async (prompt, model, stream = false) => {
                try {
                    if (!puter?.ai) return { error: 'Puter AI not ready' };
                    
                    if (stream) {
                        // Streaming mode - return async generator
                        return puter.ai.chat(prompt, { model, stream: true });
                    } else {
                        // Normal mode
                        return await puter.ai.chat(prompt, { model });
                    }
                } catch (e) {
                    // Create a serializable error report
                    let message = e.message || String(e);
                    if (message === "[object Object]") {
                        try { message = JSON.stringify(e); } catch (e2) { message = "Complex Error Object"; }
                    }
                    const report = {
                        message: message,
                        name: e.name,
                        stack: e.stack,
                        string: e.toString()
                    };
                    // Collect all other properties
                    try {
                        Object.getOwnPropertyNames(e).forEach(key => {
                            if (!report[key]) report[key] = e[key];
                        });
                    } catch (e2) { }
                    return { error: report };
                }
            };

            // Streaming Chat Helper
            window.doChatStream = async function* (prompt, model) {
                try {
                    if (!puter?.ai) {
                        yield { error: 'Puter AI not ready' };
                        return;
                    }
                    
                    const stream = await puter.ai.chat(prompt, { model, stream: true });
                    
                    // Handle different stream formats
                    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
                        for await (const chunk of stream) {
                            yield chunk;
                        }
                    } else if (stream && typeof stream.getReader === 'function') {
                        // ReadableStream
                        const reader = stream.getReader();
                        const decoder = new TextDecoder();
                        
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            
                            const text = decoder.decode(value, { stream: true });
                            yield { text };
                        }
                    } else {
                        // Fallback: return as single chunk
                        yield stream;
                    }
                } catch (e) {
                    yield { error: e.message || String(e) };
                }
            };

            // Image Wrapper (Txt2Img & Img2Img) - Enhanced for FLUX & All Models
            window.doImage = async (prompt, model, inputImage) => {
                try {
                    if (!puter?.ai) throw new Error('Puter AI not ready');
                    const options = { model };

                    if (inputImage) {
                        options.input_image = inputImage;
                    }

                    console.log('[Puter] Calling txt2img with model:', model);
                    const result = await puter.ai.txt2img(prompt, options);
                    console.log('[Puter] txt2img result type:', typeof result, 'isArray:', Array.isArray(result));

                    if (!result) {
                        throw new Error('Puter txt2img returned no result (null/undefined)');
                    }

                    // Helper function to extract URL from any value
                    const extractUrl = (val) => {
                        if (!val) return null;
                        
                        // Direct string URL
                        if (typeof val === 'string' && (val.startsWith('http') || val.startsWith('data:'))) {
                            return val;
                        }
                        
                        // Object with URL properties
                        if (typeof val === 'object' && !Array.isArray(val)) {
                            const url = val.url || val.src || val.image_url || val.data || val.output || val.output_url;
                            if (url && typeof url === 'string') return url;
                        }
                        
                        return null;
                    };

                    // 1. Direct HTML Element
                    if (result instanceof HTMLImageElement || result?.tagName === 'IMG') {
                        console.log('[Puter] Result is IMG element');
                        return result.src;
                    }

                    // 2. Direct String (URL or Base64)
                    const directUrl = extractUrl(result);
                    if (directUrl) {
                        console.log('[Puter] Found direct URL');
                        return directUrl;
                    }

                    // 3. Blob
                    if (result instanceof Blob) {
                        console.log('[Puter] Result is Blob');
                        return await new Promise(r => {
                            const reader = new FileReader();
                            reader.onload = () => r(reader.result);
                            reader.readAsDataURL(result);
                        });
                    }

                    // 4. Array (FLUX returns array!)
                    if (Array.isArray(result)) {
                        console.log('[Puter] Result is Array, length:', result.length);
                        
                        if (result.length === 0) {
                            throw new Error('Empty array returned from txt2img');
                        }
                        
                        // Try each item in array
                        for (let i = 0; i < result.length; i++) {
                            const item = result[i];
                            console.log(`[Puter] Checking array[${i}], type:`, typeof item);
                            
                            // String URL
                            const url = extractUrl(item);
                            if (url) {
                                console.log(`[Puter] Found URL in array[${i}]`);
                                return url;
                            }
                            
                            // Blob
                            if (item instanceof Blob) {
                                console.log(`[Puter] Found Blob in array[${i}]`);
                                return await new Promise(r => {
                                    const reader = new FileReader();
                                    reader.onload = () => r(reader.result);
                                    reader.readAsDataURL(item);
                                });
                            }
                            
                            // Nested array (FLUX sometimes does this!)
                            if (Array.isArray(item) && item.length > 0) {
                                console.log(`[Puter] Found nested array[${i}], length:`, item.length);
                                const nestedUrl = extractUrl(item[0]);
                                if (nestedUrl) return nestedUrl;
                            }
                        }
                        
                        // If nothing found, return first item as string
                        console.warn('[Puter] No URL found in array, returning first item');
                        return String(result[0]);
                    }

                    // 5. Object (Gemini/GPT/Other JSON responses)
                    if (typeof result === 'object') {
                        console.log('[Puter] Result is Object, keys:', Object.keys(result).join(', '));
                        
                        // Check common paths
                        const possiblePaths = [
                            result?.url,
                            result?.src,
                            result?.data,
                            result?.result,
                            result?.image_url,
                            result?.image,
                            result?.output,
                            result?.output_url,
                            result?.choices?.[0]?.image_url,
                            result?.choices?.[0]?.url,
                            result?.choices?.[0]?.message?.content,
                            result?.message?.content,
                            result?.message,
                            result?.images?.[0],
                            result?.data?.[0]?.url,
                            result?.data?.[0]
                        ];
                        
                        for (const val of possiblePaths) {
                            const url = extractUrl(val);
                            if (url) {
                                console.log('[Puter] Found URL in object path');
                                return url;
                            }
                        }

                        // Deep search in nested objects
                        const deepSearch = (obj, depth = 0, path = '') => {
                            if (depth > 4) return null;
                            if (!obj || typeof obj !== 'object') return null;
                            
                            for (const key in obj) {
                                const val = obj[key];
                                const currentPath = path ? `${path}.${key}` : key;
                                
                                const url = extractUrl(val);
                                if (url) {
                                    console.log(`[Puter] Found URL at path: ${currentPath}`);
                                    return url;
                                }
                                
                                if (typeof val === 'object' && val !== null) {
                                    const nested = deepSearch(val, depth + 1, currentPath);
                                    if (nested) return nested;
                                }
                            }
                            return null;
                        };
                        
                        const deepFound = deepSearch(result);
                        if (deepFound) return deepFound;

                        console.error('[Puter] Image Extraction Failed. Raw Response:', JSON.stringify(result).substring(0, 1000));
                        throw new Error(`Cannot extract image URL. Keys: ${Object.keys(result).join(', ')}. Type: ${Array.isArray(result) ? 'Array' : typeof result}. Raw: ${JSON.stringify(result).substring(0, 200)}`);
                    }

                    // Last resort
                    console.warn('[Puter] Unknown result type, returning as-is');
                    return result;
                    
                } catch (e) {
                    console.error('[Puter] doImage Error:', e);
                    let message = e.message || String(e);
                    if (message === "[object Object]") {
                        try { message = JSON.stringify(e); } catch (e2) { message = "Complex Image Error Object"; }
                    }
                    return { error: { message: message, stack: e.stack, name: e.name, raw: String(e) } };
                }
            };

            // Search Wrapper (Perplexity)
            window.doSearch = async (prompt) => {
                if (!puter?.ai) throw new Error('Puter AI not ready');
                // Using Sonar Reasoning Pro for advanced search
                return await puter.ai.chat(prompt, { model: 'sonar-reasoning-pro' });
            };

            // Text-to-Speech Wrapper with Fallbacks
            window.doTTS = async (text, voice, model) => {
                const tryTTS = async (v, m, p) => {
                    console.log(`[Puter] TTS Attempt: Voice=${v || 'default'}, Model=${m || 'default'}, Provider=${p || 'default'}`);
                    const options = {};
                    if (p) options.provider = p;
                    if (v) options.voice = v;
                    if (m) options.model = m;

                    const result = await puter.ai.txt2speech(text, options);

                    if (result && (result instanceof HTMLAudioElement || result.tagName === 'AUDIO')) return result.src;
                    if (result instanceof Blob) {
                        return await new Promise(r => {
                            const reader = new FileReader();
                            reader.onload = () => r(reader.result);
                            reader.readAsDataURL(result);
                        });
                    }
                    return result;
                };

                try {
                    // 1. Try ElevenLabs with requested params
                    return await tryTTS(voice, model || 'eleven_multilingual_v2', 'elevenlabs');
                } catch (e1) {
                    console.warn(`[Puter] TTS Attempt 1 Failed: ${e1.message}`);
                    try {
                        // 2. Try ElevenLabs Flash (More stable sometimes)
                        return await tryTTS(voice, 'eleven_flash_v2_5', 'elevenlabs');
                    } catch (e2) {
                        console.warn(`[Puter] TTS Attempt 2 Failed: ${e2.message}`);
                        try {
                            // 3. Try ElevenLabs Default Rachel
                            return await tryTTS('21m00Tcm4TlvDq8ikWAM', 'eleven_multilingual_v2', 'elevenlabs');
                        } catch (e3) {
                            console.error(`[Puter] All ElevenLabs attempts failed. Final fallback to Puter default...`);
                            // 4. Final Fallback to Puter Default
                            return await tryTTS(null, null, null);
                        }
                    }
                }
            };

            // Speech-to-Text Wrapper (Filesystem Approach)
            window.doSTT = async (audioDataVal) => {
                try {
                    if (!puter?.ai) throw new Error('Puter AI not ready');

                    // Convert Data URI to Blob
                    const response = await fetch(audioDataVal);
                    const originalBlob = await response.blob();

                    // Reconstruct blob with MP3 mime type (spoofing for the backend)
                    const blob = new Blob([originalBlob], { type: 'audio/mpeg' });

                    // Generate temp filename with .mp3 extension
                    const filename = `~/temp_voice_${Date.now()}.mp3`;

                    // Write to Puter FS
                    await puter.fs.write(filename, blob);

                    try {
                        // Transcribe using whisper-1 (best for varied audio formats)
                        const transcription = await puter.ai.speech2txt(filename, { model: 'whisper-1' });

                        // Delete temp file
                        await puter.fs.delete(filename).catch(() => { });

                        return transcription;
                    } catch (transE) {
                        // Cleanup on error
                        await puter.fs.delete(filename).catch(() => { });
                        throw transE;
                    }
                } catch (e) {
                    throw new Error(e.message || JSON.stringify(e));
                }
            };

            // Voice Conversion Wrapper (Speech-to-Speech)
            window.doS2S = async (audioDataVal, voice) => {
                const tryS2S = async (v, m) => {
                    console.log(`[Puter] S2S Attempt: Voice=${v}, Model=${m}`);
                    const result = await puter.ai.speech2speech(audioDataVal, {
                        provider: 'elevenlabs',
                        voice: v || '21m00Tcm4TlvDq8ikWAM',
                        model: m || 'eleven_multilingual_sts_v2'
                    });
                    if (result instanceof Blob) {
                        return await new Promise(r => {
                            const reader = new FileReader();
                            reader.onload = () => r(reader.result);
                            reader.readAsDataURL(result);
                        });
                    }
                    return result;
                };

                try {
                    return await tryS2S(voice, 'eleven_multilingual_sts_v2');
                } catch (e) {
                    console.warn(`[Puter] S2S Failed, trying Rachel fallback...`);
                    return await tryS2S('21m00Tcm4TlvDq8ikWAM', 'eleven_multilingual_sts_v2');
                }
            };
            // Video Wrapper (Txt2Vid)
            window.doVideo = async (prompt, model) => {
                try {
                    if (!puter?.ai) throw new Error('Puter AI not ready');
                    const options = {
                        model: model || 'sora-2', // Reverted to Sora-2 per user request
                        prompt
                    };
                    const result = await puter.ai.txt2vid(prompt, options);

                    if (result && (result instanceof HTMLVideoElement || result.tagName === 'VIDEO')) {
                        return result.src;
                    }
                    if (typeof result === 'string') return result;
                    return result;
                } catch (e) {
                    throw new Error(e.message || JSON.stringify(e));
                }
            };
        });
    }

    async close() {
        this.status = 'dead';
        this.isReady = false;
        if (this.browser) {
            console.log(`[Session #${this.id}] Killing browser...`);
            await this.browser.close().catch(() => { });
        }
    }
}

// =====================
// Session Pool (Manager)

// 6. Video (Optimized)
app.post('/api/video/generate', async (req, res) => {
    try {
        const { prompt, model } = req.body;
        console.log(`[Video] Generating: "${prompt.substring(0, 40)}..."`);

        // Set longer timeout for video generation
        req.setTimeout(180000); // 3 minutes

        const result = await safeExecute('Video', async (session) => {
            return await session.page.evaluate(async (p, m) => window.doVideo(p, m),
                prompt,
                model || 'sora-2'
            );
        });

        res.json({ url: result });

    } catch (e) {
        console.error('[Video] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// =====================
// Session Pool (Hot-Swap Dual Browser System)
// =====================

class SessionPool {
    constructor() {
        this.active = null;      // Currently active browser
        this.standby = null;     // Hot standby browser (ready to swap)
        this.sessionCounter = 0;
        this.isInitializing = false;
        this.initPromise = null;
        this.isRotating = false;
    }

    async init() {
        if (this.isInitializing) return this.initPromise;
        
        this.isInitializing = true;
        this.initPromise = (async () => {
            console.log('[Pool] 🚀 ULTRA-FAST Dual Browser Init...');
            try {
                // PARALLEL LAUNCH for maximum speed
                console.log('[Pool] Launching 2 browsers simultaneously...');
                const startTime = Date.now();
                
                const [browser1, browser2] = await Promise.all([
                    this.createSession('active'),
                    this.createSession('standby')
                ]);
                
                this.active = browser1;
                this.standby = browser2;
                
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[Pool] ✅ Ready in ${elapsed}s!`);
                console.log(`[Pool] Active: #${this.active.id} | Standby: #${this.standby.id}`);
            } catch (e) {
                console.error('[Pool] Init failed:', e.message);
                this.isInitializing = false;
                throw e;
            }
            this.isInitializing = false;
        })();
        
        return this.initPromise;
    }

    async createSession(type) {
        this.sessionCounter++;
        const s = new BrowserSession(this.sessionCounter, type);

        try {
            await s.init(null);
            if (s.token) {
                console.log(`[Pool] ✅ Session #${s.id} (${type}) ready with token`);
            }
            return s;
        } catch (e) {
            console.error(`[Pool] Session #${s.id} failed:`, e.message);
            throw e;
        }
    }

    async getSession() {
        // If initializing, wait for it
        if (this.isInitializing) {
            await this.initPromise;
        }

        // Return active if ready
        if (this.active && this.active.isReady) {
            return this.active;
        }
        
        // Fallback to standby if active is dead
        if (this.standby && this.standby.isReady) {
            console.warn('[Pool] ⚠️ Active dead, using standby...');
            await this.hotSwap();
            return this.active;
        }
        
        throw new Error('No sessions available');
    }

    async hotSwap() {
        if (this.isRotating) {
            console.log('[Pool] Already rotating, waiting...');
            await new Promise(r => setTimeout(r, 1000));
            return this.active;
        }
        
        this.isRotating = true;
        
        try {
            console.log('[Pool] 🔄 HOT-SWAP: Switching to standby browser...');
            
            const oldActive = this.active;
            const oldStandby = this.standby;
            
            // INSTANT SWAP: Standby becomes active
            this.active = oldStandby;
            this.standby = null;
            
            console.log(`[Pool] ✅ SWAPPED! New Active: #${this.active.id}`);
            console.log(`[Pool] New Active Token: ${this.active.token?.substring(0, 20)}...`);
            
            // Kill old active browser in background (non-blocking)
            if (oldActive) {
                console.log(`[Pool] �️ Killing old browser #${oldActive.id}...`);
                oldActive.close().catch(() => {});
            }
            
            // Start creating new standby in background (non-blocking)
            console.log('[Pool] 🔧 Creating new standby browser in background...');
            this.createSession('standby')
                .then(newStandby => {
                    this.standby = newStandby;
                    console.log(`[Pool] ✅ New Standby Ready: #${newStandby.id}`);
                    console.log(`[Pool] Standby Token: ${newStandby.token?.substring(0, 20)}...`);
                    
                    // Force GC after swap complete
                    if (global.gc) {
                        console.log('[Pool] 🧹 Running garbage collection...');
                        global.gc();
                    }
                })
                .catch(e => {
                    console.error('[Pool] ⚠️ Failed to create new standby:', e.message);
                    // Try again after delay
                    setTimeout(() => {
                        console.log('[Pool] � Retrying standby creation...');
                        this.createSession('standby')
                            .then(s => {
                                this.standby = s;
                                console.log(`[Pool] ✅ Standby recovered: #${s.id}`);
                            })
                            .catch(e2 => console.error('[Pool] ⚠️ Standby retry failed:', e2.message));
                    }, 5000);
                });
            
            this.isRotating = false;
            return this.active;
            
        } catch (e) {
            console.error('[Pool] Hot-swap failed:', e.message);
            this.isRotating = false;
            throw e;
        }
    }

    // Force rotation (for limit errors)
    async forceRotate() {
        console.warn('[Pool] ⚠️ LIMIT REACHED - Forcing hot-swap...');
        return await this.hotSwap();
    }

    // Get system status
    getStatus() {
        return {
            active: this.active ? {
                id: this.active.id,
                ready: this.active.isReady,
                status: this.active.status,
                hasToken: !!this.active.token,
                activeRequests: this.active.activeRequests
            } : null,
            standby: this.standby ? {
                id: this.standby.id,
                ready: this.standby.isReady,
                status: this.standby.status,
                hasToken: !!this.standby.token
            } : null,
            isRotating: this.isRotating
        };
    }
}

const pool = new SessionPool();

// =====================
// Helper: Execute with Failover
// =====================

// ULTRA-FAST execution with minimal overhead
async function safeExecute(actionName, fn, retryCount = 0) {
    const MAX_RETRIES = 2;
    let session = null;
    
    try {
        session = await pool.getSession();
        session.activeRequests++;

        // Skip helper injection if already done (speed optimization)
        if (!session._helpersInjected) {
            await session.injectHelpers();
            session._helpersInjected = true;
        }
        
        const result = await fn(session);

        session.activeRequests--;

        // Fast error check
        if (result?.error) {
            const errorStr = String(result.error).toLowerCase();
            if (errorStr.includes('insufficient_funds') || 
                errorStr.includes('usage-limited') || 
                errorStr.includes('limit') ||
                errorStr.includes('quota')) {
                console.warn(`[${actionName}] ⚠️ LIMIT! Rotating...`);
                throw new Error('LIMIT_REACHED');
            }
        }

        // Periodic GC only (not every request)
        if (Math.random() < 0.1 && global.gc) global.gc();

        return result;

    } catch (e) {
        if (session) session.activeRequests--;

        const errStr = e.toString().toLowerCase();
        const isRecoverable = 
            errStr.includes('limit') || 
            errStr.includes('quota') || 
            errStr.includes('429') || 
            errStr.includes('insufficient_funds') ||
            errStr.includes('navigat') || 
            errStr.includes('protocol') ||
            errStr.includes('target closed');

        if (isRecoverable && retryCount < MAX_RETRIES) {
            console.warn(`[${actionName}] 🔄 Retry ${retryCount + 1}/${MAX_RETRIES}`);
            
            // Faster backoff
            await new Promise(r => setTimeout(r, (retryCount + 1) * 1000));
            await pool.forceRotate();
            
            return safeExecute(actionName, fn, retryCount + 1);
        }
        
        throw e;
    }
}

// =====================
// API Endpoints
// =====================

// 1. Chat (Ultra-Fast with Context Preservation + Streaming Support)
app.post('/api/chat', async (req, res) => {
    try {
        const { prompt, model, messages, system, chatId, stream = false } = req.body;
        let input = messages || prompt;
        if (!input && !messages) return res.status(400).json({ error: 'No input provided' });

        // Streaming mode
        if (stream) {
            console.log(`[Chat] STREAMING mode enabled`);
            
            // Set headers for SSE (Server-Sent Events)
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
            
            const executeStream = async (retryCount = 0) => {
                const MAX_RETRIES = 2;
                let session = null;
                
                try {
                    session = await pool.getSession();
                    session.activeRequests++;
                    await session.injectHelpers();
                    
                    // Create a unique callback ID for this stream
                    const callbackId = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    
                    // Track if we hit a limit error
                    let limitErrorDetected = false;
                    let limitErrorMessage = null;
                    
                    // Setup streaming with real-time callback
                    await session.page.exposeFunction(callbackId, (chunk) => {
                        try {
                            // Check for limit errors
                            if (chunk.error) {
                                const errorStr = JSON.stringify(chunk.error).toLowerCase();
                                if (errorStr.includes('insufficient_funds') || 
                                    errorStr.includes('usage-limited') ||
                                    errorStr.includes('limit') ||
                                    errorStr.includes('quota')) {
                                    console.warn('[Stream] ⚠️ LIMIT REACHED in chunk!');
                                    limitErrorDetected = true;
                                    limitErrorMessage = chunk.error.message || JSON.stringify(chunk.error);
                                    
                                    // Send error to client immediately
                                    if (!res.writableEnded) {
                                        res.write(`data: ${JSON.stringify({ error: 'LIMIT_REACHED', message: limitErrorMessage })}\n\n`);
                                    }
                                    return; // Don't throw, just mark and return
                                }
                                
                                // Send other errors to client
                                if (!res.writableEnded) {
                                    res.write(`data: ${JSON.stringify({ error: chunk.error })}\n\n`);
                                }
                                return;
                            }
                            
                            // Skip metadata chunks
                            if (chunk.type === 'usage' || chunk.type === 'metadata' || chunk.usage) {
                                return;
                            }
                            
                            // Extract text
                            let text = null;
                            if (typeof chunk === 'string') {
                                text = chunk;
                            } else if (chunk.text) {
                                text = chunk.text;
                            } else if (chunk.content) {
                                text = chunk.content;
                            } else if (chunk.message) {
                                text = typeof chunk.message === 'string' ? chunk.message : chunk.message.content;
                            } else if (chunk.delta && chunk.delta.content) {
                                text = chunk.delta.content;
                            } else if (chunk.choices && chunk.choices[0]) {
                                const choice = chunk.choices[0];
                                text = choice.delta?.content || choice.text || choice.message?.content;
                            }
                            
                            // Send chunk immediately
                            if (text && text.trim() && !res.writableEnded) {
                                res.write(`data: ${JSON.stringify({ text })}\n\n`);
                            }
                        } catch (e) {
                            console.error('[Stream] Callback error:', e);
                            // Send error to client
                            if (!res.writableEnded) {
                                res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
                            }
                        }
                    });
                    
                    // Start streaming with callback
                    const streamResult = await session.page.evaluate(async (p, m, cbId) => {
                        try {
                            if (!puter?.ai) {
                                return { error: 'Puter AI not ready' };
                            }
                            
                            let stream;
                            try {
                                stream = await puter.ai.chat(p, { model: m, stream: true });
                            } catch (chatError) {
                                // Catch errors from puter.ai.chat call itself
                                console.error('[Puter Stream] Chat call failed:', chatError);
                                
                                // Extract error details
                                let errorObj = {
                                    message: chatError.message || String(chatError),
                                    name: chatError.name,
                                    stack: chatError.stack
                                };
                                
                                // Check for limit-related properties
                                if (chatError.delegate) errorObj.delegate = chatError.delegate;
                                if (chatError.code) errorObj.code = chatError.code;
                                if (chatError.status) errorObj.status = chatError.status;
                                
                                return { error: errorObj };
                            }
                            
                            // Check if stream itself is an error
                            if (stream && stream.error) {
                                console.error('[Puter Stream] Stream returned error:', stream.error);
                                return { error: stream.error };
                            }
                            
                            // Check if stream is actually an error response (no iterator)
                            if (stream && !stream[Symbol.asyncIterator] && !stream.getReader && typeof stream === 'object') {
                                // Might be an error object disguised as response
                                const streamStr = JSON.stringify(stream).toLowerCase();
                                if (streamStr.includes('error') || streamStr.includes('limit') || streamStr.includes('insufficient')) {
                                    console.error('[Puter Stream] Stream looks like error:', stream);
                                    return { error: stream };
                                }
                            }
                            
                            // Handle different stream formats
                            if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
                                try {
                                    for await (const chunk of stream) {
                                        // Check each chunk for errors
                                        if (chunk && chunk.error) {
                                            console.error('[Puter Stream] Error chunk:', chunk.error);
                                            return { error: chunk.error };
                                        }
                                        
                                        // Call the exposed function to send chunk to Node.js
                                        await window[cbId](chunk);
                                    }
                                } catch (streamError) {
                                    console.error('[Puter Stream] Iteration error:', streamError);
                                    return { error: streamError.message || String(streamError) };
                                }
                            } else if (stream && typeof stream.getReader === 'function') {
                                const reader = stream.getReader();
                                const decoder = new TextDecoder();
                                
                                try {
                                    while (true) {
                                        const { done, value } = await reader.read();
                                        if (done) break;
                                        
                                        const text = decoder.decode(value, { stream: true });
                                        await window[cbId]({ text });
                                    }
                                } catch (readerError) {
                                    console.error('[Puter Stream] Reader error:', readerError);
                                    return { error: readerError.message || String(readerError) };
                                }
                            } else {
                                // Fallback: return as single chunk
                                await window[cbId](stream);
                            }
                            
                            return { success: true };
                        } catch (e) {
                            console.error('[Puter Stream] Top-level error:', e);
                            // Extract detailed error info
                            let errorObj = {
                                message: e.message || String(e),
                                name: e.name,
                                stack: e.stack
                            };
                            
                            // Try to get more details from Puter error
                            if (e.delegate) errorObj.delegate = e.delegate;
                            if (e.code) errorObj.code = e.code;
                            if (e.status) errorObj.status = e.status;
                            
                            return { error: errorObj };
                        }
                    }, input, model || 'gemini-2.0-flash', callbackId);
                    
                    // Check for errors or limit detection
                    if (limitErrorDetected || (streamResult && streamResult.error)) {
                        const errorToCheck = limitErrorDetected ? { message: limitErrorMessage } : streamResult.error;
                        const errorStr = JSON.stringify(errorToCheck).toLowerCase();
                        
                        // Check if it's a limit error
                        if (errorStr.includes('insufficient_funds') || 
                            errorStr.includes('usage-limited') ||
                            errorStr.includes('limit') ||
                            errorStr.includes('quota')) {
                            
                            if (retryCount < MAX_RETRIES) {
                                console.warn(`[Stream] 🔄 LIMIT REACHED! Rotating browser (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                                
                                if (session) session.activeRequests--;
                                
                                // Send notification to client about rotation
                                if (!res.writableEnded) {
                                    res.write(`data: ${JSON.stringify({ info: 'Rotating to new session, retrying...' })}\n\n`);
                                }
                                
                                // Rotate to new browser
                                await pool.forceRotate();
                                
                                // Wait a bit
                                await new Promise(r => setTimeout(r, (retryCount + 1) * 2000));
                                
                                // Retry with new browser
                                return executeStream(retryCount + 1);
                            } else {
                                // Max retries reached, send final error
                                if (!res.writableEnded) {
                                    res.write(`data: ${JSON.stringify({ error: 'LIMIT_REACHED', message: 'Maximum retries reached. Please try again later or get a new token.' })}\n\n`);
                                }
                            }
                        } else if (streamResult && streamResult.error && !res.writableEnded) {
                            // Non-limit error
                            res.write(`data: ${JSON.stringify({ error: streamResult.error })}\n\n`);
                        }
                    }
                    
                    // Send completion
                    if (!res.writableEnded) {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    
                    if (session) session.activeRequests--;
                    if (global.gc) global.gc();
                    
                } catch (e) {
                    console.error('[Stream] Error:', e);
                    
                    if (session) session.activeRequests--;
                    
                    const errStr = e.toString().toLowerCase();
                    const isLimitError = 
                        errStr.includes('limit') || 
                        errStr.includes('insufficient_funds') ||
                        errStr.includes('usage-limited') ||
                        errStr.includes('quota');
                    
                    if (isLimitError && retryCount < MAX_RETRIES) {
                        console.warn(`[Stream] 🔄 Retrying after limit error (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                        
                        await pool.forceRotate();
                        await new Promise(r => setTimeout(r, (retryCount + 1) * 2000));
                        
                        return executeStream(retryCount + 1);
                    }
                    
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
                        res.end();
                    }
                }
            };
            
            await executeStream();
            return;
        }

        // Normal mode (non-streaming)
        // Check cache for identical requests (skip for chat history)
        if (!chatId && typeof input === 'string' && !stream) {
            const cacheKey = getCacheKey('chat', { prompt: input, model });
            const cached = getFromCache(cacheKey);
            if (cached) {
                console.log('[Chat] Cache HIT ⚡');
                return res.json(cached);
            }
        }

        // Logging (minimal for speed)
        if (Array.isArray(input)) {
            console.log(`[Chat] ${input.length} msgs, Model: ${model || 'default'}`);
        } else {
            console.log(`[Chat] "${input.substring(0, 30)}...", Model: ${model || 'default'}`);
        }

        const result = await safeExecute('Chat', async (session) => {
            return await session.page.evaluate(async (p, m) => window.doChat(p, m, false), input, model || 'gemini-2.0-flash');
        });

        if (result && result.error) {
            const errDetails = typeof result.error === 'object' ? JSON.stringify(result.error, null, 2) : String(result.error);
            throw new Error(errDetails);
        }

        // Normalize response
        const normalizeResponse = (res) => {
            if (!res) return '';
            if (typeof res === 'string') return res;

            const extractContent = (content) => {
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) {
                    return content.map(c => {
                        if (typeof c === 'string') return c;
                        return c.text || c.content || JSON.stringify(c);
                    }).join('');
                }
                return JSON.stringify(content);
            };

            if (res.message) {
                if (res.message.content) return extractContent(res.message.content);
                if (res.message.text) return res.message.text;
                if (typeof res.message === 'string') return res.message;
            }

            if (res.choices && res.choices[0]) {
                const choice = res.choices[0];
                if (choice.message) return extractContent(choice.message.content);
                if (choice.text) return choice.text;
            }

            if (res.content) return extractContent(res.content);
            if (res.text) return res.text;

            return typeof res === 'object' ? JSON.stringify(res, null, 2) : String(res);
        };

        const text = normalizeResponse(result);
        const response = { text, full: result };

        // Save to chat history if chatId provided
        if (chatId) {
            chatStore.addMessage(chatId, 'user', typeof input === 'string' ? input : JSON.stringify(input));
            chatStore.addMessage(chatId, 'assistant', text);
        }

        // Cache simple prompts
        if (!chatId && typeof input === 'string') {
            const cacheKey = getCacheKey('chat', { prompt: input, model });
            setCache(cacheKey, response);
        }

        res.json(response);

    } catch (e) {
        console.error(`[Chat] Error:`, e);
        let errMsg = e.message || String(e);
        if (errMsg === '[object Object]') {
            try { errMsg = JSON.stringify(e, null, 2); } catch (e3) { errMsg = e.toString(); }
        }
        res.status(500).json({ error: errMsg });
    }
});

// 2. Image (Enhanced)
app.post('/api/image/generate', async (req, res) => {
    try {
        const { prompt, model, input_image } = req.body;

        console.log(`[Image] Generating: "${prompt.substring(0, 40)}..." (Img2Img: ${!!input_image})`);

        const result = await safeExecute('Image', async (session) => {
            return await session.page.evaluate(async (p, m, i) => window.doImage(p, m, i),
                prompt,
                model || 'gemini-2.5-flash-image-preview',
                input_image
            );
        });

        if (result && result.error) {
            const errDetails = typeof result.error === 'object' ? JSON.stringify(result.error, null, 2) : String(result.error);
            throw new Error(errDetails);
        }

        res.json(result);

    } catch (e) {
        console.error('[Image] Error:', e);
        let errMsg = e.message || String(e);
        if (errMsg === '[object Object]') {
            try { errMsg = JSON.stringify(e, null, 2); } catch (e3) { errMsg = e.toString(); }
        }
        res.status(500).json({ error: errMsg });
    }
});

// 3. Search (Perplexity)
app.post('/api/tool/search', async (req, res) => {
    try {
        const { prompt } = req.body;
        const result = await safeExecute('Search', async (session) => {
            return await session.page.evaluate(async (p) => window.doSearch(p), prompt);
        });
        res.json({ result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Text-to-Speech (TTS)
app.post('/api/tool/tts', async (req, res) => {
    try {
        const { text, voice } = req.body;
        console.log(`[TTS] Generating voice for: "${text?.substring(0, 30)}..." (Voice: ${voice || 'default'})`);
        const audioData = await safeExecute('TTS', async (session) => {
            return await session.page.evaluate(async (t, v) => window.doTTS(t, v), text, voice);
        });
        res.json({ audio: audioData });
    } catch (e) {
        console.error('[TTS] Error:', e);
        res.status(500).json({ error: e.message || 'Unknown TTS error' });
    }
});

// 5. Speech-to-Text (STT)
app.post('/api/tool/stt', async (req, res) => {
    try {
        const { audio } = req.body; // Expecting Base64 string or URL
        if (!audio) return res.status(400).json({ error: 'Audio data/url required' });

        const result = await safeExecute('STT', async (session) => {
            return await session.page.evaluate(async (a) => window.doSTT(a), audio);
        });
        res.json({ text: result.text || result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Speech-to-Speech (S2S)
app.post('/api/tool/s2s', async (req, res) => {
    try {
        const { audio, voice } = req.body;
        console.log(`[S2S] Converting voice (Voice: ${voice || 'default'})`);
        const result = await safeExecute('S2S', async (session) => {
            return await session.page.evaluate(async (a, v) => window.doS2S(a, v), audio, voice);
        });
        res.json({ audio: result });
    } catch (e) {
        console.error('[S2S] Error:', e);
        res.status(500).json({ error: e.message || 'Unknown S2S error' });
    }
});

// ULTRA-FAST Health Check (minimal overhead)
app.get('/api/health', (req, res) => {
    const isReady = pool.active?.isReady && pool.active?.token;
    
    // Fast response with minimal data
    res.status(isReady ? 200 : 503).json({
        status: isReady ? 'ready' : 'initializing',
        ready: isReady,
        active: pool.active?.id || null,
        standby: pool.standby?.id || null,
        cache: responseCache.size,
        uptime: Math.floor(process.uptime())
    });
});

app.get('/debug', async (req, res) => {
    let html = '<html><body style="background:#222;color:#0f0;font-family:monospace;"><h1>Browser Status</h1>';

    const getSessInfo = async (s, name) => {
        if (!s) return `<h2>${name}: NULL</h2>`;
        let shot = '';
        try {
            if (s.page) shot = await s.page.screenshot({ encoding: 'base64', type: 'webp', quality: 20 });
        } catch (e) { }

        return `
            <div style="border:1px solid #555; padding:10px; margin:10px;">
                <h2>${name} (ID: ${s.id})</h2>
                <p>Status: ${s.status} | Ready: ${s.isReady} | Active Req: ${s.activeRequests}</p>
                <p>Created: ${new Date(s.createdAt).toISOString()}</p>
                ${shot ? `<img src="data:image/webp;base64,${shot}" style="max-width:400px;border:1px solid #fff;">` : '<p>No Screenshot</p>'}
            </div>
        `;
    };

    html += await getSessInfo(pool.primary, 'PRIMARY');
    html += '</body></html>';
    res.send(html);
});

// =====================
// Missing Endpoints & Listen Logic
// =====================

app.post('/api/auth/token', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    try {
        pool.updateToken(token);
        res.json({ success: true, message: 'Token saved and synced' });
    } catch (e) {
        console.error('[Auth] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Session Recovery Endpoint (for quick browser switch scenario)
app.post('/api/session/recover', async (req, res) => {
    try {
        const { userId } = req.body;
        
        console.log('[Session] Recovery requested...');
        
        // Get last known token
        const lastToken = chatStore.getLastToken();
        
        if (!lastToken) {
            return res.status(404).json({ 
                error: 'No previous session found',
                needsLogin: true 
            });
        }

        // Check if current session is healthy
        if (pool.primary && pool.primary.isReady && pool.primary.token) {
            return res.json({
                success: true,
                recovered: false,
                message: 'Session already active',
                chats: chatStore.getAllChats()
            });
        }

        // Force rotation with existing token
        await pool.forceRotate();
        
        res.json({
            success: true,
            recovered: true,
            message: 'Session recovered successfully',
            chats: chatStore.getAllChats()
        });

    } catch (e) {
        console.error('[Session] Recovery failed:', e);
        res.status(500).json({ 
            error: e.message,
            needsLogin: true 
        });
    }
});

// Manual Token Extraction (for debugging)
app.get('/api/session/extract-token', async (req, res) => {
    try {
        const session = await pool.getSession();
        
        if (!session || !session.page) {
            return res.status(503).json({ error: 'No active session' });
        }

        console.log('[Extract] Manually extracting token from browser console...');
        
        const result = await session.page.evaluate(() => {
            const results = {
                puterAuthToken: null,
                puterAuthTokenType: null,
                localStorage: {},
                sessionStorage: {},
                cookies: document.cookie
            };
            
            // Try puter.authToken
            try {
                if (typeof puter !== 'undefined' && puter.authToken) {
                    results.puterAuthToken = puter.authToken;
                    results.puterAuthTokenType = typeof puter.authToken;
                    
                    // If object, try to extract all properties
                    if (typeof puter.authToken === 'object') {
                        results.puterAuthTokenKeys = Object.keys(puter.authToken);
                        results.puterAuthTokenValues = {};
                        for (const key in puter.authToken) {
                            results.puterAuthTokenValues[key] = puter.authToken[key];
                        }
                    }
                }
            } catch (e) {
                results.puterError = e.message;
            }
            
            // Get all localStorage
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    results.localStorage[key] = localStorage.getItem(key);
                }
            } catch (e) {}
            
            // Get all sessionStorage
            try {
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    results.sessionStorage[key] = sessionStorage.getItem(key);
                }
            } catch (e) {}
            
            return results;
        });
        
        console.log('[Extract] Raw result:', JSON.stringify(result, null, 2));
        
        res.json({
            success: true,
            data: result,
            instructions: 'Check data.puterAuthToken or data.localStorage for token'
        });

    } catch (e) {
        console.error('[Extract] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Clear cache endpoint
app.post('/api/cache/clear', (req, res) => {
    responseCache.clear();
    res.json({ success: true, message: 'Cache cleared' });
});

// Chat Management with Context
app.get('/api/chats', (req, res) => res.json(chatStore.getAllChats()));

app.post('/api/chats', (req, res) => {
    const chat = chatStore.createChat(req.body.title, req.body.model);
    res.status(201).json(chat);
});

app.get('/api/chats/:id', (req, res) => {
    const chat = chatStore.getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json(chat);
});

app.delete('/api/chats/:id', (req, res) => {
    const index = chatStore.data.chats.findIndex(c => c.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Chat not found' });
    chatStore.data.chats.splice(index, 1);
    chatStore.save();
    res.json({ success: true });
});


// Start (Only if running directly)
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server v2 running on ${PORT}`);
        pool.init();
        startKeepAlive();
    });
}

// Exports for server.js compatibility
module.exports = {
    // If server.js wants to mount us:
    app,
    start: () => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server v2 running on ${PORT}`);
            pool.init();
            startKeepAlive();
        });
    },
    // Keep old controller interface just in case
    init: () => { pool.init(); },
    getStatus: () => ({ isReady: pool.primary?.isReady, isLoggedIn: !!pool.primary?.token }),
    injectToken: async (t) => pool.updateToken(t),
    chat: async (input, model) => { /* routed via app */ }
};

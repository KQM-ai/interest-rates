const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');

// --- Config ---
const PORT = process.env.PORT || 3000;
const SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'default_session';
const BOT_VERSION = '1.0.1'; // Updated version
const startedAt = Date.now();
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MEMORY_THRESHOLD_MB = parseInt(process.env.MEMORY_THRESHOLD_MB || '450');
const RECONNECT_DELAY = parseInt(process.env.RECONNECT_DELAY || '10000');
const WATCHDOG_INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL || '300000'); // 5 minutes

// Add validation for critical environment variables
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing Supabase credentials. Exiting.');
  process.exit(1);
}

// Setup Supabase client with more robust error handling
let supabase;
try {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('✅ Supabase client initialized');
} catch (error) {
  console.error('❌ Failed to initialize Supabase client:', error.message);
  process.exit(1);
}

// Enhanced logging with levels
const log = (level, message, ...args) => {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level.toUpperCase()}] [${SESSION_ID}] ${message}`;
  
  console[level in console ? level : 'log'](formatted, ...args);
};

// Add debug level specifically for self-pings
log.debug = (message, ...args) => {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [DEBUG] [${SESSION_ID}] ${message}`;
  
  console.log(formatted, ...args);
};

// --- Supabase Store with improved error handling ---
class SupabaseStore {
  constructor(supabaseClient, sessionId) {
    this.supabase = supabaseClient;
    this.sessionId = sessionId;
    this.retryCount = 0;
    this.maxRetries = 3;
    log('info', `SupabaseStore initialized for session ID: ${this.sessionId}`);
  }

  async _executeWithRetry(operation, fallback = null) {
    this.retryCount = 0;
    while (this.retryCount < this.maxRetries) {
      try {
        return await operation();
      } catch (err) {
        this.retryCount++;
        log('warn', `Supabase operation failed (attempt ${this.retryCount}/${this.maxRetries}): ${err.message}`);
        if (this.retryCount >= this.maxRetries) {
          log('error', `Max retries reached for Supabase operation: ${err.message}`);
          return fallback;
        }
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, this.retryCount)));
      }
    }
  }

  async sessionExists({ session }) {
    return this._executeWithRetry(async () => {
      const { count, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('session_key', session);

      if (error) throw new Error(`Supabase error in sessionExists: ${error.message}`);
      return count > 0;
    }, false);
  }

  async extract() {
    return this._executeWithRetry(async () => {
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_key', this.sessionId)
        .limit(1)
        .single();

      if (error) throw new Error(`Failed to extract session: ${error.message}`);
      return data?.session_data || null;
    }, null);
  }

  async save(sessionData) {
    return this._executeWithRetry(async () => {
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({ 
          session_key: this.sessionId, 
          session_data: sessionData
          // No updated_at field - using only the columns from your schema
        }, { onConflict: 'session_key' });

      if (error) throw new Error(`Failed to save session: ${error.message}`);
      return true;
    }, false);
  }

  async delete() {
    return this._executeWithRetry(async () => {
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_key', this.sessionId);

      if (error) throw new Error(`Failed to delete session: ${error.message}`);
      return true;
    }, false);
  }
}

const supabaseStore = new SupabaseStore(supabase, SESSION_ID);
let client = null;
let connectionRetryCount = 0;
let isClientInitializing = false;

// Improved WhatsApp client creation with better error handling
function createWhatsAppClient() {
  const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
  const parentDir = path.dirname(sessionPath);
  
  // Ensure session directory exists
  try {
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
      log('info', `📁 Created session directory: ${parentDir}`);
    }
  } catch (err) {
    log('error', `Failed to create session directory: ${err.message}`);
    // Continue anyway as Supabase is the primary storage
  }

  return new Client({
    authStrategy: new RemoteAuth({
      store: supabaseStore,
      backupSyncIntervalMs: 300000, // 5 minutes
      dataPath: sessionPath,
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-features=site-per-process',
        '--js-flags="--max-old-space-size=500"', // Limit Node.js memory for puppeteer
      ],
      timeout: 120000, // 2 minute timeout for browser launch
    },
    qrTimeout: 0, // Never timeout waiting for QR
    restartOnAuthFail: true,
    takeoverOnConflict: true, // Take over session if logged in elsewhere
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  });
}

function setupClientEvents(c) {
  c.on('qr', qr => {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
    log('warn', `📱 Scan QR Code: ${qrUrl}`);
    
    // Also generate QR code in terminal for direct access
    qrcode.generate(qr, { small: true });
    
    // Reset connection retry count when we get a QR code
    connectionRetryCount = 0;
  });

  c.on('ready', () => {
    log('info', '✅ WhatsApp client is ready.');
    connectionRetryCount = 0; // Reset retry count on successful connection
    
    // Force garbage collection if available
    if (global.gc) {
      log('info', '🧹 Running garbage collection');
      global.gc();
    }
  });

  c.on('authenticated', () => {
    log('info', '🔐 Client authenticated.');
  });

  c.on('remote_session_saved', () => {
    log('info', '💾 Session saved to Supabase.');
  });

  c.on('disconnected', async reason => {
    log('warn', `Client disconnected: ${reason}`);
    
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        log('error', `Error destroying client: ${err.message}`);
      } finally {
        client = null;
      }
    }
    
    connectionRetryCount++;
    const delay = Math.min(RECONNECT_DELAY * connectionRetryCount, 5 * 60 * 1000); // Cap at 5 minutes
    log('info', `Will try to reconnect in ${delay/1000} seconds (attempt ${connectionRetryCount})`);
    
    setTimeout(startClient, delay);
  });

  c.on('auth_failure', async msg => {
    log('error', `❌ Auth failed: ${msg}. Clearing session.`);
    
    // Clear the session data
    try {
      await supabaseStore.delete();
      log('info', '🗑️ Session data deleted from Supabase');
      
      // Clear local session files
      const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        log('info', '🗑️ Local session files deleted');
      }
    } catch (err) {
      log('error', `Failed to clear session data: ${err.message}`);
    }
    
    // Don't exit - instead try to restart the client after a delay
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        log('error', `Error destroying client on auth failure: ${err.message}`);
      } finally {
        client = null;
      }
    }
    
    log('info', '🔄 Restarting client after auth failure...');
    setTimeout(startClient, 30000); // Wait 30 seconds before trying again
  });

  c.on('message', handleIncomingMessage);
  
  // Additional event handlers for better monitoring
  c.on('loading_screen', (percent, message) => {
    log('info', `Loading: ${percent}% - ${message}`);
  });
  
  c.on('change_state', state => {
    log('info', `Connection state changed to: ${state}`);
  });
}

let messageCount = 0;
let lastMemoryCheck = 0;

// Improved message handler with better error handling and throttling
async function handleIncomingMessage(msg) {
  try {
    // Basic validation
    if (!msg || !msg.from) {
      log('warn', '⚠️ Received invalid message object');
      return;
    }
    
    // Only process group messages
    if (!msg.from.endsWith('@g.us')) {
      return;
    }

    const groupId = msg.from;
    const senderId = msg.author || msg.from;
    const text = msg.body || '';
    const messageId = msg?.id?.id?.toString?.() || '';

    let replyInfo = null;
    let hasReply = false;

    // Get quoted message if this is a reply
    try {
      const quoted = await msg.getQuotedMessage?.();
      if (quoted?.id?.id) {
        hasReply = true;
        replyInfo = {
          message_id: quoted?.id?.id || null,
          text: quoted?.body || null,
        };
      }
    } catch (err) {
      log('warn', `⚠️ Failed to get quoted message: ${err.message}`);
    }

    // Check if message contains interest rates info (your filtering logic)
    const isImportant =
      text.toLowerCase().includes('dear valued partners') ||
      (hasReply && replyInfo?.text?.toLowerCase().includes('dear valued partners'));

    if (!isImportant) {
      return; // Skip unimportant messages silently
    }

    // Memory usage tracking
    messageCount++;
    const now = Date.now();
    
    // Only check memory every 50 messages or at least 5 minutes
    if (messageCount % 50 === 0 || (now - lastMemoryCheck > 5 * 60 * 1000)) {
      lastMemoryCheck = now;
      const mem = process.memoryUsage();
      const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
      const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
      log('info', `🧠 Memory: RSS=${rssMB}MB, HeapUsed=${heapUsedMB}MB, HeapTotal=${heapTotalMB}MB`);

      // Warning threshold
      if (parseFloat(rssMB) > MEMORY_THRESHOLD_MB) {
        log('warn', `⚠️ RSS memory usage above ${MEMORY_THRESHOLD_MB}MB.`);
        
        // Force garbage collection if available
        if (global.gc) {
          log('info', '🧹 Running forced garbage collection');
          global.gc();
        }
      }
    }

    // Prepare payload for n8n webhook
    const payload = {
      groupId,
      senderId,
      text,
      messageId,
      hasReply,
      replyInfo,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      botVersion: BOT_VERSION,
    };

    await sendToN8nWebhook(payload);
    
  } catch (err) {
    log('error', `Error processing message: ${err.message}`);
  }
}

// Improved webhook sender with better retry logic and timeout handling
async function sendToN8nWebhook(payload, attempt = 0) {
  if (!N8N_WEBHOOK_URL) {
    return; // Silently skip if webhook URL is not set
  }

  // Truncate long texts to avoid large payloads
  if (payload.text?.length > 1000) {
    payload.text = payload.text.slice(0, 1000) + '... [truncated]';
  }
  if (payload.replyInfo?.text?.length > 500) {
    payload.replyInfo.text = payload.replyInfo.text.slice(0, 500) + '... [truncated]';
  }

  // Estimate payload size
  const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadSize > 90_000) {
    log('warn', `🚫 Payload too large (${payloadSize} bytes). Skipping webhook.`);
    return;
  }

  try {
    // Use exponential backoff for retries
    const timeout = Math.min(10000 + attempt * 5000, 30000); // Increase timeout with each attempt, max 30s
    
    await axios.post(N8N_WEBHOOK_URL, payload, { 
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `WhatsAppBot/${BOT_VERSION}`
      },
      // Add validation to prevent accidental redirect following
      maxRedirects: 0,
    });
    
    log('info', `✅ Webhook sent (${payloadSize} bytes).`);
  } catch (err) {
    const status = err.response?.status;
    const isNetworkError = !status; // axios network errors don't have status
    
    // Only retry network errors or 5xx server errors
    if ((isNetworkError || (status >= 500 && status < 600)) && attempt < 3) {
      const nextAttempt = attempt + 1;
      const delayMs = 1000 * Math.pow(2, nextAttempt); // Exponential backoff: 2s, 4s, 8s
      
      log('warn', `Webhook attempt ${nextAttempt}/3 will retry in ${delayMs/1000}s: ${err.message}`);
      setTimeout(() => sendToN8nWebhook(payload, nextAttempt), delayMs);
    } else {
      // Don't retry client errors (4xx) or after max retries
      const errorContext = status ? `HTTP ${status}` : 'Network error';
      log('error', `Webhook failed after ${attempt + 1} attempt(s): ${errorContext} - ${err.message}`);
    }
  }
}

// Improved client starter with mutex to prevent multiple initializations
async function startClient() {
  if (isClientInitializing) {
    log('info', '⏳ Client already initializing, skipping duplicate init.');
    return;
  }
  
  if (client) {
    log('info', '⏳ Client already exists, skipping re-init.');
    return;
  }

  isClientInitializing = true;
  
  try {
    log('info', '🚀 Starting WhatsApp client...');
    client = createWhatsAppClient();
    setupClientEvents(client);

    await client.initialize();
    log('info', '✅ WhatsApp client initialized.');
  } catch (err) {
    log('error', `❌ WhatsApp client failed to initialize: ${err.message}`);
    
    if (client) {
      try {
        await client.destroy();
      } catch (destroyErr) {
        log('error', `Error destroying client after init failure: ${destroyErr.message}`);
      }
    }
    
    client = null;
    
    // Try again after a delay with exponential backoff
    connectionRetryCount++;
    const delay = Math.min(RECONNECT_DELAY * Math.pow(2, Math.min(connectionRetryCount - 1, 5)), 10 * 60 * 1000); // Cap at 10 minutes
    log('info', `Will try to initialize again in ${delay/1000} seconds (attempt ${connectionRetryCount})`);
    setTimeout(startClient, delay);
  } finally {
    isClientInitializing = false;
  }
}

// Enhanced Express server with basic security
const app = express();

// Security middleware
app.use((req, res, next) => {
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Basic rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  // Clean up old entries
  if (requestCounts.size > 100) {
    for (const [key, { timestamp }] of requestCounts.entries()) {
      if (now - timestamp > RATE_LIMIT_WINDOW) {
        requestCounts.delete(key);
      }
    }
  }
  
  // Check rate limit
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, timestamp: now });
  } else {
    const record = requestCounts.get(ip);
    if (now - record.timestamp > RATE_LIMIT_WINDOW) {
      // Reset if window expired
      record.count = 1;
      record.timestamp = now;
    } else {
      record.count++;
      if (record.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ 
          error: 'Too many requests',
          retry_after: Math.ceil((record.timestamp + RATE_LIMIT_WINDOW - now) / 1000)
        });
      }
    }
  }
  
  next();
});

app.use(express.json({ limit: '1mb' })); // Limit request body size

// Public health check endpoint
app.get('/', (_, res) => {
  const uptime = Date.now() - startedAt;
  res.status(200).json({
    status: client ? '✅ Bot running' : '⚠️ Bot initializing',
    sessionId: SESSION_ID,
    version: BOT_VERSION,
    uptimeMinutes: Math.floor(uptime / 60000),
    uptimeHours: Math.floor(uptime / 3600000),
    uptimeDays: Math.floor(uptime / 86400000),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
  });
});

// Message sending endpoint - no API key required as requested
app.post('/send-message', async (req, res) => {
  const { jid, message, imageUrl } = req.body;

  if (!jid || (!message && !imageUrl)) {
    return res.status(400).json({ success: false, error: 'Missing jid or message/imageUrl' });
  }

  if (!client) {
    return res.status(503).json({ success: false, error: 'WhatsApp client not ready' });
  }

  try {
    // Send media if imageUrl provided
    if (imageUrl) {
      // Validate URL to prevent request forgery
      try {
        new URL(imageUrl); // Will throw if invalid URL
      } catch (err) {
        return res.status(400).json({ success: false, error: 'Invalid imageUrl format' });
      }
      
      try {
        const media = await MessageMedia.fromUrl(imageUrl, { 
          unsafeMime: false, // Safer option
          reqOptions: {
            timeout: 15000,  // 15 second timeout
            headers: {
              'User-Agent': `WhatsAppBot/${BOT_VERSION}`
            }
          }
        });
        
        const sentMessage = await client.sendMessage(jid, media, {
          caption: message || '',
        });
        
        return res.status(200).json({ 
          success: true, 
          messageId: sentMessage.id.id,
          timestamp: new Date().toISOString()
        });
      } catch (mediaErr) {
        log('error', `Failed to process media: ${mediaErr.message}`);
        return res.status(500).json({ 
          success: false, 
          error: `Failed to process media: ${mediaErr.message}`
        });
      }
    }

    // Send plain text message
    const sentMessage = await client.sendMessage(jid, message);
    return res.status(200).json({ 
      success: true, 
      messageId: sentMessage.id.id,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('error', `Error sending message: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get client status endpoint
app.get('/status', async (req, res) => {
  try {
    if (!client) {
      return res.status(503).json({ 
        status: 'offline',
        error: 'Client not initialized'
      });
    }
    
    const state = await client.getState();
    const connectionState = client.pupPage ? 'connected' : 'disconnected';
    const mem = process.memoryUsage();
    
    return res.status(200).json({
      status: state,
      connectionState,
      connectionRetries: connectionRetryCount,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
      },
      messagesProcessed: messageCount,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('error', `Status check error: ${err.message}`);
    return res.status(500).json({ 
      status: 'error',
      error: err.message
    });
  }
});

// Force restart endpoint
app.post('/restart', async (req, res) => {
  log('info', '🔄 Manual restart requested');
  
  res.status(202).json({ 
    success: true, 
    message: 'Restart initiated' 
  });
  
  // Destroy and restart client
  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      log('error', `Error during manual client destroy: ${err.message}`);
    } finally {
      client = null;
      // Reset counters on manual restart
      connectionRetryCount = 0; 
    }
  }
  
  // Start client after a short delay
  setTimeout(startClient, 2000);
});

// Start server and initialize client
app.listen(PORT, () => {
  log('info', `🚀 Server started on http://localhost:${PORT}`);
  log('info', `🤖 Bot Version: ${BOT_VERSION}`);
  
  // Start WhatsApp client
  startClient();
  
  // Setup self-ping to match desired log format
  setInterval(() => {
    log.debug('🏓 Self-ping successful');
  }, 60000); // Every minute
  
  // Handle SIGTERM for graceful shutdown
  process.on('SIGTERM', async () => {
    log('info', '📴 SIGTERM received, shutting down gracefully');
    
    if (client) {
      try {
        await client.destroy();
        log('info', '🔌 WhatsApp client destroyed');
      } catch (err) {
        log('error', `Error during shutdown: ${err.message}`);
      }
    }
    
    // Exit after a short timeout to allow logs to flush
    setTimeout(() => process.exit(0), 1500);
  });
});

// Enhanced watchdog with memory monitoring and cleanup
setInterval(async () => {
  // First, log memory in exactly the format requested
  const mem = process.memoryUsage();
  const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
  const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
  
  // Log memory stats in exactly the requested format
  log('info', `🧠 Memory: RSS=${rssMB}MB, HeapUsed=${heapUsedMB}MB, HeapTotal=${heapTotalMB}MB`);
  
  // Skip if client is initializing
  if (isClientInitializing) {
    return;
  }
  
  // Check if client is missing
  if (!client) {
    log('warn', '🕵️ Watchdog: client is missing. Restarting...');
    await startClient();
    return;
  }

  try {
    // Check WhatsApp connection state
    const state = await client.getState();
    log('info', `✅ Watchdog: client state is "${state}".`);

    // Check if memory exceeds threshold (450MB) and perform cleanup if needed
    if (parseFloat(rssMB) > MEMORY_THRESHOLD_MB) {
      log('warn', `⚠️ Memory usage exceeded ${MEMORY_THRESHOLD_MB}MB (${rssMB}MB). Performing cleanup...`);
      
      // Force garbage collection if available
      if (global.gc) {
        log('info', '🧹 Running forced garbage collection');
        global.gc();
        
        // Check if garbage collection helped
        const afterGC = process.memoryUsage();
        const afterRssMB = (afterGC.rss / 1024 / 1024).toFixed(1);
        log('info', `🧹 After GC: RSS=${afterRssMB}MB`);
        
        // If still too high, restart the client
        if (parseFloat(afterRssMB) > MEMORY_THRESHOLD_MB) {
          log('warn', `⚠️ Memory still high after GC. Restarting client...`);
          await client.destroy().catch(err => 
            log('error', `Error destroying client during memory cleanup: ${err.message}`)
          );
          client = null;
          await startClient();
        }
      } else {
        // If GC not available, restart client to reduce memory
        log('warn', `⚠️ GC not available. Restarting client to reduce memory...`);
        await client.destroy().catch(err => 
          log('error', `Error destroying client during memory cleanup: ${err.message}`)
        );
        client = null;
        await startClient();
      }
    }

    // Additional pupPage check
    const hasValidPage = Boolean(client.pupPage);
    if (!hasValidPage) {
      log('warn', '⚠️ Watchdog: client missing pupPage. Restarting...');
      await client.destroy().catch(err => 
        log('error', `Error destroying client in watchdog: ${err.message}`)
      );
      client = null;
      await startClient();
      return;
    }

    if (state !== 'CONNECTED') {
      log('warn', `⚠️ Watchdog detected bad state "${state}". Restarting client...`);
      await client.destroy().catch(err => 
        log('error', `Error destroying client in watchdog: ${err.message}`)
      );
      client = null;
      await startClient();
    }
  } catch (err) {
    log('error', `🚨 Watchdog error: ${err.message}. Restarting...`);
    if (client) {
      await client.destroy().catch(destroyErr => 
        log('error', `Error destroying client after watchdog error: ${destroyErr.message}`)
      );
    }
    client = null;
    await startClient();
  }
}, WATCHDOG_INTERVAL);

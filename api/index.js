// /api/index.js

/**
 * SHIB Ads WebApp Backend API
 * Handles all POST requests from the Telegram Mini App frontend.
 * Uses the Supabase REST API for persistence and includes strong Telegram signature validation.
 */

// Load environment variables for Supabase and Telegram Bot Token
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN; // ⬅️ يجب إضافة هذا المتغير في Vercel

// تحميل وحدة التشفير (Crypto) المدمجة في بيئة Node.js (Vercel)
const crypto = require('crypto');

// ------------------------------------------------------------------
// ثوابت المكافآت المحددة والمؤمنة بالكامل على الخادم
// ------------------------------------------------------------------
const REWARD_PER_AD = 3; 
const REFERRAL_COMMISSION_RATE = 0.05;
const SPIN_SECTORS = [5, 10, 15, 20, 5]; 
const DAILY_MAX = 100; // حد الإعلانات اليومي
const DAILY_MAX_SPINS = 15; // حد الدوران اليومي
const MIN_WITHDRAW_AMOUNT = 400; // الحد الأدنى للسحب

/**
 * Helper function to randomly select a prize from the defined sectors.
 */
function calculateRandomSpinPrize() {
    const randomIndex = Math.floor(Math.random() * SPIN_SECTORS.length);
    return SPIN_SECTORS[randomIndex];
}

// --- Helper Functions ---

function sendSuccess(res, data = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data }));
}

function sendError(res, message, statusCode = 400) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

async function supabaseFetch(tableName, method, body = null, queryParams = '?select=*') {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const url = `${SUPABASE_URL}/rest/v1/${tableName}${queryParams}`;

  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation' 
  };

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  };

  const response = await fetch(url, options);
  
  if (response.ok) {
      const responseText = await response.text();
      try {
          const jsonResponse = JSON.parse(responseText);
          // Supabase returns an array for successful GET/POST/PATCH. Check for success flag in case of empty response.
          return Array.isArray(jsonResponse) ? jsonResponse : { success: true }; 
      } catch (e) {
          // Empty response or non-JSON success
          return { success: true }; 
      }
  }

  let data;
  try {
      data = await response.json();
  } catch (e) {
      const errorMsg = `Supabase error: ${response.status} ${response.statusText}`;
      throw new Error(errorMsg);
  }

  const errorMsg = data.message || `Supabase error: ${response.status} ${response.statusText}`;
  throw new Error(errorMsg);
}

// ------------------------------------------------------------------
// 🔑 دالة التحقق الأمني من توقيع تليجرام (InitData Signature Validation)
// ------------------------------------------------------------------

/**
 * Helper to check the HMAC signature against Telegram's specification.
 */
function checkSignature({ hash, ...data }) {
    // 1. Create a secret key based on the Bot Token
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    
    // 2. Prepare the data check string
    const dataCheckString = Object.keys(data)
        .filter(key => key !== 'hash')
        .sort()
        .map(key => (`${key}=${data[key]}`))
        .join('\n');

    // 3. Calculate the signature hash
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    // 4. Compare
    return hmac === hash;
}

/**
 * Parses initData string, validates signature, and returns the parsed data.
 */
function validateInitData(initData) {
    if (!BOT_TOKEN) {
        console.error("BOT_TOKEN is missing. Signature check disabled.");
        return false;
    }
    
    // Convert the query string into a parsable object
    const params = new URLSearchParams(initData);
    const data = {};
    for (const [key, value] of params.entries()) {
        data[key] = value;
    }

    if (!data.hash) return false;
    
    // Parse user object from JSON string
    let user = null;
    try {
        if (data.user) {
            user = JSON.parse(data.user);
            data.user = user;
        } else {
             // User data is essential for ID confirmation
             return false; 
        }
    } catch(e) {
        return false;
    }
    
    // Check for expiration (optional, but good practice, default 24 hours)
    if (data.auth_date && (Date.now() / 1000 - data.auth_date) > 86400) { 
        // console.warn("InitData expired.");
        // return false; 
    }

    if (!checkSignature(data)) {
        console.error("InitData signature validation failed.");
        return false;
    }
    
    return data;
}

/**
 * Global pre-handler to validate initData for all sensitive actions.
 * @returns {Object|null} The validated InitData object or null on failure.
 */
async function securityPreCheck(res, body) {
    const { init_data, user_id } = body;

    if (!init_data) {
        sendError(res, 'Missing Telegram WebApp initialization data for security check.', 403);
        return null;
    }
    if (!user_id) {
        sendError(res, 'Missing user_id in request body.', 403);
        return null;
    }

    const validatedData = validateInitData(init_data);

    if (!validatedData) {
        sendError(res, 'Security validation failed. Request rejected.', 403);
        return null;
    }
    
    // Ensure the user_id in the body matches the validated user_id from initData
    if (!validatedData.user || String(validatedData.user.id) !== String(user_id)) {
         sendError(res, 'User ID mismatch. Security check failed.', 403);
         return null;
    }

    return validatedData;
}

// --- API Handlers ---

/**
 * HANDLER: type: "getUserData" - Read-only, no signature check required
 * Fetches the current user data (balance, counts, history, and referrals) for UI initialization.
 */
async function handleGetUserData(req, res, body) {
    const { user_id } = body;

    if (!user_id) {
        return sendError(res, 'Missing user_id for data fetch.');
    }
    const id = parseInt(user_id);
    
    try {
        // 1. Fetch user data (balance, ads_watched_today, spins_today)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,spins_today`);
        
        if (!users || users.length === 0 || users.success) {
            // User not found, return default zero values
            return sendSuccess(res, { 
                balance: 0, 
                ads_watched_today: 0, 
                spins_today: 0,
                referrals_count: 0,
                withdrawal_history: []
            });
        }
        
        const userData = users[0];

        // 2. Fetch referrals count
        const referrals = await supabaseFetch('users', 'GET', null, `?ref_by=eq.${id}&select=id`);
        const referralsCount = Array.isArray(referrals) ? referrals.length : 0;

        // 3. Fetch withdrawal history
        const history = await supabaseFetch('withdrawals', 'GET', null, `?user_id=eq.${id}&select=amount,status,created_at&order=created_at.desc`);
        const withdrawalHistory = Array.isArray(history) ? history : [];

        sendSuccess(res, {
            ...userData,
            referrals_count: referralsCount,
            withdrawal_history: withdrawalHistory
        });

    } catch (error) {
        console.error('GetUserData failed:', error.message);
        sendError(res, `Failed to retrieve user data: ${error.message}`, 500);
    }
}


/**
 * 1) type: "register" - No signature check required, often called without full initData
 * Creates a new user if they don't exist.
 */
async function handleRegister(req, res, body) {
  const { user_id, ref_by } = body;
  const id = parseInt(user_id);

  try {
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id`);

    if (!Array.isArray(users) || users.length === 0) {
      const newUser = {
        id,
        balance: 0,
        ads_watched_today: 0,
        spins_today: 0,
        ref_by: ref_by ? parseInt(ref_by) : null,
      };

      await supabaseFetch('users', 'POST', newUser, '?select=id');
    }

    sendSuccess(res, { message: 'User registered or already exists.' });
  } catch (error) {
    console.error('Registration failed:', error.message);
    sendError(res, `Registration failed: ${error.message}`, 500);
  }
}

/**
 * 2) type: "watchAd"
 * 🔒 PROTECTION: Telegram Signature Check + Strict Daily Limit (100) + Server-side Commission.
 */
async function handleWatchAd(req, res, body) {
    // ⬅️ تحقق أمني من توقيع تليجرام
    const validatedData = await securityPreCheck(res, body);
    if (!validatedData) return;

    const id = parseInt(validatedData.user.id);
    const reward = REWARD_PER_AD; 

    try {
        // 1. Fetch current user data (limit check + ref_by)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,ref_by`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        const user = users[0];
        
        // ⬅️ التحقق الصارم من الحد اليومي (100)
        if (user.ads_watched_today >= DAILY_MAX) {
            return sendError(res, `Daily ad limit (${DAILY_MAX}) reached.`, 403);
        }
        
        const newBalance = user.balance + reward;
        const newAdsCount = user.ads_watched_today + 1;

        // 2. Update user record: balance and ads_watched_today
        await supabaseFetch('users', 'PATCH', 
          { balance: newBalance, ads_watched_today: newAdsCount }, 
          `?id=eq.${id}`);

        // 3. Save to ads_history (Optional, depends on your schema)
        // await supabaseFetch('ads_history', 'POST', 
        //   { user_id: id, reward }, 
        //   '?select=user_id');

        // 4. 💰 معالجة عمولة الإحالة (تلقائيًا على الخادم)
        if (user.ref_by) {
             const commissionAmount = reward * REFERRAL_COMMISSION_RATE;
             
             // Fetch referrer's balance
             const referrers = await supabaseFetch('users', 'GET', null, `?id=eq.${user.ref_by}&select=balance`);
             if (Array.isArray(referrers) && referrers.length > 0) {
                 const newRefBalance = referrers[0].balance + commissionAmount;
                 
                 // Update referrer balance
                 await supabaseFetch('users', 'PATCH', 
                   { balance: newRefBalance }, 
                   `?id=eq.${user.ref_by}`);

                 // Add record to commission_history (Optional, depends on your schema)
                 // await supabaseFetch('commission_history', 'POST', 
                 //   { referrer_id: user.ref_by, referee_id: id, amount: commissionAmount, source_reward: reward }, 
                 //   '?select=referrer_id');
             }
        }

        // 5. Return new state
        sendSuccess(res, { new_balance: newBalance, new_ads_count: newAdsCount, actual_reward: reward });
    } catch (error) {
        console.error('WatchAd failed:', error.message);
        sendError(res, `WatchAd failed: ${error.message}`, 500);
    }
}


/**
 * 3) type: "spin"
 * 🔒 PROTECTION: Telegram Signature Check + Strict Daily Limit (15).
 */
async function handleSpin(req, res, body) {
    // ⬅️ تحقق أمني من توقيع تليجرام
    const validatedData = await securityPreCheck(res, body);
    if (!validatedData) return;

    const id = parseInt(validatedData.user.id);

    try {
        // 1. Fetch current user data (limit check)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=spins_today`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        const user = users[0];
        
        // ⬅️ التحقق الصارم من الحد اليومي (15)
        if (user.spins_today >= DAILY_MAX_SPINS) {
            return sendError(res, `Daily spin limit (${DAILY_MAX_SPINS}) reached.`, 403);
        }

        const newSpinsCount = user.spins_today + 1;

        // 2. Update user record: spins_today
        await supabaseFetch('users', 'PATCH', 
          { spins_today: newSpinsCount }, 
          `?id=eq.${id}`);

        // 3. Save to spin_requests (Optional, depends on your schema)
        // await supabaseFetch('spin_requests', 'POST', 
        //   { user_id: id }, 
        //   '?select=user_id');

        sendSuccess(res, { new_spins_today: newSpinsCount });
    } catch (error) {
        console.error('Spin request failed:', error.message);
        sendError(res, `Spin request failed: ${error.message}`, 500);
    }
}

/**
 * 4) type: "spinResult"
 * 🔒 PROTECTION: Telegram Signature Check.
 */
async function handleSpinResult(req, res, body) {
    // ⬅️ تحقق أمني من توقيع تليجرام
    const validatedData = await securityPreCheck(res, body);
    if (!validatedData) return;
    
    const id = parseInt(validatedData.user.id);
    // ⬅️ يتم احتساب الجائزة عشوائيا على الخادم لضمان عدم الغش
    const prize = calculateRandomSpinPrize(); 

    try {
        // 1. Fetch current user balance
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance`);
        if (!ArrayOf(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        const newBalance = users[0].balance + prize;

        // 2. Update user record: balance
        await supabaseFetch('users', 'PATCH', 
          { balance: newBalance }, 
          `?id=eq.${id}`);

        // 3. Save to spin_results (Optional, depends on your schema)
        // await supabaseFetch('spin_results', 'POST', 
        //   { user_id: id, prize }, 
        //   '?select=user_id');

        sendSuccess(res, { new_balance: newBalance, actual_prize: prize }); 
    } catch (error) {
        console.error('Spin result failed:', error.message);
        sendError(res, `Spin result failed: ${error.message}`, 500);
    }
}

/**
 * 5) type: "withdraw"
 * 🔒 PROTECTION: Telegram Signature Check + Check Minimum and Balance.
 */
async function handleWithdraw(req, res, body) {
    // ⬅️ تحقق أمني من توقيع تليجرام
    const validatedData = await securityPreCheck(res, body);
    if (!validatedData) return;
    
    const id = parseInt(validatedData.user.id);
    const { binanceId, amount } = body;
  
    if (typeof amount !== 'number' || amount <= 0) {
        return sendError(res, 'Invalid withdrawal amount.', 400);
    }

    try {
        // 1. Fetch current user balance to ensure sufficient funds
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }

        const currentBalance = users[0].balance;
        
        if (amount < MIN_WITHDRAW_AMOUNT) { 
            return sendError(res, `Minimum withdrawal is ${MIN_WITHDRAW_AMOUNT} SHIB.`, 403);
        }
        if (amount > currentBalance) {
            return sendError(res, 'Insufficient balance.', 403);
        }
        
        const newBalance = currentBalance - amount;

        // 2. Update user record: balance
        await supabaseFetch('users', 'PATCH', 
          { balance: newBalance }, 
          `?id=eq.${id}`);

        // 3. Create record in withdrawals table
        await supabaseFetch('withdrawals', 'POST', {
          user_id: id,
          binance_id: binanceId,
          amount: amount,
          status: 'Pending',
        }, '?select=user_id');

        sendSuccess(res, { new_balance: newBalance });
    } catch (error) {
        console.error('Withdrawal failed:', error.message);
        sendError(res, `Withdrawal failed: ${error.message}`, 500);
    }
}

// --- Main Handler for Vercel/Serverless ---

module.exports = async (req, res) => {
    // Enable CORS for development/testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return sendSuccess(res);
    }

    if (req.method !== 'POST') {
        return sendError(res, `Method ${req.method} not allowed. Only POST is supported.`, 405);
    }

    let body;
    try {
        body = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => {
                data += chunk.toString();
            });
            req.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON payload.'));
                }
            });
            req.on('error', reject);
        });
    } catch (error) {
        return sendError(res, error.message, 400);
    }

    if (!body || !body.type) {
        return sendError(res, 'Missing "type" field in the request body.', 400);
    }
    
    // Route the request based on the 'type' field
    switch (body.type) {
        case 'getUserData':
            await handleGetUserData(req, res, body);
            break;
        case 'register':
            await handleRegister(req, res, body);
            break;
        case 'watchAd':
            await handleWatchAd(req, res, body);
            break;
        case 'spin':
            await handleSpin(req, res, body);
            break;
        case 'spinResult':
            await handleSpinResult(req, res, body);
            break;
        case 'withdraw':
            await handleWithdraw(req, res, body);
            break;
        default:
            sendError(res, `Unknown action type: ${body.type}`, 400);
    }
};
د// /api/index.js

/**
 * SHIB Ads WebApp Backend API
 * Handles all POST requests from the Telegram Mini App frontend.
 * Uses the Supabase REST API for persistence.
 */

// Load environment variables for Supabase connection
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// ⬅️ جديد: المفتاح السري والقيود الأمنية
const SECRET_KEY = process.env.SECRET_KEY || 'your-very-secret-key-replace-me';
const DAILY_MAX_ADS = 100; 
const DAILY_MAX_SPINS = 15; 
const crypto = require('crypto'); // ⬅️ جديد: استيراد مكتبة التشفير

// ------------------------------------------------------------------
// ثوابت المكافآت المحددة والمؤمنة بالكامل على الخادم (لضمان عدم التلاعب)
// ------------------------------------------------------------------
const REWARD_PER_AD = 3; 
const REFERRAL_COMMISSION_RATE = 0.05;
const SPIN_SECTORS = [5, 10, 15, 20, 5]; 

/**
 * Helper function to randomly select a prize from the defined sectors.
 */
function calculateRandomSpinPrize() {
    const randomIndex = Math.floor(Math.random() * SPIN_SECTORS.length);
    return SPIN_SECTORS[randomIndex];
}

/**
 * NEW: Verifies the SHA256 signature sent from the client.
 * The signature is: SHA256(user_id:type:SECRET_KEY)
 * @param {string} user_id The Telegram user ID.
 * @param {string} type The API request type (e.g., 'watchAd').
 * @param {string} signature The received signature string.
 * @returns {boolean} True if the signature is valid.
 */
function verifySignature(user_id, type, signature) {
    if (!signature) return false;
    
    const dataToSign = `${user_id}:${type}:${SECRET_KEY}`;
    // يجب تثبيت مكتبة 'crypto' (مثلاً: npm install crypto)
    const calculatedSignature = crypto.createHash('sha256').update(dataToSign).digest('hex');
    
    return calculatedSignature === signature;
}

// --- Helper Functions ---

/**
 * Sends a JSON response with status 200.
 * @param {Response} res The response object.
 * @param {Object} data The data to include in the response body.
 */
function sendSuccess(res, data = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data }));
}

/**
 * Sends a JSON error response with status 400 or 500.
 * @param {Response} res The response object.
 * @param {string} message The error message.
 * @param {number} statusCode The HTTP status code (default 400).
 */
function sendError(res, message, statusCode = 400) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

/**
 * Executes a fetch request to the Supabase REST API.
 * @param {string} tableName The name of the Supabase table.
 * @param {string} method HTTP method (GET, POST, PATCH, DELETE).
 * @param {Object} body JSON body for POST/PATCH.
 * @param {string} queryParams URL search parameters (e.g., '?select=*').
 * @returns {Promise<Object>} The JSON response from Supabase.
 */
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
  
  // Handling success responses (2xx)
  if (response.ok) {
      const responseText = await response.text();
      try {
          const jsonResponse = JSON.parse(responseText);
          // Supabase often returns an empty array on successful INSERT/UPDATE.
          return jsonResponse.length > 0 ? jsonResponse : { success: true }; 
      } catch (e) {
          // Handle empty response body (e.g., 204 No Content)
          return { success: true }; 
      }
  }

  // Handling error responses (4xx, 5xx)
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

// --- API Handlers ---

/**
 * HANDLER: type: "getUserData"
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
            // Return default state if user not found (should be handled by register first)
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
 * 1) type: "register"
 * Creates a new user if they don't exist.
 */
async function handleRegister(req, res, body) {
  const { user_id, ref_by } = body;
  const id = parseInt(user_id);

  try {
    // 1. Check if user exists
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id`);

    if (!Array.isArray(users) || users.length === 0) {
      // 2. User does not exist, create new user
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
 * Adds reward to user balance and increments ads_watched_today.
 * الحماية: تستخدم REWARD_PER_AD من الخادم فقط وتتحقق من التوقيع والحد الأقصى.
 */
async function handleWatchAd(req, res, body) {
  const { user_id, signature } = body; // ⬅️ استقبال التوقيع
  const id = parseInt(user_id);
  const reward = REWARD_PER_AD; // ⬅️ قيمة المكافأة مأخوذة من الخادم (آمنة)

  // 1. ⬅️ التحقق من التوقيع
  if (!verifySignature(user_id, 'watchAd', signature)) {
      return sendError(res, 'Invalid signature or missing token.', 403);
  }

  try {
    // 2. Fetch current user data
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    const user = users[0];

    // 3. ⬅️ التحقق من الحد الأقصى اليومي (الحماية على الخادم)
    if (user.ads_watched_today >= DAILY_MAX_ADS) {
        return sendError(res, `Daily ad limit (${DAILY_MAX_ADS}) reached.`, 403);
    }

    const newBalance = user.balance + reward;
    const newAdsCount = user.ads_watched_today + 1;

    // 4. Update user record: balance and ads_watched_today
    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance, ads_watched_today: newAdsCount }, 
      `?id=eq.${id}`);

    // 5. Save to ads_history
    await supabaseFetch('ads_history', 'POST', 
      { user_id: id, reward }, 
      '?select=user_id');

    // 6. Return new state
    sendSuccess(res, { new_balance: newBalance, new_ads_count: newAdsCount, actual_reward: reward }); // ⬅️ إرجاع المكافأة الحقيقية
  } catch (error) {
    console.error('WatchAd failed:', error.message);
    sendError(res, `WatchAd failed: ${error.message}`, 500);
  }
}

/**
 * 3) type: "commission"
 * Adds commission to referrer balance and logs the event.
 * الحماية: تحسب قيمة العمولة على الخادم. (لا تحتاج توقيع لأنها عملية داخلية)
 */
async function handleCommission(req, res, body) {
  const { referrer_id, referee_id } = body; 

  if (!referrer_id || !referee_id) {
    // لا يعتبر خطأ حرج، يتم إيقاف العملية بهدوء إذا لم تتوفر بيانات الإحالة
    return sendSuccess(res, { message: 'Invalid commission data received but acknowledged.' });
  }

  const referrerId = parseInt(referrer_id);
  const refereeId = parseInt(referee_id);
  
  // ⬅️ حساب العمولة بشكل آمن على الخادم
  const sourceReward = REWARD_PER_AD;
  const commissionAmount = sourceReward * REFERRAL_COMMISSION_RATE; 

  try {
    // 1. Fetch current referrer balance
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${referrerId}&select=balance`);
    if (!Array.isArray(users) || users.length === 0) {
        // Referrer not found, abort commission gracefully.
        return sendSuccess(res, { message: 'Referrer not found, commission aborted.' });
    }
    
    const newBalance = users[0].balance + commissionAmount;

    // 2. Update referrer balance
    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance }, 
      `?id=eq.${referrerId}`);

    // 3. Add record to commission_history
    await supabaseFetch('commission_history', 'POST', 
      { referrer_id: referrerId, referee_id: refereeId, amount: commissionAmount, source_reward: sourceReward }, 
      '?select=referrer_id');

    sendSuccess(res, { new_referrer_balance: newBalance });
  } catch (error) {
    console.error('Commission failed:', error.message);
    sendError(res, `Commission failed: ${error.message}`, 500);
  }
}

/**
 * 4) type: "spin"
 * Increments spins_today and logs the request. يتحقق من التوقيع والحد الأقصى.
 */
async function handleSpin(req, res, body) {
  const { user_id, signature } = body; // ⬅️ استقبال التوقيع
  const id = parseInt(user_id);

  // 1. ⬅️ التحقق من التوقيع
  if (!verifySignature(user_id, 'spin', signature)) {
      return sendError(res, 'Invalid signature or missing token.', 403);
  }

  try {
    // 2. Fetch current user data
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=spins_today`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    // 3. ⬅️ التحقق من الحد الأقصى اليومي (الحماية على الخادم)
    if (users[0].spins_today >= DAILY_MAX_SPINS) {
        return sendError(res, `Daily spin limit (${DAILY_MAX_SPINS}) reached.`, 403);
    }
    
    const newSpinsCount = users[0].spins_today + 1;

    // 4. Update user record: spins_today
    await supabaseFetch('users', 'PATCH', 
      { spins_today: newSpinsCount }, 
      `?id=eq.${id}`);

    // 5. Save to spin_requests
    await supabaseFetch('spin_requests', 'POST', 
      { user_id: id }, 
      '?select=user_id');

    sendSuccess(res, { new_spins_today: newSpinsCount });
  } catch (error) {
    console.error('Spin request failed:', error.message);
    sendError(res, `Spin request failed: ${error.message}`, 500);
  }
}

/**
 * 5) type: "spinResult"
 * يحسب الجائزة على الخادم، يضيفها إلى رصيد المستخدم، ويسجل النتيجة. يتحقق من التوقيع.
 */
async function handleSpinResult(req, res, body) {
  const { user_id, signature } = body; // ⬅️ استقبال التوقيع
  const id = parseInt(user_id);
  
  // 1. ⬅️ التحقق من التوقيع
  if (!verifySignature(user_id, 'spinResult', signature)) {
      return sendError(res, 'Invalid signature or missing token.', 403);
  }
  
  // ⬅️ حساب الجائزة بشكل آمن على الخادم
  const prize = calculateRandomSpinPrize(); 

  try {
    // 2. Fetch current user balance
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    const newBalance = users[0].balance + prize;

    // 3. Update user record: balance
    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance }, 
      `?id=eq.${id}`);

    // 4. Save to spin_results
    await supabaseFetch('spin_results', 'POST', 
      { user_id: id, prize }, 
      '?select=user_id');

    // 5. إرجاع الجائزة الحقيقية المحسوبة في الخادم
    sendSuccess(res, { new_balance: newBalance, actual_prize: prize }); 
  } catch (error) {
    console.error('Spin result failed:', error.message);
    sendError(res, `Spin result failed: ${error.message}`, 500);
  }
}

/**
 * 6) type: "withdraw"
 * Subtracts amount from user balance and creates a withdrawal record. يتحقق من التوقيع.
 */
async function handleWithdraw(req, res, body) {
  const { user_id, binanceId, amount, signature } = body; // ⬅️ استقبال التوقيع
  const id = parseInt(user_id);
  
  // 1. ⬅️ التحقق من التوقيع
  if (!verifySignature(user_id, 'withdraw', signature)) {
      return sendError(res, 'Invalid signature or missing token.', 403);
  }
  
  if (typeof amount !== 'number' || amount <= 0) {
        return sendError(res, 'Invalid withdrawal amount.', 400);
  }
  
  // ⬅️ المنطق الأمني: التحقق من الرصيد والحد الأدنى على الخادم

  try {
    // 2. Fetch current user balance to ensure sufficient funds
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }

    const currentBalance = users[0].balance;
    if (amount < 400) { // الحد الأدنى المكرر هنا للتأكيد
        return sendError(res, 'Minimum withdrawal is 400 SHIB.', 403);
    }
    if (amount > currentBalance) {
        return sendError(res, 'Insufficient balance.', 403);
    }
    
    const newBalance = currentBalance - amount;

    // 3. Update user record: balance
    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance }, 
      `?id=eq.${id}`);

    // 4. Create record in withdrawals table
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

/**
 * The entry point for the Vercel/Serverless function.
 * @param {Request} req The incoming request object.
 * @param {Response} res The outgoing response object.
 */
module.exports = async (req, res) => {
  // CORS configuration
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
  
  if (!body.user_id && body.type !== 'commission') {
      return sendError(res, 'Missing user_id in the request body.', 400);
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
    case 'commission':
      await handleCommission(req, res, body);
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
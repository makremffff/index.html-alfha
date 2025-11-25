// /api/index.js

/**
 * SHIB Ads WebApp Backend API
 * Handles all requests from the Telegram Mini App frontend.
 * Uses the Supabase REST API for persistence.
 */

// Load environment variables for Supabase connection
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
  };

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  };

  const response = await fetch(url, options);
  
  // Supabase responses for mutation operations (POST, PATCH) might be an empty array on success
  if (method === 'POST' || method === 'PATCH') {
      const responseText = await response.text();
      // Check for success status codes (201 Created, 200 OK)
      if (response.ok) {
          try {
              return JSON.parse(responseText);
          } catch (e) {
              // Return a generic success object if response is empty (e.g., 204 or empty body)
              return { success: true }; 
          }
      }
  }

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.message || `Supabase error: ${response.status} ${response.statusText}`;
    throw new Error(errorMsg);
  }

  return data;
}

// --- API Handlers ---

/**
 * 1) type: "register"
 * Creates a new user if they don't exist.
 */
async function handleRegister(req, res, body) {
  const { user_id, ref_by } = body;

  if (!user_id) {
    return sendError(res, 'Missing user_id for registration.');
  }

  const id = parseInt(user_id);
  if (isNaN(id)) {
      return sendError(res, 'Invalid user_id.');
  }

  try {
    // 1. Check if user exists
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id`);

    if (users && users.length === 0) {
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

    // 3. Always return success (even if user already existed)
    sendSuccess(res, { message: 'User registered or already exists.' });
  } catch (error) {
    console.error('Registration failed:', error.message);
    sendError(res, `Registration failed: ${error.message}`, 500);
  }
}

/**
 * 2) type: "watchAd"
 * Adds reward to user balance and increments ads_watched_today.
 */
async function handleWatchAd(req, res, body) {
  const { user_id, reward } = body;

  if (!user_id || typeof reward !== 'number') {
    return sendError(res, 'Missing user_id or reward for watchAd.');
  }

  const id = parseInt(user_id);
  if (isNaN(id)) {
      return sendError(res, 'Invalid user_id.');
  }

  try {
    // 1. Fetch current user data to ensure existence and get current values
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today`);
    if (!users || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    const user = users[0];
    const newBalance = user.balance + reward;
    const newAdsCount = user.ads_watched_today + 1;

    // 2. Update user record: balance and ads_watched_today
    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance, ads_watched_today: newAdsCount }, 
      `?id=eq.${id}`);

    // 3. Save to ads_history
    await supabaseFetch('ads_history', 'POST', 
      { user_id: id, reward }, 
      '?select=user_id');

    // 4. Return new balance
    sendSuccess(res, { new_balance: newBalance });
  } catch (error) {
    console.error('WatchAd failed:', error.message);
    sendError(res, `WatchAd failed: ${error.message}`, 500);
  }
}

/**
 * 3) type: "commission"
 * Adds commission to referrer balance and logs the event.
 */
async function handleCommission(req, res, body) {
  const { referrer_id, referee_id, amount, source_reward } = body;

  if (!referrer_id || !referee_id || typeof amount !== 'number' || typeof source_reward !== 'number') {
    return sendError(res, 'Missing required fields for commission.');
  }

  const referrerId = parseInt(referrer_id);
  const refereeId = parseInt(referee_id);
  
  if (isNaN(referrerId) || isNaN(refereeId)) {
      return sendError(res, 'Invalid referrer_id or referee_id.');
  }

  try {
    // 1. Fetch current referrer balance
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${referrerId}&select=balance`);
    if (!users || users.length === 0) {
        // Log, but still record history, or just abort. Aborting is safer.
        console.warn(`Referrer ID ${referrerId} not found for commission.`);
        return sendSuccess(res, { message: 'Referrer not found, commission aborted.' });
    }
    
    const newBalance = users[0].balance + amount;

    // 2. Update referrer balance
    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance }, 
      `?id=eq.${referrerId}`);

    // 3. Add record to commission_history
    await supabaseFetch('commission_history', 'POST', 
      { referrer_id: referrerId, referee_id: refereeId, amount, source_reward }, 
      '?select=referrer_id');

    sendSuccess(res, { new_referrer_balance: newBalance });
  } catch (error) {
    console.error('Commission failed:', error.message);
    sendError(res, `Commission failed: ${error.message}`, 500);
  }
}

/**
 * 4) type: "spin"
 * Increments spins_today and logs the request.
 */
async function handleSpin(req, res, body) {
  const { user_id } = body;

  if (!user_id) {
    return sendError(res, 'Missing user_id for spin request.');
  }
  
  const id = parseInt(user_id);
  if (isNaN(id)) {
      return sendError(res, 'Invalid user_id.');
  }

  try {
    // 1. Fetch current user data to ensure existence and get current value
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=spins_today`);
    if (!users || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    const newSpinsCount = users[0].spins_today + 1;

    // 2. Update user record: spins_today
    await supabaseFetch('users', 'PATCH', 
      { spins_today: newSpinsCount }, 
      `?id=eq.${id}`);

    // 3. Save to spin_requests
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
 * Adds the prize to user balance and logs the result.
 */
async function handleSpinResult(req, res, body) {
  const { user_id, prize } = body;

  if (!user_id || typeof prize !== 'number') {
    return sendError(res, 'Missing user_id or prize for spin result.');
  }
  
  const id = parseInt(user_id);
  if (isNaN(id)) {
      return sendError(res, 'Invalid user_id.');
  }

  try {
    // 1. Fetch current user balance
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance`);
    if (!users || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    const newBalance = users[0].balance + prize;

    // 2. Update user record: balance
    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance }, 
      `?id=eq.${id}`);

    // 3. Save to spin_results
    await supabaseFetch('spin_results', 'POST', 
      { user_id: id, prize }, 
      '?select=user_id');

    sendSuccess(res, { new_balance: newBalance });
  } catch (error) {
    console.error('Spin result failed:', error.message);
    sendError(res, `Spin result failed: ${error.message}`, 500);
  }
}

/**
 * 6) type: "withdraw"
 * Subtracts amount from user balance and creates a withdrawal record.
 */
async function handleWithdraw(req, res, body) {
  const { user_id, binanceId, amount } = body;

  if (!user_id || !binanceId || typeof amount !== 'number') {
    return sendError(res, 'Missing user_id, binanceId, or amount for withdrawal.');
  }

  const id = parseInt(user_id);
  if (isNaN(id)) {
      return sendError(res, 'Invalid user_id.');
  }

  try {
    // 1. Fetch current user balance to ensure sufficient funds
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance`);
    if (!users || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }

    const currentBalance = users[0].balance;
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

/**
 * The entry point for the Vercel/Serverless function.
 * @param {Request} req The incoming request object.
 * @param {Response} res The outgoing response object.
 */
module.exports = async (req, res) => {
  // CORS configuration (optional, but good practice)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return sendSuccess(res);
  }

  // Only handle POST requests as required
  if (req.method !== 'POST') {
    return sendError(res, `Method ${req.method} not allowed. Only POST is supported.`, 405);
  }

  let body;
  try {
    // Use native request.json() to parse the body
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
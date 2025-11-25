// api/index.js
// Vercel Serverless Function - Node.js

// إعدادات Supabase من متغيرات البيئة
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SHIB_ACTIONS_TABLE = 'shib_actions'; // لـ register, commission, withdraw, update_stats LOG
const USER_STATS_TABLE = 'user_stats';     // لـ get_stats و update_stats

/**
 * دالة مساعدة لتحديد ما إذا كان التاريخان يقعان في نفس اليوم (UTC).
 */
function isSameDay(date1, date2) {
    // التحقق من السنة والشهر واليوم
    return date1.getUTCFullYear() === date2.getUTCFullYear() &&
           date1.getUTCMonth() === date2.getUTCMonth() &&
           date1.getUTCDate() === date2.getUTCDate();
}

/**
 * دالة عامة لإجراء اتصال بـ Supabase REST API باستخدام fetch.
 */
async function call(table, method, body = null, filter = "") {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error("Supabase environment variables are not set.");
    }

    let url = `${SUPABASE_URL}/rest/v1/${table}`;
    if (filter) {
        url += `?${filter}`;
    }

    const headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
    
    // إعدادات خاصة للحصول على البيانات أو تنفيذ UPSERT
    if (method === 'GET' || (method === 'POST' && table === USER_STATS_TABLE)) {
        // للـ GET/SELECT نطلب تمثيل البيانات
        headers['Prefer'] = 'return=representation'; 
    } else {
        // لعمليات التسجيل الأخرى نطلب الحد الأدنى من الإرجاع
        headers['Prefer'] = 'return=minimal'; 
    }
    
    // لعملية UPSERT على user_stats (تحديث إذا وُجد، وإضافة إذا لم يُوجد)
    if (method === 'POST' && table === USER_STATS_TABLE) {
        // نحدد أن التعارض يتم بناءً على user_id
        headers['Prefer'] += ', on-conflict=user_id';
    }


    const config = {
        method: method,
        headers: headers,
    };

    if (body && (method === 'POST' || method === 'PATCH')) {
        config.body = JSON.stringify(body);
    }

    const response = await fetch(url, config);

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = errorText;
        try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.message) {
                errorMessage = errorJson.message;
            }
        } catch (e) {} // في حالة عدم وجود JSON
        throw new Error(`Supabase API Error (${response.status}): ${errorMessage}`);
    }

    if (response.status === 204) { // No Content
        return { message: "Action recorded successfully (No content returned)." };
    }
    
    // إذا كان Prefer يطلب تمثيل البيانات، نرجع الـ JSON
    if (headers['Prefer'].includes('return=representation')) {
         // تأكد من عدم محاولة قراءة الجسم إذا كان فارغًا
         const contentLength = response.headers.get('content-length');
         if (contentLength === '0' || response.status === 204) return [];
        return response.json();
    }
    
    return { message: "Action recorded successfully." };
}

/**
 * المعالج الرئيسي للطلبات.
 */
module.exports = async (req, res) => {
    // إعدادات CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: "Method Not Allowed. Only POST is supported." });
    }

    let body;
    try {
        body = req.body;
    } catch (e) {
        return res.status(400).json({ ok: false, error: "Invalid JSON body received." });
    }

    if (!body || !body.type) {
        return res.status(400).json({ ok: false, error: "Missing 'type' field in the request body." });
    }

    const { type } = body;
    let userId = null;

    if (body.user_id) {
        userId = body.user_id;
    } else if (body.referee_id) { 
        userId = body.referee_id;
    }

    const logPayload = {
        type: type,
        user_id: userId, 
        payload: body,   
    };

    try {
        switch (type) {
            
            // =======================================================
            // 1. أكشن جلب حالة المستخدم (get_stats) - لتنفيذ Daily Reset
            // =======================================================
            case 'get_stats': {
                if (!userId) {
                    return res.status(400).json({ ok: false, error: "user_id is required for get_stats." });
                }

                // 1. جلب حالة المستخدم الحالية
                let statsResponse = await call(USER_STATS_TABLE, 'GET', null, `user_id=eq.${userId}`);
                let userStats = statsResponse.length > 0 ? statsResponse[0] : null;
                
                const now = new Date();
                let resetNeeded = false;

                if (userStats) {
                    // 2. التحقق من إعادة التعيين اليومية
                    const lastUpdate = new Date(userStats.last_update);
                    if (!isSameDay(now, lastUpdate)) {
                        userStats.ads_watched_today = 0;
                        userStats.spins_today = 0;
                        resetNeeded = true;
                    }
                } else {
                    // 3. مستخدم جديد: إنشاء سجل افتراضي
                    userStats = {
                        user_id: userId,
                        balance: 0,
                        ads_watched_today: 0,
                        spins_today: 0,
                        referrals_count: 0,
                        last_update: now.toISOString()
                    };
                    resetNeeded = true; // لضمان إضافته لأول مرة
                }
                
                // 4. حفظ الحالة الجديدة (إذا تم إعادة التعيين أو كان مستخدم جديد)
                if (resetNeeded) {
                     await call(USER_STATS_TABLE, 'POST', {
                        user_id: userId,
                        balance: parseFloat(userStats.balance),
                        ads_watched_today: userStats.ads_watched_today,
                        spins_today: userStats.spins_today,
                        last_update: now.toISOString(),
                        referrals_count: userStats.referrals_count
                     });
                }
                
                // 5. إرجاع حالة المستخدم (Stats)
                return res.status(200).json({ ok: true, stats: userStats });
            }

            // =======================================================
            // 2. أكشن تحديث حالة المستخدم (update_stats) - لحفظ الرصيد والعدادات
            // =======================================================
            case 'update_stats': {
                // الحقول المتوقعة: user_id, balance, ads_watched_today, spins_today
                const { balance, ads_watched_today, spins_today } = body;

                if (!userId || balance === undefined || ads_watched_today === undefined || spins_today === undefined) {
                    return res.status(400).json({ ok: false, error: "Missing required fields for update_stats." });
                }
                
                const now = new Date();
                
                // أ. تسجيل الأكشن في جدول shib_actions (للتوثيق)
                await call(SHIB_ACTIONS_TABLE, 'POST', {
                    type: 'update_stats',
                    user_id: userId,
                    payload: body
                });

                // ب. حفظ حالة المستخدم الدائمة (UPSERT)
                await call(USER_STATS_TABLE, 'POST', {
                    user_id: userId,
                    balance: parseFloat(balance), 
                    ads_watched_today: parseInt(ads_watched_today),
                    spins_today: parseInt(spins_today),
                    last_update: now.toISOString()
                });

                return res.status(200).json({ ok: true, message: `User stats updated successfully for user ${userId}.` });
            }
            
            // =======================================================
            // 3. الأكشنات الأصلية (Log Only)
            // =======================================================
            case 'register':
            case 'commission':
            case 'withdraw': {
                // تسجيل الأكشن في جدول shib_actions فقط
                await call(SHIB_ACTIONS_TABLE, 'POST', logPayload);
                
                // يمكنك إضافة منطق تحديث الرصيد هنا في المستقبل إذا أردت جعل الـ Backend هو مصدر الحقيقة
                // حالياً، يتم الاعتماد على Frontend لإرسال "update_stats" بشكل منفصل بعد كل عملية ربح/سحب

                return res.status(200).json({ ok: true, message: `${type} action recorded.` });
            }
            
            default:
                // معالجة الأكشنات غير المعروفة
                console.error(`Unknown action type: ${type}`);
                return res.status(400).json({ ok: false, error: `Unknown action type: ${type}.` });
        }
    } catch (error) {
        console.error('API Handler Error:', error.message);
        return res.status(500).json({ ok: false, error: `Internal Server Error: ${error.message}` });
    }
};
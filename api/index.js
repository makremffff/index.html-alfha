// api/index.js
const { URLSearchParams } = require('url');

// إعدادات Supabase من متغيرات البيئة
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TABLE_NAME = 'shib_actions';

/**
 * دالة عامة لإجراء اتصال بـ Supabase REST API باستخدام fetch.
 *
 * @param {string} table - اسم الجدول المراد التعامل معه.
 * @param {string} method - نوع طلب HTTP (POST, GET, PATCH, DELETE).
 * @param {Object} body - جسم الطلب (للـ POST والـ PATCH).
 * @param {string} [filter=""] - سلسلة استعلام لتصفية البيانات (مثل `id=eq.123`).
 * @returns {Promise<Object>} بيانات الاستجابة من Supabase.
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
        'Prefer': 'return=minimal' // لتسريع الاستجابة
    };

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
        throw new Error(`Supabase API Error: ${response.status} - ${errorText}`);
    }

    // لا تقم بإرجاع json() إذا كان return=minimal (201, 204)
    if (response.status === 201 || response.status === 204) {
        return { message: "Action recorded successfully." };
    }
    
    // للـ GET
    return response.json();
}

/**
 * معالج طلب WebApp الرئيسي.
 * @param {Object} req - كائن الطلب (Vercel).
 * @param {Object} res - كائن الاستجابة (Vercel).
 */
module.exports = async (req, res) => {
    // 13. دعم CORS: السماح بالوصول من أي مصدر لطلبات WebApp (يمكن تضييقه لاحقًا)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // التعامل مع طلب OPTIONS (Pre-flight request)
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 1. كل الطلبات تكون عبر POST فقط.
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: "Method Not Allowed. Only POST is supported." });
        return;
    }

    let body;
    try {
        // فك JSON من req.body (يتطلب أن يكون الخادم قادرًا على قراءة stream أو استخدام body-parser)
        // في Vercel Serverless، يتم تحليل الجسم تلقائيًا لـ JSON إذا كان Content-Type هو application/json
        body = req.body;
    } catch (e) {
        res.status(400).json({ ok: false, error: "Invalid JSON body." });
        return;
    }

    // 2. التحقق من وجود "type"
    if (!body || !body.type) {
        res.status(400).json({ ok: false, error: "Missing 'type' field in the request body." });
        return;
    }

    const { type } = body;
    let userId = null; // 9. user_id يبدأ بقيمة null

    // محاولة استخراج user_id من الحمولة مباشرة إذا كان موجوداً
    if (body.user_id) {
        userId = body.user_id;
    } else if (body.referee_id) { 
        // قد يكون referee_id هو المستخدم في حالة commission
        userId = body.referee_id;
    }

    const logPayload = {
        type: type,
        user_id: userId,
        payload: body, // 9. تخزين الحمولة كاملة
    };

    try {
        // 3. نستخدم Switch(type) لمعالجة كل نوع.
        switch (type) {
            case 'register': {
                // 8. استلام كامل المعلومات: (user_id, ref_by)
                const { user_id, ref_by } = body;

                // **منطق معالجة register:**
                // هنا يتم تسجيل المستخدم في جدول المستخدمين (خارج نطاق هذا الطلب)
                // يتم الآن فقط تسجيل الأكشن في shib_actions
                await call(TABLE_NAME, 'POST', logPayload);
                
                // 11. إرجاع رد JSON: { ok:true }
                res.status(200).json({ ok: true, message: `Registered action recorded for user ${user_id}.` });
                break;
            }
            case 'commission': {
                // 8. استلام كامل المعلومات: (referrer_id, referee_id, amount, source_reward)
                const { referrer_id, referee_id, amount, source_reward } = body;
                
                // **منطق معالجة commission:**
                // هنا يتم إضافة الـ amount لرصيد الـ referrer_id (خارج نطاق هذا الطلب)
                // يتم الآن فقط تسجيل الأكشن في shib_actions
                await call(TABLE_NAME, 'POST', logPayload);

                res.status(200).json({ ok: true, message: `Commission action recorded for referrer ${referrer_id}.` });
                break;
            }
            case 'withdraw': {
                // 8. استلام كامل المعلومات: (binanceId, amount)
                const { binanceId, amount } = body;

                // **منطق معالجة withdraw:**
                // هنا يتم التحقق من الرصيد وبدء عملية السحب اليدوية (خارج نطاق هذا الطلب)
                // يتم الآن فقط تسجيل الأكشن في shib_actions
                await call(TABLE_NAME, 'POST', logPayload);

                res.status(200).json({ ok: true, message: `Withdrawal action recorded for Binance ID ${binanceId}.` });
                break;
            }
            default:
                // 11. تسجيل الخطأ إذا كان type غير معروف
                console.error(`Unknown action type: ${type}`);
                res.status(400).json({ ok: false, error: `Unknown action type: ${type}.` });
                break;
        }
    } catch (error) {
        console.error('API Handler Error:', error.message);
        res.status(500).json({ ok: false, error: `Internal Server Error: ${error.message}` });
    }
};
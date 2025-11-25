// لا توجد استيرادات لمكتبات خارجية - نعتمد فقط على fetch وبيئة Vercel

// **تأكد من تعيين هذه المتغيرات في إعدادات Vercel**
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;


/**
 * دالة مساعدة عامة للاتصال بـ Supabase REST API مباشرة.
 * @param {string} method - طريقة HTTP (GET, POST, PATCH).
 * @param {string} table - اسم الجدول.
 * @param {object} queryParams - معاملات الاستعلام (Filters, Selects, onConflict, Count).
 * @param {object | null} body - جسم الطلب لـ POST/PATCH.
 * @returns {Promise<any>} البيانات المسترجعة أو رسالة نجاح.
 */
async function restCall(method, table, queryParams = {}, body = null) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error("Supabase environment variables not set.");
    }

    // بناء URL: https://[URL]/rest/v1/[table]
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    
    const headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    };

    let preferHeader = 'return=representation';

    // إضافة مرشحات الاستعلام (eq, select, on_conflict) إلى URL
    Object.keys(queryParams).forEach(key => {
        if (key === 'count' && queryParams[key] === 'exact') {
            // نستخدم Prefer: count=exact لجلب العدد
            preferHeader = 'count=exact';
        } else if (key === 'onConflict' && (method === 'POST' || method === 'PATCH')) {
            // معالجة UPSERT/Update Conflict. يتم تمريره كـ Query Param
            url.searchParams.append('on_conflict', queryParams[key]);
        } else {
            url.searchParams.append(key, queryParams[key]);
        }
    });
    
    // إعداد الرؤوس بناءً على نوع الطلب
    if (method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        headers['Prefer'] = preferHeader;
    } else {
        headers['Accept'] = 'application/json';
        if (queryParams.count === 'exact') {
            headers['Prefer'] = preferHeader;
        }
    }


    const options = {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    };

    const response = await fetch(url.toString(), options);
    
    // في حالة خطأ Supabase
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Supabase API Error (${response.status}): ${errorText}`);
    }

    // لطلبات جلب العدد (COUNT)
    if (queryParams.count === 'exact') {
        const contentRange = response.headers.get('content-range');
        const count = contentRange ? parseInt(contentRange.split('/')[1]) : 0;
        return { count };
    }

    // لطلبات الجلب العادية
    if (response.status === 204) return []; // No Content
    
    const json = await response.json();
    return json;
}


/**
 * دالة مساعدة للتحقق من مرور يوم كامل (Daily Reset Logic)
 * @param {string} lastUpdated - آخر وقت تم فيه تحديث الإحصائيات (ISO String)
 * @returns {boolean} True إذا كان اليوم جديداً
 */
function isNewDay(lastUpdated) {
    if (!lastUpdated) return true;
    const now = new Date();
    const last = new Date(lastUpdated);
    // نقارن تواريخ اليوم فقط (yyyy/mm/dd)
    return now.toDateString() !== last.toDateString();
}


export default async (req, res) => {
    // التأكد من أن نوع الطلب هو POST
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    try {
        // استخراج البيانات من جسم الطلب
        const { type, user_id, ...data } = req.body;

        if (!user_id || !type) {
            return res.status(400).json({ ok: false, error: 'Missing user_id or type' });
        }

        switch (type) {
            
            case 'register':
                // 1. تسجيل عمل الإحالة إذا وُجد
                if (data.ref_by) {
                    await restCall('POST', 'shib_actions', {}, {
                        user_id,
                        type: 'referral_received',
                        amount: 0, 
                        data: { ref_by: data.ref_by } // **نستخدم 'data'**
                    });
                }
                // 2. تسجيل عمل التسجيل
                await restCall('POST', 'shib_actions', {}, { user_id, type: 'registration' });
                 
                return res.status(200).json({ ok: true, message: 'User registered/Referral logged.' });
                 
            
            case 'get_stats':
                // 1. جلب الإحصائيات الحالية
                let statsData = null;
                try {
                    const result = await restCall('GET', 'user_stats', { select: '*', user_id: `eq.${user_id}` });
                    if (result && result.length > 0) {
                        statsData = result[0]; 
                    }
                } catch (e) {
                    console.warn('Stats not found or REST error on select, treating as new user:', e.message);
                }

                // 2. إعداد الإحصائيات الافتراضية للمستخدم الجديد
                let currentStats = statsData || { 
                    user_id, 
                    balance: 0, 
                    ads_watched_today: 0, 
                    spins_today: 0, 
                    last_update: new Date().toISOString() 
                };
                
                // 3. جلب عدد الإحالات
                const { count: refCount } = await restCall('GET', 'shib_actions', { 
                    select: 'id', 
                    'data->>ref_by': `eq.${String(user_id)}`, // البحث داخل حقل 'data'
                    type: 'eq.referral_received', 
                    count: 'exact'
                });
                
                currentStats.referrals_count = refCount || 0;

                // 4. تطبيق منطق إعادة التعيين اليومية
                if (statsData && isNewDay(statsData.last_update)) {
                    console.log('Daily reset triggered for user:', user_id);
                    currentStats.ads_watched_today = 0;
                    currentStats.spins_today = 0;
                    currentStats.last_update = new Date().toISOString();
                    
                    // حفظ الإحصائيات المعاد تعيينها فوراً (UPSERT)
                    await restCall('POST', 'user_stats', { onConflict: 'user_id' }, currentStats);
                }
                
                return res.status(200).json({ ok: true, stats: currentStats });

            
            case 'update_stats':
                const { balance, ads_watched_today, spins_today } = data;
                
                if (balance === undefined || ads_watched_today === undefined || spins_today === undefined) {
                     return res.status(400).json({ ok: false, error: 'Missing stats data for update' });
                }

                const updatePayload = {
                    user_id,
                    balance: parseFloat(balance),
                    ads_watched_today: parseInt(ads_watched_today),
                    spins_today: parseInt(spins_today),
                    last_update: new Date().toISOString()
                };

                // حفظ أو تحديث الإحصائيات (UPSERT)
                await restCall('POST', 'user_stats', { onConflict: 'user_id' }, updatePayload);

                return res.status(200).json({ ok: true, message: 'Stats updated successfully' });

            case 'commission':
                 const { referrer_id, referee_id, amount: commissionAmount, source_reward } = data;
                 
                 // 1. تسجيل العمولة في جدول shib_actions
                 await restCall('POST', 'shib_actions', {}, {
                     user_id: referrer_id,
                     type: 'commission_earned',
                     amount: commissionAmount,
                     data: { referee_id, source_reward } // **نستخدم 'data'**
                 });

                 // 2. تحديث رصيد المُحيل (يجب جلب الرصيد القديم أولاً)
                 const refStatsResult = await restCall('GET', 'user_stats', { 
                    select: 'balance', 
                    user_id: `eq.${referrer_id}` 
                 });

                 const oldBalance = refStatsResult[0] ? parseFloat(refStatsResult[0].balance) : 0;
                 const newBalance = oldBalance + parseFloat(commissionAmount);

                 // UPSERT (تحديث الرصيد)
                 await restCall('POST', 'user_stats', { onConflict: 'user_id' }, { 
                     user_id: referrer_id, 
                     balance: newBalance, 
                     last_update: new Date().toISOString() 
                 });
                 
                 return res.status(200).json({ ok: true, message: 'Commission logged and balance updated.' });

            case 'withdraw':
                const { binanceId, amount } = data;
                
                // تسجيل طلب السحب في جدول shib_actions
                await restCall('POST', 'shib_actions', {}, {
                    user_id,
                    type: 'withdrawal_request',
                    amount: parseFloat(amount),
                    data: { binance_id: binanceId } // **نستخدم 'data'**
                });

                return res.status(200).json({ ok: true, message: 'Withdrawal request logged.' });

            default:
                return res.status(400).json({ ok: false, error: 'Unknown action type' });
        }
    } catch (error) {
        console.error('API Handler Error:', error.message);
        // عند حدوث خطأ، نرسل تفاصيل الخطأ لتسهيل تتبعه
        return res.status(500).json({ ok: false, error: 'Internal Server Error', details: error.message });
    }
};